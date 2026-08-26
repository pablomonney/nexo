#!/usr/bin/env node
/**
 * Revisa un CSV de comprobantes contra los motores del sistema.
 *
 *   npm run comprobantes:revisar -- archivo.csv
 *   npm run comprobantes:revisar -- archivo.csv --mapeo scripts/mapeos/comprobantes-csv-es.json
 *
 * ## Qué hace y qué NO hace
 *
 * **No escribe nada.** Ni un asiento, ni una fila en `tax_transactions`, ni un
 * documento. Lee el CSV, lo pasa por los mismos validadores y motores que usa la
 * aplicación, e imprime lo que el sistema diría. Es una herramienta para
 * contestar *"¿estos comprobantes sirven?"* antes de cargarlos, no una vía de
 * ingesta paralela que saltee la bitácora.
 *
 * ## El mapeo se declara, no se adivina
 *
 * Es la misma decisión que `MapeoDeExtracto` en el motor de bancos. Un CSV con
 * columnas "Subtotal", "Neto", "Importe" y "Base imponible" tiene cuatro
 * candidatos plausibles para el neto, y elegir por heurística acierta casi
 * siempre — hasta el archivo donde "Importe" era el total. Sin `--mapeo` el
 * script imprime los encabezados que encontró y una plantilla, y no procesa nada.
 *
 * ## Las tres categorías de la salida, y por qué están separadas
 *
 * 1. **Errores de forma**: dígito verificador de CUIT, aritmética, duplicados.
 *    Son verificables sin ninguna norma.
 * 2. **Lo que dice el motor de IVA**: alícuota identificada contra `tax_rates`
 *    vigentes a la fecha del comprobante, y estado del crédito fiscal.
 * 3. **Observaciones SIN fuente archivada**: cosas que se ven mal y que este
 *    repositorio **no puede afirmar** que estén mal, porque la norma que las
 *    regula no está archivada. Van aparte y dicen qué falta archivar. Mezclarlas
 *    con las dos primeras convertiría una sospecha en un veredicto.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { isValidCuit, money, normalizeCuit, parseCalendarDate } from '@aai/shared';
import { identificarAlicuota } from '@aai/tax-engine';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
try {
  process.loadEnvFile(join(RAIZ, '.env'));
} catch {
  /* en CI las variables vienen del entorno */
}

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
const mapeoRuta = args.includes('--mapeo') ? args[args.indexOf('--mapeo') + 1] : null;

if (archivo === undefined) {
  console.error('Uso: npm run comprobantes:revisar -- archivo.csv [--mapeo mapeo.json]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function parsearCsv(texto, separador) {
  const filas = [];
  let campo = '';
  let fila = [];
  let enComillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else enComillas = false;
      } else campo += c;
      continue;
    }
    if (c === '"' && campo.length === 0) enComillas = true;
    else if (c === separador) {
      fila.push(campo);
      campo = '';
    } else if (c === '\n') {
      fila.push(campo.replace(/\r$/, ''));
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (campo.length > 0 || fila.length > 0) {
    fila.push(campo.replace(/\r$/, ''));
    filas.push(fila);
  }
  return filas.filter((f) => f.some((v) => v.trim() !== ''));
}

// El BOM de UTF-8 se pega al primer encabezado y hace que `columnas.codigoTipo`
// no matchee por un carácter invisible. Es la clase de fallo que se diagnostica
// mal durante media hora.
const BOM = String.fromCharCode(0xfeff);
const sinBom = (s) => (s.startsWith(BOM) ? s.slice(1) : s);
const texto = sinBom(readFileSync(archivo, 'utf8'));

if (mapeoRuta === null) {
  const encabezados = parsearCsv(texto, ',')[0] ?? [];
  console.log('Falta --mapeo. Las columnas se declaran; adivinarlas es cómo un total termina');
  console.log('cargado como neto.');
  console.log('');
  console.log(`Encabezados encontrados (${encabezados.length}):`);
  for (const e of encabezados) console.log(`  · ${e}`);
  console.log('');
  console.log('Hay un mapeo listo para encabezados en español:');
  console.log('  npm run comprobantes:revisar -- ' + archivo + ' --mapeo scripts/mapeos/comprobantes-csv-es.json');
  process.exit(2);
}

const mapeo = JSON.parse(readFileSync(join(RAIZ, mapeoRuta), 'utf8'));
const filas = parsearCsv(texto, mapeo.separador ?? ',');
const encabezados = filas[0].map((h) => sinBom(h).trim());

const faltantes = Object.entries(mapeo.columnas).filter(([, col]) => !encabezados.includes(col));
if (faltantes.length > 0) {
  console.error(`El mapeo declara columnas que el archivo no tiene:`);
  for (const [campo, col] of faltantes) console.error(`  ✘ ${campo} → "${col}"`);
  console.error('');
  console.error(`Encabezados del archivo: ${encabezados.join(' | ')}`);
  process.exit(1);
}

