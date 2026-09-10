/**
 * Los que saben escribir una entidad canónica en NEXO.
 *
 * ## Por qué hay uno por entidad y no un escritor genérico
 *
 * Porque cada tabla de NEXO tiene sus reglas y no son parametrizables. Un
 * tercero sin documento tiene que declarar `SIN_IDENTIFICAR` y dejar el número
 * en `null` —lo exige un CHECK—; un producto gravado necesita el id del
 * impuesto; un comprobante necesita que sus renglones sumen exactamente la
 * cabecera. Un escritor genérico que armara el INSERT desde el mapeo se
 * llevaría por delante esas reglas o las duplicaría en TypeScript, y ahí
 * empezarían a diferir.
 *
 * ## Una fila del origen no es siempre un registro de destino
 *
 * Un asiento son varios renglones; un comprobante también. Una exportación
 * trae una fila por renglón con el número repetido, así que el escritor recibe
 * **un grupo de filas** y escribe un registro. Las entidades donde una fila es
 * un registro reciben grupos de uno: es la misma forma, no dos caminos.
 *
 * ## Qué se escribe hoy, dicho sin adornos
 *
 * Nueve de las once entidades canónicas se escriben. Las dos que no —cobranzas
 * y comprobantes de compra sin proveedor conocido— no son un olvido: dicen su
 * motivo en `MOTIVO_SIN_ESCRITOR`, y ese texto se muestra en la pantalla. Lo
 * otro sería una migración que dice haber importado cobranzas y no importó
 * ninguna.
 */


import type { Campo, Entidad, RegistroCanonico } from '@aai/migration-engine';
import type { ContextoDeImportacion } from './contexto.js';

export interface ResultadoDeEscritura {
  readonly idDestino: string;
  readonly tabla: string;
  /** Lo que el escritor quiere que quede dicho aunque la fila haya entrado. */
  readonly advertencias?: readonly string[];
}

/** Por qué una fila no se pudo escribir. Es un rechazo, no una excepción. */
export class NoSePuedeEscribir extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'NoSePuedeEscribir';
  }
}

