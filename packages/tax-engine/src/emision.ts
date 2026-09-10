/**
 * La seguridad de la emisión fiscal, como reglas puras.
 *
 * ## Qué problema resuelve este archivo, dicho sin rodeos
 *
 * Emitir un comprobante es pedirle a ARCA que autorice una factura a nombre del
 * contribuyente. **Eso no se deshace.** Un comprobante autorizado de más no se
 * borra: se anula con una nota de crédito, que es otro comprobante, con su
 * numeración y su impacto contable.
 *
 * Y la llamada que lo produce puede terminar sin respuesta. Ahí aparece el caso
 * que ordena todo el diseño:
 *
 *     mandé el pedido → se cortó → **no sé si ARCA lo autorizó**
 *
 * La reacción intuitiva —reintentar— es exactamente la que duplica la factura.
 * Por eso este archivo existe: para que «no sé» sea un estado con nombre, con
 * transiciones propias, y **sin ninguna que lleve a pedir un CAE nuevo**.
 *
 * ## Por qué es puro y vive en `tax-engine`
 *
 * No abre conexiones, no escribe en la base y no conoce ARCA. Son las reglas, y
 * separarlas del transporte permite ejercitarlas enteras —incluidas las ramas
 * que en producción aparecerían una vez cada mil emisiones— sin una credencial
 * y sin red.
 *
 * El transporte vive en `@aai/arca-emision`, que **sigue aislado del grafo de
 * la aplicación** (`.dependency-cruiser.cjs`). Este archivo no lo levanta: lo
 * que hace es dejar escritas las reglas que habrá que cumplir el día que esa
 * regla se saque a sabiendas.
 */

/**
 * Los estados de una intención fiscal.
 *
 * Nótese que son estados de **la intención**, no del comprobante. Un
 * comprobante existe cuando ARCA lo autorizó; antes hay una intención de
 * emitirlo, que es lo que hay que poder rastrear cuando algo sale mal.
 */
export type EstadoDeEmision =
  /** Se declaró la intención. Todavía no se reservó número ni se llamó a nadie. */
  | 'BORRADOR'
  /** Número reservado y datos completos. Lista para salir. */
  | 'LISTA'
  /** La llamada está en curso. **Nadie más puede tocar esta intención.** */
  | 'EMITIENDO'
  /** ARCA contestó y autorizó. Hay CAE con su vencimiento. */
  | 'AUTORIZADA'
  /** ARCA contestó y rechazó, con su código y su motivo. */
  | 'RECHAZADA'
  /**
   * **El estado que ordena el diseño.** Se mandó y no se sabe qué pasó: timeout
   * después de transmitir, 5xx, proceso muerto a mitad de camino.
   *
   * De acá **no se sale pidiendo otro CAE**. Se sale preguntándole a ARCA.
   */
  | 'DESCONOCIDA'
  /** Se está averiguando qué pasó, contra el organismo. */
  | 'RECONCILIANDO'
  /** Se abandonó antes de que ARCA autorizara nada. */
  | 'ANULADA';

/**
 * Qué transición puede seguir a cuál.
 *
 * Escrito como mapa y no como una cadena de `if`: una transición que no está
 * acá **no existe**, y agregarla obliga a escribirla en un solo lugar donde se
 * ve al lado de todas las demás.
 */
const SIGUIENTES: Readonly<Record<EstadoDeEmision, readonly EstadoDeEmision[]>> = {
  BORRADOR: ['LISTA', 'ANULADA'],
  LISTA: ['EMITIENDO', 'ANULADA'],
  // Los cuatro desenlaces posibles de una llamada, y ninguno más.
  EMITIENDO: ['AUTORIZADA', 'RECHAZADA', 'DESCONOCIDA'],
  // **Terminal.** Un comprobante autorizado no se re-emite: se anula con una
  // nota de crédito, que es otra intención fiscal con su propio número.
  AUTORIZADA: [],
  // Rechazada es terminal para ESTA intención. Corregir y volver a intentar es
  // una intención nueva, con número nuevo: el que se reservó ya se consumió
  // ante ARCA aunque el comprobante no exista.
  RECHAZADA: [],
  // De «no sé» solo se sale averiguando. **No hay arista a EMITIENDO.**
  DESCONOCIDA: ['RECONCILIANDO'],
  // La averiguación termina en una de las dos certezas, o vuelve a la duda si
  // no se pudo resolver todavía.
  RECONCILIANDO: ['AUTORIZADA', 'RECHAZADA', 'DESCONOCIDA'],
  ANULADA: [],
};

export function puedeTransicionar(desde: EstadoDeEmision, hacia: EstadoDeEmision): boolean {
  return SIGUIENTES[desde].includes(hacia);
}

/** Los estados desde los que ya no se mueve nada. */
export function esTerminal(estado: EstadoDeEmision): boolean {
  return SIGUIENTES[estado].length === 0;
}

