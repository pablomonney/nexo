#!/usr/bin/env node
/**
 * Siembra DATOS SINTÉTICOS en la base de PRUEBAS para poder mirar las pantallas de detalle de la consola.
 *
 *   node scripts/servir-contra-pruebas.mjs                      # terminal 1: la API aislada, puerto 3002
 *   node scripts/sembrar-datos-visuales.mjs <credenciales.json>  # terminal 2
 *
 * `credenciales.json` = `{ "email": "…", "password": "…", "mfa": "<secreto base32>" }` de un usuario DE PRUEBA que ya
 * tiene una empresa vacía (se lo crea con el alta autoservicio contra la API aislada). El archivo vive FUERA del repo.
 *
 * ## Qué garantiza
 *
 *   · Habla SOLO con `http://localhost:3002`, que es lo que levanta `servir-contra-pruebas` (base `*_test` local, pagos,
 *     correo e IA en «ninguno»). Cualquier otro destino se rechaza.
 *   · Todo entra POR LA API: nada de SQL directo, nada que se salte las reglas del dominio.
 *   · No usa datos reales: terceros, CUIT, importes y nombres son inventados. Los CUIT tienen dígito verificador
 *     válido (la API lo exige) pero NO corresponden a nadie.
 *   · No ejecuta nada externo: no hay IA, correo ni pagos; ARCA, si se consultara, estaría en homologación. Las
 *     «constataciones» que se cargan son declaraciones de prueba y lo dicen en su motivo.
 *
 * ## Cómo reconocer lo sembrado
 *
 *   · Terceros, productos, depósitos, vendedores, listas de precios, etapas del embudo, cajas: nombre o código con
 *     prefijo `VIS`.
 *   · Documentos: archivos `visual-<marca>-<n>.xml`.
 *   · Asientos: descripción que empieza con «VIS ».
 *   · Los ids quedan en `var/visual/datos-sembrados.json` (no se versiona).
 *
 * ## Cómo limpiarlo
 *
 * Los libros son append-only (asientos, movimientos, bitácora): no hay `DELETE` por diseño. La limpieza es rehacer la
 * base de pruebas: `DROP DATABASE aai_test; CREATE DATABASE aai_test;` y `npm run db:migrate` con `DATABASE_URL`
 * apuntando a ella. Nunca se limpia de a una fila.
 *
 * ## Qué se deja SIN hacer a propósito
 *
 * Cada pantalla de detalle tiene una acción (asignar un tercero, corregir una decisión, anular una imputación, renombrar
 * una etapa…). La siembra deja el estado de PARTIDA de cada una; la acción se ejecuta después DESDE LA CONSOLA, que es
 * lo que se quiere verificar.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const BASE = 'http://localhost:3002';

// ── Compuerta: solo la API aislada ─────────────────────────────────────────────────────────────────────
{
  const u = new URL(BASE);
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.port !== '3002') {
    console.error(`Me niego: ${BASE} no es la API aislada de pruebas (http://localhost:3002).`);
    process.exit(2);
  }
}

const archivoCredenciales = process.argv[2];
const solo = process.argv.find((a) => a.startsWith('--solo='))?.slice('--solo='.length);
/** ¿Corre esta sección? Sin --solo corren todas; con --solo=banco, solo esa (sirve para agregar datos sin duplicar el resto). */
const corre = (seccion) => solo === undefined || solo === seccion;
if (!archivoCredenciales) {
  console.error('Uso: node scripts/sembrar-datos-visuales.mjs <credenciales.json> [--solo=banco]');
  process.exit(2);
}
const cred = JSON.parse(readFileSync(archivoCredenciales, 'utf8'));

