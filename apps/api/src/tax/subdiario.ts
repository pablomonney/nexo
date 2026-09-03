/**
 * La carga del subdiario de IVA desde la base.
 *
 * Vivía dentro de `routes/vat.ts`, y salió de ahí cuando el Diario resumido
 * pasó a necesitar exactamente lo mismo: el resumen mensual del art. 327 tiene
 * que surgir **del subdiario**, no de una suma paralela hecha sobre el Diario.
 * Dos armados distintos del mismo subdiario serían dos respuestas posibles a
 * "de dónde surge este asiento resumido", que es justo lo que el artículo pide
 * poder verificar.
 */

import {
  armarLibroIvaDigital,
  comoSubdiarioDeclarado,
  construirSubdiario,
  exportarSubdiarioCsv,
  type AlicuotaRelevada,
  type ClaseComprobante,
  type ComprobanteIva,
  type CondicionIva,
  type DireccionIva,
  type EstadoLibroIva,
  type ResultadoConstatacion,
  type Subdiario,
} from '@aai/tax-engine';
import { hashDeLibro } from '@aai/accounting-engine';
import type { Tx } from '@aai/db';
import {
  calendarDate,
  daysInMonth,
  moneyFromDecimalString,
  parseCalendarDate,
  type Currency,
} from '@aai/shared';

const MONEDA: Currency = 'ARS';

// ---------------------------------------------------------------------------
// Carga desde la base
// ---------------------------------------------------------------------------

/**
 * Alícuotas vigentes, con su norma.
 *
 * Devuelve un array vacío cuando `tax_rates` no tiene nada vigente a esa fecha —
 * porque nadie corrió `npm run tax:seed`, o porque el comprobante es anterior al
 * 18/11/2002, que es el borde hasta donde llega el texto ordenado archivado. El
 * motor lo traduce a `SIN_ALICUOTAS_RELEVADAS`; no hay ningún camino por el que
 * acá aparezca un 21% de la nada.
 */
export async function cargarAlicuotas(tx: Tx): Promise<AlicuotaRelevada[]> {
  const result = await tx.query<{
    id: string;
    label: string;
    numerator: string;
    denominator: string;
    valid_from: string;
    valid_to: string | null;
    norm_version_id: string;
  }>(
    `SELECT r.id, r.label, r.numerator::text, r.denominator::text,
            r.valid_from::text, r.valid_to::text, r.norm_version_id
       FROM tax_rates r
       JOIN taxes t ON t.id = r.tax_id
      WHERE t.code = 'IVA'`,
  );

  return result.rows.map((fila) => ({
    id: fila.id,
    numerador: BigInt(fila.numerator),
    denominador: BigInt(fila.denominator),
    etiqueta: fila.label,
    vigenteDesde: parseCalendarDate(fila.valid_from),
    vigenteHasta: fila.valid_to === null ? null : parseCalendarDate(fila.valid_to),
    normVersionId: fila.norm_version_id,
  }));
}

export interface FiltroComprobantes {
  readonly txId?: string;
  readonly desde?: string;
  readonly hasta?: string;
  readonly direccion?: DireccionIva;
}

/**
 * Operaciones de IVA con su clase resuelta **por fecha**.
 *
 * El `LEFT JOIN` contra `arca_comprobante_types` usa la fecha del comprobante,
 * no `now()`. Es la diferencia entre saber qué era la 991 en 2019 y saber qué es
 * hoy — y de la clase depende si el comprobante suma o resta en el período.
 */