/**
 * ¿Se puede pedir un CAE estando en este estado?
 *
 * Es la pregunta más importante del módulo y por eso es una función y no una
 * comparación suelta en quien emite. `DESCONOCIDA` contesta **no**: es
 * literalmente el caso de la doble emisión.
 */
export function puedePedirCae(estado: EstadoDeEmision): boolean {
  return estado === 'LISTA';
}

/** ¿Hace falta averiguar qué pasó antes de hacer cualquier otra cosa? */
export function requiereReconciliacion(estado: EstadoDeEmision): boolean {
  return estado === 'DESCONOCIDA' || estado === 'RECONCILIANDO';
}

// ---------------------------------------------------------------------------
// Cómo se lee un fallo de la llamada
// ---------------------------------------------------------------------------

/**
 * Qué pasó al intentar emitir, desde el punto de vista de **qué sabemos**.
 *
 * La clasificación no es por tipo de error técnico: es por si el pedido pudo
 * haber llegado. Un timeout de conexión y un timeout de lectura son el mismo
 * error para un cliente HTTP y son cosas opuestas para una emisión fiscal.
 */
export type DesenlaceDeLlamada =
  /** No salió de acá: DNS, conexión rechazada, certificado local inválido. */
  | 'NO_SE_ENVIO'
  /** ARCA contestó y autorizó. */
  | 'AUTORIZO'
  /** ARCA contestó y rechazó, con código. */
  | 'RECHAZO'
  /** Se transmitió y no llegó respuesta, o llegó una que no se puede interpretar. */
  | 'SIN_RESPUESTA';

/**
 * A qué estado lleva cada desenlace.
 *
 * `NO_SE_ENVIO` es el único que devuelve a `LISTA`, y solo porque significa que
 * **el pedido no llegó a salir**. Cualquier duda sobre si salió cae en
 * `DESCONOCIDA`, que es el lado conservador: preguntar de más cuesta una
 * consulta; emitir de más cuesta una factura.
 */
export function estadoSegunDesenlace(desenlace: DesenlaceDeLlamada): EstadoDeEmision {
  switch (desenlace) {
    case 'NO_SE_ENVIO':
      return 'LISTA';
    case 'AUTORIZO':
      return 'AUTORIZADA';
    case 'RECHAZO':
      return 'RECHAZADA';
    case 'SIN_RESPUESTA':
      return 'DESCONOCIDA';
  }
}

/**
 * ¿Se puede reintentar solo, sin intervención?
 *
 * Únicamente cuando consta que el pedido no salió. Todo lo demás exige que
 * alguien —o la reconciliación— averigüe primero.
 */
export function reintentoSeguro(desenlace: DesenlaceDeLlamada): boolean {
  return desenlace === 'NO_SE_ENVIO';
}

// ---------------------------------------------------------------------------
// La evidencia de que ARCA autorizó
// ---------------------------------------------------------------------------

/**
 * Lo mínimo que hace falta para poder decir «autorizada».
 *
 * NEXO **no puede** marcar una emisión como autorizada porque la venta exista,
 * porque el pedido se haya armado o porque la transacción local haya cerrado
 * bien. La autoridad sobre la autorización es ARCA, y la prueba es el CAE con
 * su vencimiento y el número que quedó autorizado.
 */
export interface EvidenciaDeAutorizacion {
  readonly cae: string;
  /** `AAAAMMDD`, tal como lo devuelve el servicio. */
  readonly caeVencimiento: string;
  readonly numeroAutorizado: number;
}

export type MotivoSinEvidencia =
  | 'CAE_VACIO'
  | 'CAE_NO_NUMERICO'
  | 'VENCIMIENTO_INVALIDO'
  | 'NUMERO_INVALIDO'
  | 'NUMERO_DISTINTO_DEL_RESERVADO';

/**
 * ¿La evidencia alcanza para escribir `AUTORIZADA`?
 *
 * El último motivo es el que más importa y el menos evidente:
 * **`numeroAutorizado` tiene que ser el que se reservó.** Si ARCA autorizó otro
 * número, lo que se autorizó no es lo que se pidió, y guardarlo como si fuera
 * lo mismo dejaría la numeración de la empresa describiendo algo que no pasó.
 */
