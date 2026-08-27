/**
 * Los tipos del WSFEv1, transcriptos del contrato SOAP publicado por el servicio.
 *
 * Fuente: `docs/normative-sources/originals/ARCA_wsfev1_homologacion.wsdl`,
 * archivado con sha256 y bajado de
 * <https://wswhomo.afip.gov.ar/wsfev1/service.asmx?WSDL>.
 *
 * **El WSDL, no el manual.** El manual del desarrollador está archivado desde la
 * FASE 1 —`ARCA_manual_desarrollador_wsfev1_v4.6.pdf`— y su contenido está como
 * imagen: no se puede leer con una máquina, así que los nombres de campo no se
 * pudieron transcribir de ahí. El WSDL lo publica el mismo servicio, es legible,
 * y dice exactamente qué acepta el endpoint que va a recibir el pedido. Para
 * escribir un cliente es mejor fuente que el PDF.
 *
 * Los nombres van **tal cual el WSDL**, en su mayúscula original y en castellano
 * mezclado con inglés (`CbteFch`, `ImpTotConc`, `MonId`). No se traducen ni se
 * normalizan: el día que algo falle, el nombre del campo en el error de ARCA
 * tiene que ser buscable en este archivo.
 */

/** `FEAuthRequest`. Va en todas las operaciones. */
export interface Autenticacion {
  readonly Token: string;
  readonly Sign: string;
  /** `long` en el WSDL. Se maneja como string para no perder dígitos. */
  readonly Cuit: string;
}

/** `AlicIva`. `Id` sale de `FEParamGetTiposIva`, no de una constante nuestra. */
export interface AlicuotaIva {
  readonly Id: number;
  readonly BaseImp: number;
  readonly Importe: number;
}

/**
 * `FEDetRequest` — el comprobante.
 *
 * Los campos obligatorios (`minOccurs=1` en el WSDL) son los primeros doce.
 * `Iva`, `Tributos`, `CbtesAsoc` y el resto son opcionales, y **para una Factura
 * C no van**: el comprobante clase C no discrimina IVA. Mandar un array `Iva`
 * vacío o con una alícuota en cero es la causa más común de rechazo.
 */
export interface DetalleComprobante {
  /** 1 productos · 2 servicios · 3 productos y servicios. `FEParamGetTiposConcepto`. */
  readonly Concepto: number;
  /** `FEParamGetTiposDoc`. 99 = consumidor final sin identificar. */
  readonly DocTipo: number;
  readonly DocNro: string;
  readonly CbteDesde: number;
  readonly CbteHasta: number;
  /** `AAAAMMDD`. Sin guiones: el WSDL lo declara `string` y ARCA lo quiere así. */
  readonly CbteFch: string;
  readonly ImpTotal: number;
  /** No gravado. */
  readonly ImpTotConc: number;
  readonly ImpNeto: number;
  /** Exento. */
  readonly ImpOpEx: number;
  readonly ImpTrib: number;
  readonly ImpIVA: number;
  /** Obligatorios cuando `Concepto` es 2 o 3. `AAAAMMDD`. */
  readonly FchServDesde?: string;
  readonly FchServHasta?: string;
  readonly FchVtoPago?: string;
  readonly MonId: string;
  readonly MonCotiz: number;
  /** RG 5616/2024. `FEParamGetCondicionIvaReceptor`. */
  readonly CondicionIVAReceptorId?: number;
  readonly Iva?: readonly AlicuotaIva[];
}

/** `FECAECabRequest`. */
export interface CabeceraLote {
  readonly CantReg: number;
  readonly PtoVta: number;
  readonly CbteTipo: number;
}

export interface Observacion {
  readonly Code: number;
  readonly Msg: string;
}

export interface ErrorArca {
  readonly Code: number;
  readonly Msg: string;
}

/**
 * `CbteTipo` de `FEParamGetTiposCbte`, con los nombres del WSDL.
 *
 * Las fechas vienen en `yyyyMMdd` y `FchHasta` puede llegar como `NULL`: el tipo
 * sigue vigente. Se modela `null` y no una fecha lejana, porque "no tiene fecha
 * de baja" y "se da de baja en el año 9999" no son la misma afirmación.
 */
export interface TipoDeComprobanteArca {
  readonly Id: number;
  readonly Desc: string;
  readonly FchDesde: string | null;
  readonly FchHasta: string | null;
}

/** `FECAEDetResponse`. `Resultado` es `A` (aprobado), `R` (rechazado) o `P` (parcial). */
export interface RespuestaComprobante {
  readonly Concepto: number;
  readonly DocTipo: number;
  readonly DocNro: string;
  readonly CbteDesde: number;
  readonly CbteHasta: number;
  readonly CbteFch: string;
  readonly Resultado: string;
  readonly CAE: string | null;
  /** `AAAAMMDD`. */
  readonly CAEFchVto: string | null;
  readonly Observaciones: readonly Observacion[];
}

export interface RespuestaLote {
  readonly Resultado: string;
  readonly comprobantes: readonly RespuestaComprobante[];
  readonly errores: readonly ErrorArca[];
  readonly eventos: readonly Observacion[];
}

/**
 * Un comprobante autorizado, que es lo único que sirve para armar un PDF.
 *
 * `Resultado === 'A'` y `CAE !== null` son lo mismo en la práctica, pero el tipo
 * lo hace explícito: no existe un comprobante autorizado sin CAE, y no hay forma
 * de construir este objeto desde una respuesta rechazada.
 */
export interface ComprobanteAutorizado {
  readonly cuitEmisor: string;
  readonly ptoVta: number;
  readonly cbteTipo: number;
  readonly cbteNro: number;
  readonly cbteFch: string;
  readonly docTipo: number;
  readonly docNro: string;
  readonly impTotal: number;
  readonly moneda: string;
  readonly cotizacion: number;
  readonly cae: string;
  readonly caeFchVto: string;
  readonly concepto: string;
  /**
   * `E` para comprobante autorizado por CAE, `A` por CAEA.
   *
   * Lo exige el campo `tipoCodAut` del QR. Va acá y no como literal en la
   * especificación porque es una propiedad del comprobante —de cómo se
   * autorizó—, no del formato del código.
   */
  readonly tipoCodAut: 'E' | 'A';
}
