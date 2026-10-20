/**
 * Cómo se muestran los permisos: por módulo, y con una etiqueta de lo que cada uno permite hacer.
 *
 * El código de un permiso es `dominio:accion` (`cash:write`). Esta tabla pone nombre de módulo al dominio y etiqueta a la acción para
 * que quien arma un puesto propio vea «Caja — Cargar y editar» y no `cash:write`. La descripción larga sale de `permissions.description`.
 *
 * Un dominio que no figura acá se muestra con su código: no se esconde (mostrar de menos sería más peligroso que mostrar feo).
 */

export const MODULOS_POR_DOMINIO: Readonly<Record<string, string>> = {
  account: 'Plan de cuentas',
  alert: 'Alertas',
  allocation: 'Cuenta corriente (imputaciones)',
  analysis: 'Señales y escenarios',
  analytics: 'Analítica',
  arca_credential: 'Certificados de ARCA',
  asset: 'Bienes de uso',
  assistant: 'Asistente',
  audit: 'Auditoría',
  audit_finding: 'Hallazgos de auditoría',
  bank: 'Bancos',
  billing: 'Cuenta con NEXO',
  book: 'Libros emitidos',
  branch: 'Sucursales',
  cash: 'Caja',
  check: 'Cheques',
  commercial: 'Presupuestos y pedidos',
  commission: 'Comisiones',
  company: 'Datos de la empresa',
  cost_center: 'Centros de costo',
  crm: 'CRM',
  decision: 'Decisiones',
  document: 'Documentos',
  fiscal_year: 'Cierre de ejercicio',
  integration: 'Integraciones',
  intelligence: 'Preguntar',
  journal_entry: 'Asientos',
  ledger: 'Verificación del Mayor',
  migration: 'Migraciones',
  norm_watch: 'Normas detectadas',
  note: 'Notas a los estados',
  party: 'Clientes y proveedores',
  payment_order: 'Órdenes de pago',
  period: 'Cierre de períodos',
  prediction: 'Propuestas de IA',
  product: 'Productos y precios',
  project: 'Proyectos',
  purchase_request: 'Pedidos de compra',
  receipt: 'Recepciones',
  report: 'Libros y reportes',
  rule: 'Reglas normativas',
  secret: 'Secretos de integraciones',
  statement: 'Estados contables',
  stock: 'Stock',
  subscription: 'Plan',
  tax_affectation: 'Afectación fiscal',
  tax_transaction: 'Constatación de comprobantes',
  user: 'Usuarios',
  vat_book: 'IVA',
};

const ETIQUETA_DE_LA_ACCION: Readonly<Record<string, string>> = {
  read: 'Ver',
  write: 'Cargar y editar',
  approve: 'Aprobar',
  create: 'Crear',
  upload: 'Subir',
  download: 'Descargar',
  import: 'Importar',
  reconcile: 'Conciliar',
  confirm: 'Confirmar',
  adjust: 'Ajustar',
  count: 'Contar',
  acknowledge: 'Reconocer',
  configure: 'Configurar',
  review: 'Revisar',
  run: 'Pedir que clasifique',
  ingest: 'Cargar lo que llega de afuera',
  resolve: 'Resolver',
  generate: 'Generar',
  declare: 'Declarar',
  constatar: 'Constatar',
  ask: 'Usar',
};

export interface PermisoParaMostrar {
  readonly codigo: string;
  readonly modulo: string;
  readonly funcion: string;
  readonly descripcion: string;
}

export function paraMostrar(codigo: string, descripcion: string): PermisoParaMostrar {
  const [dominio = codigo, accion = ''] = codigo.split(':');
  return {
    codigo,
    modulo: MODULOS_POR_DOMINIO[dominio] ?? dominio,
    funcion: ETIQUETA_DE_LA_ACCION[accion] ?? accion,
    descripcion,
  };
}

/**
 * ¿Este permiso mueve plata, aprueba, ajusta el inventario o toca la contabilidad? Quien lo tiene entra con segundo factor, venga de donde venga:
 * de un rol, de un puesto predeterminado, de un puesto propio o de un ajuste a una persona. Es el mismo criterio con el que se marcaron los
 * puestos predeterminados (`tests/security/puestos-predeterminados.test.ts`).
 */
export function permisoSensible(codigo: string): boolean {
  return /:approve$|^stock:adjust$|^journal_entry:create$|^vat_book:generate$|^tax_|^payment_order:write$/u.test(codigo);
}