export function verificarEvidencia(
  evidencia: EvidenciaDeAutorizacion,
  numeroReservado: number,
): { readonly valida: true } | { readonly valida: false; readonly motivo: MotivoSinEvidencia } {
  if (evidencia.cae.trim() === '') return { valida: false, motivo: 'CAE_VACIO' };
  // El CAE es una cadena de dígitos. Se valida como cadena y no como número: es
  // largo, y convertirlo a `number` le comería precisión.
  if (!/^\d{8,}$/u.test(evidencia.cae)) return { valida: false, motivo: 'CAE_NO_NUMERICO' };
  if (!/^\d{8}$/u.test(evidencia.caeVencimiento)) {
    return { valida: false, motivo: 'VENCIMIENTO_INVALIDO' };
  }
  if (!Number.isInteger(evidencia.numeroAutorizado) || evidencia.numeroAutorizado <= 0) {
    return { valida: false, motivo: 'NUMERO_INVALIDO' };
  }
  if (evidencia.numeroAutorizado !== numeroReservado) {
    return { valida: false, motivo: 'NUMERO_DISTINTO_DEL_RESERVADO' };
  }
  return { valida: true };
}

// ---------------------------------------------------------------------------
// Reconciliación: qué dice el último autorizado
// ---------------------------------------------------------------------------

/**
 * Qué se concluye al preguntarle a ARCA por dónde va la numeración.
 *
 * `FECompUltimoAutorizado` devuelve el último número autorizado para un punto
 * de venta y un tipo. Comparado contra el número que esta intención reservó,
 * resuelve la duda:
 *
 *     último ≥ reservado   el comprobante **existe**. Falta recuperar su CAE.
 *     último = reservado−1 ARCA nunca lo autorizó: se puede dar por rechazado.
 *     último < reservado−1 algo no cierra: hay un hueco que este razonamiento
 *                          no explica, y adivinar sería peor que decirlo.
 *
 * Es el único mecanismo de reconciliación que este repositorio puede usar hoy
 * sin inventar nada: está implementado en `@aai/arca-emision` y su manual está
 * archivado con hash.
 */
export type VeredictoDeReconciliacion =
  | 'EXISTE_FALTA_RECUPERAR_CAE'
  | 'NO_SE_AUTORIZO'
  | 'INCONSISTENTE';

export function reconciliarPorUltimoAutorizado(
  ultimoAutorizado: number,
  numeroReservado: number,
): VeredictoDeReconciliacion {
  if (ultimoAutorizado >= numeroReservado) return 'EXISTE_FALTA_RECUPERAR_CAE';
  if (ultimoAutorizado === numeroReservado - 1) return 'NO_SE_AUTORIZO';
  return 'INCONSISTENTE';
}

// ---------------------------------------------------------------------------
// La clave de idempotencia
// ---------------------------------------------------------------------------

/**
 * Qué identifica a una intención fiscal.
 *
 * **No es la petición HTTP.** Es la operación comercial: la misma venta, pedida
 * dos veces, es una sola intención de emitir. Dos ventas distintas son dos.
 *
 * Por eso no entran acá el sello de tiempo, un uuid nuevo por reintento, la IP
 * ni el identificador de sesión: todos cambian entre dos intentos de emitir
 * **lo mismo**, que es justo cuando la clave tiene que coincidir.
 *
 * El ambiente forma parte de la clave a propósito: la misma venta emitida en
 * homologación y en producción son dos hechos distintos ante el organismo, y
 * confundirlos haría que una prueba bloqueara la emisión real.
 */
export interface IntencionFiscal {
  readonly companyId: string;
  readonly ambiente: 'homologacion' | 'produccion';
  /** Qué originó la intención: hoy, un documento comercial. */
  readonly origenTipo: string;
  /** El identificador estable de ese origen. */
  readonly origenId: string;
}

/**
 * Separador de la clave. Ninguno de los campos puede contenerlo.
 *
 * U+001F —separador de unidad— y no un guion ni una barra: los uuid y los
 * nombres de origen no lo contienen nunca, asi que dos tuplas distintas no
 * pueden colapsar en la misma clave. Se escribe con la secuencia de escape y
 * no con el caracter literal porque el literal es invisible en el editor y se
 * pierde en el primer reformateo sin que nadie lo note.
 *
 * NO se usa U+0000, que seria el separador natural: PostgreSQL lo rechaza
 * dentro de un text, y esta clave se guarda en una columna. Es el mismo
 * defecto que el motor de migracion ya se comio una vez.
 */
const SEPARADOR = '';

/**
 * La clave, derivada y no generada.
 *
 * Determinística: los mismos datos dan la misma clave, en este proceso y en el
 * de dentro de un año. Eso es lo que hace que sobreviva a un reinicio, a un
 * despliegue y a un reintento desde otra máquina.
 */
export function claveDeIntencion(intencion: IntencionFiscal): string {
  const partes = [
    intencion.companyId,
    intencion.ambiente,
    intencion.origenTipo,
    intencion.origenId,
  ];

  for (const parte of partes) {
    if (parte.includes(SEPARADOR)) {
      throw new Error('Un componente de la clave de intención fiscal contiene el separador.');
    }
    if (parte.trim() === '') {
      throw new Error('Un componente de la clave de intención fiscal está vacío.');
    }
  }

  return partes.join(SEPARADOR);
}
