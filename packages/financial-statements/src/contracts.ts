/**
 * financial-statements — Estado de Situación Patrimonial y Estado de Resultados.
 *
 * Este archivo solo DEFINE; `index.ts` solo reexporta.
 *
 * ## La decisión que gobierna el paquete: la estructura es dato, no código
 *
 * El criterio de la fase es *"dos empresas con marcos distintos generan
 * estructuras distintas **sin cambiar código**"*. Eso descarta la forma en que
 * casi todos los sistemas contables arman un balance: un módulo por marco, con
 * los rubros escritos adentro y un `if` por regulador.
 *
 * Acá la plantilla es un árbol declarativo guardado en `statement_templates`,
 * versionado por `(marco, tipo de ente, regulador, período)` y **con la norma de
 * la que sale**. Agregar un marco es cargar una plantilla; el código no se toca.
 *
 * Y por eso mismo la plantilla hay que **validarla**: viene de la base, así que
 * no se puede confiar en que esté bien formada. Es el mismo razonamiento que el
 * intérprete cerrado del motor normativo.
 *
 * ## La segunda decisión: no existe forma de escribir un importe
 *
 * Ningún tipo de este archivo tiene un campo donde alguien ponga una cifra. Todo
 * renglón se **deriva** de saldos de cuentas, y todo renglón sale con la lista de
 * las cuentas que lo formaron. Es el §38 en el nivel de tipos: una cifra sin
 * origen no se puede representar.
 *
 * Fuente de la estructura: Ley 19.550 (T.O. 1984), arts. 63 (balance general) y
 * 64 (estado de resultados). Archivada en
 * `docs/normative-sources/originals/INFOLEG_LGS_19550_texto_actualizado.htm`.
 */

import type { CalendarDate, Money } from '@aai/shared';

export type TipoEstado = 'ESP' | 'ER';

/** Marco contable aplicable. Sale del motor normativo, no de una constante. */
export type MarcoContable = 'RT_FACPCE' | 'NIIF' | 'NIIF_PYMES' | 'ENTE_PEQUENO';

/**
 * Los mismos valores que `companies.entity_type`, ni uno más.
 *
 * La primera versión de este tipo tenía seis valores inventados desde la
 * intuición —`ASOCIACION` en vez de `ASOC_CIVIL`, sin `SA_299` ni
 * `FIDEICOMISO`—. Una plantilla no se habría podido cargar para media docena de
 * tipos de ente que la base sí admite, y el motor habría respondido "no hay
 * plantilla" para entes perfectamente normales.
 */
export type TipoEnte =
  | 'SA'
  | 'SA_299'
  | 'SRL'
  | 'SAS'
  | 'SOCIEDAD_SIMPLE'
  | 'ASOC_CIVIL'
  | 'FUNDACION'
  | 'COOPERATIVA'
  | 'MUTUAL'
  | 'SUCURSAL_EXTRANJERA'
  | 'UNIPERSONAL'
  | 'FIDEICOMISO';

/**
 * Los de `companies.regulator`, más `NINGUNO`.
 *
 * En la base la columna es nullable: un ente sin organismo de contralor tiene
 * `NULL`. Acá se representa con un valor propio en vez de `null` porque la
 * plantilla se busca **por** regulador, y buscar por `null` obliga a que cada
 * consulta se acuerde de tratarlo distinto.
 */
export type Regulador = 'IGJ' | 'CNV' | 'BCRA' | 'INAES' | 'PROVINCIAL' | 'NINGUNO';

/**
 * Qué cuentas alimentan un renglón.
 *
 * Un selector es **cerrado a propósito**: prefijo de código, tipo de cuenta y
 * rol fiscal. No hay expresiones ni condiciones arbitrarias.
 *
 * La tentación es permitir una condición general —"cualquier cuenta que cumpla
 * X"— y termina siendo un lenguaje que nadie puede auditar. Un perito tiene que
 * poder leer una plantilla y decir qué cuentas caen en cada rubro; con tres
 * criterios enumerables eso se puede, y con un lenguaje de expresiones no.
 */
export interface SelectorDeCuentas {
  /** Códigos que empiezan con alguno de estos prefijos. */
  readonly prefijos?: readonly string[];
  /** Tipos de cuenta admitidos. */
  readonly tipos?: readonly TipoCuenta[];
  /** Códigos exactos, para las excepciones que ningún prefijo captura. */
  readonly codigos?: readonly string[];
  /**
   * Códigos **exactos** que se excluyen aunque el prefijo los capture.
   *
   * Exactos, no prefijos: `'4.9'` no excluye a `'4.9.01'`. La asimetría con
   * `prefijos` es fácil de leer al revés —costó una plantilla mal armada, que
   * `CUENTA_EN_DOS_RUBROS` atrapó— así que para sacar una rama entera conviene
   * enumerar los prefijos que sí van, en vez de tomar uno ancho y descontar.
   */
  readonly excluir?: readonly string[];
}

