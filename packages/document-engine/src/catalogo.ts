/**
 * Catálogo de tipos de comprobante.
 *
 * Este archivo documenta un hallazgo de FASE 3b que conviene no perder:
 *
 * **ARCA no publica la tabla de tipos de comprobante como una constante. Publica
 * el método para pedirla, y cada entrada tiene `FchDesde` y `FchHasta`.**
 *
 * En el manual del wsfev1 v4.6 archivado, `FEParamGetTiposCbte` devuelve
 * `<Id> <Desc> <FchDesde> <FchHasta>`; y el manual del WSCDC v4 dice que
 * `CbteTipo` "debe ser alguno de los definidos en el método
 * `ComprobantesTipoConsultar()`". Es decir: la tabla es **normativa versionada
 * en el tiempo**, exactamente como una alícuota o un mínimo no imponible.
 *
 * La consecuencia de diseño es directa y sigue al §6: cablear un `Record` con
 * los códigos de hoy haría que un comprobante de 2019 se interpretara con la
 * tabla de 2026. Por eso el catálogo real vive en base de datos, se sincroniza
 * desde el organismo y se consulta **por fecha**.
 *
 * Lo de abajo es una **semilla**, no la fuente de verdad. Cada entrada está
 * transcripta del texto archivado en
 * `docs/normative-sources/originals/ARCA_manual_desarrollador_wsfev1_v4.6.pdf`,
 * sección "Controles aplicados al objeto <FeCabReq>", campo `CbteTipo`
 * ("Obligatorio. Valores permitidos:"). Es el subconjunto que ese manual
 * enumera: no es el universo completo de tipos de comprobante del régimen.
 *
 * Códigos que aparecen en el manual **sin descripción** —5, 34, 39, 40, 60, 61,
 * 88, 991 y otros, citados como comprobantes asociables— no se inventan acá. Un
 * código sin fuente devuelve `null`, y la UI muestra el número tal cual.
 */

export interface TipoComprobante {
  readonly codigo: number;
  readonly descripcion: string;
  /** Letra impresa, cuando la descripción oficial la incluye. */
  readonly letra: 'A' | 'B' | 'C' | null;
  readonly clase: 'FACTURA' | 'NOTA_DEBITO' | 'NOTA_CREDITO' | 'RECIBO' | 'LIQUIDACION';
}

/** Cita exacta de la fuente V1 de la que sale la semilla. */
export const FUENTE_SEMILLA = {
  documento: 'ARCA_manual_desarrollador_wsfev1_v4.6.pdf',
  seccion: 'Controles aplicados al objeto <FeCabReq> — campo CbteTipo',
  metodoAutoritativo: 'FEParamGetTiposCbte',
  nivelVerificacion: 'V1',
} as const;

