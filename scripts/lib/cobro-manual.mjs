/**
 * Las partes puras del cobro manual por transferencia: sin base, sin red, sin reloj.
 *
 * Están aparte para poder probarlas una por una (`tests/unit/cobro-manual.test.ts`) y porque son justo donde un error de
 * redondeo o de interpretación dejaría un cobro asignado al documento equivocado.
 *
 * ## Los importes nunca son `number`
 *
 * Se llevan en CENTAVOS como `bigint`. Un `0.1 + 0.2` en una conciliación bancaria es un cobro que «no coincide» por un
 * centavo invisible, o peor, uno que coincide con el documento de otro cliente.
 */

import { createHash } from 'node:crypto';

/** `'3000.00'` → `300000n`; `'3.000,50'` (es-AR) → `300050n`; `'3000'` → `300000n`. `null` si no es un importe. */
export function aCentavos(texto) {
  let t = String(texto ?? '').trim().replace(/^\$\s*/u, '');
  if (t === '') return null;
  let negativo = false;
  if (t.startsWith('-')) {
    negativo = true;
    t = t.slice(1).trim();
  }
  // El último separador es el decimal; el otro, de miles. «3.000» sin decimales es tres mil, no tres.
  const ultimaComa = t.lastIndexOf(',');
  const ultimoPunto = t.lastIndexOf('.');
  let entero;
  let decimales = '';
  if (ultimaComa > ultimoPunto) {
    entero = t.slice(0, ultimaComa).replace(/\./gu, '');
    decimales = t.slice(ultimaComa + 1);
  } else if (ultimoPunto > ultimaComa && t.length - ultimoPunto - 1 <= 2 && ultimoPunto !== -1) {
    entero = t.slice(0, ultimoPunto).replace(/,/gu, '');
    decimales = t.slice(ultimoPunto + 1);
  } else {
    entero = t.replace(/[.,]/gu, '');
  }
  if (!/^\d+$/u.test(entero) || !/^\d{0,2}$/u.test(decimales)) return null;
  const centavos = BigInt(entero) * 100n + BigInt(decimales.padEnd(2, '0') || '0');
  return negativo ? -centavos : centavos;
}

