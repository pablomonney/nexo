#!/usr/bin/env node
/**
 * Cobro manual por transferencia bancaria: ver qué se debe, conciliar lo que entró, registrar el cobro y dar el comprobante.
 *
 *   node scripts/cobro-manual.mjs pendientes
 *   node scripts/cobro-manual.mjs conciliar --extracto movimientos.csv
 *   node scripts/cobro-manual.mjs registrar  --documento <n.° o id> --importe 3000.00 --fecha 2026-11-03 --referencia <n.° de operación>
 *   node scripts/cobro-manual.mjs registrar  …los mismos…  --confirmar
 *   node scripts/cobro-manual.mjs comprobante --documento <n.° o id> [--salida comprobante.txt]
 *
 * ## Por qué es un script del operador y no una pantalla
 *
 * Igual que `facturacion-ciclo.mjs`: marcar un cargo como pagado levanta una suspensión y una mora, y el administrador de una
 * empresa cliente no puede poder hacerlo sobre su propio cargo. `aai_app` tiene sólo `SELECT` sobre las tablas de facturación.
 * Este script conecta como operador de la instalación. Usa `registrarCobro`, el MISMO camino que va a usar el webhook de una
 * pasarela el día que haya una: no hay un segundo camino hacia «PAGADO».
 *
 * ## Qué garantiza
 *
 *   · `pendientes`, `conciliar` y `comprobante` NO escriben. `registrar` sólo escribe con `--confirmar`; sin él muestra qué haría.
 *   · El importe lo confirma quien registra y tiene que ser **exactamente** el del documento. Un pago distinto (parcial, de más)
 *     no se registra: no hay en el sistema un estado «cobrado en parte» y inventarlo sería una decisión de producto.
 *   · La referencia bancaria es obligatoria. Registrar el mismo documento con la misma referencia dos veces es el mismo cobro
 *     (no se duplica); con otra referencia sobre un documento ya pagado, se rechaza.
 *   · `conciliar` sólo PROPONE. Que un movimiento «coincida» no lo registra.
 *
 * ## En el servidor
 *
 * `bash scripts/cobro-manual.sh <subcomando> …` corre esto dentro de la imagen de NEXO, con el mismo patrón que las tareas
 * diarias. (Requiere que la imagen desplegada ya traiga este script.)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { opcionesDeConexion } from './lib/zona.mjs';
import { aCentavos, armarComprobante, claveDeCobro, conciliar, deCentavos, parsearExtracto } from './lib/cobro-manual.mjs';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI y en la imagen las variables vienen del entorno */
}

const [, , subcomando, ...resto] = process.argv;

function opcion(nombre) {
  const i = resto.indexOf(`--${nombre}`);
  return i >= 0 ? resto[i + 1] : undefined;
}
const bandera = (nombre) => resto.includes(`--${nombre}`);

function uso(codigo) {
  console.error(
    'uso: node scripts/cobro-manual.mjs pendientes\n' +
      '     node scripts/cobro-manual.mjs conciliar --extracto <archivo.csv>\n' +
      '     node scripts/cobro-manual.mjs registrar --documento <n.° o id> --importe <monto> --fecha <AAAA-MM-DD> --referencia <texto> [--confirmar]\n' +
      '     node scripts/cobro-manual.mjs comprobante --documento <n.° o id> [--salida <archivo>]',
  );
  process.exit(codigo);
}

if (!['pendientes', 'conciliar', 'registrar', 'comprobante'].includes(subcomando ?? '')) uso(subcomando === undefined || subcomando === '--help' ? 0 : 2);
if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL.');
  process.exit(2);
}

const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL, ...opcionesDeConexion() });
await cliente.connect();
const destino = new URL(process.env.DATABASE_URL);
console.log(`base: ${destino.pathname.slice(1)} en ${destino.hostname}\n`);

/** Documento por número (entero) o por id (uuid). */
async function buscarDocumento(ref) {
  if (ref === undefined) {
    console.error('Falta --documento.');
    process.exit(2);
  }
  const porNumero = /^\d+$/u.test(ref);
  const r = await cliente.query(
    `SELECT d.id, d.numero::text AS numero, d.estado, d.moneda, d.importe_total::text AS importe,
            d.emitido_el::text AS emitido_el, d.vence_el::text AS vence_el, d.pagado_el::text AS pagado_el,
            d.es_comprobante_fiscal, d.cae, d.subscription_id,
            c.legal_name AS empresa, c.cuit,
            s.periodicidad
       FROM billing_documents d
       JOIN companies c ON c.id = d.company_id
       LEFT JOIN company_subscriptions s ON s.id = d.subscription_id
      WHERE ${porNumero ? 'd.numero = $1::bigint' : 'd.id = $1::uuid'}`,
    [ref],
  );
  if (r.rowCount === 0) {
    console.error(`No existe el documento ${ref}.`);
    process.exit(3);
  }
  return r.rows[0];
}

