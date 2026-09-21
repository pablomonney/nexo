#!/usr/bin/env node
/**
 * Una factura de prueba, de punta a punta y legible.
 *
 *   npm run factura:demo
 *
 * Crea una empresa nueva, le materializa el plan NEXO PYME, la configura,
 * factura un producto, muestra el asiento que NEXO propone, lo registra y lo
 * aprueba. Después imprime el Mayor.
 *
 * ## Para qué sirve, si ya hay tests
 *
 * `tests/integration/empresa-nueva.test.ts` recorre lo mismo y lo comprueba.
 * Este script recorre lo mismo y **lo muestra**: un asiento que pasa los tests
 * pero que nadie leyó nunca es un asiento en el que no conviene confiar. Acá se
 * ve lo que vería un contador.
 *
 * ## Escribe de verdad
 *
 * No hay mocks. Cada paso pasa por la ruta HTTP real contra la base que diga
 * `DATABASE_URL`, y las filas quedan. En este esquema nada se borra —hay
 * disparadores `forbid_delete`— así que la empresa que crea queda.
 *
 * Por eso se niega a correr contra producción: pide `--si` para escribir, y
 * rechaza cualquier base cuyo nombre no termine en algo de desarrollo.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI y en contenedores las variables vienen del entorno */
}

const { buildServer } = await import('@aai/api/server');
const { initPool, closePool } = await import('@aai/db');
const { ROLES, cuitCheckDigit, totp, withCheckDigit } = await import('@aai/shared');
const pg = (await import('pg')).default;
const { hash: argonHash } = await import('@node-rs/argon2');

// ── Guardas ────────────────────────────────────────────────────────────────
const URL_BASE = process.env.DATABASE_URL ?? '';
if (URL_BASE === '') {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}
const NOMBRE_BASE = (URL_BASE.split('/').pop() ?? '').split('?')[0];

// Lista blanca, no lista negra: una base que no reconozco no es una base en la
// que este script pueda escribir. Al revés —prohibir «nexo» y permitir el
// resto— el día que producción se llame de otra forma, escribe ahí.
const BASES_PERMITIDAS = new Set(['aai', 'aai_test', 'aai_demo', 'aai_limpia']);
if (!BASES_PERMITIDAS.has(NOMBRE_BASE)) {
  console.error(`Este script no escribe en «${NOMBRE_BASE}».`);
  console.error(`Solo en: ${[...BASES_PERMITIDAS].join(', ')}.`);
  console.error('Es una factura de prueba: no va en la contabilidad de nadie.');
  process.exit(2);
}
if (!process.argv.includes('--si')) {
  console.error(`Va a escribir una empresa y un asiento en «${NOMBRE_BASE}», y acá nada se borra.`);
  console.error('Si es lo que querés:  npm run factura:demo -- --si');
  process.exit(2);
}

// ── Importes ───────────────────────────────────────────────────────────────
const CANTIDAD = 12;
const PRECIO = 8500; // por unidad
const NETO = CANTIDAD * PRECIO; // 102.000
const IVA = Math.round(NETO * 0.21); // 21.420
const TOTAL = NETO + IVA; // 123.420

const FACTURA_A = 1;
const PASSWORD = 'una-contrasena-suficientemente-larga';
const pesos = (n) =>
  Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dec = (n) => n.toFixed(2);

// ── Arranque ───────────────────────────────────────────────────────────────
initPool(URL_BASE);
const app = await buildServer();
await app.ready();
const db = new pg.Client({ connectionString: URL_BASE });
await db.connect();

const stamp = String(
  (await db.query("SELECT nextval('fixture_ids')::text AS v")).rows[0].v,
).slice(-8);

