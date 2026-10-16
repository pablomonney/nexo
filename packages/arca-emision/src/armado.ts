/**
 * Del documento comercial al comprobante que se le pide a ARCA — función **pura**, sin red ni base.
 *
 * Es el paso E3 de `docs/EMISION_DE_FACTURAS_PLAN.md`. Recibe lo que NEXO ya sabe (quién emite, a quién, qué líneas, qué
 * importes) y devuelve el pedido `FECAESolicitar` listo —cabecera y detalle— **o la lista completa de lo que impide armarlo**.
 * No decide nada fiscal por su cuenta: donde hay que elegir (la condición del emisor, la alícuota, el concepto) o se deduce
 * de forma exacta o se rechaza con un motivo, jamás se supone. Es el mismo criterio con que el motor de IVA se niega a
 * suponer una alícuota.
 *
 * ## De dónde sale cada regla
 *
 * - **La letra** (A/B/C): RG 1415/2003, arts. 15 y 16 (texto archivado en `docs/normative-sources/originals/`):
 *   · emisor **responsable inscripto** → **A** si el receptor es responsable inscripto o monotributista; **B** si es exento,
 *     no responsable, consumidor final o «sujeto no categorizado»;
 *   · emisor **exento / no responsable** o adherido al **régimen simplificado (monotributo)** → **C**.
 * - **Los códigos** (`CbteTipo`, condición del receptor, `Id` de alícuota, `DocTipo`): las tablas que contestó ARCA en
 *   **homologación** el 2026-10-16, archivadas en `docs/normative-sources/extracted/arca-wsfev1-tablas-homologacion-2026-10-16.json`.
 *   No se cablean de memoria: cada constante de este archivo está en ese JSON, y una prueba lo comprueba.
 * - **La condición del receptor es obligatoria** (RG 5616/2024; sin ella ARCA rechaza con 10246) y **cada letra admite sólo
 *   algunas** (la A, cuatro; la B, siete; la C, las once): se valida contra la tabla de ARCA.
 *
 * ## Los importes nunca pasan por punto flotante
 *
 * Todo se calcula con `Money` (centavos enteros) y sale como texto decimal. `ImpTotal = ImpTotConc + ImpNeto + ImpOpEx +
 * ImpTrib + ImpIVA` se cumple **por construcción**: el total no se recibe, se calcula.
 *
 * ## Lo que esta función NO hace (y por qué)
 *
 * - **No reserva el número ni habla con ARCA**: el número llega ya reservado (E4). Acá sólo se arma.
 * - **No verifica la fecha contra «hoy»**: ARCA admite una ventana distinta para productos y para servicios y «hoy» es una
 *   lectura del reloj; la verifica el caso de uso (E4).
 * - **No arma notas de crédito ni de débito** (llevan `CbtesAsoc`; E6) **ni tributos / percepciones** (importe distinto de
 *   cero en `percepciones` se rechaza) **ni facturas de exportación** (clase E). Rechazar es lo correcto mientras no estén.
 * - **No aplica el umbral de identificación del consumidor final**: depende de un monto que fija ARCA y cambia; hasta que
 *   se decida de dónde sale, una factura a consumidor final sin identificar se arma y lo dice en `avisos`.
 * - **No valida que el redondeo de IVA de ARCA coincida línea por línea**: se agrupa por alícuota y se avisa si el IVA
 *   informado difiere del que daría la base agrupada. Lo decide ARCA al autorizar (se prueba en homologación).
 */

import {
  compareDates,
  type CalendarDate,
  isCalendarDate,
  isValidCuit,
  moneyFromDecimalString,
  multiplyByRate,
  normalizeCuit,
  rate,
  toDecimalString,
  type Currency,
  type Money,
} from '@aai/shared';
import type { AlicuotaIva, CabeceraLote, DetalleComprobante } from './contracts.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Las tablas de ARCA (FEParamGet*), tal como las contestó homologación el 2026-10-16.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LetraDeComprobante = 'A' | 'B' | 'C';
export type ClaseDeComprobante = 'FACTURA';

