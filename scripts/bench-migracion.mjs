/**
 * Cuánto tarda una migración de verdad.
 *
 * Mide las etapas por separado porque se rompen por motivos distintos: leer el
 * archivo es CPU, guardar las filas crudas es una tanda de INSERT, y escribir
 * en la empresa es un INSERT por fila más la búsqueda de duplicado. Un número
 * global escondería cuál de las tres se degradó.
 *
 *     npm run bench:migracion -- 1000 10000 50000
 *
 * Sin argumentos corre 1.000, 10.000 y 50.000. Cada volumen usa una **empresa
 * propia**, creada para la corrida: medir la segunda importación sobre una
 * empresa que ya tiene cincuenta mil terceros mediría otra cosa.
 *
 * Escribe en la base de DESARROLLO y no borra nada al terminar: las filas
 * quedan y se pueden mirar. Las empresas se llaman `Bench <n> <sello>`, así que
 * se reconocen y se pueden limpiar con una consulta.
 */

import { closePool, initPool, withCompany } from '@aai/db';
import { withCheckDigit } from '@aai/shared';
import pg from 'pg';

const VOLUMENES = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const TAMANOS = VOLUMENES.length > 0 ? VOLUMENES : [1000, 10_000, 50_000];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

/** Módulo 11, para generar CUIT sintéticos distintos en cada fila. */
const cuitDe = (i) => withCheckDigit(`30${String(i).padStart(8, '0')}`);

function archivo(filas, desplazamiento) {
  const lineas = ['Razón Social;CUIT;Email'];
  for (let i = 0; i < filas; i += 1) {
    const n = desplazamiento + i;
    lineas.push(`Empresa ${n} SA;${cuitDe(n)};empresa${n}@bench.local`);
  }
  return Buffer.from(lineas.join('\n'), 'utf8');
}

const ms = (desde) => Number(process.hrtime.bigint() - desde) / 1e6;
const porSegundo = (n, milis) => (milis <= 0 ? 0 : Math.round((n / milis) * 1000));
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function main() {
  const ciclo = await import('../apps/api/dist/migracion/ciclo.js');

  initPool(url);
  const raw = new pg.Client({ connectionString: url });
  await raw.connect();

  const sello = Date.now().toString().slice(-8);
  const resultados = [];
  let desplazamiento = 0;

  for (const filas of TAMANOS) {
    const empresa = await crearEmpresa(raw, `Bench ${filas} ${sello}`, sello, resultados.length);
    const bytes = archivo(filas, desplazamiento);
    desplazamiento += filas;

    const medida = await medir(ciclo, empresa, filas, bytes);
    resultados.push({ filas, bytes: bytes.length, empresa, ...medida });
    imprimir(resultados.at(-1));
  }

  console.log('\n── Resumen ────────────────────────────────────────────────────────');
  console.log(
    ['filas', 'MB', 'cargar', 'validar', 'importar', 'repetir', 'tandas', 'filas/s'].join('\t'),
  );
  for (const r of resultados) {
    console.log(
      [
        r.filas,
        mb(r.bytes),
        `${r.cargar.toFixed(0)}ms`,
        `${r.validar.toFixed(0)}ms`,
        `${r.importar.toFixed(0)}ms`,
        `${r.reimportar.toFixed(0)}ms`,
        r.tandas,
        porSegundo(r.filas, r.importar),
      ].join('\t'),
    );
  }
  console.log(
    '\nMemoria residente al terminar: ' + mb(process.memoryUsage().rss) + ' MB',
  );

  await raw.end();
  await closePool();
}

async function crearEmpresa(raw, nombre, sello, indice) {
  const sufijo = String(Number(sello) + indice).padStart(8, '0').slice(-8);
  const org = await raw.query(
    'INSERT INTO organizations (name, tax_id) VALUES ($1,$2) RETURNING id',
    [nombre, withCheckDigit(`30${sufijo}`)],
  );
  const empresa = await raw.query(
    `INSERT INTO companies (organization_id, legal_name, cuit, entity_type, jurisdiction,
                            regulator, fiscal_year_end)
     VALUES ($1,$2,$3,'SRL','AR-C','IGJ','12-31') RETURNING id`,
    [org.rows[0].id, nombre, withCheckDigit(`33${sufijo}`)],
  );
  return empresa.rows[0].id;
}