/** `300050n` → `'3000.50'`. */
export function deCentavos(c) {
  const negativo = c < 0n;
  const a = negativo ? -c : c;
  const s = `${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
  return negativo ? `-${s}` : s;
}

/**
 * Lee un extracto en CSV con encabezado: `fecha;descripcion;importe` y, opcional, `referencia`.
 * Acepta `;` o `,` como separador y fechas `AAAA-MM-DD` o `DD/MM/AAAA`. Devuelve sólo los CRÉDITOS (lo que entró).
 */
export function parsearExtracto(texto) {
  const lineas = String(texto).split(/\r?\n/u).filter((l) => l.trim() !== '');
  if (lineas.length === 0) return { movimientos: [], descartadas: [] };
  const sep = lineas[0].includes(';') ? ';' : ',';
  const cabecera = lineas[0].split(sep).map((c) => c.trim().toLowerCase());
  const col = (...nombres) => cabecera.findIndex((c) => nombres.includes(c));
  const iFecha = col('fecha');
  const iDesc = col('descripcion', 'descripción', 'detalle', 'concepto');
  const iImporte = col('importe', 'monto', 'credito', 'crédito');
  const iRef = col('referencia', 'comprobante', 'nro', 'numero', 'número', 'operacion', 'operación');
  if (iFecha < 0 || iImporte < 0) {
    throw new Error('El extracto necesita al menos las columnas «fecha» e «importe» (y de preferencia «descripcion» y «referencia»).');
  }

  const movimientos = [];
  const descartadas = [];
  lineas.slice(1).forEach((linea, i) => {
    const celdas = linea.split(sep).map((c) => c.trim());
    const n = i + 2;
    const fecha = normalizarFecha(celdas[iFecha]);
    const centavos = aCentavos(celdas[iImporte]);
    if (fecha === null || centavos === null) {
      descartadas.push({ linea: n, motivo: 'fecha o importe ilegibles', texto: linea });
      return;
    }
    if (centavos <= 0n) return; // un débito no es un cobro
    movimientos.push({
      linea: n,
      fecha,
      descripcion: iDesc >= 0 ? (celdas[iDesc] ?? '') : '',
      centavos,
      referencia: iRef >= 0 && celdas[iRef] ? celdas[iRef] : null,
    });
  });
  return { movimientos, descartadas };
}

function normalizarFecha(t) {
  const s = String(t ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s);
  if (m) return s;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

const sinAcentos = (t) => String(t).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * Propone a qué documento corresponde cada movimiento. **Sólo propone**: registrar un cobro es otro paso, de una persona.
 *
 *   YA_REGISTRADO   la referencia ya está en un cobro registrado (el mismo extracto procesado dos veces)
 *   UNICA           exactamente un documento emitido por ese importe (o, entre varios, uno solo cuyo CUIT o nombre aparece en el texto)
 *   AMBIGUA         varios documentos por el mismo importe y nada que los distinga: no se elige
 *   SIN_DOCUMENTO   ningún documento emitido por ese importe
 */
export function conciliar(movimientos, documentos, referenciasRegistradas) {
  const yaRegistradas = new Set([...referenciasRegistradas].map((r) => String(r).trim().toLowerCase()));
  return movimientos.map((mov) => {
    if (mov.referencia !== null && yaRegistradas.has(mov.referencia.trim().toLowerCase())) {
      return { movimiento: mov, estado: 'YA_REGISTRADO', candidatos: [] };
    }
    const iguales = documentos.filter((d) => d.centavos === mov.centavos);
    if (iguales.length === 0) return { movimiento: mov, estado: 'SIN_DOCUMENTO', candidatos: [] };
    if (iguales.length === 1) return { movimiento: mov, estado: 'UNICA', candidatos: iguales };

    const texto = sinAcentos(`${mov.descripcion} ${mov.referencia ?? ''}`);
    const porTexto = iguales.filter((d) => {
      const cuit = String(d.cuit ?? '').replace(/\D/gu, '');
      const nombre = sinAcentos(d.empresa ?? '');
      return (cuit.length === 11 && texto.replace(/\D/gu, '').includes(cuit)) || (nombre.length >= 6 && texto.includes(nombre));
    });
    if (porTexto.length === 1) return { movimiento: mov, estado: 'UNICA', candidatos: porTexto, porTexto: true };
    return { movimiento: mov, estado: 'AMBIGUA', candidatos: iguales };
  });
}

/** La clave de idempotencia de un cobro manual: el mismo documento con la misma referencia es el MISMO cobro. */
export function claveDeCobro(documentId, referencia) {
  const ref = String(referencia).trim().toLowerCase().replace(/\s+/gu, '-');
  return `transferencia:${documentId}:${ref}`;
}

/**
 * El comprobante de pago: texto plano, determinístico (mismos datos → mismo texto → mismo hash).
 *
 * **No es un comprobante fiscal** y lo dice en el cuerpo. NEXO no emite facturas (la emisión está cerrada a propósito);
 * esto acredita que se recibió un pago, no que se facturó.
 */
export function armarComprobante(d) {
  const cuerpo = [
    'COMPROBANTE DE PAGO RECIBIDO — NEXO',
    'NO ES UN COMPROBANTE FISCAL: no reemplaza a la factura.',
    '',
    `Documento N.°        ${d.numero}`,
    `Cliente              ${d.empresa}`,
    `CUIT                 ${d.cuit}`,
    `Concepto             ${d.concepto}`,
    `Importe recibido     ${d.moneda} ${d.importe}`,
    `Medio                Transferencia bancaria`,
    `Fecha del pago       ${d.pagadoEl}`,
    `Referencia bancaria  ${d.referencia ?? '(sin referencia)'}`,
    `Estado del documento ${d.estado}`,
    `Comprobante fiscal   ${d.esFiscal ? `sí (CAE ${d.cae ?? 's/d'})` : 'no: este documento no es un comprobante fiscal'}`,
    '',
    `Emitido el ${d.emitidoEl} a partir de los registros de NEXO.`,
  ].join('\n');
  const huella = createHash('sha256').update(cuerpo, 'utf8').digest('hex');
  return `${cuerpo}\nHuella (SHA-256 del texto de arriba): ${huella}\n`;
}
