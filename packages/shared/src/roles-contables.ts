/**
 * Los roles del mapeo contable: la fuente única.
 *
 * ## Por qué existe este archivo
 *
 * La lista de ocho roles estaba escrita **cuatro veces**: el tipo `RolContable`
 * en `armar-renglones.ts`, la constante `ROLES` en `mapeo-contable.ts`, el
 * `CHECK` de la migración 0079 y el catálogo de cuentas. Las cuatro coincidían,
 * que es exactamente la situación en la que este repositorio ya se equivocó dos
 * veces —el organismo de contralor y el tipo de entidad—: dos copias de una
 * decisión se desincronizan y nadie lo nota, **porque las dos siguen
 * contestando**.
 *
 * Acá viven una sola vez. La cuarta copia, la de la base, no se puede mover: es
 * un `CHECK` y tiene que estar en SQL. Lo que sí se puede es comprobar que sigan
 * diciendo lo mismo, y eso lo hace un test que lee la migración.
 *
 * ## Por qué el orden importa
 *
 * Los seis primeros arman el asiento de un comprobante. Los dos últimos los
 * agregó la 0079 para el asiento de costo de mercadería vendida. `accounting_map_status`
 * —y con ella la rama de la bandeja— cuenta **solo los seis primeros** a
 * propósito: una empresa de servicios no tiene mercadería, y decirle que le
 * falta declarar dónde va su costo sería reclamarle algo que no le corresponde.
 */

export const ROLES_CONTABLES = [
  'CLIENTES',
  'PROVEEDORES',
  'IVA_DEBITO',
  'IVA_CREDITO',
  'VENTAS',
  'COMPRAS',
  'MERCADERIA',
  'COSTO_DE_VENTAS',
] as const;

export type RolContable = (typeof ROLES_CONTABLES)[number];

/** Los dos que solo hacen falta con existencias. Ver el encabezado. */
export const ROLES_DE_COSTO: readonly RolContable[] = ['MERCADERIA', 'COSTO_DE_VENTAS'];

/** Para qué se usa cada rol, dicho una vez y en un solo lugar. */
export const DESCRIPCION_DE_ROL: Readonly<Record<RolContable, string>> = {
  CLIENTES: 'La contrapartida de una venta en cuenta corriente',
  PROVEEDORES: 'La contrapartida de una compra en cuenta corriente',
  IVA_DEBITO: 'El IVA que se le cobra al cliente y se le debe al fisco',
  IVA_CREDITO: 'El IVA que paga la empresa y computa contra el débito',
  VENTAS:
    'El neto gravado de una venta, cuando el comprobante no tiene renglones con cuenta propia',
  COMPRAS:
    'El neto gravado de una compra, cuando el comprobante no tiene renglones con cuenta propia',
  MERCADERIA: 'El activo que se da de baja al vender: lo que la empresa tiene hasta que lo vende',
  COSTO_DE_VENTAS: 'El resultado negativo que se reconoce cuando la mercadería sale por venta',
};

/**
 * El tipo de cuenta que cada rol admite.
 *
 * Es el mismo criterio que aplica el trigger `assert_cuenta_del_rol` (0074,
 * ampliado por la 0079). Acá sirve para validar un catálogo **antes** de que la
 * base lo rechace; el trigger sigue siendo la autoridad.
 */
export const TIPOS_ADMITIDOS_POR_ROL: Readonly<Record<RolContable, readonly string[]>> = {
  CLIENTES: ['ACTIVO'],
  PROVEEDORES: ['PASIVO'],
  IVA_DEBITO: ['PASIVO'],
  IVA_CREDITO: ['ACTIVO'],
  VENTAS: ['INGRESO'],
  // La mercadería es un activo: es lo que la empresa tiene hasta que lo vende.
  MERCADERIA: ['ACTIVO'],
  COMPRAS: ['COSTO', 'GASTO'],
  COSTO_DE_VENTAS: ['COSTO'],
};