/** `FEParamGetTiposCbte`: Factura A = 1, B = 6, C = 11. (Las notas de débito/crédito son 2/3, 7/8 y 12/13: llegan en E6.) */
export const CBTE_TIPO_FACTURA: Readonly<Record<LetraDeComprobante, number>> = { A: 1, B: 6, C: 11 };

/** `FEParamGetCondicionIvaReceptor` (RG 5616): qué `Id` admite cada letra. */
export const CONDICIONES_ADMITIDAS_POR_LETRA: Readonly<Record<LetraDeComprobante, readonly number[]>> = {
  A: [1, 6, 13, 16],
  B: [4, 5, 7, 8, 9, 10, 15],
  C: [1, 6, 13, 16, 4, 7, 8, 9, 10, 15, 5],
};

/** `FEParamGetTiposIva`: el `Id` es un código del organismo, no el porcentaje. */
export const ALICUOTAS_DE_ARCA: ReadonlyArray<{ readonly id: number; readonly porcentaje: string }> = [
  { id: 3, porcentaje: '0' },
  { id: 4, porcentaje: '10.5' },
  { id: 5, porcentaje: '21' },
  { id: 6, porcentaje: '27' },
  { id: 8, porcentaje: '5' },
  { id: 9, porcentaje: '2.5' },
];

/** `FEParamGetTiposDoc`. */
export const DOC_TIPO = { CUIT: 80, CUIL: 86, DNI: 96, PASAPORTE: 94, OTRO: 99 } as const;

export type CondicionIvaDelSistema =
  | 'RESPONSABLE_INSCRIPTO'
  | 'MONOTRIBUTO'
  | 'EXENTO'
  | 'CONSUMIDOR_FINAL'
  | 'NO_CATEGORIZADO'
  | 'DESCONOCIDA';