/**
 * El día de hoy, según la base.
 *
 * No `new Date().toISOString().slice(0,10)`. Esa es una fecha de calendario
 * calculada en UTC, y el sistema la compara contra el período abierto: en
 * Argentina, después de las nueve de la noche, «hoy» en UTC ya es mañana y el
 * comprobante cae en un día que el período todavía no cubre. El ejercicio sale
 * del mismo lugar para que los dos no puedan discrepar.
 *
 * Es el control S-37, que existe porque esto ya pasó con la siembra de precios.
 */
const hoy = (await db.query('SELECT CURRENT_DATE::text AS hoy')).rows[0].hoy;
const anio = Number(hoy.slice(0, 4));

let token = '';
let empresa = '';
const pedir = (method, url, payload) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    ...(payload === undefined ? {} : { payload }),
  });

const exigir = (r, esperado, que) => {
  if (r.statusCode !== esperado) {
    console.error(`\n✖ ${que}: HTTP ${r.statusCode}`);
    console.error(r.body);
    process.exit(1);
  }
  return r;
};

const paso = (n, texto) => console.log(`\n\x1b[1m${n}\x1b[0m  ${texto}`);
const dato = (k, v) => console.log(`     ${String(k).padEnd(22)} ${v}`);

console.log(`\n\x1b[1mFactura de prueba — base «${NOMBRE_BASE}»\x1b[0m`);

// ── 1 · Estudio, empresa y usuario ─────────────────────────────────────────
paso('1', 'Estudio, empresa y contadora');

const fundadorId = (
  await db.query(
    'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
    [
      `fundador-demo-${stamp}@estudio.test`,
      'Fundador',
      await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
    ],
  )
).rows[0].id;

const organizationId = (
  await db.query('SELECT create_organization($1,$2,$3)', [
    `Estudio demo ${stamp}`,
    withCheckDigit(`30${stamp}`),
    fundadorId,
  ])
).rows[0].create_organization;

const RAZON = `Ferretería del Norte S.A. ${stamp}`;
const CUIT_EMPRESA = withCheckDigit(`27${stamp}`);
empresa = (
  await db.query('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
    fundadorId, organizationId, RAZON, CUIT_EMPRESA, 'SA', 'AR-C', 'IGJ', '12-31',
  ])
).rows[0].create_company;
dato('empresa', RAZON);
dato('CUIT', CUIT_EMPRESA);

const tokenFundador = (
  await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: `fundador-demo-${stamp}@estudio.test`, password: PASSWORD },
  })
).json().token;

const email = `contadora-demo-${stamp}@estudio.test`;
const userId = (
  await app.inject({
    method: 'POST',
    url: `/organizations/${organizationId}/users`,
    headers: { authorization: `Bearer ${tokenFundador}` },
    payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
  })
).json().id;

for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
  await app.inject({
    method: 'POST',
    url: `/companies/${empresa}/roles`,
    headers: { authorization: `Bearer ${tokenFundador}` },
    payload: { userId, role },
  });
}

const inicial = (
  await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
).json().token;
const secret = (
  await app.inject({
    method: 'POST',
    url: '/auth/mfa/setup',
    headers: { authorization: `Bearer ${inicial}` },
  })
).json().secret;
await app.inject({
  method: 'POST',
  url: '/auth/mfa/confirm',
  payload: { code: totp(secret, Date.now()) },
  headers: { authorization: `Bearer ${inicial}` },
});
token = (
  await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
).json().token;
await app.inject({
  method: 'POST',
  url: '/auth/mfa/verify',
  payload: { code: totp(secret, Date.now()) },
  headers: { authorization: `Bearer ${token}` },
});
dato('usuario', `${email} (con MFA)`);

// ── 2 · Plan de cuentas ────────────────────────────────────────────────────
paso('2', 'Plan de cuentas');
const plan = exigir(await pedir('POST', '/chart-template'), 201, 'materializar el plan').json();
dato('plantilla', `${plan.plantilla} v${plan.version}`);
dato('cuentas', plan.cuentas);