const indice = Object.fromEntries(
  Object.entries(mapeo.columnas).map(([campo, col]) => [campo, encabezados.indexOf(col)]),
);
const registros = filas.slice(1).map((f, i) => {
  const leer = (campo) => (indice[campo] >= 0 ? (f[indice[campo]] ?? '').trim() : '');
  return {
    linea: i + 2,
    codigoTipo: Number(leer('codigoTipo')),
    numero: leer('numero'),
    fecha: leer('fecha'),
    cuitEmisor: normalizeCuit(leer('cuitEmisor')),
    razonSocialEmisor: leer('razonSocialEmisor'),
    cuitReceptor: normalizeCuit(leer('cuitReceptor')),
    razonSocialReceptor: leer('razonSocialReceptor'),
    condicionReceptor: mapeo.condiciones?.[leer('condicionReceptor')] ?? 'DESCONOCIDA',
    neto: centavos(leer('neto')),
    iva: centavos(leer('iva')),
    total: centavos(leer('total')),
    moneda: leer('moneda') || 'ARS',
  };
});

/** A unidades menores, en enteros. Nunca `Number * 100`: 19.99 * 100 = 1998.9999… */
function centavos(valor) {
  const limpio = valor.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '');
  const [entera, decimal = ''] = limpio.split(mapeo.decimal ?? '.');
  const negativo = entera.startsWith('-');
  const dig = (entera.replace('-', '') || '0') + (decimal + '00').slice(0, 2);
  const n = BigInt(dig.replace(/\D/g, '') || '0');
  return negativo ? -n : n;
}

// ---------------------------------------------------------------------------
// Contexto normativo: catálogo de comprobantes y alícuotas, desde la base
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? '';
let catalogo = new Map();
let alicuotas = [];