export type TipoCuenta = 'ACTIVO' | 'PASIVO' | 'PN' | 'INGRESO' | 'COSTO' | 'GASTO' | 'ORDEN';

/**
 * Cómo se presenta el importe del renglón.
 *
 * `NATURAL` respeta el signo del saldo; `INVERTIDO` lo da vuelta. Existe porque
 * un pasivo tiene saldo acreedor —negativo en la convención del Mayor— y en el
 * ESP se expone positivo. Sin esto, la plantilla tendría que "saber" contabilidad
 * y volveríamos a poner reglas en el código.
 */
export type Presentacion = 'NATURAL' | 'INVERTIDO';

export type TipoNodo = 'RUBRO' | 'RENGLON' | 'TOTAL';

/**
 * Un nodo del árbol de la plantilla.
 *
 * - `RUBRO`: agrupa hijos. Su importe es la suma de ellos.
 * - `RENGLON`: toma su importe de las cuentas que el selector captura.
 * - `TOTAL`: suma otros nodos por código, incluso de otra rama. Es lo que
 *   permite "Total del activo" y la línea de control "Pasivo + PN".
 */
export interface NodoPlantilla {
  readonly codigo: string;
  readonly etiqueta: string;
  readonly tipo: TipoNodo;
  /** De qué artículo sale este rubro. Vacío no es una opción para un RUBRO. */
  readonly fundamento?: string;
  readonly presentacion?: Presentacion;
  readonly selector?: SelectorDeCuentas;
  /** Códigos de otros nodos que este TOTAL suma. */
  readonly suma?: readonly string[];
  readonly hijos?: readonly NodoPlantilla[];
  /** Nota complementaria a la que remite (FASE 11). */
  readonly nota?: number;
  /** Si el renglón se muestra cuando su importe es cero. */
  readonly ocultarSiCero?: boolean;
}

export interface PlantillaEstado {
  readonly id: string;
  readonly tipo: TipoEstado;
  readonly marco: MarcoContable;
  readonly tipoEnte: TipoEnte;
  readonly regulador: Regulador;
  readonly version: number;
  readonly vigenteDesde: CalendarDate;
  readonly vigenteHasta: CalendarDate | null;
  /** De qué versión de qué norma sale la estructura. `NOT NULL` en la base. */
  readonly normVersionId: string;
  readonly articulo: string;
  readonly raiz: readonly NodoPlantilla[];
  /**
   * Sobre qué tipos de cuenta se pronuncia este estado.
   *
   * Es lo que permite distinguir **una cuenta huérfana de una cuenta ajena**. Un
   * ESP no tiene renglones para cuentas de resultado, y eso no es un hueco de la
   * plantilla: es que el art. 63 no habla de ellas. Sin este dato el control de
   * cobertura recorría el plan entero y marcaba como huérfana a toda cuenta de
   * ingresos con saldo, lo que dejaba `emisible = false` a cualquier empresa con
   * un plan de cuentas completo.
   *
   * Va en la plantilla y no en el motor porque cada empresa puede tener la suya.
   */
  readonly alcance: AlcanceDelEstado;
  /**
   * Códigos de nodo **de esta plantilla** que forman Activo = Pasivo + PN.
   *
   * `undefined` en los estados que no tienen ecuación patrimonial. Vivía como
   * constante en la ruta, con códigos (`A`, `P`) que la plantilla sembrada no
   * tiene: el control detectaba los nodos faltantes y fallaba siempre.
   */
  readonly ecuacion?: EcuacionPatrimonial;
}

export interface AlcanceDelEstado {
  readonly tipos: readonly TipoCuenta[];
  /** De qué artículo sale el alcance. Sin fundamento sería una convención nuestra. */
  readonly fundamento: string;
}

export interface EcuacionPatrimonial {
  readonly activo: string;
  readonly pasivo: string;
  readonly patrimonioNeto: string;
}

/**
 * Por qué una cuenta está o no está en un estado.
 *
 * El sistema tiene que poder explicarlo por cuenta, no dar un booleano global:
 * «no aparece» y «aparece mal» mandan a corregir cosas distintas.
 */
export type SituacionDeCuenta =
  /** Su tipo está en el alcance y algún renglón la captura. */
  | 'CLASIFICADA'
  /** Su tipo está en el alcance y ningún renglón la captura. Bloquea. */
  | 'SIN_RUBRO'
  /** Su tipo está en el alcance y más de un renglón la captura. Bloquea. */
  | 'EN_DOS_RUBROS'
  /** Su tipo no está en el alcance y ningún renglón la tocó. Correcto. */
  | 'FUERA_DEL_ALCANCE'
  /** Su tipo no está en el alcance y un selector la capturó igual. Bloquea. */
  | 'CAPTURADA_FUERA_DEL_ALCANCE';