// ── 3 · Configuración ──────────────────────────────────────────────────────
paso('3', 'Configuración contable');
const mapeo = exigir(
  await pedir('PUT', '/accounting-map', {
    asignaciones: Object.entries(ROLES).map(([rol, cuenta]) => ({ rol, cuenta })),
  }),
  200,
  'declarar el mapeo',
).json();
dato('roles declarados', `${mapeo.declarados} de 8`);


exigir(
  await pedir('POST', '/companies/current/reporting-framework', {
    framework: 'RT_FACPCE',
    validFrom: `${anio}-01-01`,
  }),
  200,
  'declarar el marco',
);
dato('marco contable', 'RT_FACPCE');

exigir(
  await pedir('POST', '/fiscal-years', {
    code: `EJ${anio}-${stamp}`,
    startDate: `${anio}-01-01`,
    endDate: `${anio}-12-31`,
  }),
  201,
  'abrir el ejercicio',
);
dato('ejercicio', `${anio}-01-01 a ${anio}-12-31`);

// ── 4 · Cliente y producto ─────────────────────────────────────────────────
paso('4', 'Cliente y producto');
const CUIT_CLIENTE = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
const CLIENTE = `Corralón San Martín S.R.L. ${stamp}`;
const clienteId = exigir(
  await pedir('POST', '/parties', {
    tipoDocumento: 'CUIT',
    numeroDocumento: CUIT_CLIENTE,
    razonSocial: CLIENTE,
    roles: ['CLIENTE'],
  }),
  201,
  'alta de cliente',
).json().id;
dato('cliente', `${CLIENTE} — CUIT ${CUIT_CLIENTE}`);

const PRODUCTO = 'Tornillo de acero 6x40';
const productoId = exigir(
  await pedir('POST', '/products', {
    codigo: `TORN-6X40-${stamp}`,
    nombre: PRODUCTO,
    impuesto: 'IVA',
    cuentaVenta: ROLES.VENTAS,
    cuentaCompra: ROLES.COMPRAS,
    llevaStock: true,
  }),
  201,
  'alta de producto',
).json().id;
dato('producto', `${PRODUCTO} → cuenta de venta ${ROLES.VENTAS}`);

// ── 5 · La factura ─────────────────────────────────────────────────────────
paso('5', 'Factura A');
// El módulo evita el 0. `cbte_numero >= 0` lo admitiría —la 0021 no exige más—
// pero una Factura A número 0 no existe, y en una demo se lee como un error.
const numero = (Number(stamp) % 99_999) + 1;


const forma =
  `--X\r\nContent-Disposition: form-data; name="file"; filename="factura-${stamp}.xml"\r\n` +
  `Content-Type: application/xml\r\n\r\n<comprobante><n>${numero}</n></comprobante>\r\n--X--\r\n`;
const documentId = exigir(
  await app.inject({
    method: 'POST',
    url: '/documents',
    headers: {
      authorization: `Bearer ${token}`,
      'x-company-id': empresa,
      'content-type': 'multipart/form-data; boundary=X',
    },
    payload: forma,
  }),
  201,
  'subir el comprobante',
).json().id;

const comprobanteId = exigir(
  await pedir('POST', `/documents/${documentId}/tax-transaction`, {
    direction: 'VENTAS',
    cbteTipo: FACTURA_A,
    puntoVenta: 1,
    numero,
    fecha: hoy,
    cuitContraparte: CUIT_CLIENTE,
    razonSocial: CLIENTE,
    condicionIva: 'RESPONSABLE_INSCRIPTO',
    neto: dec(NETO),
    iva: dec(IVA),
    noGravado: '0',
    exento: '0',
    percepciones: '0',
    total: dec(TOTAL),
  }),
  201,
  'crear la operación fiscal',
).json().taxTransactionId;

exigir(
  await pedir('POST', `/tax-transactions/${comprobanteId}/party`, { partyId: clienteId }),
  200,
  'vincular el cliente',
);