export async function cargarComprobantes(
  tx: Tx,
  companyId: string,
  filtro: FiltroComprobantes,
): Promise<ComprobanteIva[]> {
  const result = await tx.query<{
    id: string;
    direction: DireccionIva;
    cbte_tipo: number;
    clase: ClaseComprobante | null;
    punto_venta: number;
    cbte_numero: string;
    cbte_fecha: string;
    cuit_contraparte: string | null;
    razon_social: string | null;
    condicion_iva: CondicionIva;
    neto: string;
    iva: string;
    no_gravado: string;
    exento: string;
    percepciones: string;
    total: string;
    tax_rate_id: string | null;
    constatacion: ResultadoConstatacion;
    emisor_apocrifo: boolean | null;
    entry_id: string | null;
    document_id: string | null;
  }>(
    `SELECT t.id, t.direction, t.cbte_tipo, ct.clase,
            t.punto_venta, t.cbte_numero::text, t.cbte_fecha::text,
            t.cuit_contraparte, t.razon_social, t.condicion_iva,
            t.neto::text, t.iva::text, t.no_gravado::text, t.exento::text,
            t.percepciones::text, t.total::text,
            t.tax_rate_id, t.constatacion, t.emisor_apocrifo,
            t.entry_id::text, t.document_id::text
       FROM tax_transactions t
       LEFT JOIN arca_comprobante_types ct
              ON ct.codigo = t.cbte_tipo
             AND (ct.valid_from IS NULL OR ct.valid_from <= t.cbte_fecha)
             AND (ct.valid_to IS NULL OR ct.valid_to >= t.cbte_fecha)
      WHERE t.company_id = $1
        AND ($2::uuid IS NULL OR t.id = $2::uuid)
        AND ($3::date IS NULL OR t.cbte_fecha >= $3::date)
        AND ($4::date IS NULL OR t.cbte_fecha <= $4::date)
        AND ($5::text IS NULL OR t.direction = $5)
      ORDER BY t.cbte_fecha, t.punto_venta, t.cbte_numero`,
    [
      companyId,
      filtro.txId ?? null,
      filtro.desde ?? null,
      filtro.hasta ?? null,
      filtro.direccion ?? null,
    ],
  );

  return result.rows.map((fila) => ({
    id: fila.id,
    direccion: fila.direction,
    tipoComprobante: fila.cbte_tipo,
    clase: fila.clase,
    puntoVenta: fila.punto_venta,
    numero: Number(fila.cbte_numero),
    fecha: parseCalendarDate(fila.cbte_fecha),
    cuitContraparte: fila.cuit_contraparte,
    razonSocialContraparte: fila.razon_social,
    condicionContraparte: fila.condicion_iva,
    renglones: [
      {
        neto: moneyFromDecimalString(fila.neto, MONEDA),
        iva: moneyFromDecimalString(fila.iva, MONEDA),
        noGravado: moneyFromDecimalString(fila.no_gravado, MONEDA),
        exento: moneyFromDecimalString(fila.exento, MONEDA),
        alicuotaId: fila.tax_rate_id,
      },
    ],
    percepciones: moneyFromDecimalString(fila.percepciones, MONEDA),
    total: moneyFromDecimalString(fila.total, MONEDA),
    constatacion: fila.constatacion,
    emisorApocrifo: fila.emisor_apocrifo,
    entryId: fila.entry_id,
    documentId: fila.document_id,
  }));
}

export async function armarSubdiario(
  tx: Tx,
  companyId: string,
  direccion: DireccionIva,
  anio: number,
  mes: number,
): Promise<Subdiario> {
  const desde = calendarDate(anio, mes, 1);
  const hasta = calendarDate(anio, mes, daysInMonth(anio, mes));
  const catalogo = await cargarAlicuotas(tx);
  const comprobantes = await cargarComprobantes(tx, companyId, {
    desde,
    hasta,
    direccion,
  });

  return construirSubdiario(comprobantes, {
    companyId,
    direccion,
    anio,
    mes,
    desde,
    hasta,
    moneda: MONEDA,
    catalogo,
  });
}

export async function armarLibro(
  tx: Tx,
  companyId: string,
  anio: number,
  mes: number,
): Promise<{
  resumen: ReturnType<typeof armarLibroIvaDigital>;
  compras: Subdiario;
  ventas: Subdiario;
}> {
  const compras = await armarSubdiario(tx, companyId, 'COMPRAS', anio, mes);
  const ventas = await armarSubdiario(tx, companyId, 'VENTAS', anio, mes);

  const anteriorMes = mes === 1 ? 12 : mes - 1;
  const anteriorAnio = mes === 1 ? anio - 1 : anio;
  const anterior = await tx.query<{ status: EstadoLibroIva }>(
    `SELECT status FROM vat_books WHERE company_id = $1 AND anio = $2 AND mes = $3`,
    [companyId, anteriorAnio, anteriorMes],
  );

  return {
    resumen: armarLibroIvaDigital({
      companyId,
      periodo: { anio, mes },
      comprobantesCompras: compras.renglones.length,
      comprobantesVentas: ventas.renglones.length,
      excluidos: compras.excluidos.length + ventas.excluidos.length,
      // Sin fila del período anterior no se afirma que esté generado ni que no:
      // `null` significa "no hay antecedente en el sistema", que es distinto de
      // "está pendiente". La empresa puede haber empezado a operar acá este mes.
      periodoAnterior:
        anterior.rows[0] === undefined
          ? null
          : {
              periodo: { anio: anteriorAnio, mes: anteriorMes },
              estado: anterior.rows[0].status,
            },
    }),
    compras,
    ventas,
  };
}
/**
 * El subdiario, su archivo y la declaración que lo respalda.
 *
 * Los tres juntos y en un solo lugar: la declaración dice "existe este detalle"
 * y el hash dice **cuál**. Separarlos permitiría declarar un subdiario y
 * archivar otro, que es la afirmación que el art. 327 pide poder verificar.
 */
export async function declararSubdiario(
  tx: Tx,
  companyId: string,
  direccion: DireccionIva,
  anio: number,
  mes: number,
): Promise<{
  subdiario: Subdiario;
  csv: string;
  sha256: string;
  declarado: ReturnType<typeof comoSubdiarioDeclarado>;
}> {
  const subdiario = await armarSubdiario(tx, companyId, direccion, anio, mes);
  const csv = exportarSubdiarioCsv(subdiario);
  const sha256 = hashDeLibro(csv);
  return {
    subdiario,
    csv,
    sha256,
    declarado: comoSubdiarioDeclarado(subdiario, sha256),
  };
}