if (DATABASE_URL !== '') {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const tipos = await client.query(
      `SELECT codigo, descripcion, letra, clase, valid_from::text AS desde,
              valid_to::text AS hasta, vigencia_verificada
         FROM arca_comprobante_types`,
    );
    for (const fila of tipos.rows) catalogo.set(fila.codigo, fila);

    const tarifas = await client.query(
      `SELECT id, label, numerator::text AS num, denominator::text AS den,
              valid_from::text AS desde, valid_to::text AS hasta, norm_version_id
         FROM tax_rates`,
    );
    alicuotas = tarifas.rows.map((fila) => ({
      id: fila.id,
      etiqueta: fila.label,
      numerador: BigInt(fila.num),
      denominador: BigInt(fila.den),
      vigenteDesde: parseCalendarDate(fila.desde),
      vigenteHasta: fila.hasta === null ? null : parseCalendarDate(fila.hasta),
      normVersionId: fila.norm_version_id,
    }));
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Los controles
// ---------------------------------------------------------------------------

const forma = [];
const iva = [];
const sinFuente = [];

const vistos = new Map();
const identificadas = new Map();
let conIva = 0;

for (const r of registros) {
  const id = `L${r.linea} ${r.numero}`;

  // --- 1. Forma -------------------------------------------------------------
  if (!isValidCuit(r.cuitEmisor)) {
    forma.push({ id, codigo: 'CUIT_EMISOR_INVALIDO', detalle: `${r.cuitEmisor}: el dígito verificador no cierra.` });
  }
  if (!isValidCuit(r.cuitReceptor)) {
    forma.push({ id, codigo: 'CUIT_RECEPTOR_INVALIDO', detalle: `${r.cuitReceptor}: el dígito verificador no cierra.` });
  }
  if (r.cuitEmisor === r.cuitReceptor && r.cuitEmisor !== '') {
    forma.push({ id, codigo: 'EMISOR_IGUAL_A_RECEPTOR', detalle: 'El mismo CUIT emite y recibe.' });
  }
  if (r.neto + r.iva !== r.total) {
    forma.push({
      id,
      codigo: 'TOTAL_NO_CIERRA',
      detalle: `${r.neto} + ${r.iva} = ${r.neto + r.iva}, y el total declarado es ${r.total}.`,
    });
  }

  const clave = `${r.codigoTipo}|${r.numero}|${r.cuitEmisor}`;
  if (vistos.has(clave)) {
    forma.push({ id, codigo: 'DUPLICADO', detalle: `Ya apareció en la línea ${vistos.get(clave)}.` });
  } else vistos.set(clave, r.linea);

  // --- 2. Catálogo de comprobantes, POR FECHA -------------------------------
  const tipo = catalogo.get(r.codigoTipo);
  if (catalogo.size === 0) {
    // Sin base no hay catálogo, y no se inventa uno.
  } else if (tipo === undefined) {
    forma.push({
      id,
      codigo: 'TIPO_COMPROBANTE_DESCONOCIDO',
      detalle: `El código ${r.codigoTipo} no está en arca_comprobante_types.`,
    });
  } else if (tipo.vigencia_verificada === false) {
    // Se dice una vez, al final. Marcarlo cien veces no agrega información.
  }

  // --- 3. Motor de IVA ------------------------------------------------------
  if (r.iva !== 0n) {
    conIva += 1;
    const resultado = identificarAlicuota(
      money(r.neto, r.moneda),
      money(r.iva, r.moneda),
      alicuotas,
      parseCalendarDate(r.fecha),
    );
    if (resultado.alicuota === null) {
      for (const h of resultado.hallazgos) iva.push({ id, codigo: h.codigo, detalle: h.mensaje });
    } else {
      identificadas.set(
        resultado.alicuota.etiqueta,
        (identificadas.get(resultado.alicuota.etiqueta) ?? 0) + 1,
      );
    }
  }

  // --- 4. Observaciones sin fuente archivada --------------------------------
  //
  // Qué letra de comprobante corresponde a cada condición del receptor lo fija
  // la RG 1415, que NO está archivada en este repositorio. Se observa el hecho y
  // se dice que no hay fuente: afirmarlo como incumplimiento sería exactamente lo
  // que el §30 prohíbe.
  if (tipo !== undefined) {
    if (tipo.letra === 'A' && r.condicionReceptor !== 'RESPONSABLE_INSCRIPTO') {
      sinFuente.push({
        id,
        codigo: 'LETRA_Y_CONDICION',
        detalle: `${tipo.descripcion} emitida a un receptor ${r.condicionReceptor}.`,
      });
    }
    if (tipo.letra === 'B' && r.condicionReceptor === 'RESPONSABLE_INSCRIPTO') {
      sinFuente.push({
        id,
        codigo: 'LETRA_Y_CONDICION',
        detalle: `${tipo.descripcion} emitida a un Responsable Inscripto.`,
      });
    }
  }

  if (r.razonSocialEmisor === r.razonSocialReceptor && r.cuitEmisor !== r.cuitReceptor) {
    sinFuente.push({
      id,
      codigo: 'MISMA_RAZON_SOCIAL_DISTINTO_CUIT',
      detalle: `"${r.razonSocialEmisor}" figura como emisor y receptor con dos CUIT distintos.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

function resumir(titulo, hallazgos, muestra = 5) {
  console.log('');
  console.log(`${titulo}: ${hallazgos.length}`);
  if (hallazgos.length === 0) return;
  const porCodigo = new Map();
  for (const h of hallazgos) porCodigo.set(h.codigo, [...(porCodigo.get(h.codigo) ?? []), h]);
  for (const [codigo, lista] of porCodigo) {
    console.log(`  ${codigo}: ${lista.length}`);
    for (const h of lista.slice(0, muestra)) console.log(`      ${h.id} — ${h.detalle}`);
    if (lista.length > muestra) console.log(`      … y ${lista.length - muestra} más`);
  }
}

console.log('');
console.log(`Comprobantes leídos: ${registros.length}`);
console.log(`Rango de fechas: ${registros.map((r) => r.fecha).sort()[0]} → ${registros.map((r) => r.fecha).sort().at(-1)}`);
console.log(`Emisores distintos por CUIT: ${new Set(registros.map((r) => r.cuitEmisor)).size}`);
console.log(`Emisores distintos por razón social: ${new Set(registros.map((r) => r.razonSocialEmisor)).size}`);

resumir('Errores de forma (verificables sin ninguna norma)', forma);
console.log('');
console.log(`Comprobantes con IVA discriminado: ${conIva} de ${registros.length}`);
for (const [etiqueta, n] of identificadas) {
  console.log(`  ✓ ${n} identificados como ${etiqueta}`);
}

// Un renglón acá no es un problema del archivo: es el motor diciendo que no puede
// deducir de qué alícuota sale ese IVA. Puede ser un comprobante con varias
// alícuotas, un error del emisor, o una alícuota que falta relevar.
resumir('Comprobantes cuyo IVA no sale de ninguna alícuota vigente', iva);

console.log('');
console.log(`Observaciones SIN fuente archivada: ${sinFuente.length}`);
if (sinFuente.length > 0) {
  const porCodigo = new Map();
  for (const h of sinFuente) porCodigo.set(h.codigo, [...(porCodigo.get(h.codigo) ?? []), h]);
  for (const [codigo, lista] of porCodigo) {
    console.log(`  ${codigo}: ${lista.length}`);
    for (const h of lista.slice(0, 3)) console.log(`      ${h.id} — ${h.detalle}`);
    if (lista.length > 3) console.log(`      … y ${lista.length - 3} más`);
  }
  console.log('');
  console.log('  Estas NO son incumplimientos declarados: qué letra corresponde a cada condición');
  console.log('  del receptor lo fija la RG 1415, que este repositorio no tiene archivada. Se');
  console.log('  informa el hecho y se dice qué falta. Afirmar la infracción sin la norma es lo');
  console.log('  que el §30 prohíbe, y es la razón por la que van en su propia lista.');
}

if (catalogo.size > 0 && [...catalogo.values()].some((t) => t.vigencia_verificada === false)) {
  console.log('');
  console.log('Nota: los tipos de comprobante se resolvieron contra un catálogo cuya vigencia por');
  console.log('fecha NO está verificada (hallazgo de FASE 3b). La clase de un código pudo ser otra');
  console.log('en el pasado, y el signo del subdiario depende de la clase.');
}

if (alicuotas.length === 0) {
  console.log('');
  console.log('No se identificaron alícuotas: `tax_rates` está vacía o no hay DATABASE_URL.');
  console.log('Corré `npm run tax:seed`. El motor no supone 21%.');
}
