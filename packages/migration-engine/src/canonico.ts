/**
 * El modelo canónico: la única forma en que el núcleo mira los datos de afuera.
 *
 * ## Por qué existe
 *
 * Sin un modelo intermedio, cada sistema de origen tendría que conocer las
 * tablas de NEXO y NEXO tendría que conocer las de cada sistema. Con diez
 * orígenes y ocho entidades eso son ochenta caminos, y cada cambio en el
 * esquema de NEXO los toca a todos.
 *
 *     Tango  ─┐                    ┌─ parties
 *     CSV    ─┼→ modelo canónico →─┼─ products
 *     Odoo   ─┘                    └─ tax_transactions
 *
 * El adaptador traduce **de su origen al canónico** y no sabe nada de NEXO. El
 * importador traduce **del canónico a NEXO** y no sabe nada de ningún origen.
 * Un origen nuevo agrega un adaptador; no toca el importador.
 *
 * ## Todo campo llega en crudo
 *
 * Cada valor canónico conserva el texto tal como vino (`crudo`) además del
 * valor interpretado. No es redundancia: es lo que permite contestar «¿de dónde
 * salió este dato?» y lo que hace revisable una normalización. Un importe que
 * el sistema leyó como 1.234,56 y el origen escribió `1,234.56` es exactamente
 * el error que hay que poder ver después de importado.
 */

import type { CalendarDate } from '@aai/shared';

/** Las entidades que el motor sabe transportar. */
export const ENTIDADES = [
  'PARTY',
  'PRODUCT',
  'WAREHOUSE',
  'ACCOUNT',
  'JOURNAL_ENTRY',
  'STOCK_BALANCE',
  'STOCK_MOVEMENT',
  'SALES_DOCUMENT',
  'PURCHASE_DOCUMENT',
  'COLLECTION',
  'PAYMENT',
] as const;

export type Entidad = (typeof ENTIDADES)[number];

/**
 * Un valor que vino de afuera.
 *
 * `crudo` es lo que decía el origen, sin tocar. `valor` es la interpretación, o
 * `null` cuando no se pudo interpretar — y `null` significa «no se puede
 * afirmar», nunca cero ni cadena vacía, igual que en el resto de NEXO.
 */
export interface Campo<T> {
  readonly crudo: string;
  readonly valor: T | null;
  /** Por qué no se pudo interpretar, cuando `valor` es `null`. */
  readonly motivo?: string;
}

/** De dónde salió exactamente un registro. Es lo que hace auditable la migración. */
export interface Procedencia {
  /** Nombre del archivo, tabla o endpoint. */
  readonly origen: string;
  /** Número de fila, clave primaria o identificador dentro del origen. */
  readonly fila: string;
  /** El identificador que el sistema de origen le daba a esta entidad. */
  readonly idExterno: string | null;
  /** Hash del contenido crudo de la fila: detecta que la fuente cambió. */
  readonly hash: string;
}

export interface RegistroCanonico {
  readonly entidad: Entidad;
  readonly procedencia: Procedencia;
  /** Los campos ya normalizados, por nombre canónico. */
  readonly campos: Readonly<Record<string, Campo<unknown>>>;
}

// ---------------------------------------------------------------------------
// Las formas por entidad
// ---------------------------------------------------------------------------

/**
 * Qué campos tiene cada entidad y cuáles no pueden faltar.
 *
 * Está acá y no repartido entre el validador y el importador porque son la
 * misma pregunta —«¿qué necesita un cliente para ser un cliente?»— y contestada
 * en dos lugares se contesta distinto.
 */
export interface FormaDeEntidad {
  readonly entidad: Entidad;
  readonly obligatorios: readonly string[];
  readonly opcionales: readonly string[];
  /** Cómo se decide que dos registros son el mismo, en orden de confianza. */
  readonly identidad: readonly (readonly string[])[];
}