export interface Escritor {
  readonly entidad: Entidad;
  readonly tabla: string;
  /**
   * Por qué campo se agrupan las filas del origen antes de escribir.
   *
   * `null` cuando una fila es un registro. Cuando no lo es, las filas se
   * ordenan por esta clave y las que comparten valor forman un registro.
   */
  readonly agrupaPor: readonly string[] | null;
  /** Escribe el grupo y devuelve la fila creada. */
  escribir(ctx: ContextoDeImportacion, grupo: readonly RegistroCanonico[]): Promise<ResultadoDeEscritura>;
  /**
   * Busca una fila que ya represente a este registro, por los datos y no por la
   * migración. Es lo que evita duplicar un cliente que ya estaba cargado a mano
   * antes de migrar — la idempotencia por `migration_links` solo cubre lo que
   * entró por una migración anterior.
   */
  buscarExistente(ctx: ContextoDeImportacion, grupo: readonly RegistroCanonico[]): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Lectura de campos
// ---------------------------------------------------------------------------

const texto = (c: Campo<unknown> | undefined): string | null =>
  c?.valor === null || c?.valor === undefined ? null : String(c.valor);

const numero = (c: Campo<unknown> | undefined): number | null => {
  const v = c?.valor;
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Un importe, como cadena decimal con dos decimales.
 *
 * El normalizador guarda los importes en centavos —una cadena de dígitos, sin
 * coma flotante— y las columnas de NEXO son `numeric`. La conversión se hace
 * con texto y no con `Number`: 1.234.567,89 en centavos es 123456789, y pasarlo
 * por un `float` para dividirlo por cien es exactamente la forma de perder el
 * centavo que el proyecto entero evita.
 */
function importe(c: Campo<unknown> | undefined): string | null {
  const crudo = texto(c);
  if (crudo === null) return null;
  const negativo = crudo.startsWith('-');
  const digitos = (negativo ? crudo.slice(1) : crudo).padStart(3, '0');
  const entero = digitos.slice(0, -2);
  const centavos = digitos.slice(-2);
  return `${negativo ? '-' : ''}${entero}.${centavos}`;
}

const importeO = (c: Campo<unknown> | undefined, siFalta: string): string => importe(c) ?? siFalta;

/** Suma importes en centavos, sin pasar por coma flotante. */
const sumarCentavos = (valores: readonly (string | null)[]): bigint =>
  valores.reduce<bigint>((a, v) => a + (v === null ? 0n : BigInt(v)), 0n);

const enCentavos = (c: Campo<unknown> | undefined): string | null => texto(c);

/** Del centavo a la cadena decimal que espera `numeric(18,2)`. */
const centavosATexto = (n: bigint): string => {
  const negativo = n < 0n;
  const d = (negativo ? -n : n).toString().padStart(3, '0');
  return `${negativo ? '-' : ''}${d.slice(0, -2)}.${d.slice(-2)}`;
};

const primero = (grupo: readonly RegistroCanonico[]): RegistroCanonico => grupo[0]!;

// ---------------------------------------------------------------------------
// Terceros
// ---------------------------------------------------------------------------

/**
 * Un tercero.
 *
 * El documento es lo delicado: la tabla exige que el tipo y el número sean
 * coherentes —o hay CUIT y número, o es `SIN_IDENTIFICAR` y el número es
 * `null`—. Un CUIT que no validó llega acá en `null`, y entonces el tercero
 * entra sin documento en vez de entrar con uno inválido. Queda la advertencia
 * de la validación diciendo qué traía el origen.
 */
const TERCERO: Escritor = {
  entidad: 'PARTY',
  tabla: 'parties',
  agrupaPor: null,

  async buscarExistente(ctx, grupo) {
    const cuit = texto(primero(grupo).campos.cuit);
    if (cuit !== null) return ctx.terceroPorCuit(cuit);
    // Sin CUIT no se busca por nombre: dos empresas se pueden llamar igual, y
    // fusionarlas por parecido es exactamente lo que el §16 prohíbe decidir en
    // silencio.
    return null;
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const cuit = texto(r.campos.cuit);
    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO parties
         (company_id, tipo_documento, numero_documento, razon_social,
          condicion_iva, email, telefono, domicilio, localidad, provincia,
          codigo_postal, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        ctx.companyId,
        cuit === null ? 'SIN_IDENTIFICAR' : 'CUIT',
        cuit,
        texto(r.campos.razonSocial) ?? '(sin razón social)',
        // «DESCONOCIDA» y no «CONSUMIDOR_FINAL»: suponer la condición frente al
        // IVA cambia cómo se factura, y el origen puede no haberla traído.
        condicionIva(texto(r.campos.condicionIva)),
        texto(r.campos.email),
        texto(r.campos.telefono),
        texto(r.campos.direccion),
        texto(r.campos.localidad),
        texto(r.campos.provincia),
        texto(r.campos.codigoPostal),
        ctx.actor,
      ],
    );
    const id = rows[0]!.id;
    if (cuit !== null) ctx.recordarTercero(cuit, id);

    // El rol que el origen declara, cuando lo declara. Sin rol un tercero
    // existe igual: es una contraparte que todavía no operó.
    const rol = rolDeTercero(texto(r.campos.tipo));
    if (rol !== null) {
      await ctx.tx.query(
        `INSERT INTO party_roles (party_id, company_id, role, created_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [id, ctx.companyId, rol, ctx.actor],
      );
    }

    return { idDestino: id, tabla: 'parties' };
  },
};

const CONDICIONES = new Map<string, string>([
  ['responsable inscripto', 'RESPONSABLE_INSCRIPTO'],
  ['ri', 'RESPONSABLE_INSCRIPTO'],
  ['monotributo', 'MONOTRIBUTO'],
  ['monotributista', 'MONOTRIBUTO'],
  ['exento', 'EXENTO'],
  ['consumidor final', 'CONSUMIDOR_FINAL'],
  ['cf', 'CONSUMIDOR_FINAL'],
  ['no categorizado', 'NO_CATEGORIZADO'],
]);

const ROLES = new Map<string, string>([
  ['cliente', 'CLIENTE'],
  ['proveedor', 'PROVEEDOR'],
  ['empleado', 'EMPLEADO'],
  ['acreedor', 'ACREEDOR'],
  ['deudor', 'DEUDOR'],
  ['transportista', 'TRANSPORTISTA'],
]);

const sinAcentos = (crudo: string): string =>
  crudo
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function condicionIva(crudo: string | null): string {
  if (crudo === null) return 'DESCONOCIDA';
  return CONDICIONES.get(sinAcentos(crudo)) ?? 'DESCONOCIDA';
}

const rolDeTercero = (crudo: string | null): string | null =>
  crudo === null ? null : (ROLES.get(sinAcentos(crudo)) ?? null);

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

const UNIDADES = new Map<string, string>([
  ['unidad', 'UNIDAD'], ['un', 'UNIDAD'], ['u', 'UNIDAD'], ['c u', 'UNIDAD'],
  ['kilogramo', 'KILOGRAMO'], ['kg', 'KILOGRAMO'], ['kilo', 'KILOGRAMO'],
  ['gramo', 'GRAMO'], ['g', 'GRAMO'], ['gr', 'GRAMO'],
  ['tonelada', 'TONELADA'], ['tn', 'TONELADA'],
  ['litro', 'LITRO'], ['l', 'LITRO'], ['lt', 'LITRO'],
  ['mililitro', 'MILILITRO'], ['ml', 'MILILITRO'],
  ['metro', 'METRO'], ['m', 'METRO'], ['mt', 'METRO'],
  ['metro cuadrado', 'METRO_CUADRADO'], ['m2', 'METRO_CUADRADO'],
  ['metro cubico', 'METRO_CUBICO'], ['m3', 'METRO_CUBICO'],
  ['hora', 'HORA'], ['hs', 'HORA'], ['h', 'HORA'],
  ['dia', 'DIA'], ['mes', 'MES'],
  ['docena', 'DOCENA'], ['doc', 'DOCENA'],
  ['caja', 'CAJA'], ['cj', 'CAJA'],
  ['paquete', 'PAQUETE'], ['paq', 'PAQUETE'],
]);

/** Una unidad que no se reconoce es `OTRA`, no `UNIDAD`: no es lo mismo. */
const unidad = (crudo: string | null): string =>
  crudo === null ? 'UNIDAD' : (UNIDADES.get(sinAcentos(crudo)) ?? 'OTRA');

const TRATAMIENTOS = new Map<string, string>([
  ['gravado', 'GRAVADO'],
  ['exento', 'EXENTO'],
  ['no gravado', 'NO_GRAVADO'],
]);

/**
 * Un producto.
 *
 * El defecto que este escritor tenía: la columna `tax_treatment` vale
 * `GRAVADO` por omisión y un CHECK exige que un producto gravado diga contra
 * qué impuesto. El escritor no lo mandaba, así que **ningún producto se podía
 * importar** — y no se veía porque ninguna prueba importaba productos. Ahora el
 * impuesto sale del catálogo, y si el catálogo no tiene IVA se dice en vez de
 * fallar con un mensaje de la base.
 *
 * `tracks_stock` sale de si el archivo trae existencias. Un producto sin
 * existencias declaradas no lleva stock: ponerlo en verdadero le crearía una
 * existencia en cero, que es una afirmación que el origen no hizo.
 */
const PRODUCTO: Escritor = {
  entidad: 'PRODUCT',
  tabla: 'products',
  agrupaPor: null,

  async buscarExistente(ctx, grupo) {
    const sku = texto(primero(grupo).campos.sku);
    return sku === null ? null : ctx.productoPorCodigo(sku);
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const tratamiento = TRATAMIENTOS.get(sinAcentos(texto(r.campos.tratamiento) ?? '')) ?? 'GRAVADO';

    let taxId: string | null = null;
    if (tratamiento === 'GRAVADO') {
      taxId = await ctx.iva();
      if (taxId === null) {
        throw new NoSePuedeEscribir(
          'El catálogo de impuestos de esta instalación no tiene IVA, y un producto gravado ' +
            'tiene que decir contra qué impuesto lo está. Se carga con `npm run tax:seed`.',
        );
      }
    }

    const sku = texto(r.campos.sku) ?? '(sin código)';
    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO products
         (company_id, code, name, description, unit, tax_treatment, tax_id,
          tracks_stock, list_price, currency, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        ctx.companyId,
        sku,
        texto(r.campos.nombre) ?? '(sin nombre)',
        texto(r.campos.descripcion),
        unidad(texto(r.campos.unidad)),
        tratamiento,
        taxId,
        // Lo decide la migración, no el archivo de productos: la marca la pone
        // el importador de stock cuando llega una existencia de este producto.
        false,
        importe(r.campos.precio),
        texto(r.campos.moneda) ?? 'ARS',
        ctx.actor,
      ],
    );
    const id = rows[0]!.id;
    ctx.recordarProducto(sku, id);
    return { idDestino: id, tabla: 'products' };
  },
};

// ---------------------------------------------------------------------------
// Depósitos
// ---------------------------------------------------------------------------

const DEPOSITO: Escritor = {
  entidad: 'WAREHOUSE',
  tabla: 'warehouses',
  agrupaPor: null,

  async buscarExistente(ctx, grupo) {
    const codigo = texto(primero(grupo).campos.codigo);
    return codigo === null ? null : ctx.depositoPorCodigo(codigo);
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const codigo = texto(r.campos.codigo) ?? '(sin código)';
    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO warehouses (company_id, code, name, direccion, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ctx.companyId, codigo, texto(r.campos.nombre) ?? codigo, texto(r.campos.direccion), ctx.actor],
    );
    const id = rows[0]!.id;
    ctx.recordarDeposito(codigo, id);
    return { idDestino: id, tabla: 'warehouses' };
  },
};

// ---------------------------------------------------------------------------
// Plan de cuentas
// ---------------------------------------------------------------------------

const TIPOS_DE_CUENTA = new Map<string, string>([
  ['activo', 'ACTIVO'],
  ['pasivo', 'PASIVO'],
  ['pn', 'PN'],
  ['patrimonio neto', 'PN'],
  ['patrimonio', 'PN'],
  ['ingreso', 'INGRESO'],
  ['ingresos', 'INGRESO'],
  ['venta', 'INGRESO'],
  ['ventas', 'INGRESO'],
  ['costo', 'COSTO'],
  ['costos', 'COSTO'],
  ['gasto', 'GASTO'],
  ['gastos', 'GASTO'],
  ['orden', 'ORDEN'],
]);

/** La naturaleza que le corresponde a cada tipo cuando el origen no la trae. */
const NATURALEZA: Readonly<Record<string, 'DEUDORA' | 'ACREEDORA'>> = {
  ACTIVO: 'DEUDORA',
  PASIVO: 'ACREEDORA',
  PN: 'ACREEDORA',
  INGRESO: 'ACREEDORA',
  COSTO: 'DEUDORA',
  GASTO: 'DEUDORA',
  ORDEN: 'DEUDORA',
};

/**
 * El primer dígito del código, cuando el origen no dice el tipo.
 *
 * Es la convención argentina y es la que usa el plan que NEXO propone. Se
 * aplica solo como último recurso y **queda dicho en una advertencia**: deducir
 * el tipo de una cuenta del número es una convención, no un dato.
 */
const TIPO_POR_DIGITO: Readonly<Record<string, string>> = {
  '1': 'ACTIVO',
  '2': 'PASIVO',
  '3': 'PN',
  '4': 'INGRESO',
  '5': 'COSTO',
  '6': 'GASTO',
  '7': 'ORDEN',
};

/**
 * Una cuenta del plan.
 *
 * Depende de su padre: `assert_leaf_is_postable` exige que una cuenta con hijos
 * no sea imputable. Por eso el importador ordena las cuentas por longitud de
 * código antes de escribirlas —`1` antes que `1.1` antes que `1.1.01`— y por
 * eso el escritor busca al padre por código en vez de recibirlo resuelto.
 */
const CUENTA: Escritor = {
  entidad: 'ACCOUNT',
  tabla: 'accounts',
  agrupaPor: null,

  async buscarExistente(ctx, grupo) {
    const codigo = texto(primero(grupo).campos.codigo);
    if (codigo === null) return null;
    return (await ctx.cuentaPorCodigo(codigo))?.id ?? null;
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const codigo = texto(r.campos.codigo);
    if (codigo === null) throw new NoSePuedeEscribir('La cuenta no trae código');

    const advertencias: string[] = [];
    const declarado = TIPOS_DE_CUENTA.get(sinAcentos(texto(r.campos.tipo) ?? ''));
    let tipo = declarado;
    if (tipo === undefined) {
      const porDigito = TIPO_POR_DIGITO[codigo.trim()[0] ?? ''];
      if (porDigito === undefined) {
        throw new NoSePuedeEscribir(
          `La cuenta ${codigo} no dice de qué tipo es y su código no empieza con un dígito ` +
            'del 1 al 7. El tipo decide de qué lado suma la cuenta y no se puede suponer.',
        );
      }
      tipo = porDigito;
      advertencias.push(
        `El tipo de la cuenta ${codigo} se dedujo de su primer dígito (${tipo}). El archivo no ` +
          'lo declaraba: si la convención del sistema anterior era otra, revisala.',
      );
    }

    const naturalezaDeclarada = sinAcentos(texto(r.campos.naturaleza) ?? '');
    const naturaleza =
      naturalezaDeclarada === 'deudora'
        ? 'DEUDORA'
        : naturalezaDeclarada === 'acreedora'
          ? 'ACREEDORA'
          : NATURALEZA[tipo]!;

    // El padre por código. Si el archivo lo declara y no está, es un error: una
    // cuenta colgando de una cuenta que no existe rompe la jerarquía entera.
    const codigoPadre = texto(r.campos.codigoPadre);
    let parentId: string | null = null;
    if (codigoPadre !== null && codigoPadre !== '') {
      const padre = await ctx.cuentaPorCodigo(codigoPadre);
      if (padre === null) {
        throw new NoSePuedeEscribir(
          `La cuenta ${codigo} depende de ${codigoPadre}, que no está ni en el plan de la ` +
            'empresa ni en este archivo. Una cuenta sin su padre no tiene lugar en la jerarquía.',
        );
      }
      parentId = padre.id;
      // El padre deja de ser imputable en cuanto tiene un hijo. Lo exige
      // `assert_leaf_is_postable`, y hacerlo acá evita que la importación
      // muera a mitad de un plan de cuentas por el orden de las filas.
      if (padre.isPostable) {
        await ctx.tx.query('UPDATE accounts SET is_postable = false WHERE id = $1', [padre.id]);
        ctx.olvidarCuenta(codigoPadre);
      }
    }

    const imputable = r.campos.imputable?.valor;
    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO accounts
         (company_id, chart_id, code, name, parent_id, type, nature, is_postable, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        ctx.companyId,
        await ctx.planDeCuentas(),
        codigo,
        texto(r.campos.nombre) ?? codigo,
        parentId,
        tipo,
        naturaleza,
        typeof imputable === 'boolean' ? imputable : true,
        texto(r.campos.moneda) ?? 'ARS',
      ],
    );
    ctx.olvidarCuenta(codigo);
    return {
      idDestino: rows[0]!.id,
      tabla: 'accounts',
      ...(advertencias.length > 0 ? { advertencias } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

const TIPOS_DE_MOVIMIENTO = new Map<string, string>([
  ['entrada', 'ENTRADA'], ['ingreso', 'ENTRADA'], ['compra', 'ENTRADA'], ['e', 'ENTRADA'],
  ['salida', 'SALIDA'], ['egreso', 'SALIDA'], ['venta', 'SALIDA'], ['s', 'SALIDA'],
  ['ajuste positivo', 'AJUSTE_POSITIVO'], ['ajuste mas', 'AJUSTE_POSITIVO'],
  ['ajuste negativo', 'AJUSTE_NEGATIVO'], ['ajuste menos', 'AJUSTE_NEGATIVO'],
]);

/**
 * Prepara el producto para recibir existencias.
 *
 * Un producto migrado nace sin `tracks_stock` porque el archivo de productos no
 * dice nada de existencias. Cuando llega el primero de sus movimientos, sí lo
 * dice, y entonces se marca. La alternativa —marcar todos por las dudas— le
 * inventaría una existencia en cero a los servicios.
 */
async function habilitarStock(
  ctx: ContextoDeImportacion,
  productId: string,
  conLote: boolean,
): Promise<void> {
  await ctx.tx.query(
    `UPDATE products
        SET tracks_stock = true,
            lleva_lote = lleva_lote OR $3,
            kind = 'PRODUCTO'
      WHERE company_id = $1 AND id = $2 AND (NOT tracks_stock OR ($3 AND NOT lleva_lote))`,
    [ctx.companyId, productId, conLote],
  );
}

/** Resuelve producto y depósito, o dice exactamente cuál falta. */
async function ubicarEnElInventario(
  ctx: ContextoDeImportacion,
  r: RegistroCanonico,
): Promise<{ productId: string; warehouseId: string }> {
  const sku = texto(r.campos.sku);
  if (sku === null) throw new NoSePuedeEscribir('El movimiento no dice de qué producto es');

  const productId = await ctx.productoPorCodigo(sku);
  if (productId === null) {
    throw new NoSePuedeEscribir(
      `No hay ningún producto con el código ${sku}. Migrá primero los productos: NEXO no crea ` +
        'uno al vuelo porque un producto inventado desde una línea de stock no tiene ni nombre ' +
        'ni unidad ni tratamiento fiscal.',
    );
  }

  const codigoDeposito = texto(r.campos.deposito);
  const warehouseId =
    codigoDeposito === null
      ? await ctx.depositoUnico()
      : await ctx.depositoPorCodigo(codigoDeposito);

  if (warehouseId === null) {
    throw new NoSePuedeEscribir(
      codigoDeposito === null
        ? 'La fila no dice en qué depósito está y la empresa no tiene exactamente uno. Repartir ' +
          'existencias entre depósitos es una decisión de inventario y no se adivina.'
        : `No hay ningún depósito con el código ${codigoDeposito}. Migrá primero los depósitos.`,
    );
  }
  return { productId, warehouseId };
}

/** Lo común a escribir un movimiento en el libro de stock. */
async function escribirMovimiento(
  ctx: ContextoDeImportacion,
  r: RegistroCanonico,
  datos: {
    readonly productId: string;
    readonly warehouseId: string;
    readonly tipo: string;
    readonly cantidad: number;
    readonly fecha: string;
    readonly motivo: string | null;
  },
): Promise<string> {
  const lote = texto(r.campos.lote);
  await habilitarStock(ctx, datos.productId, lote !== null);

  const costo = importe(r.campos.costoUnitario);
  const { rows } = await ctx.tx.query<{ id: string }>(
    `INSERT INTO stock_movements
       (company_id, product_id, warehouse_id, tipo, cantidad, fecha,
        origen_tipo, origen_id, motivo, lote, fecha_vencimiento, costo_unitario, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'MIGRACION', $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      ctx.companyId,
      datos.productId,
      datos.warehouseId,
      datos.tipo,
      String(datos.cantidad),
      datos.fecha,
      ctx.migracionId,
      datos.motivo,
      lote,
      texto(r.campos.fechaVencimiento),
      // El costo solo entra donde el promedio ponderado lo usa. En una salida
      // sería un número guardado que nada lee, y eso confunde más de lo que ayuda.
      datos.tipo === 'ENTRADA' || datos.tipo === 'AJUSTE_POSITIVO' ? costo : null,
      ctx.actor,
    ],
  );
  return rows[0]!.id;
}

/**
 * El stock de apertura.
 *
 * Es una entrada al libro con la fecha de corte, no un ajuste: un ajuste dice
 * «alguien contó y había otra cantidad», y acá nadie contó nada — se está
 * trayendo lo que el sistema anterior afirmaba tener.
 */
const EXISTENCIA: Escritor = {
  entidad: 'STOCK_BALANCE',
  tabla: 'stock_movements',
  agrupaPor: null,

  async buscarExistente() {
    // No se busca: el libro de movimientos solo crece y no tiene una fila
    // «existencia» que pueda coincidir. La idempotencia la da `migration_links`.
    return null;
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const { productId, warehouseId } = await ubicarEnElInventario(ctx, r);

    const cantidad = numero(r.campos.cantidad);
    if (cantidad === null) {
      throw new NoSePuedeEscribir(
        `La existencia de ${texto(r.campos.sku)} no se pudo leer: ` +
          `${r.campos.cantidad?.motivo ?? 'el campo vino vacío'}.`,
      );
    }
    if (cantidad === 0) {
      throw new NoSePuedeEscribir(
        'La existencia es cero. No se registra un movimiento de cero unidades: no dice nada que ' +
          'la ausencia de movimientos no diga ya.',
      );
    }
    if (cantidad < 0) {
      throw new NoSePuedeEscribir(
        `La existencia de apertura de ${texto(r.campos.sku)} es negativa (${cantidad}). Una ` +
          'apertura negativa no es una existencia: es un error del sistema de origen.',
      );
    }

    const fecha = texto(r.campos.fechaCorte) ?? ctx.fechaCorte;
    if (fecha === null) {
      throw new NoSePuedeEscribir(
        'La existencia de apertura no dice a qué fecha está. Declarala como fecha de corte de ' +
          'la migración o traela en una columna: sin fecha, el movimiento no tiene lugar en el libro.',
      );
    }

    const id = await escribirMovimiento(ctx, r, {
      productId,
      warehouseId,
      tipo: 'ENTRADA',
      cantidad,
      fecha,
      motivo: 'Existencia de apertura traída del sistema anterior',
    });
    return { idDestino: id, tabla: 'stock_movements' };
  },
};

/** Un movimiento histórico, tal como lo tenía el sistema anterior. */
const MOVIMIENTO_DE_STOCK: Escritor = {
  entidad: 'STOCK_MOVEMENT',
  tabla: 'stock_movements',
  agrupaPor: null,

  async buscarExistente() {
    return null;
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const { productId, warehouseId } = await ubicarEnElInventario(ctx, r);

    const crudo = texto(r.campos.tipo);
    const tipo = TIPOS_DE_MOVIMIENTO.get(sinAcentos(crudo ?? ''));
    if (tipo === undefined) {
      throw new NoSePuedeEscribir(
        `«${crudo ?? ''}» no se entiende como tipo de movimiento. Se reconocen entrada, salida y ` +
          'ajuste positivo o negativo. Suponer el signo de un movimiento de stock cambia la ' +
          'existencia en el sentido contrario.',
      );
    }

    const cantidad = numero(r.campos.cantidad);
    if (cantidad === null || cantidad <= 0) {
      throw new NoSePuedeEscribir(
        `La cantidad del movimiento no sirve (${texto(r.campos.cantidad) ?? 'vacía'}). El libro ` +
          'guarda cantidades positivas y el signo lo pone el tipo.',
      );
    }

    const fecha = texto(r.campos.fecha);
    if (fecha === null) throw new NoSePuedeEscribir('El movimiento no trae fecha');

    const id = await escribirMovimiento(ctx, r, {
      productId,
      warehouseId,
      tipo,
      cantidad,
      fecha,
      motivo: texto(r.campos.motivo) ?? 'Movimiento traído del sistema anterior',
    });
    return { idDestino: id, tabla: 'stock_movements' };
  },
};

// ---------------------------------------------------------------------------
// Comprobantes
// ---------------------------------------------------------------------------

const TRATAMIENTO_DE_RENGLON = new Map<string, string>([
  ['gravado', 'GRAVADO'],
  ['exento', 'EXENTO'],
  ['no gravado', 'NO_GRAVADO'],
]);

/**
 * Un comprobante histórico.
 *
 * ## Qué NO hace, y es lo más importante
 *
 * **No pide un CAE.** Un comprobante que el sistema anterior emitió ya tiene el
 * suyo, o no tiene ninguno; pedirle uno nuevo a ARCA para un documento de hace
 * tres años sería emitir un comprobante que nunca existió. Se guarda lo que el
 * archivo traiga en `cae` como parte del registro, y la constatación queda en
 * `NO_CONSULTADO`: nadie le preguntó a ARCA por este comprobante, y decir otra
 * cosa sería afirmar una verificación que no ocurrió.
 *
 * ## Por qué exige la composición del total
 *
 * `total = neto + iva + no gravado + exento + percepciones` es un CHECK de la
 * base, y el libro de IVA se arma con esas partes. Un archivo que solo trae el
 * total no permite reconstruirlas: repartirlo suponiendo una alícuota cambiaría
 * el crédito o el débito fiscal de la empresa. Se rechaza diciéndolo.
 */
function comprobante(entidad: 'SALES_DOCUMENT' | 'PURCHASE_DOCUMENT'): Escritor {
  const ventas = entidad === 'SALES_DOCUMENT';
  const campoCuit = ventas ? 'cuitCliente' : 'cuitProveedor';
  const campoRazon = ventas ? 'razonSocialCliente' : 'razonSocialProveedor';

  return {
    entidad,
    tabla: 'tax_transactions',
    agrupaPor: ['tipoComprobante', 'puntoVenta', 'numero', campoCuit],

    async buscarExistente(ctx, grupo) {
      const r = primero(grupo);
      const tipo = await codigoDeComprobante(ctx, r);
      if (tipo === null) return null;

      const { rows } = await ctx.tx.query<{ id: string }>(
        `SELECT id FROM tax_transactions
          WHERE company_id = $1 AND direction = $2 AND cbte_tipo = $3
            AND punto_venta = $4 AND cbte_numero = $5
          LIMIT 1`,
        [
          ctx.companyId,
          ventas ? 'VENTAS' : 'COMPRAS',
          tipo,
          numero(r.campos.puntoVenta) ?? 0,
          numero(r.campos.numero) ?? 0,
        ],
      );
      return rows[0]?.id ?? null;
    },

    async escribir(ctx, grupo) {
      const r = primero(grupo);
      const advertencias: string[] = [];

      const fecha = texto(r.campos.fecha);
      if (fecha === null) throw new NoSePuedeEscribir('El comprobante no trae fecha');

      // El tipo, contra el catálogo de ARCA. No se adivina: decide en qué
      // columna del libro de IVA cae el comprobante.
      const cbteTipo = await codigoDeComprobante(ctx, r);
      if (cbteTipo === null) {
        throw new NoSePuedeEscribir(
          `«${texto(r.campos.tipoComprobante) ?? ''}» no se reconoce como tipo de comprobante. Se ` +
            'entienden el código de ARCA («1»), la descripción («Factura A») y la abreviatura ' +
            '(«FC A», «NC B»). El tipo decide de qué lado del libro de IVA cae el comprobante, ' +
            'y suponerlo cambia el impuesto de la empresa.',
        );
      }

      const periodo = await ctx.periodoDe(fecha);
      if (periodo === null) {
        throw new NoSePuedeEscribir(
          `No hay ningún período que contenga ${fecha}. Un comprobante vive en un período: creá ` +
            'el ejercicio y sus períodos desde «Períodos y cierre» antes de migrar la historia.',
        );
      }
      if (periodo.status === 'CERRADO') {
        throw new NoSePuedeEscribir(
          `El período que contiene ${fecha} está CERRADO. Migrar dentro de un ejercicio cerrado ` +
            'cambiaría estados contables ya emitidos.',
        );
      }

      const ivaId = await ctx.iva();
      if (ivaId === null) {
        throw new NoSePuedeEscribir(
          'El catálogo de impuestos no tiene IVA. Se carga con `npm run tax:seed`.',
        );
      }

      // ── La composición del total ──────────────────────────────────────
      const total = enCentavos(r.campos.total);
      if (total === null) {
        throw new NoSePuedeEscribir('El comprobante no trae total, o no se pudo leer');
      }
      const neto = enCentavos(r.campos.neto) ?? '0';
      const iva = enCentavos(r.campos.iva) ?? '0';
      const noGravado = enCentavos(r.campos.noGravado) ?? '0';
      const exento = enCentavos(r.campos.exento) ?? '0';
      const percepciones = enCentavos(r.campos.percepciones) ?? '0';
      const partes = sumarCentavos([neto, iva, noGravado, exento, percepciones]);

      if (partes !== BigInt(total)) {
        throw new NoSePuedeEscribir(
          `El comprobante declara un total de ${centavosATexto(BigInt(total))} y sus partes suman ` +
            `${centavosATexto(partes)} (neto ${centavosATexto(BigInt(neto))}, IVA ` +
            `${centavosATexto(BigInt(iva))}, no gravado ${centavosATexto(BigInt(noGravado))}, ` +
            `exento ${centavosATexto(BigInt(exento))}, percepciones ` +
            `${centavosATexto(BigInt(percepciones))}). El libro de IVA se arma con esas partes: ` +
            'repartir el total suponiendo una alícuota cambiaría el impuesto de la empresa.',
        );
      }

      // ── El tercero ────────────────────────────────────────────────────
      const cuit = texto(r.campos[campoCuit]);
      const partyId = cuit === null ? null : await ctx.terceroPorCuit(cuit);
      if (cuit !== null && partyId === null) {
        advertencias.push(
          `El comprobante ${texto(r.campos.numero) ?? ''} declara el CUIT ${cuit} y no hay ningún ` +
            'tercero con ese documento. Queda registrado con el CUIT pero sin vincular: migrá los ' +
            'terceros y volvé a correr para que se enlace.',
        );
      }

      const cae = texto(r.campos.cae);
      const { rows } = await ctx.tx.query<{ id: string }>(
        `INSERT INTO tax_transactions
           (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
            cbte_fecha, cuit_contraparte, razon_social, condicion_iva,
            neto, iva, no_gravado, exento, percepciones, total,
            constatacion, constatacion_origen, party_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 'NO_CONSULTADO', 'NO_CONSULTADO', $18, $19)
         RETURNING id`,
        [
          ctx.companyId,
          ivaId,
          periodo.id,
          ventas ? 'VENTAS' : 'COMPRAS',
          cbteTipo,
          numero(r.campos.puntoVenta) ?? 0,
          numero(r.campos.numero) ?? 0,
          fecha,
          cuit,
          texto(r.campos[campoRazon]),
          condicionIva(texto(r.campos.condicionIva)),
          centavosATexto(BigInt(neto)),
          centavosATexto(BigInt(iva)),
          centavosATexto(BigInt(noGravado)),
          centavosATexto(BigInt(exento)),
          centavosATexto(BigInt(percepciones)),
          centavosATexto(BigInt(total)),
          partyId,
          ctx.actor,
        ],
      );
      const id = rows[0]!.id;

      if (cae !== null) {
        advertencias.push(
          `El comprobante trae el CAE ${cae}. Queda como dato del origen: NEXO no le pide a ARCA ` +
            'un CAE nuevo para un comprobante histórico, y tampoco lo verifica.',
        );
      }

      // ── Los renglones ─────────────────────────────────────────────────
      //
      // Solo si cierran con la cabecera. `assert_renglones_cierran` lo exige, y
      // tiene razón: unos renglones que no suman el total del comprobante son
      // peores que no tener renglones — parecen el detalle y no lo son.
      const renglones = grupo.filter((f) => texto(f.campos.sku) !== null || texto(f.campos.descripcion) !== null);
      if (renglones.length > 0) {
        const escritos = await escribirRenglones(ctx, id, renglones);
        if (escritos.cierran) {
          // nada que decir: cerraron.
        } else {
          await ctx.tx.query('DELETE FROM tax_transaction_lines WHERE tax_transaction_id = $1', [id]);
          advertencias.push(
            `Los ${renglones.length} renglones del comprobante suman neto ` +
              `${centavosATexto(escritos.neto)} e IVA ${centavosATexto(escritos.iva)}, y la ` +
              `cabecera declara ${centavosATexto(BigInt(neto))} y ${centavosATexto(BigInt(iva))}. ` +
              'Se guardó el comprobante con los totales del origen y sin el detalle: unos ' +
              'renglones que no cierran parecen el detalle y no lo son.',
          );
        }
      }

      return {
        idDestino: id,
        tabla: 'tax_transactions',
        ...(advertencias.length > 0 ? { advertencias } : {}),
      };
    },
  };
}

/** El código ARCA del tipo que declara la fila, o `null` si no se reconoce. */
async function codigoDeComprobante(
  ctx: ContextoDeImportacion,
  r: RegistroCanonico,
): Promise<number | null> {
  const crudo = texto(r.campos.tipoComprobante);
  if (crudo === null) return null;
  return ctx.tipoDeComprobante(crudo);
}

async function escribirRenglones(
  ctx: ContextoDeImportacion,
  taxTransactionId: string,
  renglones: readonly RegistroCanonico[],
): Promise<{ cierran: boolean; neto: bigint; iva: bigint }> {
  let sumaNeto = 0n;
  let sumaIva = 0n;

  for (const [i, linea] of renglones.entries()) {
    const sku = texto(linea.campos.sku);
    const productId = sku === null ? null : await ctx.productoPorCodigo(sku);
    // `netoRenglon` y no `neto`: en un archivo de ventas la columna «Neto» es
    // la del comprobante y se repite en cada fila. Sumar esa en vez de la del
    // renglón daría el total multiplicado por la cantidad de renglones, y el
    // comprobante quedaría sin detalle por un error de lectura, no de datos.
    const neto = enCentavos(linea.campos.netoRenglon) ?? '0';
    const iva = enCentavos(linea.campos.ivaRenglon) ?? '0';
    const tratamiento =
      TRATAMIENTO_DE_RENGLON.get(sinAcentos(texto(linea.campos.tratamiento) ?? '')) ?? 'GRAVADO';

    if (tratamiento === 'GRAVADO') sumaNeto += BigInt(neto);
    sumaIva += BigInt(iva);

    await ctx.tx.query(
      `INSERT INTO tax_transaction_lines
         (company_id, tax_transaction_id, line_no, product_id, descripcion,
          cantidad, unidad, precio_unitario, descuento, tratamiento, neto, iva)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        ctx.companyId,
        taxTransactionId,
        i + 1,
        productId,
        texto(linea.campos.descripcion) ?? sku ?? '(sin descripción)',
        String(numero(linea.campos.cantidad) ?? 1),
        unidad(texto(linea.campos.unidad)),
        importeO(linea.campos.precioUnitario, '0.00'),
        importeO(linea.campos.descuento, '0.00'),
        tratamiento,
        centavosATexto(BigInt(neto)),
        centavosATexto(BigInt(iva)),
      ],
    );
  }

  const cabecera = await ctx.tx.query<{ neto: string; iva: string }>(
    'SELECT neto::text, iva::text FROM tax_transactions WHERE id = $1',
    [taxTransactionId],
  );
  const enCentavosDeTexto = (t: string): bigint => BigInt(t.replace('.', ''));
  return {
    cierran:
      sumaNeto === enCentavosDeTexto(cabecera.rows[0]!.neto) &&
      sumaIva === enCentavosDeTexto(cabecera.rows[0]!.iva),
    neto: sumaNeto,
    iva: sumaIva,
  };
}

// ---------------------------------------------------------------------------
// Asientos
// ---------------------------------------------------------------------------

/**
 * Un asiento migrado.
 *
 * ## Entra como PROPUESTO, no como APROBADO
 *
 * Y es la decisión de fondo del importador contable. Un asiento aprobado
 * proyecta movimientos en el Mayor y no se puede tocar más; un asiento que
 * viene de un archivo de otro sistema no fue revisado por nadie de esta
 * empresa. Entra propuesto —que es donde entra también lo que propone la IA, y
 * por el mismo motivo— y alguien lo aprueba mirándolo.
 *
 * La consecuencia práctica: **revertir la contabilidad migrada no toca el
 * Mayor**, porque nunca llegó a tocarlo. Lo que se revierte es una propuesta.
 */
/** Los libros que NEXO conoce, y cómo los escriben los sistemas de gestión. */
const LIBROS = new Map<string, string>([
  ['general', 'GENERAL'], ['diario', 'GENERAL'], ['diario general', 'GENERAL'],
  ['compras', 'COMPRAS'], ['subdiario de compras', 'COMPRAS'],
  ['ventas', 'VENTAS'], ['subdiario de ventas', 'VENTAS'],
  ['bancos', 'BANCOS'], ['banco', 'BANCOS'],
  ['caja', 'CAJA'],
  ['sueldos', 'SUELDOS'], ['haberes', 'SUELDOS'],
  ['ajustes', 'AJUSTES'], ['ajuste', 'AJUSTES'],
  ['cierre', 'CIERRE'],
  ['apertura', 'APERTURA'],
]);

const ASIENTO: Escritor = {
  entidad: 'JOURNAL_ENTRY',
  tabla: 'journal_entries',
  agrupaPor: ['asiento'],

  async buscarExistente(ctx, grupo) {
    const r = primero(grupo);
    const codigo = texto(r.campos.codigoExterno) ?? texto(r.campos.asiento);
    if (codigo === null) return null;
    const { rows } = await ctx.tx.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE company_id = $1 AND source_type = 'MANUAL'
          AND description LIKE $2 AND status <> 'ANULADO'
        LIMIT 1`,
      [ctx.companyId, `%[origen ${codigo}]`],
    );
    return rows[0]?.id ?? null;
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const fecha = texto(r.campos.fecha);
    if (fecha === null) throw new NoSePuedeEscribir('El asiento no trae fecha');

    const periodo = await ctx.periodoDe(fecha);
    if (periodo === null) {
      throw new NoSePuedeEscribir(
        `No hay ningún período que contenga ${fecha}. Un asiento vive en un período: creá el ` +
          'ejercicio y sus períodos antes de migrar la contabilidad.',
      );
    }
    if (periodo.status === 'CERRADO') {
      throw new NoSePuedeEscribir(
        `El período que contiene ${fecha} está CERRADO y no admite asientos nuevos.`,
      );
    }

    // ── Las cuentas ─────────────────────────────────────────────────────
    const renglones: { cuenta: string; debe: bigint; haber: bigint; descripcion: string | null }[] = [];
    let debe = 0n;
    let haber = 0n;

    for (const linea of grupo) {
      const codigo = texto(linea.campos.cuenta);
      if (codigo === null) {
        throw new NoSePuedeEscribir('Un renglón del asiento no dice contra qué cuenta va');
      }
      const cuenta = await ctx.cuentaPorCodigo(codigo);
      if (cuenta === null) {
        throw new NoSePuedeEscribir(
          `La cuenta ${codigo} no está en el plan de esta empresa. Migrá primero el plan de ` +
            'cuentas: NEXO no crea una cuenta al vuelo porque no sabría de qué tipo es, y el ' +
            'tipo decide de qué lado suma.',
        );
      }
      if (!cuenta.isPostable) {
        throw new NoSePuedeEscribir(
          `La cuenta ${codigo} no admite imputación: tiene cuentas hijas. Un asiento contra una ` +
            'cuenta de agrupación deja el Mayor sin poder desagregarse.',
        );
      }
      if (cuenta.status === 'ARCHIVED') {
        throw new NoSePuedeEscribir(`La cuenta ${codigo} está archivada.`);
      }

      const d = BigInt(enCentavos(linea.campos.debe) ?? '0');
      const h = BigInt(enCentavos(linea.campos.haber) ?? '0');
      if (d < 0n || h < 0n) {
        throw new NoSePuedeEscribir(
          `El renglón de la cuenta ${codigo} trae un importe negativo. El debe y el haber son ` +
            'positivos: el signo lo pone la columna, no el número.',
        );
      }
      if (d > 0n && h > 0n) {
        throw new NoSePuedeEscribir(
          `El renglón de la cuenta ${codigo} tiene importe en el debe y en el haber a la vez.`,
        );
      }
      debe += d;
      haber += h;
      renglones.push({
        cuenta: cuenta.id,
        debe: d,
        haber: h,
        descripcion: texto(linea.campos.descripcion),
      });
    }

    if (debe !== haber) {
      throw new NoSePuedeEscribir(
        `El asiento no cuadra: el debe suma ${centavosATexto(debe)} y el haber ` +
          `${centavosATexto(haber)}. NEXO no agrega un renglón para cuadrarlo — se corrige en el ` +
          'sistema de origen y se vuelve a migrar.',
      );
    }
    if (debe === 0n) {
      throw new NoSePuedeEscribir('El asiento suma cero en las dos columnas: no registra nada.');
    }

    // ── La cabecera ─────────────────────────────────────────────────────
    const codigoExterno = texto(r.campos.codigoExterno) ?? texto(r.campos.asiento);

    // El libro sale del vocabulario cerrado de NEXO, no del texto del archivo.
    //
    // La primera versión de este escritor daba de alta el libro en `journals`
    // con el nombre que trajera el origen. Estaba mal por dos motivos: esa tabla
    // duplica un catálogo que en NEXO vive en el propio `journal_code` —y el
    // repositorio ya la tenía declarada como redundante— y un libro llamado
    // «DIARIO GRAL» le agregaría a la empresa una categoría que ninguna otra
    // pantalla conoce. Lo que no se reconoce va a GENERAL, y queda dicho.
    const libroDeclarado = texto(r.campos.libro);
    const libro = LIBROS.get(sinAcentos(libroDeclarado ?? '')) ?? 'GENERAL';
    const avisoDelLibro =
      libroDeclarado !== null && libro === 'GENERAL' && sinAcentos(libroDeclarado) !== 'general'
        ? `El asiento venía del libro «${libroDeclarado}», que no es uno de los de NEXO ` +
          '(General, Compras, Ventas, Bancos, Caja, Sueldos, Ajustes, Cierre, Apertura). Entró ' +
          'en el General.'
        : null;

    const siguiente = await ctx.tx.query<{ next_entry_number: number }>(
      'SELECT next_entry_number($1, $2, $3)',
      [ctx.companyId, libro, periodo.fiscalYearId],
    );

    // La descripción lleva el número del origen entre corchetes. Es lo que
    // permite reconocer el asiento en la próxima corrida sin agregarle una
    // columna a `journal_entries` para un solo caso de uso.
    const descripcion =
      `${texto(r.campos.descripcion) ?? 'Asiento migrado'}` +
      (codigoExterno === null ? '' : ` [origen ${codigoExterno}]`);

    const cabecera = await ctx.tx.query<{ id: string }>(
      `INSERT INTO journal_entries
         (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
          description, kind, status, currency, total_debit, total_credit,
          source_type, source_id, manual_justification, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'NORMAL', 'PROPUESTO', $8, $9, $10,
               'MANUAL', NULL, $11, $12)
       RETURNING id`,
      [
        ctx.companyId,
        libro,
        periodo.id,
        periodo.fiscalYearId,
        siguiente.rows[0]!.next_entry_number,
        fecha,
        descripcion.slice(0, 500),
        texto(r.campos.moneda) ?? 'ARS',
        centavosATexto(debe),
        centavosATexto(haber),
        `Migrado desde ${r.procedencia.origen}, fila ${r.procedencia.fila}. Entra PROPUESTO: ` +
          'nadie de esta empresa lo revisó todavía.',
        ctx.actor,
      ],
    );
    const entryId = cabecera.rows[0]!.id;

    for (const [i, linea] of renglones.entries()) {
      await ctx.tx.query(
        `INSERT INTO journal_entry_lines
           (company_id, entry_id, line_no, account_id, debit, credit, currency, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          ctx.companyId,
          entryId,
          i + 1,
          linea.cuenta,
          centavosATexto(linea.debe),
          centavosATexto(linea.haber),
          texto(r.campos.moneda) ?? 'ARS',
          linea.descripcion,
        ],
      );
    }

    return {
      idDestino: entryId,
      tabla: 'journal_entries',
      advertencias: [
        `El asiento ${codigoExterno ?? ''} entró como PROPUESTO. No está en el Mayor todavía: ` +
          'lo estará cuando alguien lo apruebe desde «Asientos».',
        ...(avisoDelLibro === null ? [] : [avisoDelLibro]),
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Pagos
// ---------------------------------------------------------------------------

/**
 * Una orden de pago histórica.
 *
 * Entra en BORRADOR y sin asiento. Una orden APROBADA o PAGADA exige quién la
 * aprobó y cuándo, y un archivo de otro sistema no trae a esa persona; ponerse
 * a uno mismo como aprobador de un pago de hace dos años es falsificar una
 * firma.
 *
 * Sus renglones citan comprobantes de NEXO. Si el comprobante que el archivo
 * menciona no está migrado, la orden entra igual **sin renglones**, con la
 * advertencia: una orden de pago sin imputar sigue diciendo cuánto se le pagó a
 * quién y cuándo, que es la mayor parte de lo que se quiere conservar.
 */
const PAGO: Escritor = {
  entidad: 'PAYMENT',
  tabla: 'payment_orders',
  agrupaPor: null,

  async buscarExistente() {
    return null;
  },

  async escribir(ctx, grupo) {
    const r = primero(grupo);
    const advertencias: string[] = [];

    const fecha = texto(r.campos.fecha);
    if (fecha === null) throw new NoSePuedeEscribir('El pago no trae fecha');

    const cuit = texto(r.campos.cuitProveedor);
    if (cuit === null) {
      throw new NoSePuedeEscribir(
        'El pago no dice a qué proveedor fue. Una orden de pago sin destinatario no se puede ' +
          'registrar: la tabla exige el tercero.',
      );
    }
    const partyId = await ctx.terceroPorCuit(cuit);
    if (partyId === null) {
      throw new NoSePuedeEscribir(
        `No hay ningún tercero con el CUIT ${cuit}. Migrá primero los terceros.`,
      );
    }

    const importeCentavos = enCentavos(r.campos.importe);
    if (importeCentavos === null || BigInt(importeCentavos) <= 0n) {
      throw new NoSePuedeEscribir('El pago no trae un importe legible mayor que cero');
    }

    const siguiente = await ctx.tx.query<{ n: number }>(
      `SELECT coalesce(max(numero), 0) + 1 AS n FROM payment_orders WHERE company_id = $1`,
      [ctx.companyId],
    );

    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO payment_orders
         (company_id, party_id, numero, fecha, status, observaciones, created_by)
       VALUES ($1, $2, $3, $4, 'BORRADOR', $5, $6)
       RETURNING id`,
      [
        ctx.companyId,
        partyId,
        siguiente.rows[0]!.n,
        fecha,
        [
          `Migrada desde ${r.procedencia.origen}, fila ${r.procedencia.fila}.`,
          texto(r.campos.medio) === null ? null : `Medio declarado: ${texto(r.campos.medio)}.`,
          texto(r.campos.referencia) === null ? null : `Referencia: ${texto(r.campos.referencia)}.`,
        ]
          .filter((x) => x !== null)
          .join(' '),
        ctx.actor,
      ],
    );
    const id = rows[0]!.id;

    // El comprobante que el archivo cita, si está migrado.
    const comprobanteCitado = texto(r.campos.comprobante);
    if (comprobanteCitado !== null) {
      const encontrado = await ctx.tx.query<{ id: string }>(
        `SELECT id FROM tax_transactions
          WHERE company_id = $1 AND direction = 'COMPRAS' AND party_id = $2
            AND cbte_numero::text = $3
          LIMIT 1`,
        [ctx.companyId, partyId, comprobanteCitado.replace(/\D+/g, '')],
      );
      if (encontrado.rows[0] !== undefined) {
        await ctx.tx.query(
          `INSERT INTO payment_order_lines
             (company_id, payment_order_id, tax_transaction_id, importe, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [ctx.companyId, id, encontrado.rows[0].id, centavosATexto(BigInt(importeCentavos)), ctx.actor],
        );
      } else {
        advertencias.push(
          `El pago cita el comprobante ${comprobanteCitado} y no hay ninguno migrado de ese ` +
            'proveedor con ese número. La orden queda sin imputar: dice cuánto y a quién, no ' +
            'contra qué factura.',
        );
      }
    } else {
      advertencias.push(
        'El pago no cita ningún comprobante. La orden queda sin imputar, que es lo que el ' +
          'archivo permitía afirmar.',
      );
    }

    return {
      idDestino: id,
      tabla: 'payment_orders',
      ...(advertencias.length > 0 ? { advertencias } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// El registro
// ---------------------------------------------------------------------------

const ESCRITORES = new Map<Entidad, Escritor>([
  ['PARTY', TERCERO],
  ['PRODUCT', PRODUCTO],
  ['WAREHOUSE', DEPOSITO],
  ['ACCOUNT', CUENTA],
  ['JOURNAL_ENTRY', ASIENTO],
  ['STOCK_BALANCE', EXISTENCIA],
  ['STOCK_MOVEMENT', MOVIMIENTO_DE_STOCK],
  ['SALES_DOCUMENT', comprobante('SALES_DOCUMENT')],
  ['PURCHASE_DOCUMENT', comprobante('PURCHASE_DOCUMENT')],
  ['PAYMENT', PAGO],
]);

export const escritorDe = (entidad: Entidad): Escritor | null => ESCRITORES.get(entidad) ?? null;

/** Las entidades que hoy se pueden escribir en NEXO. La UI lo lee de acá. */
export const ENTIDADES_IMPORTABLES: readonly Entidad[] = [...ESCRITORES.keys()];

/**
 * En qué orden se importan.
 *
 * No es una preferencia: es una dependencia. Un movimiento de stock necesita el
 * producto y el depósito; un asiento necesita la cuenta; un comprobante
 * necesita el tercero; un pago necesita el comprobante. Importar en el orden en
 * que las hojas aparecen en el archivo haría fallar la mitad de las filas por
 * un motivo que no es de los datos.
 */
export const ORDEN_DE_IMPORTACION: readonly Entidad[] = [
  'WAREHOUSE',
  'ACCOUNT',
  'PARTY',
  'PRODUCT',
  'STOCK_BALANCE',
  'STOCK_MOVEMENT',
  'SALES_DOCUMENT',
  'PURCHASE_DOCUMENT',
  'JOURNAL_ENTRY',
  'COLLECTION',
  'PAYMENT',
];

/**
 * Por qué una entidad llega a la vista previa y no se puede importar.
 *
 * El motivo se muestra en la pantalla. «Todavía no» sin explicación deja a
 * alguien esperando una versión que nadie sabe si viene.
 */
export const MOTIVO_SIN_ESCRITOR: Readonly<Partial<Record<Entidad, string>>> = {
  COLLECTION:
    'Una cobranza en NEXO es una imputación contra un renglón del Mayor: `party_allocations` ' +
    'exige el `journal_entry_line_id` que la cancela. Un archivo de otro sistema no trae ese ' +
    'renglón, y elegirlo por parecido decidiría contra qué factura se aplicó cada peso. Cuando ' +
    'la contabilidad migrada esté aprobada, la imputación se hace desde «Imputaciones» con los ' +
    'renglones a la vista.',
};