export interface ClasificacionDeCuenta {
  readonly accountId: string;
  readonly codigo: string;
  readonly tipo: TipoCuenta;
  readonly situacion: SituacionDeCuenta;
  /** Los renglones que la capturaron. Vacío si ninguno. */
  readonly renglones: readonly string[];
}

// ---------------------------------------------------------------------------
// Lo que entra
// ---------------------------------------------------------------------------

/**
 * Saldo de una cuenta al cierre, con lo suficiente para clasificarla.
 *
 * Viene del Mayor de FASE 7. El motor de estados **no consulta nada**: recibe
 * saldos ya resueltos, igual que el motor contable recibe su contexto.
 */
export interface SaldoDeCuenta {
  readonly accountId: string;
  readonly codigo: string;
  readonly nombre: string;
  readonly tipo: TipoCuenta;
  /** Positivo = deudor. Es la convención del Mayor. */
  readonly saldo: Money;
  readonly imputable: boolean;
}

// ---------------------------------------------------------------------------
// Lo que sale
// ---------------------------------------------------------------------------

/**
 * El origen de un renglón: las cuentas que lo formaron, con su aporte.
 *
 * Es el `lineage_id NOT NULL` de la base, expresado en tipos. **No hay ninguna
 * forma de construir un `RenglonEmitido` sin él**, y por eso el §38 —ninguna
 * cifra sin origen— no depende de que alguien se acuerde de completarlo.
 *
 * Un rubro sin cuentas es legítimo (un "Bienes de uso" en cero existe) y su
 * origen es la lista vacía: se preguntó y no hubo cuentas. Distinto de un
 * importe que alguien escribió.
 */
export interface OrigenDelRenglon {
  readonly accountId: string;
  readonly codigo: string;
  readonly aporte: Money;
}

export interface RenglonEmitido {
  readonly codigo: string;
  readonly etiqueta: string;
  readonly tipo: TipoNodo;
  readonly nivel: number;
  readonly importe: Money;
  /** Ejercicio anterior. `null` cuando no hay comparativo. */
  readonly comparativo: Money | null;
  readonly origen: readonly OrigenDelRenglon[];
  readonly nota: number | null;
  readonly fundamento: string | null;
}

export type CodigoControlEstado =
  | 'CUENTA_SIN_RUBRO'
  | 'CUENTA_EN_DOS_RUBROS'
  /**
   * Un selector capturó una cuenta cuyo tipo el estado declara no tratar.
   *
   * Es el control que nace de tener alcance: antes era invisible. Un renglón del
   * ESP que por un prefijo demasiado ancho se lleve una cuenta de gastos infla
   * el activo, y la ecuación patrimonial puede seguir cerrando si el mismo error
   * se repite del otro lado.
   */
  | 'CUENTA_FUERA_DE_ALCANCE'
  /**
   * Informativo, nunca bloquea: las cuentas que este estado no trata.
   *
   * Existe porque la pregunta «¿por qué esta cuenta no aparece?» tiene que tener
   * respuesta. Sin él, una cuenta ajena y una cuenta olvidada se ven igual: no
   * están.
   */
  | 'CUENTAS_FUERA_DEL_ALCANCE'
  | 'ECUACION_PATRIMONIAL'
  | 'RESULTADO_COHERENTE'
  | 'COMPARATIVO_MISMA_ESTRUCTURA'
  | 'TOTAL_REFERENCIA_INEXISTENTE';

export interface ControlDeEstado {
  readonly codigo: CodigoControlEstado;
  readonly cumple: boolean;
  readonly detalle: string;
  /** Los códigos de cuenta o de renglón involucrados. */
  readonly involucrados: readonly string[];
}

export interface EstadoContable {
  readonly plantillaId: string;
  readonly tipo: TipoEstado;
  readonly marco: MarcoContable;
  readonly companyId: string;
  readonly fechaCierre: CalendarDate;
  readonly fechaCierreComparativo: CalendarDate | null;
  readonly moneda: Money['currency'];
  readonly renglones: readonly RenglonEmitido[];
  readonly controles: readonly ControlDeEstado[];
  /**
   * Qué pasó con cada cuenta del plan, una por una.
   *
   * Es la respuesta a «¿por qué este número es este número?» del lado de la
   * entrada: los renglones dicen de qué cuentas sale cada importe, y esto dice
   * qué se hizo con cada cuenta —incluidas las que no entraron y por qué—.
   */
  readonly clasificacion: readonly ClasificacionDeCuenta[];
  /**
   * `false` inhabilita la emisión.
   *
   * A diferencia del Libro Diario —que se emite igual con sus observaciones
   * porque un libro con un hueco existe y hay que verlo—, un estado contable que
   * no cierra **no se emite**. El Diario es el registro de lo que pasó; el
   * estado contable es una afirmación sobre la situación patrimonial, y una
   * afirmación que no cierra es falsa.
   */
  readonly emisible: boolean;
  readonly motivo: string;
}