export const FORMAS: Readonly<Record<Entidad, FormaDeEntidad>> = {
  PARTY: {
    entidad: 'PARTY',
    obligatorios: ['razonSocial'],
    opcionales: [
      'cuit', 'tipo', 'condicionIva', 'email', 'telefono', 'direccion',
      'localidad', 'provincia', 'codigoPostal', 'codigoExterno',
    ],
    // El CUIT identifica a un contribuyente en Argentina: si coincide, es el
    // mismo. El código del sistema viejo es la segunda mejor evidencia.
    identidad: [['cuit'], ['codigoExterno'], ['email'], ['razonSocial']],
  },
  PRODUCT: {
    entidad: 'PRODUCT',
    obligatorios: ['sku', 'nombre'],
    opcionales: [
      'descripcion', 'unidad', 'precio', 'moneda', 'alicuotaIva', 'tratamiento', 'codigoExterno',
    ],
    identidad: [['sku'], ['codigoExterno']],
  },
  WAREHOUSE: {
    entidad: 'WAREHOUSE',
    obligatorios: ['codigo', 'nombre'],
    opcionales: ['direccion', 'codigoExterno'],
    identidad: [['codigo'], ['codigoExterno']],
  },
  ACCOUNT: {
    entidad: 'ACCOUNT',
    obligatorios: ['codigo', 'nombre'],
    opcionales: ['tipo', 'naturaleza', 'imputable', 'codigoPadre', 'moneda'],
    identidad: [['codigo']],
  },
  JOURNAL_ENTRY: {
    entidad: 'JOURNAL_ENTRY',
    obligatorios: ['fecha', 'cuenta', 'debe', 'haber'],
    opcionales: ['asiento', 'descripcion', 'libro', 'numero', 'codigoExterno'],
    identidad: [['codigoExterno'], ['asiento', 'cuenta']],
  },
  STOCK_BALANCE: {
    entidad: 'STOCK_BALANCE',
    obligatorios: ['sku', 'cantidad'],
    opcionales: ['deposito', 'costoUnitario', 'moneda', 'fechaCorte', 'lote', 'fechaVencimiento'],
    identidad: [['sku', 'deposito', 'lote'], ['sku', 'deposito']],
  },
  STOCK_MOVEMENT: {
    entidad: 'STOCK_MOVEMENT',
    obligatorios: ['sku', 'fecha', 'cantidad', 'tipo'],
    opcionales: [
      'deposito', 'costoUnitario', 'moneda', 'motivo', 'lote', 'fechaVencimiento', 'codigoExterno',
    ],
    // Sin código externo, la identidad la forma el movimiento entero: dos
    // movimientos idénticos el mismo día del mismo producto son, para el libro,
    // el mismo hecho contado dos veces — y el aviso lo dice en vez de decidir.
    identidad: [['codigoExterno'], ['sku', 'fecha', 'tipo', 'cantidad', 'deposito']],
  },

  // ── Los comprobantes ────────────────────────────────────────────────────
  //
  // Una exportación de ventas casi nunca trae una fila por comprobante: trae
  // una fila por **renglón**, con el número repetido. Por eso la forma lleva
  // los campos de la cabecera y los del renglón juntos, y el importador agrupa
  // por identidad — el mismo mecanismo con el que un asiento agrupa sus
  // renglones por número de asiento.
  //
  // Un archivo que sí trae una fila por comprobante sigue funcionando: es el
  // caso de un solo renglón por grupo.
  SALES_DOCUMENT: {
    entidad: 'SALES_DOCUMENT',
    obligatorios: ['fecha', 'numero', 'total'],
    opcionales: [
      'tipoComprobante', 'puntoVenta', 'cuitCliente', 'razonSocialCliente',
      'condicionIva', 'neto', 'iva', 'noGravado', 'exento', 'percepciones',
      'moneda', 'cae', 'codigoExterno',
      // Del renglón.
      'sku', 'descripcion', 'cantidad', 'unidad', 'precioUnitario', 'descuento', 'alicuotaIva',
      'tratamiento', 'netoRenglon', 'ivaRenglon',
    ],
    identidad: [['codigoExterno'], ['tipoComprobante', 'puntoVenta', 'numero']],
  },
  PURCHASE_DOCUMENT: {
    entidad: 'PURCHASE_DOCUMENT',
    obligatorios: ['fecha', 'numero', 'total'],
    opcionales: [
      'tipoComprobante', 'puntoVenta', 'cuitProveedor', 'razonSocialProveedor',
      'condicionIva', 'neto', 'iva', 'noGravado', 'exento', 'percepciones',
      'moneda', 'cae', 'codigoExterno',
      'sku', 'descripcion', 'cantidad', 'unidad', 'precioUnitario', 'descuento', 'alicuotaIva',
      'tratamiento', 'netoRenglon', 'ivaRenglon',
    ],
    identidad: [['codigoExterno'], ['cuitProveedor', 'tipoComprobante', 'puntoVenta', 'numero']],
  },

  COLLECTION: {
    entidad: 'COLLECTION',
    obligatorios: ['fecha', 'importe'],
    opcionales: [
      'medio', 'cuitCliente', 'razonSocialCliente', 'referencia', 'moneda',
      'comprobante', 'codigoExterno',
    ],
    identidad: [['codigoExterno'], ['fecha', 'importe', 'referencia']],
  },
  PAYMENT: {
    entidad: 'PAYMENT',
    obligatorios: ['fecha', 'importe'],
    opcionales: [
      'medio', 'cuitProveedor', 'razonSocialProveedor', 'referencia', 'moneda',
      'comprobante', 'codigoExterno',
    ],
    identidad: [['codigoExterno'], ['fecha', 'importe', 'referencia']],
  },
};

/** Los tipos que un campo canónico puede tomar, para el normalizador. */
export type TipoDeCampo = 'TEXTO' | 'CUIT' | 'FECHA' | 'IMPORTE' | 'CANTIDAD' | 'ENTERO' | 'BOOLEANO';

/**
 * De qué tipo es cada campo canónico.
 *
 * Un solo mapa para todas las entidades: los nombres canónicos no se repiten
 * con significados distintos, y mantener uno por entidad multiplicaría por
 * nueve el lugar donde equivocarse.
 */
export const TIPO_DE_CAMPO: Readonly<Record<string, TipoDeCampo>> = {
  cuit: 'CUIT',
  cuitCliente: 'CUIT',
  cuitProveedor: 'CUIT',
  cuitTercero: 'CUIT',
  fecha: 'FECHA',
  fechaCorte: 'FECHA',
  fechaVencimiento: 'FECHA',
  noGravado: 'IMPORTE',
  exento: 'IMPORTE',
  percepciones: 'IMPORTE',
  precioUnitario: 'IMPORTE',
  netoRenglon: 'IMPORTE',
  ivaRenglon: 'IMPORTE',
  descuento: 'IMPORTE',
  puntoVenta: 'ENTERO',
  numero: 'ENTERO',
  debe: 'IMPORTE',
  haber: 'IMPORTE',
  precio: 'IMPORTE',
  total: 'IMPORTE',
  neto: 'IMPORTE',
  iva: 'IMPORTE',
  importe: 'IMPORTE',
  costoUnitario: 'IMPORTE',
  cantidad: 'CANTIDAD',
  alicuotaIva: 'CANTIDAD',
  imputable: 'BOOLEANO',
};

export const tipoDe = (campo: string): TipoDeCampo => TIPO_DE_CAMPO[campo] ?? 'TEXTO';

/** Un valor canónico ya interpretado, según su tipo. */
export type ValorCanonico = string | number | bigint | CalendarDate | boolean;
