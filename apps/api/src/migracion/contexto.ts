/**
 * Lo que los escritores necesitan saber de la empresa antes de escribir.
 *
 * ## Por qué existe
 *
 * Un comprobante migrado necesita el período de su fecha, el id del IVA y el
 * tercero que corresponde a su CUIT. Un movimiento de stock necesita el
 * producto y el depósito. Un asiento necesita la cuenta. Si cada escritor
 * consultara eso por su cuenta, una importación de 50.000 filas haría 200.000
 * consultas para resolver siempre los mismos veinte valores.
 *
 * Este contexto los resuelve una vez y los recuerda. Es una caché **de una
 * corrida**: se arma al empezar la importación y se descarta al terminar, así
 * que no puede quedar desactualizada entre migraciones.
 *
 * ## Lo que NO hace
 *
 * No crea nada por su cuenta salvo lo que está explícitamente dicho abajo (el
 * plan de cuentas vacío y el depósito por omisión, los dos con su motivo).
 * Cuando algo falta, devuelve `null` y el escritor decide si eso es un error o
 * una advertencia — porque depende de la entidad, y el contexto no la conoce.
 */

import type { Tx } from '@aai/db';

export interface PeriodoDeLaFecha {
  readonly id: string;
  readonly fiscalYearId: string;
  readonly status: 'ABIERTO' | 'BLOQUEADO' | 'CERRADO';
}

export interface CuentaConocida {
  readonly id: string;
  readonly code: string;
  readonly isPostable: boolean;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export class ContextoDeImportacion {
  readonly #tx: Tx;
  readonly #companyId: string;
  readonly #actor: string;
  readonly #migracionId: string;
  readonly #fechaCorte: string | null;

  readonly #terceros = new Map<string, string>();
  readonly #productos = new Map<string, string>();
  readonly #depositos = new Map<string, string>();
  readonly #cuentas = new Map<string, CuentaConocida>();
  readonly #periodos = new Map<string, PeriodoDeLaFecha | null>();

  #ivaId: string | null | undefined = undefined;
  #chartId: string | null = null;
  #depositoPorOmision: string | null | undefined = undefined;
  #tiposDeComprobante: Map<string, number> | null = null;

  constructor(
    tx: Tx,
    datos: {
      readonly companyId: string;
      readonly actor: string;
      readonly migracionId: string;
      readonly fechaCorte: string | null;
    },
  ) {
    this.#tx = tx;
    this.#companyId = datos.companyId;
    this.#actor = datos.actor;
    this.#migracionId = datos.migracionId;
    this.#fechaCorte = datos.fechaCorte;
  }

  get tx(): Tx {
    return this.#tx;
  }
  get companyId(): string {
    return this.#companyId;
  }
  get actor(): string {
    return this.#actor;
  }
  /** De qué migración viene lo que se escribe. Va en `stock_movements.origen_id`. */
  get migracionId(): string {
    return this.#migracionId;
  }
  /**
   * A qué fecha está la foto que se trae, o `null` si nadie la declaró.
   *
   * `null` no es «hoy»: una existencia de apertura sin fecha no se registra, y
   * el escritor lo dice. Fechar hoy una existencia de hace dos años le pondría
   * al libro un movimiento en el momento equivocado.
   */
  get fechaCorte(): string | null {
    return this.#fechaCorte;
  }

  /** El impuesto IVA del catálogo. Sin él no se puede registrar un comprobante. */
  async iva(): Promise<string | null> {
    if (this.#ivaId === undefined) {
      const { rows } = await this.#tx.query<{ id: string }>(
        "SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1",
      );
      this.#ivaId = rows[0]?.id ?? null;
    }
    return this.#ivaId;
  }

