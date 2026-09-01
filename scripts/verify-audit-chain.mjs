#!/usr/bin/env node
/**
 * Recorre la bitácora encadenada y comprueba que nadie la tocó.
 *
 *   npm run audit:cadena                              — modo CONDUCTUAL (el de `verify`)
 *   node scripts/verify-audit-chain.mjs --observacional        — sobre DATABASE_URL, tal cual está
 *   node scripts/verify-audit-chain.mjs --observacional <cuit> — una sola empresa
 *
 * ## El agujero que cierra
 *
 * `verify_audit_chain()` existe desde la migración 0008 y se corrigió en la
 * 0025. Estaba bien escrita, encadenada por `seq` y con la misma fórmula que el
 * trigger. Y sin embargo tenía **la forma exacta del defecto que este proyecto
 * persigue**: estructura correcta, regla escrita, y nadie recorriendo el camino
 * entre las dos.
 *
 * Concretamente, antes de este script:
 *
 * - No había ningún comando que la corriera. El único llamador en todo el
 *   repositorio era un test de integración, sobre una empresa de fixture.
 * - Ese test comprobaba que **no** reporta roturas en una cadena sana. Es decir:
 *   la única rama ejercitada era la verde. Nadie había visto nunca a la función
 *   detectar algo.
 *
 * Un detector de adulteraciones que jamás detectó una adulteración no está
 * probado: está declarado. Y es peor que no tenerlo, porque tranquiliza.
 *
 * ## Por eso el modo conductual rompe una cadena a propósito
 *
 * En la base de verificación —descartable, terminada en `_verify`— se adultera
 * una entrada y se comprueba que la función la señala. Recién después se
 * verifica el resto. Si la trampa **no** se detecta, el script falla: no importa
 * que las demás cadenas den verde, porque un verificador ciego las daría verdes
 * igual.
 *
 * Para poder adulterar hay que apagar el trigger `forbid_update`, que es
 * justamente el que impide hacerlo. Eso no debilita nada: simula al atacante que
 * la cadena existe para atrapar —alguien con acceso directo a la base, que sí
 * puede apagar un trigger— y ocurre en una base que se destruye al terminar.
 *
 * ## Qué NO prueba
 *
 * Que la bitácora sea completa. La cadena demuestra que lo escrito no se
 * modificó; no dice que se haya escrito todo lo que pasó. Eso lo defienden las
 * rutas, cada una con su `recordAudit`, y los tests que las ejercitan.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(HERE, '..', '.env'))) {
  process.loadEnvFile(join(HERE, '..', '.env'));
}

const VERIFICADO = 'VERIFICADO';
const ROTA = 'ROTA';
const NO_EJERCITADO = 'NO_EJERCITADO';
const SIMBOLO = { [VERIFICADO]: '✔', [ROTA]: '✘', [NO_EJERCITADO]: '✘' };

const observacional = process.argv.includes('--observacional');
const conductual = !observacional;
const cuitPedido = process.argv.slice(2).find((a) => /^\d{11}$/.test(a)) ?? null;

let url = process.env.DATABASE_URL ?? '';
if (url === '' && observacional) {
  console.log('audit:cadena — sin DATABASE_URL. Nada que verificar.');
  process.exit(0);
}

if (conductual) {
  const { prepararBaseDeVerificacion } = await import('./verification-db.mjs');
  const { sembrarFixtures } = await import('./fixtures-invariantes.mjs');
  console.log('Modo CONDUCTUAL — base de verificación aislada y fixtures propios.\n');
  url = await prepararBaseDeVerificacion({ silencioso: true });
  await sembrarFixtures(url, { silencioso: true });
  console.log('  ✔ fixtures conductuales sembrados\n');
} else {
  console.log(`Modo OBSERVACIONAL — se mira ${new URL(url).pathname.slice(1)} tal como está.\n`);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  // ── El control del control ─────────────────────────────────────────────────
  //
  // Va primero a propósito. Si el detector está ciego, cualquier verde que
  // venga después no significa nada, y conviene enterarse antes de leerlos.

  if (conductual) {
    const detecta = await probarQueDetecta(client);
    if (detecta === null) {
      console.error('audit:cadena — NO EJERCITADO: el fixture no dejó ni una entrada de bitácora.');
      console.error('');
      console.error('  No es "la cadena está sana": es "no se pudo probar el detector". El fixture');
      console.error('  prometió actividad auditada y no la produjo, así que el roto es el fixture.');
      process.exit(1);
    }
    if (detecta === false) {
      console.error('audit:cadena — EL VERIFICADOR NO DETECTA.');
      console.error('');
      console.error('  Se adulteró una entrada a propósito y `verify_audit_chain()` no la señaló.');
      console.error('  Mientras esto pase, ningún resultado verde de este script vale: la cadena');
      console.error('  encadenada deja de ser una defensa y pasa a ser una decoración.');
      process.exit(1);
    }
    console.log('  ✔ el verificador detecta una entrada adulterada\n');
  }

  // ── Las cadenas de verdad ──────────────────────────────────────────────────

  const empresas = await client.query(
    cuitPedido === null
      ? 'SELECT id, cuit, legal_name FROM companies ORDER BY legal_name'
      : 'SELECT id, cuit, legal_name FROM companies WHERE cuit = $1',
    cuitPedido === null ? [] : [cuitPedido],
  );

  const resultados = [];
  for (const empresa of empresas.rows) {
    // El universo primero. Sin cuántas entradas hay, "cadena sana" y "cadena
    // vacía" se ven exactamente igual, que es el falso verde que este proyecto
    // ya se comió tres veces.
    const total = await client.query(
      'SELECT count(*)::int AS n FROM audit_logs WHERE company_id = $1',
      [empresa.id],
    );
    const entradas = total.rows[0].n;

    const rotura = await client.query('SELECT * FROM verify_audit_chain($1)', [empresa.id]);

    // Una rotura manda aunque el universo diera cero: si las dos consultas se
    // contradicen, el problema es el control y taparlo sería esconder el único
    // caso que hay que mirar.
    const estado =
      rotura.rowCount > 0 ? ROTA : entradas > 0 ? VERIFICADO : NO_EJERCITADO;

    resultados.push({ empresa, entradas, rotura: rotura.rows[0] ?? null, estado });
  }

  for (const r of resultados) {
    const nombre = `${r.empresa.legal_name} (${r.empresa.cuit})`;
    if (r.estado === ROTA) {
      console.error(`  ${SIMBOLO[ROTA]} ${nombre} — CADENA ADULTERADA en ${r.rotura.roto_en}`);
      console.error(`      hash esperado ${r.rotura.hash_esperado}`);
      console.error(`      hash guardado ${r.rotura.hash_guardado}`);
    } else if (r.estado === VERIFICADO) {
      console.log(`  ${SIMBOLO[VERIFICADO]} ${nombre} — ${r.entradas} entrada(s), cadena íntegra`);
    } else {
      console.log(`  ${SIMBOLO[NO_EJERCITADO]} ${nombre} — sin entradas: nada que verificar`);
    }
  }

  const rotas = resultados.filter((r) => r.estado === ROTA);
  const verificadas = resultados.filter((r) => r.estado === VERIFICADO);

  if (rotas.length > 0) {
    console.error('');
    console.error('La bitácora fue modificada por fuera de la aplicación. `audit_logs` es');
    console.error('append-only por trigger, así que llegar a este estado exige acceso directo a la');
    console.error('base: tratalo como un incidente de seguridad y no como un error de datos.');
    process.exit(1);
  }

  if (verificadas.length === 0) {
    const mensaje =
      empresas.rows.length === 0
        ? 'no hay ni una empresa'
        : `${empresas.rows.length} empresa(s), ninguna con entradas de bitácora`;

    if (conductual) {
      console.error('');
      console.error(`audit:cadena — NO EJERCITADO: ${mensaje}.`);
      process.exit(1);
    }
    console.log('');
    console.log(`audit:cadena — NO EJERCITADO: ${mensaje}. No se afirma que la bitácora esté íntegra.`);
    process.exit(0);
  }

  console.log('');
  console.log(
    `audit:cadena — ${verificadas.length} cadena(s) verificada(s) con entradas reales, sin adulteraciones.`,
  );
} finally {
  await client.end();
}

/**
 * Adultera una entrada y comprueba que el verificador la señale.
 *
 * Devuelve `true` si la detectó, `false` si no, y `null` si no había ninguna
 * entrada con la que probar — que no es lo mismo y no puede informarse igual.
 *
 * Todo ocurre dentro de una transacción que **siempre** se revierte: la base es
 * descartable, pero dejarla adulterada haría fallar a los verificadores que
 * corren después por un motivo que no es el suyo.
 */
async function probarQueDetecta(cliente) {
  const candidata = await cliente.query(
    `SELECT id, company_id FROM audit_logs ORDER BY company_id, seq DESC LIMIT 1`,
  );
  if (candidata.rowCount === 0) return null;

  const { id, company_id: empresa } = candidata.rows[0];

  await cliente.query('BEGIN');
  try {
    // El trigger que impide el UPDATE es justamente el que hace falta apagar
    // para simular al atacante contra el que la cadena defiende: alguien con
    // acceso directo a la base, que puede apagarlo.
    await cliente.query('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    await cliente.query(`UPDATE audit_logs SET motivo = 'adulterado' WHERE id = $1`, [id]);

    const rotura = await cliente.query('SELECT * FROM verify_audit_chain($1)', [empresa]);
    return rotura.rowCount > 0;
  } finally {
    // El ROLLBACK deshace también el DISABLE TRIGGER: es DDL transaccional en
    // PostgreSQL, así que la tabla queda con sus candados puestos.
    await cliente.query('ROLLBACK');
  }
}