// ── TOTP (RFC 6238) para el segundo factor de la cuenta de PRUEBA ─────────────────────────────────────────────
function totp(secretoBase32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretoBase32.replace(/=+$/u, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const clave = Buffer.from(bits.match(/.{8}/gu).filter((b) => b.length === 8).map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', clave).update(contador).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// ── Cliente HTTP mínimo (cookie de sesión) ───────────────────────────────────────────────────────────────────
let cookie = '';
let empresa = '';
const fallos = [];

async function pedir(metodo, ruta, cuerpo, { forma = false, claveIdem = false } = {}) {
  const cab = { accept: 'application/json' };
  if (cookie) cab.cookie = cookie;
  if (empresa) cab['x-company-id'] = empresa;
  if (cuerpo !== undefined && !forma) cab['content-type'] = 'application/json';
  if (forma) cab['content-type'] = 'multipart/form-data; boundary=X';
  if (claveIdem) cab['idempotency-key'] = randomUUID();
  const r = await fetch(BASE + ruta, {
    method: metodo,
    headers: cab,
    body: cuerpo === undefined ? undefined : forma ? cuerpo : JSON.stringify(cuerpo),
  });
  const nuevas = r.headers.getSetCookie?.() ?? [];
  if (nuevas.length > 0) {
    const jar = new Map(cookie.split('; ').filter(Boolean).map((p) => [p.split('=')[0], p]));
    for (const c of nuevas) jar.set(c.split('=')[0], c.split(';')[0]);
    cookie = [...jar.values()].join('; ');
  }
  const texto = await r.text();
  let datos = null;
  try {
    datos = JSON.parse(texto);
  } catch {
    /* sin cuerpo */
  }
  return { status: r.status, ok: r.ok, datos, texto };
}

/** Pide y exige un estado; si no es el esperado lo anota y devuelve `null` para que el resto siga. */
async function paso(descripcion, metodo, ruta, cuerpo, esperado = [200, 201], opciones) {
  const r = await pedir(metodo, ruta, cuerpo, opciones);
  const bien = [].concat(esperado).includes(r.status);
  console.log(`${bien ? '  ok ' : '  ✘  '} ${r.status} ${descripcion}`);
  if (!bien) {
    fallos.push({ descripcion, status: r.status, cuerpo: r.texto.slice(0, 300) });
    console.log(`        ${r.texto.slice(0, 220)}`);
    return null;
  }
  return r.datos ?? {};
}

// ── Datos inventados ─────────────────────────────────────────────────────────────────────────────────────
function cuitInventado(prefijo, n) {
  const diez = `${prefijo}${String(n).padStart(8, '0')}`;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = [...diez].reduce((a, d, i) => a + Number(d) * pesos[i], 0);
  const r = 11 - (suma % 11);
  return diez + (r === 11 ? 0 : r === 10 ? 9 : r);
}

const marca = Date.now().toString(36).slice(-5).toUpperCase();
const base8 = Number(String(Date.now()).slice(-7)) * 10;
// «Hoy» es el día de Buenos Aires, no el de UTC: después de las 21:00 ART el reloj de UTC ya está en el día siguiente.
const ISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' });
const hoy = ISO.format(new Date());
const haceDias = (n) => {
  const [a, m, d] = hoy.split('-').map(Number);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.UTC(a, m - 1, d - n)));
};
const anio = hoy.slice(0, 4);
let numeroCbte = Number(String(Date.now()).slice(-6));

const sembrado = { marca, base: BASE, creado: new Date().toISOString(), hoy };

async function comprobante({ direccion, cuit, razon, neto, iva, fecha, cbteTipo = 1, constatar = false }) {
  numeroCbte += 1;
  const total = (Number(neto) + Number(iva)).toFixed(2);
  const forma =
    `--X\r\nContent-Disposition: form-data; name="file"; filename="visual-${marca}-${numeroCbte}.xml"\r\n` +
    `Content-Type: application/xml\r\n\r\n<comprobante><n>${numeroCbte}</n></comprobante>\r\n--X--\r\n`;
  const sub = await paso(`subir visual-${marca}-${numeroCbte}.xml`, 'POST', '/documents', forma, 201, { forma: true });
  if (!sub) return null;
  const op = await paso(`registrar comprobante ${direccion} tipo ${cbteTipo} Nº ${numeroCbte} (${razon}, total ${total})`, 'POST', `/documents/${sub.id}/tax-transaction`, {
    direction: direccion,
    cbteTipo,
    puntoVenta: 1,
    numero: numeroCbte,
    fecha,
    cuitContraparte: cuit,
    razonSocial: razon,
    condicionIva: 'RESPONSABLE_INSCRIPTO',
    neto, iva, noGravado: '0', exento: '0', percepciones: '0', total,
    ...(constatar
      ? { constatacionDeclarada: { resultado: 'OK', motivo: 'Dato sintético de prueba: NO se consultó a ARCA' } }
      : {}),
  }, 201);
  return op ? op.taxTransactionId : null;
}

async function main() {
  console.log(`Sembrando datos sintéticos «VIS» (marca ${marca}) en ${BASE}\n`);

  // ── 1 · Sesión y empresa ────────────────────────────────────────────────────────────────────────────────
  const login = await pedir('POST', '/auth/login', { email: cred.email, password: cred.password });
  if (login.status !== 200) throw new Error(`login ${login.status}: ${login.texto.slice(0, 200)}`);
  const v = await pedir('POST', '/auth/mfa/verify', { code: totp(cred.mfa) });
  console.log(`  ok  login ${login.status}, mfa ${v.status}`);

  const cartera = await pedir('GET', '/companies');
  const lista = cartera.datos?.companies ?? [];
  if (lista.length === 0) throw new Error(`el usuario no tiene empresas: ${cartera.texto.slice(0, 200)}`);
  empresa = lista[0].id;
  sembrado.empresa = { id: empresa, razonSocial: lista[0].legalName };
  console.log(`  ok  empresa «${lista[0].legalName}» (${empresa})`);

  // El rol de CONTADOR firma lo contable (asientos, decisiones, imputaciones). El alta autoservicio da ADMINISTRADOR.
  const yo = await pedir('GET', '/auth/me');
  const userId = yo.datos?.user?.userId ?? yo.datos?.user?.id;
  await paso('dar el rol CONTADOR al usuario de prueba', 'POST', `/companies/${empresa}/roles`, { userId, role: 'CONTADOR' }, [200, 201, 409]);
  // El rol nuevo se ve en una sesión nueva.
  await pedir('POST', '/auth/login', { email: cred.email, password: cred.password });
  await pedir('POST', '/auth/mfa/verify', { code: totp(cred.mfa) });

  if (solo !== undefined) {
    await bancos();
    return;
  }

  // ── 2 · Ejercicio y plan de cuentas ─────────────────────────────────────────────────────────────────────
  await paso('ejercicio fiscal', 'POST', '/fiscal-years', { code: `EJ${anio}-VIS`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31` }, [201, 409]);
  for (const c of [
    { code: '1.1.01', name: 'VIS Caja', type: 'ACTIVO' },
    { code: '1.1.02', name: 'VIS Deudores por ventas', type: 'ACTIVO', requiresThirdParty: true },
    { code: '1.1.03', name: 'VIS Banco', type: 'ACTIVO' },
    { code: '1.1.04', name: 'VIS Mercaderías', type: 'ACTIVO' },
    { code: '1.1.05', name: 'VIS IVA crédito fiscal', type: 'ACTIVO' },
    { code: '2.1.01', name: 'VIS Proveedores', type: 'PASIVO', requiresThirdParty: true },
    { code: '2.1.02', name: 'VIS IVA débito fiscal', type: 'PASIVO' },
    { code: '4.1.01', name: 'VIS Ventas', type: 'INGRESO' },
    { code: '5.1.01', name: 'VIS Compras', type: 'COSTO' },
    { code: '5.2.01', name: 'VIS Gastos generales', type: 'GASTO' },
  ]) {
    await paso(`cuenta ${c.code} ${c.name}`, 'POST', '/accounts', c, [201, 409]);
  }

  // ── 3 · Terceros ────────────────────────────────────────────────────────────────────────────────────────
  const tercero = async (razonSocial, prefijo, n, roles) => {
    const cuit = cuitInventado(prefijo, base8 + n);
    const r = await paso(`tercero ${razonSocial}`, 'POST', '/parties', {
      tipoDocumento: 'CUIT', numeroDocumento: cuit, razonSocial, roles, condicionIva: 'RESPONSABLE_INSCRIPTO',
    }, 201);
    return r ? { id: r.id, cuit } : null;
  };
  const cliente1 = await tercero(`VIS Cliente Norte SA ${marca}`, '30', 1, ['CLIENTE']);
  const cliente2 = await tercero(`VIS Cliente Sur SRL ${marca}`, '30', 2, ['CLIENTE']);
  const proveedor1 = await tercero(`VIS Proveedor de Insumos SA ${marca}`, '33', 3, ['PROVEEDOR']);
  Object.assign(sembrado, { cliente1, cliente2, proveedor1 });
  if (!cliente1 || !cliente2 || !proveedor1) throw new Error('sin terceros no se puede seguir');

  // ── 4 · Vendedor, depósitos, productos y stock ─────────────────────────────────────────────────────────
  const vendedor = await paso('vendedor VIS-V1', 'POST', '/salespeople', { codigo: `VIS-V1-${marca}`, nombre: `VIS Vendedora del Norte ${marca}` }, 201);
  sembrado.vendedor = vendedor?.id;
  const dep1 = await paso('depósito central', 'POST', '/warehouses', { codigo: `VIS-D1-${marca}`, nombre: `VIS Depósito central ${marca}` }, 201);
  const dep2 = await paso('depósito secundario', 'POST', '/warehouses', { codigo: `VIS-D2-${marca}`, nombre: `VIS Depósito secundario ${marca}` }, 201);
  const prod1 = await paso('producto con stock', 'POST', '/products', {
    codigo: `VIS-P1-${marca}`, nombre: `VIS Producto con stock ${marca}`, impuesto: 'IVA', cuentaVenta: '4.1.01', cuentaCompra: '5.1.01', llevaStock: true,
  }, 201);
  const serv1 = await paso('servicio', 'POST', '/products', {
    codigo: `VIS-S1-${marca}`, nombre: `VIS Servicio de consultoría ${marca}`, impuesto: 'IVA', cuentaVenta: '4.1.01',
  }, 201);
  Object.assign(sembrado, { deposito1: dep1?.id, deposito2: dep2?.id, producto1: prod1?.id, servicio1: serv1?.id });

  if (prod1 && dep1 && dep2) {
    await paso('existencia inicial 100 u. a $500 (ajuste positivo, con costo)', 'POST', '/stock-movements/ajuste', {
      productoId: prod1.id, depositoId: dep1.id, cantidad: '100', fecha: haceDias(40), sentido: 'POSITIVO',
      motivo: 'VIS existencia inicial declarada (dato sintético)', costoUnitario: '500.0000',
    }, 201, { claveIdem: true });
    await paso('transferencia de 10 u. al depósito secundario', 'POST', '/stock-movements/transferencia', {
      productoId: prod1.id, origenDepositoId: dep1.id, destinoDepositoId: dep2.id, cantidad: '10', fecha: haceDias(20), motivo: 'VIS reparto entre depósitos',
    }, 201, { claveIdem: true });
    await paso('ajuste negativo de 2 u. por rotura', 'POST', '/stock-movements/ajuste', {
      productoId: prod1.id, depositoId: dep1.id, cantidad: '2', fecha: haceDias(10), sentido: 'NEGATIVO', motivo: 'VIS rotura en el depósito (dato sintético)',
    }, 201, { claveIdem: true });
  }

  // ── 5 · Comprobantes ─────────────────────────────────────────────────────────────────────────────────────
  const lineaVenta = (neto, iva, descripcion) => ({
    productoId: prod1?.id, descripcion, cantidad: '1', precioUnitario: neto, tratamiento: 'GRAVADO', neto, iva,
  });

  // A · venta con tercero, renglones y vendedor (ítems 1, 6/7, 8)
  const ventaA = await comprobante({ direccion: 'VENTAS', cuit: cliente1.cuit, razon: 'VIS Cliente Norte', neto: '100000.00', iva: '21000.00', fecha: haceDias(30) });
  if (ventaA) {
    await paso('A · asignar tercero', 'POST', `/tax-transactions/${ventaA}/party`, { partyId: cliente1.id });
    await paso('A · renglones', 'PUT', `/tax-transactions/${ventaA}/lines`, { renglones: [lineaVenta('100000.00', '21000.00', 'VIS Venta de mercadería')] });
    if (vendedor) await paso('A · vendedor', 'POST', `/tax-transactions/${ventaA}/salesperson`, { vendedorId: vendedor.id });
  }
  // B · venta SIN tercero ni renglones (ítems 6/7 y 11 parten de acá: la acción se hace desde la consola)
  const ventaB = await comprobante({ direccion: 'VENTAS', cuit: cliente2.cuit, razon: 'VIS Cliente Sur', neto: '40000.00', iva: '8400.00', fecha: haceDias(12) });
  // C · venta de cliente2 con tercero y renglones (ítem 15: imputación que se anula desde la consola)
  const ventaC = await comprobante({ direccion: 'VENTAS', cuit: cliente2.cuit, razon: 'VIS Cliente Sur', neto: '60000.00', iva: '12600.00', fecha: haceDias(25) });
  if (ventaC) {
    await paso('C · asignar tercero', 'POST', `/tax-transactions/${ventaC}/party`, { partyId: cliente2.id });
    await paso('C · renglones', 'PUT', `/tax-transactions/${ventaC}/lines`, { renglones: [lineaVenta('60000.00', '12600.00', 'VIS Venta de mercadería')] });
  }
  // NC · nota de crédito de venta a cliente1 (ítems 9/10)
  const nc = await comprobante({ direccion: 'VENTAS', cuit: cliente1.cuit, razon: 'VIS Cliente Norte', neto: '20000.00', iva: '4200.00', fecha: haceDias(15), cbteTipo: 3 });
  if (nc) await paso('NC · asignar tercero', 'POST', `/tax-transactions/${nc}/party`, { partyId: cliente1.id });
  // D · compra con constatación declarada y renglones (ítem 5: crédito fiscal de IVA)
  const compraD = await comprobante({ direccion: 'COMPRAS', cuit: proveedor1.cuit, razon: 'VIS Proveedor de Insumos', neto: '50000.00', iva: '10500.00', fecha: haceDias(18), constatar: true });
  if (compraD) {
    await paso('D · asignar proveedor', 'POST', `/tax-transactions/${compraD}/party`, { partyId: proveedor1.id });
    await paso('D · renglones', 'PUT', `/tax-transactions/${compraD}/lines`, {
      renglones: [{ productoId: prod1?.id, descripcion: 'VIS Compra de insumos', cantidad: '100', precioUnitario: '500.0000', tratamiento: 'GRAVADO', neto: '50000.00', iva: '10500.00' }],
    });
  }
  // E · segunda compra, para la orden de pago (ítem 21)
  const compraE = await comprobante({ direccion: 'COMPRAS', cuit: proveedor1.cuit, razon: 'VIS Proveedor de Insumos', neto: '30000.00', iva: '6300.00', fecha: haceDias(8), constatar: true });
  if (compraE) await paso('E · asignar proveedor', 'POST', `/tax-transactions/${compraE}/party`, { partyId: proveedor1.id });
  Object.assign(sembrado, { ventaA, ventaB_sinTercero: ventaB, ventaC, notaDeCredito: nc, compraD, compraE });

  // ── 6 · Cobros e imputaciones (ítems 8 y 15) ───────────────────────────────────────────────────────────
  const cobro = async (partyId, importe, descripcion) => {
    const alta = await paso(`asiento de cobranza ${importe}`, 'POST', '/journal-entries', {
      journalCode: 'GENERAL', entryDate: haceDias(5), description: `VIS ${descripcion}`, currency: 'ARS',
      lines: [
        { accountCode: '1.1.01', debit: importe, credit: '0' },
        { accountCode: '1.1.02', debit: '0', credit: importe, partyId },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'VIS cobranza sintética registrada por el script de siembra',
    }, 201);
    if (!alta) return null;
    await paso('aprobar la cobranza', 'POST', `/journal-entries/${alta.id}/approve`, undefined, 200);
    const libres = await pedir('GET', `/parties/${partyId}/movimientos-sin-imputar`);
    const mov = (libres.datos?.movimientos ?? []).find((m) => Number(m.disponible) === Number(importe));
    return mov ? { asientoId: alta.id, lineaId: mov.lineaId } : null;
  };
  const cobro1 = await cobro(cliente1.id, '80000.00', 'Cobranza parcial del cliente Norte');
  const cobro2 = await cobro(cliente2.id, '60000.00', 'Cobranza del cliente Sur');
  sembrado.cobros = { cobro1, cobro2 };
  if (cobro1 && ventaA) {
    const imp = await paso('imputar 80.000 de la cobranza a la venta A', 'POST', '/party-allocations', { taxTransactionId: ventaA, journalEntryLineId: cobro1.lineaId, importe: '80000.00' }, 201);
    sembrado.imputacionVentaA = imp?.id;
  }
  if (cobro2 && ventaC) {
    const imp = await paso('imputar 60.000 de la cobranza a la venta C (la que se anula desde la consola)', 'POST', '/party-allocations', { taxTransactionId: ventaC, journalEntryLineId: cobro2.lineaId, importe: '60000.00' }, 201);
    sembrado.imputacionVentaC = imp?.id;
  }

  // ── 7 · Corrección de la nota de crédito (ítems 9/10) ──────────────────────────────────────────────────
  if (nc && ventaA) {
    const c1 = await paso('NC corrige 10.000 de la venta A', 'POST', '/tax-transaction-corrections', { correctoraId: nc, corregidaId: ventaA, importe: '10000.00' }, 201);
    const c2 = await paso('NC corrige 5.000 más de la venta A (la que se anula desde la consola)', 'POST', '/tax-transaction-corrections', { correctoraId: nc, corregidaId: ventaA, importe: '5000.00' }, [201, 422]);
    sembrado.correcciones = { c1: c1?.id, c2: c2?.id };
  }

  // ── 8 · Decisión contable (ítem 14: se corrige desde la consola) ──────────────────────────────────────
  if (ventaA) {
    const d = await paso('decisión manual vigente sobre la venta A', 'POST', `/comprobantes/${ventaA}/decision`, {
      manual: { justificacion: 'VIS decisión sintética: se propone el asiento tal como lo arma el sistema (dato de prueba)', resultado: 'PROPUESTA_DE_ASIENTO' },
    }, [200, 201]);
    sembrado.decisionVenta = d?.decisionId ?? d?.id;
  }

  // ── 9 · Listas de precios (ítems 16/17) ────────────────────────────────────────────────────────────────
  if (prod1) {
    const lp1 = await paso('lista de precios mayorista', 'POST', '/price-lists', { codigo: `VIS-LP1-${marca}`, nombre: `VIS Lista mayorista ${marca}`, vigenteDesde: `${anio}-01-01` }, 201);
    const lp2 = await paso('lista de precios minorista', 'POST', '/price-lists', { codigo: `VIS-LP2-${marca}`, nombre: `VIS Lista minorista ${marca}`, vigenteDesde: `${anio}-01-01` }, 201);
    for (const [lp, tramos] of [[lp1, [['1', '800.00'], ['10', '700.00']]], [lp2, [['1', '950.00']]]]) {
      if (lp) await paso('precios de la lista', 'PUT', `/price-lists/${lp.id}/items`, { items: tramos.map(([d, p]) => ({ productoId: prod1.id, cantidadDesde: d, precio: p })) }, 200);
    }
    // cliente2 ya tiene una lista asignada; cliente1 queda SIN lista: la asignación se hace desde la consola.
    if (lp1) await paso('asignar la lista mayorista al cliente Sur', 'POST', `/parties/${cliente2.id}/price-lists`, { priceListId: lp1.id, desde: `${anio}-01-01` }, 201);
    sembrado.listas = { mayorista: lp1?.id, minorista: lp2?.id };
  }

  // ── 10 · CRM (ítem 20) ─────────────────────────────────────────────────────────────────────────────────
  const etapas = {};
  for (const [codigo, nombre, orden, tipo, prob] of [
    ['VIS-CONTACTO', 'VIS Primer contacto', 1, 'ABIERTA', 10],
    ['VIS-PROPUESTA', 'VIS Propuesta enviada', 2, 'ABIERTA', 50],
    ['VIS-GANADA', 'VIS Ganada', 3, 'GANADA', 100],
    ['VIS-PERDIDA', 'VIS Perdida', 4, 'PERDIDA', 0],
  ]) {
    const e = await paso(`etapa del embudo ${nombre}`, 'POST', '/crm/stages', { codigo: `${codigo}-${marca}`, nombre, orden, tipo, probabilidad: prob }, 201);
    etapas[codigo] = e?.id;
  }
  sembrado.etapasCrm = etapas;

  // ── 11 · Orden de pago (ítem 21) y solicitud de compra (ítem 22) ───────────────────────────────────────
  if (compraD && compraE) {
    const odp = await paso('orden de pago (compra D)', 'POST', '/payment-orders', { proveedorId: proveedor1.id, fecha: hoy, renglones: [{ comprobanteId: compraD, importe: '30000.00' }] }, 201);
    sembrado.ordenDePago = odp?.id;
  }
  const sol = await paso('solicitud de compra en borrador', 'POST', '/purchase-requests', {
    fecha: hoy, justificacion: 'VIS se agotó el insumo en el depósito (dato sintético)', renglones: [{ descripcion: 'VIS Insumo de embalaje', cantidad: '25' }],
  }, 201);
  sembrado.solicitudDeCompra = sol?.id;

  // ── 12 · Conciliación bancaria (ítem 4) ────────────────────────────────────────────────────────────────
  await bancos();

  // El ítem 3 (estados contables) NO se siembra: el catálogo trae plantillas solo para SA (Ley 19.550, IGJ, RT FACPCE)
  // y esta empresa es una SRL, así que `GET /statements` responde «FUENTE NO ENCONTRADA» a propósito. Ver
  // docs/VERIFICACION_VISUAL_16_PANTALLAS.md.
}

/**
 * Un segundo movimiento bancario sobre la cuenta que ya existe (--solo=banco2): deja un asiento y un extracto SIN
 * conciliar, para poder repetir desde la consola «proponer → confirmar → de dónde sale» (ítem 4).
 */
async function bancosSegundoMovimiento() {
  const cuentas = await pedir('GET', '/banks/accounts');
  const cuenta = (cuentas.datos?.cuentas ?? []).find((c) => String(c.banco).startsWith('VIS Banco'));
  const mapeos = await pedir('GET', '/banks/statement-layouts');
  const layout = (mapeos.datos?.mapeos ?? []).find((m) => String(m.nombre).startsWith('VIS'));
  if (!cuenta || !layout) {
    console.log('  ✘  falta la cuenta o el mapeo de la siembra del banco: correr antes --solo=banco');
    fallos.push({ descripcion: 'banco2 sin cuenta o mapeo', status: 0, cuerpo: '' });
    return;
  }
  const a = await paso('asiento: otra cobranza acreditada', 'POST', '/journal-entries', {
    journalCode: 'GENERAL', entryDate: haceDias(1), description: 'VIS Otra cobranza acreditada en el banco', currency: 'ARS',
    lines: [
      { accountCode: '1.1.03', debit: '777.00', credit: '0' },
      { accountCode: '4.1.01', debit: '0', credit: '777.00' },
    ],
    source: { type: 'MANUAL', id: null },
    manualJustification: 'VIS cobranza sintética registrada por el script de siembra',
  }, 201);
  if (a) await paso('aprobar el asiento', 'POST', `/journal-entries/${a.id}/approve`, undefined, 200);
  await paso('importar el segundo extracto (un crédito de 777,00)', 'POST', `/banks/accounts/${cuenta.id}/statements`, {
    layoutId: layout.id, desde: haceDias(2), hasta: hoy, saldoInicial: '0', saldoFinal: '777.00',
    contenido: ['Fecha;Descripcion;Debito;Credito', `${haceDias(1)};VIS OTRA COBRANZA ACREDITADA;;777,00`].join('\n'),
  }, 201);
}

/** Cuenta bancaria, extracto importado y conciliación abierta: el borde de partida del ítem 4. */
async function bancos() {
  if (solo === 'banco2') return bancosSegundoMovimiento();
  if (!corre('banco')) return;
  const cuenta = await paso('cuenta bancaria', 'POST', '/banks/accounts', { banco: `VIS Banco ${marca}`, cuentaCodigo: '1.1.03' }, 201);
  if (!cuenta) return;
  const desde = haceDias(30);
  await paso('asiento: cobranza acreditada en el banco', 'POST', '/journal-entries', {
    journalCode: 'GENERAL', entryDate: haceDias(3), description: 'VIS Cobranza acreditada en el banco', currency: 'ARS',
    lines: [
      { accountCode: '1.1.03', debit: '12345.00', credit: '0' },
      { accountCode: '4.1.01', debit: '0', credit: '12345.00' },
    ],
    source: { type: 'MANUAL', id: null },
    manualJustification: 'VIS cobranza sintética registrada por el script de siembra',
  }, 201).then(async (a) => a && paso('aprobar el asiento del banco', 'POST', `/journal-entries/${a.id}/approve`, undefined, 200));
  const layout = await paso('mapeo de columnas del extracto', 'POST', '/banks/statement-layouts', {
    bankAccountId: cuenta.id, nombre: 'VIS Extracto de prueba', filasEncabezado: 1, columnaFecha: 0, columnaDescripcion: 1,
    formatoFecha: 'AAAA-MM-DD', formatoImporte: 'ES_AR', signo: { tipo: 'COLUMNAS_SEPARADAS', columnaDebito: 2, columnaCredito: 3 },
  }, 201);
  if (!layout) return;
  const extracto = await paso('importar el extracto (un crédito de 12.345,00)', 'POST', `/banks/accounts/${cuenta.id}/statements`, {
    layoutId: layout.id, desde, hasta: hoy, saldoInicial: '0', saldoFinal: '12345.00',
    contenido: ['Fecha;Descripcion;Debito;Credito', `${haceDias(3)};VIS COBRANZA ACREDITADA;;12.345,00`].join('\n'),
  }, 201);
  const conciliacion = await paso('abrir la conciliación del período', 'POST', `/banks/accounts/${cuenta.id}/reconciliations`, { desde, hasta: hoy, saldoExtracto: '12345.00' }, 201);
  sembrado.banco = { cuenta: cuenta.id, extracto: extracto?.id, conciliacion: conciliacion?.reconciliationId };
}

main()
  .then(() => {
    mkdirSync(join(RAIZ, 'var', 'visual'), { recursive: true });
    const archivo = join(RAIZ, 'var', 'visual', 'datos-sembrados.json');
    // Una corrida parcial (--solo=…) SUMA a lo que dejó la anterior; no la pisa.
    let previo = {};
    try {
      previo = JSON.parse(readFileSync(archivo, 'utf8'));
    } catch {
      /* primera corrida */
    }
    writeFileSync(archivo, JSON.stringify({ ...previo, ...sembrado, fallos }, null, 2));
    console.log(`\nListo: ${fallos.length} paso(s) fallido(s). Ids en var/visual/datos-sembrados.json`);
    process.exit(fallos.length === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