  /**
   * El plan de cuentas donde entran las cuentas migradas.
   *
   * Se crea uno si la empresa no tiene ninguno. Es la única creación implícita
   * del contexto y tiene el mismo motivo que la de `POST /accounts`: un plan de
   * cuentas vacío no es una decisión contable, es el recipiente. La primera
   * cuenta sí lo es, y esa la trae el archivo.
   */
  async planDeCuentas(): Promise<string> {
    if (this.#chartId !== null) return this.#chartId;
    const existente = await this.#tx.query<{ id: string }>(
      'SELECT id FROM account_charts WHERE company_id = $1 ORDER BY version DESC LIMIT 1',
      [this.#companyId],
    );
    if (existente.rows[0] !== undefined) {
      this.#chartId = existente.rows[0].id;
      return this.#chartId;
    }
    const creado = await this.#tx.query<{ id: string }>(
      `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan de cuentas')
       RETURNING id`,
      [this.#companyId],
    );
    this.#chartId = creado.rows[0]!.id;
    return this.#chartId;
  }

  /** El período que contiene esa fecha, o `null` si la empresa no tiene ninguno. */
  async periodoDe(fecha: string): Promise<PeriodoDeLaFecha | null> {
    const recordado = this.#periodos.get(fecha);
    if (recordado !== undefined) return recordado;

    const { rows } = await this.#tx.query<{
      id: string;
      fiscal_year_id: string;
      status: PeriodoDeLaFecha['status'];
    }>(
      `SELECT id, fiscal_year_id, status FROM periods
        WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date
        LIMIT 1`,
      [this.#companyId, fecha],
    );
    const fila = rows[0];
    const periodo =
      fila === undefined
        ? null
        : { id: fila.id, fiscalYearId: fila.fiscal_year_id, status: fila.status };
    this.#periodos.set(fecha, periodo);
    return periodo;
  }

  /** Un tercero por su CUIT. No lo crea: el escritor decide qué hacer si falta. */
  async terceroPorCuit(cuit: string): Promise<string | null> {
    const recordado = this.#terceros.get(cuit);
    if (recordado !== undefined) return recordado;

    const { rows } = await this.#tx.query<{ id: string }>(
      `SELECT id FROM parties
        WHERE company_id = $1 AND numero_documento = $2 AND tipo_documento IN ('CUIT','CUIL')
        LIMIT 1`,
      [this.#companyId, cuit],
    );
    const id = rows[0]?.id ?? null;
    if (id !== null) this.#terceros.set(cuit, id);
    return id;
  }

  /** Un producto por su código. */
  async productoPorCodigo(codigo: string): Promise<string | null> {
    const recordado = this.#productos.get(codigo);
    if (recordado !== undefined) return recordado;

    const { rows } = await this.#tx.query<{ id: string }>(
      'SELECT id FROM products WHERE company_id = $1 AND code = $2 LIMIT 1',
      [this.#companyId, codigo],
    );
    const id = rows[0]?.id ?? null;
    if (id !== null) this.#productos.set(codigo, id);
    return id;
  }

  /** Un depósito por su código. */
  async depositoPorCodigo(codigo: string): Promise<string | null> {
    const recordado = this.#depositos.get(codigo);
    if (recordado !== undefined) return recordado;

    const { rows } = await this.#tx.query<{ id: string }>(
      'SELECT id FROM warehouses WHERE company_id = $1 AND code = $2 LIMIT 1',
      [this.#companyId, codigo],
    );
    const id = rows[0]?.id ?? null;
    if (id !== null) this.#depositos.set(codigo, id);
    return id;
  }

  /**
   * El depósito al que van los movimientos que no dicen a cuál.
   *
   * Se elige el único que tenga la empresa. Si tiene varios, **no se elige**:
   * repartir existencias entre depósitos es una decisión de inventario y
   * adivinarla pone mercadería donde no está. Si no tiene ninguno, tampoco se
   * crea: un depósito inventado es un lugar físico que no existe.
   */
  async depositoUnico(): Promise<string | null> {
    if (this.#depositoPorOmision === undefined) {
      const { rows } = await this.#tx.query<{ id: string }>(
        `SELECT id FROM warehouses WHERE company_id = $1 AND status = 'ACTIVO' LIMIT 2`,
        [this.#companyId],
      );
      this.#depositoPorOmision = rows.length === 1 ? rows[0]!.id : null;
    }
    return this.#depositoPorOmision;
  }

  /** Una cuenta por su código, con lo que hace falta para saber si admite imputación. */
  async cuentaPorCodigo(codigo: string): Promise<CuentaConocida | null> {
    const recordada = this.#cuentas.get(codigo);
    if (recordada !== undefined) return recordada;

    const { rows } = await this.#tx.query<{
      id: string;
      code: string;
      is_postable: boolean;
      status: 'ACTIVE' | 'ARCHIVED';
    }>('SELECT id, code, is_postable, status FROM accounts WHERE company_id = $1 AND code = $2', [
      this.#companyId,
      codigo,
    ]);
    const fila = rows[0];
    if (fila === undefined) return null;
    const cuenta: CuentaConocida = {
      id: fila.id,
      code: fila.code,
      isPostable: fila.is_postable,
      status: fila.status,
    };
    this.#cuentas.set(codigo, cuenta);
    return cuenta;
  }