const SEMILLA: readonly TipoComprobante[] = [
  { codigo: 1, descripcion: 'Factura A', letra: 'A', clase: 'FACTURA' },
  { codigo: 2, descripcion: 'Nota de Débito A', letra: 'A', clase: 'NOTA_DEBITO' },
  { codigo: 3, descripcion: 'Nota de Crédito A', letra: 'A', clase: 'NOTA_CREDITO' },
  { codigo: 4, descripcion: 'Recibo A', letra: 'A', clase: 'RECIBO' },
  { codigo: 6, descripcion: 'Factura B', letra: 'B', clase: 'FACTURA' },
  { codigo: 7, descripcion: 'Nota de Débito B', letra: 'B', clase: 'NOTA_DEBITO' },
  { codigo: 8, descripcion: 'Nota de Crédito B', letra: 'B', clase: 'NOTA_CREDITO' },
  { codigo: 9, descripcion: 'Recibo B', letra: 'B', clase: 'RECIBO' },
  { codigo: 11, descripcion: 'Factura C', letra: 'C', clase: 'FACTURA' },
  { codigo: 12, descripcion: 'Nota de Débito C', letra: 'C', clase: 'NOTA_DEBITO' },
  { codigo: 13, descripcion: 'Nota de Crédito C', letra: 'C', clase: 'NOTA_CREDITO' },
  { codigo: 15, descripcion: 'Recibo C', letra: 'C', clase: 'RECIBO' },
  {
    codigo: 51,
    descripcion: 'Factura "A con leyenda operación sujeta a retención" (CAEA observa comprobante)',
    letra: 'A',
    clase: 'FACTURA',
  },
  {
    codigo: 52,
    descripcion:
      'Nota de Débito "A con leyenda operación sujeta a retención" (CAEA observa comprobante)',
    letra: 'A',
    clase: 'NOTA_DEBITO',
  },
  {
    codigo: 53,
    descripcion:
      'Nota de Crédito "A con leyenda operación sujeta a retención" (CAEA observa comprobante)',
    letra: 'A',
    clase: 'NOTA_CREDITO',
  },
  {
    codigo: 54,
    descripcion: 'Recibo "A con leyenda operación sujeta a retención"',
    letra: 'A',
    clase: 'RECIBO',
  },
  { codigo: 63, descripcion: 'Liquidaciones A', letra: 'A', clase: 'LIQUIDACION' },
  { codigo: 64, descripcion: 'Liquidaciones B', letra: 'B', clase: 'LIQUIDACION' },
  {
    codigo: 201,
    descripcion: 'Factura de Crédito electrónica MiPyMEs (FCE) A',
    letra: 'A',
    clase: 'FACTURA',
  },
  {
    codigo: 202,
    descripcion: 'Nota de Débito electrónica MiPyMEs (FCE) A',
    letra: 'A',
    clase: 'NOTA_DEBITO',
  },
  {
    codigo: 203,
    descripcion: 'Nota de Crédito electrónica MiPyMEs (FCE) A',
    letra: 'A',
    clase: 'NOTA_CREDITO',
  },
  {
    codigo: 206,
    descripcion: 'Factura de Crédito electrónica MiPyMEs (FCE) B',
    letra: 'B',
    clase: 'FACTURA',
  },
  {
    codigo: 207,
    descripcion: 'Nota de Débito electrónica MiPyMEs (FCE) B',
    letra: 'B',
    clase: 'NOTA_DEBITO',
  },
  {
    codigo: 208,
    descripcion: 'Nota de Crédito electrónica MiPyMEs (FCE) B',
    letra: 'B',
    clase: 'NOTA_CREDITO',
  },
  {
    codigo: 211,
    descripcion: 'Factura de Crédito electrónica MiPyMEs (FCE) C',
    letra: 'C',
    clase: 'FACTURA',
  },
  {
    codigo: 212,
    descripcion: 'Nota de Débito electrónica MiPyMEs (FCE) C',
    letra: 'C',
    clase: 'NOTA_DEBITO',
  },
  {
    codigo: 213,
    descripcion: 'Nota de Crédito electrónica MiPyMEs (FCE) C',
    letra: 'C',
    clase: 'NOTA_CREDITO',
  },
];

const POR_CODIGO = new Map(SEMILLA.map((tipo) => [tipo.codigo, tipo]));

/**
 * Busca un tipo en la semilla. Devuelve `null` si no está: un código que no
 * figura en la fuente archivada no se describe de memoria.
 */
export function tipoComprobanteSemilla(codigo: number): TipoComprobante | null {
  return POR_CODIGO.get(codigo) ?? null;
}

export function semillaCompleta(): readonly TipoComprobante[] {
  return SEMILLA;
}

/**
 * Puerto del catálogo real, resuelto por fecha.
 *
 * La implementación que consulta la base y sincroniza contra el organismo llega
 * con FASE 8. Hasta entonces, `CatalogoSemilla` responde con la semilla y avisa
 * que la vigencia no está verificada — que es distinto de responder como si lo
 * estuviera.
 */
export interface CatalogoComprobantes {
  buscar(codigo: number, fecha: string): Promise<ResultadoCatalogo>;
}

export interface ResultadoCatalogo {
  readonly tipo: TipoComprobante | null;
  /** `false` mientras la vigencia por fecha no se resuelva contra el organismo. */
  readonly vigenciaVerificada: boolean;
  readonly fuente: string;
}

export class CatalogoSemilla implements CatalogoComprobantes {
  async buscar(codigo: number, fecha: string): Promise<ResultadoCatalogo> {
    // La fecha se recibe y se ignora: la semilla no tiene vigencias. Ignorarla
    // en silencio sería el error —por eso `vigenciaVerificada` viaja en `false`.
    void fecha;
    return {
      tipo: tipoComprobanteSemilla(codigo),
      vigenciaVerificada: false,
      fuente: `Semilla transcripta de ${FUENTE_SEMILLA.documento}. La vigencia por fecha exige sincronizar ${FUENTE_SEMILLA.metodoAutoritativo}.`,
    };
  }
}