exigir(
  await pedir('PUT', `/tax-transactions/${comprobanteId}/lines`, {
    renglones: [
      {
        productoId,
        descripcion: PRODUCTO,
        cantidad: String(CANTIDAD),
        unidad: 'UNIDAD',
        precioUnitario: dec(PRECIO),
        tratamiento: 'GRAVADO',
        neto: dec(NETO),
        iva: dec(IVA),
      },
    ],
  }),
  200,
  'cargar el detalle',
);

// El ancho se calcula una vez y todas las filas lo respetan. Escribir el
// relleno a mano en cada `console.log` fue exactamente lo que descuadró la caja
// en la primera corrida: cada línea tenía su propia aritmética y ninguna
// coincidía con las demás.
const ANCHO = 66;
const marco = (izq, medio, der) => `     ${izq}${medio.repeat(ANCHO)}${der}`;
const fila = (texto) => `     │${texto.padEnd(ANCHO).slice(0, ANCHO)}│`;
/** Etiqueta a la izquierda, importe a la derecha, dentro del mismo ancho. */
const filaImporte = (etiqueta, importe) =>
  fila(`  ${etiqueta.padEnd(ANCHO - 6 - importe.length)}${importe}  `);

console.log('');
console.log(marco('┌', '─', '┐'));
console.log(fila(`  FACTURA A   0001-${String(numero).padStart(8, '0')}`));
console.log(marco('├', '─', '┤'));
console.log(fila(`  Emisor    ${RAZON}`));
console.log(fila(`            CUIT ${CUIT_EMPRESA}`));
console.log(fila(`  Cliente   ${CLIENTE}`));
console.log(fila(`            CUIT ${CUIT_CLIENTE} — Responsable Inscripto`));
console.log(fila(`  Fecha     ${hoy}`));
console.log(marco('├', '─', '┤'));
console.log(
  filaImporte(`${String(CANTIDAD).padStart(3)} u.  ${PRODUCTO}  × ${pesos(PRECIO)}`, pesos(NETO)),
);
console.log(marco('├', '─', '┤'));
console.log(filaImporte('Neto gravado', pesos(NETO)));
console.log(filaImporte('IVA 21%', pesos(IVA)));
console.log(filaImporte('TOTAL', pesos(TOTAL)));
console.log(marco('└', '─', '┘'));

// ── 6 · El asiento propuesto ───────────────────────────────────────────────
paso('6', 'Asiento propuesto — NEXO sugiere, no registra');
const propuesta = exigir(
  await pedir('GET', `/tax-transactions/${comprobanteId}/asiento-propuesto`),
  200,
  'pedir la propuesta',
).json();

if (propuesta.motivoSinRenglones !== null) {
  console.error(`\n✖ no se propuso nada: ${propuesta.motivoSinRenglones}`);
  process.exit(1);
}

console.log('');
console.log(`     ${propuesta.descripcion}`);
console.log('');
console.log(`     ${'Cuenta'.padEnd(12)} ${'Detalle'.padEnd(28)} ${'Debe'.padStart(12)} ${'Haber'.padStart(12)}`);
console.log(`     ${'─'.repeat(12)} ${'─'.repeat(28)} ${'─'.repeat(12)} ${'─'.repeat(12)}`);
let debe = 0;
let haber = 0;
for (const r of propuesta.renglones) {
  debe += Number(r.debit);
  haber += Number(r.credit);
  const nombre = (
    await db.query('SELECT name FROM accounts WHERE company_id = $1 AND code = $2', [
      empresa,
      r.accountCode,
    ])
  ).rows[0].name;
  console.log(
    `     ${r.accountCode.padEnd(12)} ${nombre.slice(0, 28).padEnd(28)} ` +
      `${(Number(r.debit) === 0 ? '' : pesos(r.debit)).padStart(12)} ` +
      `${(Number(r.credit) === 0 ? '' : pesos(r.credit)).padStart(12)}`,
  );
}
console.log(`     ${' '.repeat(12)} ${' '.repeat(28)} ${'─'.repeat(12)} ${'─'.repeat(12)}`);
console.log(
  `     ${' '.repeat(12)} ${''.padEnd(28)} ${pesos(debe).padStart(12)} ${pesos(haber).padStart(12)}`,
);
console.log('');
dato('cuadra', debe === haber ? `sí (${pesos(debe)} = ${pesos(haber)})` : '✖ NO');
dato('vínculo fiscal', propuesta.renglones.filter((r) => r.taxTransactionId).length + ' renglón(es)');
dato('advertencias', propuesta.advertenciasDeConfiguracion.length === 0 ? 'ninguna' : propuesta.advertenciasDeConfiguracion.join(' · '));
console.log('');
console.log('     Esto todavía no es un asiento: no tiene número, no está en ningún');
console.log('     libro y no movió un solo saldo.');