async function medir(ciclo, companyId, filas, bytes) {
  const actor = 'user:bench';
  const marcas = {};

  const id = await withCompany({ companyId, actorId: actor }, async (tx) => {
    const id = await ciclo.crearMigracion(tx, companyId, actor, {
      adaptador: 'ARCHIVO_GENERICO',
      titulo: `Bench ${filas}`,
    });

    let t = process.hrtime.bigint();
    await ciclo.cargarOrigen(tx, companyId, actor, id, { nombre: 'bench.csv', bytes });
    marcas.cargar = ms(t);

    const { rows } = await tx.query('SELECT id FROM migration_tables WHERE migration_id = $1', [id]);
    await ciclo.declararMapeo(tx, companyId, actor, id, [
      {
        id: rows[0].id,
        entidad: 'PARTY',
        mapeo: { 'Razón Social': 'razonSocial', CUIT: 'cuit', Email: 'email' },
        incluida: true,
      },
    ]);

    t = process.hrtime.bigint();
    const veredicto = await ciclo.validarMigracion(tx, companyId, actor, id);
    marcas.validar = ms(t);
    if (!veredicto.sePuedeImportar) {
      throw new Error(`La validación no dejó importar: ${JSON.stringify(veredicto)}`);
    }
    return id;
  });

  let t = process.hrtime.bigint();
  const r = await ciclo.importar(companyId, actor, id);
  marcas.importar = ms(t);
  marcas.conteos = r.conteos;
  marcas.tandas = r.progreso.tandas;

  // La segunda corrida sobre los mismos datos: mide el costo de reconocer lo
  // que ya está, que en una migración repetida es todo el trabajo.
  const segunda = await withCompany({ companyId, actorId: actor }, async (tx) => {
    const id2 = await ciclo.crearMigracion(tx, companyId, actor, {
      adaptador: 'ARCHIVO_GENERICO',
      titulo: `Bench repetido ${filas}`,
    });
    await ciclo.cargarOrigen(tx, companyId, actor, id2, { nombre: 'bench-2.csv', bytes });
    const { rows } = await tx.query('SELECT id FROM migration_tables WHERE migration_id = $1', [id2]);
    await ciclo.declararMapeo(tx, companyId, actor, id2, [
      {
        id: rows[0].id,
        entidad: 'PARTY',
        mapeo: { 'Razón Social': 'razonSocial', CUIT: 'cuit', Email: 'email' },
        incluida: true,
      },
    ]);
    await ciclo.validarMigracion(tx, companyId, actor, id2);
    return id2;
  });

  t = process.hrtime.bigint();
  const r2 = await ciclo.importar(companyId, actor, segunda);
  marcas.reimportar = ms(t);
  marcas.conteos2 = r2.conteos;

  return marcas;
}

function imprimir(r) {
  const linea = (etapa, milis) =>
    `  ${etapa.padEnd(24)} ${milis.toFixed(0).padStart(8)} ms   ${String(
      porSegundo(r.filas, milis),
    ).padStart(7)} filas/s`;

  console.log(`\n═══ ${r.filas.toLocaleString('es-AR')} filas · ${mb(r.bytes)} MB ═══`);
  console.log(`  empresa ${r.empresa}`);
  console.log(linea('leer y guardar crudo', r.cargar));
  console.log(linea('validar', r.validar));
  console.log(linea('importar (primera vez)', r.importar));
  console.log(linea('importar (repetida)', r.reimportar));
  console.log(`  tandas                   ${String(r.tandas).padStart(8)}`);
  console.log('  primera:  ' + JSON.stringify(r.conteos));
  console.log('  repetida: ' + JSON.stringify(r.conteos2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