async function hoyEnLaBase() {
  return (await cliente.query('SELECT CURRENT_DATE::text AS hoy')).rows[0].hoy;
}

try {
  if (subcomando === 'pendientes') {
    const r = await cliente.query(
      `SELECT d.numero::text AS numero, c.legal_name AS empresa, c.cuit, d.moneda, d.importe_total::text AS importe,
              d.emitido_el::text AS emitido, d.vence_el::text AS vence, d.estado,
              CASE WHEN d.vence_el IS NULL THEN NULL ELSE (CURRENT_DATE - d.vence_el) END AS mora
         FROM billing_documents d JOIN companies c ON c.id = d.company_id
        WHERE d.tipo = 'CARGO' AND d.estado IN ('EMITIDO', 'INCOBRABLE')
        ORDER BY d.vence_el NULLS LAST, d.numero`,
    );
    console.log(`Documentos emitidos y no cobrados: ${r.rowCount}\n`);
    for (const d of r.rows) {
      const mora = d.mora === null ? 'sin vencimiento' : d.mora > 0 ? `vencido hace ${d.mora} d` : 'al día';
      console.log(`  N.° ${d.numero}  ${d.empresa} (CUIT ${d.cuit})  ${d.moneda} ${d.importe}  emitido ${d.emitido}  vence ${d.vence ?? '—'}  ${mora}  [${d.estado}]`);
    }
    if (r.rowCount === 0) console.log('  (nada pendiente)');
  }

  if (subcomando === 'conciliar') {
    const archivo = opcion('extracto');
    if (archivo === undefined) {
      console.error('Falta --extracto <archivo.csv>.');
      process.exit(2);
    }
    const { movimientos, descartadas } = parsearExtracto(readFileSync(archivo, 'utf8'));
    const docs = (
      await cliente.query(
        `SELECT d.id, d.numero::text AS numero, c.legal_name AS empresa, c.cuit, d.moneda, d.importe_total::text AS importe
           FROM billing_documents d JOIN companies c ON c.id = d.company_id
          WHERE d.tipo = 'CARGO' AND d.estado IN ('EMITIDO', 'INCOBRABLE')`,
      )
    ).rows.map((d) => ({ ...d, centavos: aCentavos(d.importe) }));
    const registradas = (
      await cliente.query("SELECT referencia_externa FROM payment_intents WHERE proveedor = 'TRANSFERENCIA' AND referencia_externa IS NOT NULL")
    ).rows.map((r) => r.referencia_externa);

    const informe = conciliar(movimientos, docs, registradas);
    console.log(`Créditos en el extracto: ${movimientos.length}   ilegibles: ${descartadas.length}   documentos abiertos: ${docs.length}\n`);
    for (const x of informe) {
      const m = x.movimiento;
      const base = `  línea ${m.linea}  ${m.fecha}  ${deCentavos(m.centavos)}  «${m.descripcion}»  ref ${m.referencia ?? '—'}`;
      if (x.estado === 'UNICA') {
        const d = x.candidatos[0];
        console.log(`${base}\n    → UNICA: documento N.° ${d.numero} (${d.empresa})${x.porTexto ? ' — elegido por el CUIT o el nombre del texto' : ''}`);
        console.log(`      registrar:  node scripts/cobro-manual.mjs registrar --documento ${d.numero} --importe ${deCentavos(m.centavos)} --fecha ${m.fecha} --referencia "${m.referencia ?? '<n.° de operación>'}" --confirmar`);
      } else if (x.estado === 'AMBIGUA') {
        console.log(`${base}\n    → AMBIGUA: ${x.candidatos.map((d) => `N.° ${d.numero} (${d.empresa})`).join(', ')}. No se elige: confirmá con el cliente de quién es la transferencia.`);
      } else if (x.estado === 'YA_REGISTRADO') {
        console.log(`${base}\n    → YA REGISTRADO (esa referencia ya tiene su cobro)`);
      } else {
        console.log(`${base}\n    → SIN DOCUMENTO por ese importe (¿pago parcial, de más, de un cliente sin cargo emitido?). No se registra nada.`);
      }
    }
    for (const d of descartadas) console.log(`  línea ${d.linea}: ${d.motivo} — ${d.texto}`);
    console.log('\nEsto sólo PROPONE. No se escribió nada.');
  }

  if (subcomando === 'registrar') {
    const doc = await buscarDocumento(opcion('documento'));
    const importe = aCentavos(opcion('importe'));
    const fecha = opcion('fecha');
    const referencia = (opcion('referencia') ?? '').trim();
    const falta = [];
    if (importe === null) falta.push('--importe (monto con hasta dos decimales)');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(fecha ?? '')) falta.push('--fecha (AAAA-MM-DD)');
    if (referencia.length < 6) falta.push('--referencia (el n.° de operación bancaria, al menos 6 caracteres: es lo que permite conciliar y que un reintento no cobre dos veces)');
    if (falta.length > 0) {
      console.error(`Falta o está mal: ${falta.join('; ')}.`);
      process.exit(2);
    }
    const esperado = aCentavos(doc.importe);
    console.log(`Documento N.° ${doc.numero} — ${doc.empresa} (CUIT ${doc.cuit}) — ${doc.moneda} ${doc.importe} — ${doc.estado}`);
    console.log(`Cobro a registrar: ${doc.moneda} ${deCentavos(importe)} el ${fecha}, referencia «${referencia}»\n`);

    if (importe !== esperado) {
      console.error(`NO SE REGISTRA: el importe (${deCentavos(importe)}) no es el del documento (${doc.importe}). ` +
        'Un pago parcial o de más no tiene estado en el sistema: hay que decidir cómo se trata antes de registrarlo.');
      process.exit(3);
    }
    const hoy = await hoyEnLaBase();
    if (fecha > hoy) {
      console.error(`NO SE REGISTRA: la fecha ${fecha} es posterior a hoy (${hoy}).`);
      process.exit(3);
    }
    if (doc.emitido_el !== null && fecha < doc.emitido_el) {
      console.error(`NO SE REGISTRA: la fecha ${fecha} es anterior a la emisión del documento (${doc.emitido_el}).`);
      process.exit(3);
    }

    if (!bandera('confirmar')) {
      console.log('SIMULACRO: no se escribió nada. Para registrarlo, repetir el mismo comando con --confirmar.');
    } else {
      const { registrarCobro } = await import(new URL('../apps/api/dist/billing/ciclo.js', import.meta.url).href);
      const tx = { query: (text, values) => cliente.query(text, values) };
      const actor = `operador:${process.env.USERNAME ?? process.env.USER ?? 'desconocido'}`;
      await cliente.query('BEGIN');
      try {
        const r = await registrarCobro(tx, {
          documentId: doc.id,
          proveedor: 'TRANSFERENCIA',
          idempotencia: claveDeCobro(doc.id, referencia),
          referenciaExterna: referencia,
          actorId: actor,
          pagadoEl: fecha,
        });
        if (r.estado === 'REGISTRADO' || r.estado === 'YA_REGISTRADO') {
          await cliente.query('COMMIT');
          console.log(r.estado === 'YA_REGISTRADO'
            ? 'YA ESTABA REGISTRADO con esa referencia: no se duplicó.'
            : `REGISTRADO.${r.reactivada ? ' Se levantó la suspensión o la mora de la empresa.' : ''}`);
          console.log(`Siguiente paso: node scripts/cobro-manual.mjs comprobante --documento ${doc.numero}`);
        } else {
          await cliente.query('ROLLBACK');
          console.error(`NO SE REGISTRÓ: ${r.detalle}`);
          process.exitCode = 3;
        }
      } catch (error) {
        await cliente.query('ROLLBACK').catch(() => undefined);
        if (error.code === '23505' && String(error.constraint ?? error.message).includes('referencia_por_proveedor')) {
          console.error(`NO SE REGISTRÓ: la referencia «${referencia}» ya está en OTRO cobro. Una transferencia paga un solo documento: revisá el número de operación.`);
          process.exitCode = 3;
        } else {
          throw error;
        }
      }
    }
  }

  if (subcomando === 'comprobante') {
    const doc = await buscarDocumento(opcion('documento'));
    if (doc.estado !== 'PAGADO') {
      console.error(`El documento N.° ${doc.numero} está ${doc.estado}: sólo se da comprobante de un pago ya registrado.`);
      process.exit(3);
    }
    const pago = (
      await cliente.query(
        "SELECT referencia_externa FROM payment_intents WHERE document_id = $1 AND estado = 'PAGADO' ORDER BY created_at DESC LIMIT 1",
        [doc.id],
      )
    ).rows[0];
    const texto = armarComprobante({
      numero: doc.numero,
      empresa: doc.empresa,
      cuit: doc.cuit,
      concepto: `Suscripción a NEXO${doc.periodicidad ? ` (${String(doc.periodicidad).toLowerCase()})` : ''}`,
      moneda: doc.moneda,
      importe: doc.importe,
      pagadoEl: doc.pagado_el,
      referencia: pago?.referencia_externa ?? null,
      estado: doc.estado,
      esFiscal: doc.es_comprobante_fiscal,
      cae: doc.cae,
      emitidoEl: await hoyEnLaBase(),
    });
    const salida = opcion('salida');
    if (salida !== undefined) {
      writeFileSync(resolve(salida), texto, 'utf8');
      console.log(`Comprobante escrito en ${resolve(salida)}`);
    } else {
      console.log(texto);
    }
  }
} catch (error) {
  console.error(`Falló: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cliente.end();
}