// ── 7 · La decisión ────────────────────────────────────────────────────────
paso('7', 'Decisión — una persona lo carga');
const asiento = exigir(
  await pedir('POST', '/journal-entries', {
    journalCode: 'VENTAS',
    entryDate: propuesta.fecha,
    description: propuesta.descripcion,
    lines: propuesta.renglones.map((r) => ({
      accountCode: r.accountCode,
      debit: r.debit,
      credit: r.credit,
      ...(r.partyId === undefined ? {} : { partyId: r.partyId }),
      ...(r.taxTransactionId === undefined ? {} : { taxTransactionId: r.taxTransactionId }),
      description: r.descripcion,
    })),
    source: { type: 'INVOICE', id: comprobanteId },
    manualJustification: propuesta.justificacionSugerida ?? 'Revisado y aceptado por la contadora',
  }),
  201,
  'cargar el asiento',
).json();
dato('estado al cargarlo', asiento.status);
dato('número', asiento.entryNumber ?? '(se asigna al aprobar)');

// ── 8 · La aprobación ──────────────────────────────────────────────────────
paso('8', 'Aprobación — otra persona lo firma');
const aprobado = exigir(
  await pedir('POST', `/journal-entries/${asiento.id}/approve`),
  200,
  'aprobar el asiento',
).json();
dato('estado', aprobado.status);
dato('número de asiento', aprobado.entryNumber);

// ── 9 · El Mayor ───────────────────────────────────────────────────────────
paso('9', 'Mayor');
const mayor = exigir(
  await pedir('GET', `/books/mayor?desde=${anio}-01-01&hasta=${anio}-12-31`),
  200,
  'consultar el Mayor',
).json();

console.log('');
console.log(`     ${'Cuenta'.padEnd(12)} ${'Nombre'.padEnd(30)} ${'Saldo'.padStart(14)}`);
console.log(`     ${'─'.repeat(12)} ${'─'.repeat(30)} ${'─'.repeat(14)}`);
for (const c of mayor.cuentas) {
  console.log(
    `     ${c.codigo.padEnd(12)} ${c.nombre.slice(0, 30).padEnd(30)} ${pesos(c.saldoFinal).padStart(14)}`,
  );
}
console.log('');
dato('debe / haber', `${pesos(mayor.totales.debe)} / ${pesos(mayor.totales.haber)}`);
dato('el balance cuadra', mayor.balance.cuadra ? 'sí' : '✖ NO');

const balance = exigir(
  await pedir('GET', `/reports/trial-balance?desde=${anio}-01-01&hasta=${anio}-12-31`),
  200,
  'consultar el balance',
).json();
dato('sumas y saldos', balance.cuadra ? 'cuadra' : '✖ NO cuadra');

console.log('');
console.log(`\x1b[32mListo.\x1b[0m La empresa «${RAZON}» quedó en «${NOMBRE_BASE}» con su factura asentada.`);
console.log('');

await app.close();
await db.end();
await closePool();