  /**
   * El código ARCA de un tipo de comprobante, a partir de como lo escribió el
   * origen.
   *
   * `tax_transactions.cbte_tipo` es el número de ARCA, no un texto: el 1 es
   * Factura A y el 6 es Factura B. El catálogo `arca_comprobante_types` ya está
   * en la base con su fuente citada, así que la traducción sale de ahí y no de
   * una tabla nueva que se desincronizaría.
   *
   * Se reconocen tres formas, que son las tres en que los sistemas lo exportan:
   * el número («1»), la descripción («Factura A») y la clase con la letra
   * («FACTURA_A», «FACTURA A», «FC A»). Lo que no se reconoce devuelve `null` y
   * el escritor lo rechaza: el tipo decide en qué columna del libro de IVA cae
   * el comprobante, y adivinarlo cambia el impuesto de la empresa.
   */
  async tipoDeComprobante(crudo: string): Promise<number | null> {
    if (this.#tiposDeComprobante === null) {
      const { rows } = await this.#tx.query<{ codigo: number; descripcion: string; letra: string; clase: string }>(
        'SELECT codigo, descripcion, letra, clase FROM arca_comprobante_types',
      );
      const mapa = new Map<string, number>();
      for (const t of rows) {
        mapa.set(String(t.codigo), t.codigo);
        mapa.set(normalizarTipo(t.descripcion), t.codigo);
        mapa.set(normalizarTipo(`${t.clase} ${t.letra}`), t.codigo);
        // «FC A» y «ND B», que es como abrevian varios sistemas de gestión.
        mapa.set(normalizarTipo(`${ABREVIATURA[t.clase] ?? t.clase} ${t.letra}`), t.codigo);
      }
      this.#tiposDeComprobante = mapa;
    }
    return this.#tiposDeComprobante.get(normalizarTipo(crudo)) ?? null;
  }

  /**
   * Trae de una sola vez todo lo que la tanda va a preguntar.
   *
   * Sin esto, importar mil terceros hace mil consultas de «¿ya existe este
   * CUIT?», cada una con su ida y vuelta a la base. Medido con 20.000 filas, esa
   * clase de consulta era una de las dos que dominaban el tiempo. Con una
   * consulta por tanda el resultado es idéntico: la caché queda con lo mismo que
   * habría quedado preguntando de a uno.
   *
   * Solo precarga lo que existe. Una clave que no está no se recuerda como
   * ausente a propósito: entre una tanda y la siguiente el importador pudo
   * haberla creado, y recordar el `null` la escondería.
   */
  async precargar(claves: {
    readonly cuits?: readonly string[];
    readonly productos?: readonly string[];
    readonly depositos?: readonly string[];
    readonly cuentas?: readonly string[];
  }): Promise<void> {
    const pendientes = (lista: readonly string[] | undefined, cache: Map<string, unknown>): string[] =>
      [...new Set((lista ?? []).filter((c) => c !== '' && !cache.has(c)))];

    const cuits = pendientes(claves.cuits, this.#terceros);
    if (cuits.length > 0) {
      const { rows } = await this.#tx.query<{ id: string; numero_documento: string }>(
        `SELECT id, numero_documento FROM parties
          WHERE company_id = $1 AND tipo_documento IN ('CUIT','CUIL')
            AND numero_documento = ANY($2::text[])`,
        [this.#companyId, cuits],
      );
      for (const f of rows) this.#terceros.set(f.numero_documento, f.id);
    }

    const productos = pendientes(claves.productos, this.#productos);
    if (productos.length > 0) {
      const { rows } = await this.#tx.query<{ id: string; code: string }>(
        'SELECT id, code FROM products WHERE company_id = $1 AND code = ANY($2::text[])',
        [this.#companyId, productos],
      );
      for (const f of rows) this.#productos.set(f.code, f.id);
    }

    const depositos = pendientes(claves.depositos, this.#depositos);
    if (depositos.length > 0) {
      const { rows } = await this.#tx.query<{ id: string; code: string }>(
        'SELECT id, code FROM warehouses WHERE company_id = $1 AND code = ANY($2::text[])',
        [this.#companyId, depositos],
      );
      for (const f of rows) this.#depositos.set(f.code, f.id);
    }

    const cuentas = pendientes(claves.cuentas, this.#cuentas);
    if (cuentas.length > 0) {
      const { rows } = await this.#tx.query<{
        id: string;
        code: string;
        is_postable: boolean;
        status: 'ACTIVE' | 'ARCHIVED';
      }>(
        'SELECT id, code, is_postable, status FROM accounts WHERE company_id = $1 AND code = ANY($2::text[])',
        [this.#companyId, cuentas],
      );
      for (const f of rows) {
        this.#cuentas.set(f.code, {
          id: f.id,
          code: f.code,
          isPostable: f.is_postable,
          status: f.status,
        });
      }
    }
  }

  /** Se olvida de una cuenta recién creada, para que la próxima consulta la vea. */
  olvidarCuenta(codigo: string): void {
    this.#cuentas.delete(codigo);
  }

  /** Recuerda lo que se acaba de crear, para que el resto de la corrida lo encuentre. */
  recordarProducto(codigo: string, id: string): void {
    this.#productos.set(codigo, id);
  }
  recordarDeposito(codigo: string, id: string): void {
    this.#depositos.set(codigo, id);
    // Deja de valer «el único»: puede haber más de uno ahora.
    this.#depositoPorOmision = undefined;
  }
  recordarTercero(cuit: string, id: string): void {
    this.#terceros.set(cuit, id);
  }
}

/** Sin tildes, sin puntuación y en minúsculas: «FACTURA_A» y «Factura A» son lo mismo. */
const normalizarTipo = (crudo: string): string =>
  crudo
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Cómo abrevian los sistemas de gestión cada clase de comprobante. */
const ABREVIATURA: Readonly<Record<string, string>> = {
  FACTURA: 'FC',
  NOTA_DEBITO: 'ND',
  NOTA_CREDITO: 'NC',
  RECIBO: 'RC',
};