/** Nuestro vocabulario → `Id` de `FEParamGetCondicionIvaReceptor`. `DESCONOCIDA` no tiene: no se puede emitir sin saberla. */
const CONDICION_RECEPTOR_ID: Readonly<Record<Exclude<CondicionIvaDelSistema, 'DESCONOCIDA'>, number>> = {
  RESPONSABLE_INSCRIPTO: 1,
  MONOTRIBUTO: 6,
  EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  NO_CATEGORIZADO: 7,
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Entrada y salida
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EmisorParaArmar {
  readonly cuit: string;
  /** **No es un dato de la empresa hoy** (decisión D1 del plan): quien arma la factura lo declara. */
  readonly condicionIva: CondicionIvaDelSistema;
}

export type TipoDocumentoDelSistema = 'CUIT' | 'CUIL' | 'DNI' | 'PASAPORTE' | 'DOC_EXTRANJERO' | 'SIN_IDENTIFICAR';

export interface ReceptorParaArmar {
  readonly condicionIva: CondicionIvaDelSistema;
  readonly tipoDocumento: TipoDocumentoDelSistema;
  readonly numeroDocumento: string | null;
}

export interface LineaParaArmar {
  /** `PRODUCTO` o `SERVICIO`, como en el maestro de productos. Define el concepto del comprobante. */
  readonly tipo: 'PRODUCTO' | 'SERVICIO';
  readonly tratamiento: 'GRAVADO' | 'EXENTO' | 'NO_GRAVADO';
  /** Decimal exacto, en texto. */
  readonly neto: string;
  /** El IVA de la línea, decimal exacto. Cero si no es gravada. */
  readonly iva: string;
  /** Porcentaje explícito (`"21"`, `"10.5"`). Si falta, se deduce **exactamente** de `iva`/`neto`. */
  readonly alicuota?: string;
}

export interface EntradaDeArmado {
  readonly emisor: EmisorParaArmar;
  readonly receptor: ReceptorParaArmar;
  readonly clase: ClaseDeComprobante;
  readonly puntoDeVenta: number;
  /** El número ya reservado. */
  readonly numero: number;
  /** `AAAA-MM-DD`. */
  readonly fecha: string;
  readonly lineas: readonly LineaParaArmar[];
  /** Pesos argentinos (`ARS`, `PES` para ARCA) o dólares (`USD`, `DOL`). Por defecto `ARS`. */
  readonly moneda?: Currency;
  /** Texto decimal. Obligatoria si la moneda no es pesos. */
  readonly cotizacion?: string;
  /** Obligatorio si el concepto incluye servicios. `AAAA-MM-DD`. */
  readonly servicio?: { readonly desde: string; readonly hasta: string; readonly vencimientoDePago: string };
  /** Tributos / percepciones: todavía no se arman. Distinto de cero → se rechaza. */
  readonly percepciones?: string;
}

export type CodigoDeProblema =
  | 'EMISOR_INVALIDO'
  | 'EMISOR_CONDICION_NO_SOPORTADA'
  | 'RECEPTOR_CONDICION_DESCONOCIDA'
  | 'RECEPTOR_CONDICION_NO_ADMITIDA'
  | 'RECEPTOR_DOCUMENTO_INVALIDO'
  | 'RECEPTOR_SIN_CUIT_PARA_FACTURA_A'
  | 'RECEPTOR_NO_SOPORTADO'
  | 'PUNTO_DE_VENTA_INVALIDO'
  | 'NUMERO_INVALIDO'
  | 'FECHA_INVALIDA'
  | 'SIN_LINEAS'
  | 'LINEA_INVALIDA'
  | 'IVA_EN_FACTURA_C'
  | 'ALICUOTA_NO_DEDUCIBLE'
  | 'ALICUOTA_DESCONOCIDA'
  | 'MONEDA_NO_SOPORTADA'
  | 'COTIZACION_INVALIDA'
  | 'SERVICIO_SIN_PERIODO'
  | 'PERIODO_INVALIDO'
  | 'PERCEPCIONES_NO_SOPORTADAS'
  | 'IMPORTE_NO_POSITIVO';

export interface Problema {
  readonly codigo: CodigoDeProblema;
  readonly mensaje: string;
}

export interface ComprobanteArmado {
  readonly cabecera: CabeceraLote;
  readonly detalle: DetalleComprobante;
  /** Lo que se decidió y por qué, para guardarlo junto a la intención fiscal y poder auditarlo. */
  readonly resumen: {
    readonly letra: LetraDeComprobante;
    readonly cbteTipo: number;
    readonly concepto: 1 | 2 | 3;
    readonly condicionIvaReceptorId: number;
    readonly importeTotal: string;
    readonly importeNeto: string;
    readonly importeIva: string;
    readonly importeNoGravado: string;
    readonly importeExento: string;
    readonly alicuotas: ReadonlyArray<{ readonly id: number; readonly baseImponible: string; readonly importe: string }>;
  };
  /** Cosas que no impiden armar pero que quien emite tiene que saber. */
  readonly avisos: readonly string[];
}

export type ResultadoDeArmado =
  | { readonly ok: true; readonly comprobante: ComprobanteArmado }
  | { readonly ok: false; readonly problemas: readonly Problema[] };

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// La letra
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * La letra que le corresponde a una factura, o por qué no se puede decidir (RG 1415, arts. 15 y 16).
 *
 * Exportada porque la pantalla también necesita saberla antes de armar nada («esta factura va a ser una B»).
 */
export function letraDeFactura(
  emisor: CondicionIvaDelSistema,
  receptor: CondicionIvaDelSistema,
): { readonly ok: true; readonly letra: LetraDeComprobante } | { readonly ok: false; readonly problema: Problema } {
  if (emisor === 'MONOTRIBUTO' || emisor === 'EXENTO') return { ok: true, letra: 'C' };
  if (emisor !== 'RESPONSABLE_INSCRIPTO') {
    return {
      ok: false,
      problema: {
        codigo: 'EMISOR_CONDICION_NO_SOPORTADA',
        mensaje:
          `La condición del emisor (${emisor}) no permite emitir: hace falta declararlo como responsable inscripto, ` +
          'monotributista o exento. Es una decisión del titular (D1 del plan de emisión) y no se supone.',
      },
    };
  }
  switch (receptor) {
    case 'RESPONSABLE_INSCRIPTO':
    case 'MONOTRIBUTO':
      return { ok: true, letra: 'A' };
    case 'EXENTO':
    case 'CONSUMIDOR_FINAL':
    case 'NO_CATEGORIZADO':
      return { ok: true, letra: 'B' };
    case 'DESCONOCIDA':
      return {
        ok: false,
        problema: {
          codigo: 'RECEPTOR_CONDICION_DESCONOCIDA',
          mensaje:
            'No se sabe la condición del receptor frente al IVA. Sin ella no se puede elegir la letra, y desde la RG 5616/2024 ' +
            'ARCA rechaza (10246) el comprobante que no la informa. Declarala en la ficha del cliente.',
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// El armado
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MONEDAS_DE_ARCA: Readonly<Partial<Record<Currency, string>>> = { ARS: 'PES', USD: 'DOL' };

/** `"21.0"` → `"21"`, `"10,50"` → `"10.5"`: para comparar porcentajes como texto, sin convertirlos a número. */
function porcentajeNormal(texto: string): string {
  return texto.trim().replace(',', '.').replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
}

const aaaammdd = (fecha: string): string => fecha.replaceAll('-', '');

function dinero(texto: string, moneda: Currency): Money | null {
  try {
    return moneyFromDecimalString(texto, moneda);
  } catch {
    return null;
  }
}

/** El `Id` de la alícuota que explica exactamente `iva` sobre `neto`, o por qué no hay una sola. */
function deducirAlicuota(neto: Money, iva: Money): { id: number } | { error: string } {
  if (iva.amount === 0n) return { id: 3 }; // 0 %: un IVA en cero sobre una base gravada es la alícuota cero.
  const coinciden = ALICUOTAS_DE_ARCA.filter(
    (a) => a.id !== 3 && multiplyByRate(neto, rate(a.porcentaje, { percent: true }), 'HALF_UP').amount === iva.amount,
  );
  if (coinciden.length === 1) return { id: coinciden[0]!.id };
  return {
    error:
      coinciden.length === 0
        ? 'el IVA no es exactamente el de ninguna alícuota de ARCA sobre ese neto'
        : 'el IVA coincide con más de una alícuota',
  };
}

export function armarComprobante(entrada: EntradaDeArmado): ResultadoDeArmado {
  const problemas: Problema[] = [];
  const avisos: string[] = [];
  const falla = (codigo: CodigoDeProblema, mensaje: string): void => {
    problemas.push({ codigo, mensaje });
  };

  const moneda: Currency = entrada.moneda ?? 'ARS';
  const monId = MONEDAS_DE_ARCA[moneda];
  if (monId === undefined) {
    falla('MONEDA_NO_SOPORTADA', `La moneda ${moneda} todavía no se emite: hoy sólo pesos (ARS) y dólares (USD).`);
  }
  let cotizacion = '1';
  if (monId !== undefined && moneda !== 'ARS') {
    const c = entrada.cotizacion === undefined ? null : /^\d+(\.\d{1,6})?$/u.exec(entrada.cotizacion);
    if (c === null || /^0+(\.0+)?$/u.test(entrada.cotizacion ?? '')) {
      falla('COTIZACION_INVALIDA', 'Una factura en moneda extranjera necesita la cotización: un decimal positivo de hasta 6 decimales.');
    } else {
      cotizacion = entrada.cotizacion as string;
    }
  }
  const monedaDeCalculo: Currency = monId === undefined ? 'ARS' : moneda;

  // Emisor
  if (!isValidCuit(entrada.emisor.cuit)) {
    falla('EMISOR_INVALIDO', 'El CUIT del emisor no es válido (dígito verificador).');
  }

  // La letra
  const letra = letraDeFactura(entrada.emisor.condicionIva, entrada.receptor.condicionIva);
  if (!letra.ok) falla(letra.problema.codigo, letra.problema.mensaje);

  // Receptor: condición y documento
  let condicionReceptorId = 0;
  if (entrada.receptor.condicionIva !== 'DESCONOCIDA') {
    condicionReceptorId = CONDICION_RECEPTOR_ID[entrada.receptor.condicionIva];
    if (letra.ok && !CONDICIONES_ADMITIDAS_POR_LETRA[letra.letra].includes(condicionReceptorId)) {
      falla(
        'RECEPTOR_CONDICION_NO_ADMITIDA',
        `ARCA no admite la condición del receptor (${entrada.receptor.condicionIva}) en una factura clase ${letra.letra}.`,
      );
    }
  }

  let docTipo: number = DOC_TIPO.OTRO;
  let docNro = '0';
  const numeroDoc = entrada.receptor.numeroDocumento === null ? '' : entrada.receptor.numeroDocumento.trim();
  switch (entrada.receptor.tipoDocumento) {
    case 'CUIT':
    case 'CUIL':
      docTipo = entrada.receptor.tipoDocumento === 'CUIT' ? DOC_TIPO.CUIT : DOC_TIPO.CUIL;
      if (!isValidCuit(numeroDoc)) falla('RECEPTOR_DOCUMENTO_INVALIDO', `El ${entrada.receptor.tipoDocumento} del receptor no es válido (dígito verificador).`);
      else docNro = normalizeCuit(numeroDoc);
      break;
    case 'DNI':
      docTipo = DOC_TIPO.DNI;
      if (!/^\d{7,8}$/u.test(numeroDoc)) falla('RECEPTOR_DOCUMENTO_INVALIDO', 'El DNI del receptor tiene que tener 7 u 8 dígitos.');
      else docNro = numeroDoc;
      break;
    case 'PASAPORTE':
      docTipo = DOC_TIPO.PASAPORTE;
      if (!/^[A-Za-z0-9]{3,20}$/u.test(numeroDoc)) falla('RECEPTOR_DOCUMENTO_INVALIDO', 'El pasaporte del receptor no tiene un formato válido.');
      else docNro = numeroDoc;
      break;
    case 'SIN_IDENTIFICAR':
      if (entrada.receptor.condicionIva !== 'CONSUMIDOR_FINAL') {
        falla('RECEPTOR_DOCUMENTO_INVALIDO', 'Sólo un consumidor final puede quedar sin identificar: los demás receptores se identifican.');
      } else {
        avisos.push(
          'Receptor sin identificar: ARCA exige identificar al consumidor final a partir de un monto que fija y cambia. ' +
            'NEXO todavía no lo verifica; si el importe lo supera, ARCA rechazará el comprobante.',
        );
      }
      break;
    case 'DOC_EXTRANJERO':
      falla('RECEPTOR_NO_SOPORTADO', 'Los documentos extranjeros todavía no se emiten (corresponde otro tipo de comprobante).');
      break;
  }
  if (letra.ok && letra.letra === 'A' && docTipo !== DOC_TIPO.CUIT && entrada.receptor.tipoDocumento !== 'DOC_EXTRANJERO') {
    falla('RECEPTOR_SIN_CUIT_PARA_FACTURA_A', 'Una factura clase A se emite a un receptor identificado por CUIT.');
  }

  // Punto de venta, número, fecha
  if (!Number.isInteger(entrada.puntoDeVenta) || entrada.puntoDeVenta < 1 || entrada.puntoDeVenta > 99_999) {
    falla('PUNTO_DE_VENTA_INVALIDO', 'El punto de venta tiene que ser un entero entre 1 y 99999.');
  }
  if (!Number.isSafeInteger(entrada.numero) || entrada.numero < 1) {
    falla('NUMERO_INVALIDO', 'El número de comprobante tiene que ser un entero positivo (el que reservó NEXO).');
  }
  if (!isCalendarDate(entrada.fecha)) falla('FECHA_INVALIDA', 'La fecha del comprobante no es una fecha válida (AAAA-MM-DD).');

  // Líneas
  if (entrada.lineas.length === 0) falla('SIN_LINEAS', 'Un comprobante necesita al menos una línea.');

  let neto = 0n;
  let exento = 0n;
  let noGravado = 0n;
  let iva = 0n;
  let hayServicio = false;
  let hayProducto = false;
  const grupos = new Map<number, { base: bigint; iva: bigint }>();
  const esC = letra.ok && letra.letra === 'C';

  entrada.lineas.forEach((l, i) => {
    const n = i + 1;
    const lineaNeto = dinero(l.neto, monedaDeCalculo);
    const lineaIva = dinero(l.iva, monedaDeCalculo);
    if (lineaNeto === null || lineaIva === null || lineaNeto.amount < 0n || lineaIva.amount < 0n) {
      falla('LINEA_INVALIDA', `Línea ${n}: neto e IVA tienen que ser decimales exactos, no negativos y de hasta 2 decimales.`);
      return;
    }
    if (l.tipo === 'SERVICIO') hayServicio = true;
    else hayProducto = true;

    if (esC) {
      // Una factura C no discrimina IVA: el IVA de la línea tiene que ser cero y todo suma al neto.
      if (lineaIva.amount !== 0n) {
        falla('IVA_EN_FACTURA_C', `Línea ${n}: una factura clase C no discrimina IVA, y la línea trae IVA.`);
        return;
      }
      neto += lineaNeto.amount;
      return;
    }

    if (l.tratamiento === 'GRAVADO') {
      let id: number | null = null;
      if (l.alicuota !== undefined) {
        const pedida = porcentajeNormal(l.alicuota);
        const dada = ALICUOTAS_DE_ARCA.find((a) => a.porcentaje === pedida);
        if (dada === undefined) {
          falla('ALICUOTA_DESCONOCIDA', `Línea ${n}: ${l.alicuota} % no es una alícuota que ARCA conozca.`);
          return;
        }
        const esperado = multiplyByRate(lineaNeto, rate(dada.porcentaje, { percent: true }), 'HALF_UP');
        if (esperado.amount !== lineaIva.amount) {
          falla('ALICUOTA_NO_DEDUCIBLE', `Línea ${n}: el IVA no es el ${l.alicuota} % del neto (daría ${toDecimalString(esperado)}).`);
          return;
        }
        id = dada.id;
      } else {
        const d = deducirAlicuota(lineaNeto, lineaIva);
        if ('error' in d) {
          falla('ALICUOTA_NO_DEDUCIBLE', `Línea ${n}: ${d.error}. Indicá la alícuota de la línea.`);
          return;
        }
        id = d.id;
      }
      neto += lineaNeto.amount;
      iva += lineaIva.amount;
      const g = grupos.get(id) ?? { base: 0n, iva: 0n };
      grupos.set(id, { base: g.base + lineaNeto.amount, iva: g.iva + lineaIva.amount });
    } else {
      if (lineaIva.amount !== 0n) {
        falla('LINEA_INVALIDA', `Línea ${n}: una línea ${l.tratamiento === 'EXENTO' ? 'exenta' : 'no gravada'} no puede llevar IVA.`);
        return;
      }
      if (l.tratamiento === 'EXENTO') exento += lineaNeto.amount;
      else noGravado += lineaNeto.amount;
    }
  });

  // Percepciones / tributos
  if (entrada.percepciones !== undefined) {
    const p = dinero(entrada.percepciones, monedaDeCalculo);
    if (p === null || p.amount !== 0n) {
      falla('PERCEPCIONES_NO_SOPORTADAS', 'Los tributos y percepciones todavía no se emiten: tiene que ser cero (E3 no los arma).');
    }
  }

  // Concepto y período del servicio
  const concepto: 1 | 2 | 3 = hayServicio && hayProducto ? 3 : hayServicio ? 2 : 1;
  let periodo: { desde: string; hasta: string; vto: string } | null = null;
  if (concepto !== 1) {
    const s = entrada.servicio;
    if (s === undefined) {
      falla('SERVICIO_SIN_PERIODO', 'El comprobante incluye servicios: hace falta el período del servicio y la fecha de vencimiento del pago.');
    } else if (![s.desde, s.hasta, s.vencimientoDePago].every(isCalendarDate)) {
      falla('PERIODO_INVALIDO', 'El período del servicio y el vencimiento del pago tienen que ser fechas válidas (AAAA-MM-DD).');
    } else if (compareDates(s.desde as CalendarDate, s.hasta as CalendarDate) > 0) {
      falla('PERIODO_INVALIDO', 'El servicio no puede terminar antes de empezar.');
    } else if (isCalendarDate(entrada.fecha) && compareDates(s.vencimientoDePago as CalendarDate, entrada.fecha as CalendarDate) < 0) {
      falla('PERIODO_INVALIDO', 'El vencimiento del pago no puede ser anterior a la fecha del comprobante.');
    } else {
      periodo = { desde: s.desde, hasta: s.hasta, vto: s.vencimientoDePago };
    }
  }

  // Totales: el total no se recibe, se calcula.
  const impNeto = neto;
  const impIva = iva;
  const total = impNeto + exento + noGravado + impIva;
  if (entrada.lineas.length > 0 && total <= 0n && problemas.length === 0) {
    falla('IMPORTE_NO_POSITIVO', 'El total del comprobante tiene que ser mayor que cero.');
  }

  if (problemas.length > 0 || !letra.ok || monId === undefined) {
    return { ok: false, problemas };
  }

  // Aviso: el IVA informado versus el que daría la base agrupada (lo decide ARCA al autorizar).
  const alicuotas: AlicuotaIva[] = [];
  const resumenAlicuotas: Array<{ id: number; baseImponible: string; importe: string }> = [];
  if (letra.letra !== 'C') {
    for (const [id, g] of [...grupos.entries()].sort((a, b) => a[0] - b[0])) {
      const m = (x: bigint): Money => moneyFromDecimalString(bigATexto(x), monedaDeCalculo);
      alicuotas.push({ Id: id, BaseImp: toDecimalString(m(g.base)), Importe: toDecimalString(m(g.iva)) });
      resumenAlicuotas.push({ id, baseImponible: toDecimalString(m(g.base)), importe: toDecimalString(m(g.iva)) });
      const porc = ALICUOTAS_DE_ARCA.find((a) => a.id === id)!.porcentaje;
      const sobreLaBase = multiplyByRate(m(g.base), rate(porc, { percent: true }), 'HALF_UP').amount;
      if (sobreLaBase !== g.iva) {
        avisos.push(
          `El IVA informado de la alícuota ${porc} % (${toDecimalString(m(g.iva))}) difiere del que da la base agrupada ` +
            `(${toDecimalString(m(sobreLaBase))}) por el redondeo línea por línea: ARCA decide al autorizar.`,
        );
      }
    }
  }

  const monto = (x: bigint): string => toDecimalString(moneyFromDecimalString(bigATexto(x), monedaDeCalculo));
  const cbteTipo = CBTE_TIPO_FACTURA[letra.letra];

  const detalle: DetalleComprobante = {
    Concepto: concepto,
    DocTipo: docTipo,
    DocNro: docNro,
    CbteDesde: entrada.numero,
    CbteHasta: entrada.numero,
    CbteFch: aaaammdd(entrada.fecha),
    ImpTotal: monto(total),
    ImpTotConc: monto(noGravado),
    ImpNeto: monto(impNeto),
    ImpOpEx: monto(exento),
    ImpTrib: monto(0n),
    ImpIVA: monto(impIva),
    ...(periodo === null
      ? {}
      : { FchServDesde: aaaammdd(periodo.desde), FchServHasta: aaaammdd(periodo.hasta), FchVtoPago: aaaammdd(periodo.vto) }),
    MonId: monId,
    MonCotiz: cotizacion,
    CondicionIVAReceptorId: condicionReceptorId,
    // Una factura C no manda el nodo `Iva` (ni vacío): es el rechazo más común.
    ...(alicuotas.length > 0 ? { Iva: alicuotas } : {}),
  };

  return {
    ok: true,
    comprobante: {
      cabecera: { CantReg: 1, PtoVta: entrada.puntoDeVenta, CbteTipo: cbteTipo },
      detalle,
      resumen: {
        letra: letra.letra,
        cbteTipo,
        concepto,
        condicionIvaReceptorId: condicionReceptorId,
        importeTotal: monto(total),
        importeNeto: monto(impNeto),
        importeIva: monto(impIva),
        importeNoGravado: monto(noGravado),
        importeExento: monto(exento),
        alicuotas: resumenAlicuotas,
      },
      avisos,
    },
  };
}

/** Centavos enteros → texto decimal con dos decimales, sin pasar por un número de punto flotante. */
function bigATexto(centavos: bigint): string {
  const negativo = centavos < 0n;
  const abs = (negativo ? -centavos : centavos).toString().padStart(3, '0');
  return `${negativo ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}
