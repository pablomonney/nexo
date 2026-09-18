/**
 * Plan de cuentas NEXO PYME Argentina — Modelo basado en normativa contable
 * argentina vigente.
 *
 * **No es un plan oficial ni obligatorio.** La RT 54 (T.O. RT 59) no contiene un
 * plan de cuentas: la expresión no aparece una sola vez en el texto archivado en
 * `docs/normative-sources/extracted/RT59.txt`. Lo que la norma fija son los
 * rubros que hay que exponer, y su ¶56 habilita expresamente a «introducir
 * cambios en la denominación, apertura o agrupamiento de cuentas». Este catálogo
 * es la forma que NEXO propone para llegar a esos rubros; el modelo contable de
 * cada ente lo decide quien lo firma.
 *
 * ## Alcance
 *
 * PYME argentina general, con foco inicial en actividades comerciales y de
 * servicios. Incluye las tres cuentas de bienes de cambio de producción
 * —materias primas, productos en proceso y productos terminados— para cubrir
 * necesidades productivas básicas **sin** convertir esto en un catálogo
 * industrial: no hay cuentas de costos por órdenes, ni por procesos, ni
 * variaciones de producción.
 *
 * ## Por qué esta forma de codificación
 *
 * Cuatro niveles, numérica con puntos, porque `accounts.code` admite `^[0-9.]+$`
 * (migración 0003) y porque **las plantillas de estados contables seleccionan
 * cuentas por prefijo**. El prefijo no es decorativo: es el mapeo entre el plan y
 * el estado contable.
 *
 *     1.1.03.01
 *     │ │ │  └── cuenta imputable
 *     │ │ └───── rubro de exposición
 *     │ └─────── corriente / no corriente
 *     └───────── clase
 *
 * ## La excepción de nivel, declarada
 *
 * La regla conceptual es «nivel 3 = rubro agrupador, nivel 4 = imputable», y hay
 * **ocho excepciones deliberadas**: `1.2.03`, `1.2.04`, `2.1.08`, `2.1.09` y las
 * cuatro de `2.2` que no tienen apertura. Son rubros que en una PYME no
 * necesitan analíticas, y agregarles una hija `.01` sería inventar un nivel para
 * que la regla cierre. La base no lo impide —el trigger `accounts_parent_not_postable`
 * solo prohíbe que una cuenta CON hijas sea imputable— y el control de cobertura
 * de los estados tampoco: los selectores por prefijo las capturan igual.
 *
 * ## Las tres bajas respecto de los borradores previos
 *
 *     1.2.07  Cargas diferidas              RT 54 no tiene ese rubro
 *     4.8     Ganancias de ejercicios ant.  ¶69/¶646: van al EEPN, no al ER
 *     6.8     Pérdidas de ejercicios ant.   idem
 *
 * Y no existe ninguna cuenta de resultados extraordinarios (`4.9`, `6.9`): el
 * ¶630 dice que «una entidad no presentará partida alguna como resultado
 * extraordinario».
 *
 * ## Cuentas de orden — funcionalidad de NEXO, no exigencia de RT 54
 *
 * La clase 7 **no sale de la RT 54**, que no regula cuentas de orden. Es una
 * funcionalidad contable de NEXO, declarada como tal: sirve para registrar
 * compromisos que no integran el patrimonio —documentos endosados, garantías
 * otorgadas— con su par deudor y acreedor. **No participa de la ecuación
 * patrimonial, no entra en el ESP, no entra en el ER y no afecta el resultado.**
 * Cuando se escriban las plantillas RT 54, el fundamento de esos renglones debe
 * decir exactamente eso y no citar un párrafo que no existe.
 *
 * ## Metadatos para la automatización futura
 *
 * Cada cuenta lleva `usos`, que es el dominio del producto que la va a tocar
 * cuando exista la automatización. **Hoy no automatiza nada**: es el dato que le
 * va a faltar a `account_suggestion_rules` el día que se escriba, y anotarlo
 * ahora es más barato que deducirlo después de mil imputaciones.
 *
 * Las que llevan `especializada: true` **requieren tratamiento profesional** y
 * V1 no las automatiza aunque existan: participaciones permanentes sin VPP,
 * impuesto diferido sin el método, RECPAM sin ajuste por inflación aplicado,
 * VNR sin política de medición declarada. Que la cuenta exista no significa que
 * el sistema sepa cuándo usarla.
 */

/** Los dominios del producto que van a imputar contra estas cuentas. */
export const USOS = [
  'VENTAS',
  'COMPRAS',
  'CLIENTES',
  'PROVEEDORES',
  'TESORERIA',
  'IMPUESTOS',
  'STOCK',
  'ACTIVOS',
  'SUELDOS',
  'CIERRE',
  'ESTADOS',
];

export const PLANTILLA = {
  templateId: 'NEXO_PYME_AR',
  version: 1,
  nombre: 'Plan de cuentas NEXO PYME Argentina',
  descripcion: 'Modelo basado en normativa contable argentina vigente',
  alcance: 'PYME argentina general, con foco inicial en actividades comerciales y de servicios',
  origen:
    'Modelo NEXO. Los rubros de exposición siguen la RT 54 (T.O. RT 59), ¶209-¶646. ' +
    'La RT 54 no prescribe un plan de cuentas: su ¶56 admite cambios de denominación, ' +
    'apertura y agrupamiento. La clase 7 (cuentas de orden) es funcionalidad de NEXO ' +
    'y no una exigencia de la norma.',
};

/** La naturaleza que le corresponde a cada tipo cuando nadie la invierte. */
export const NATURALEZA_POR_TIPO = {
  ACTIVO: 'DEUDORA',
  PASIVO: 'ACREEDORA',
  PN: 'ACREEDORA',
  INGRESO: 'ACREEDORA',
  COSTO: 'DEUDORA',
  GASTO: 'DEUDORA',
  ORDEN: 'DEUDORA',
};

/** El padre de un código es todo lo que está antes del último punto. */
export function padreDe(codigo) {
  const corte = codigo.lastIndexOf('.');
  return corte === -1 ? null : codigo.slice(0, corte);
}

export function nivelDe(codigo) {
  return codigo.split('.').length;
}

export function naturalezaDe(cuenta) {
  return cuenta.naturaleza ?? NATURALEZA_POR_TIPO[cuenta.tipo];
}

/** Agrupadora: no recibe imputaciones. El trigger de la 0003 lo garantiza además. */
const g = (codigo, nombre, tipo, extra = {}) => ({
  codigo,
  nombre,
  tipo,
  imputable: false,
  nucleo: true,
  usos: [],
  ...extra,
});

/** Imputable. `usos` vacío significa que ningún dominio la toca automáticamente. */
const c = (codigo, nombre, tipo, extra = {}) => ({
  codigo,
  nombre,
  tipo,
  imputable: true,
  nucleo: false,
  usos: [],
  ...extra,
});

export const CUENTAS = [
  // ══ 1 · ACTIVO ═════════════════════════════════════════════════════════
  g('1', 'Activo', 'ACTIVO'),
  g('1.1', 'Activo corriente', 'ACTIVO'),

  g('1.1.01', 'Caja y bancos', 'ACTIVO'),
  c('1.1.01.01', 'Caja en pesos', 'ACTIVO', { nucleo: true, usos: ['TESORERIA'] }),
  c('1.1.01.02', 'Caja en moneda extranjera', 'ACTIVO', { usos: ['TESORERIA'] }),
  c('1.1.01.03', 'Fondo fijo', 'ACTIVO', { usos: ['TESORERIA'] }),
  c('1.1.01.04', 'Banco cuenta corriente en pesos', 'ACTIVO', { nucleo: true, usos: ['TESORERIA'] }),
  c('1.1.01.05', 'Banco caja de ahorro en pesos', 'ACTIVO', { usos: ['TESORERIA'] }),
  c('1.1.01.06', 'Banco cuenta en moneda extranjera', 'ACTIVO', { usos: ['TESORERIA'] }),
  c('1.1.01.07', 'Billeteras virtuales', 'ACTIVO', { nucleo: true, usos: ['TESORERIA'] }),
  c('1.1.01.08', 'Valores a depositar', 'ACTIVO', { nucleo: true, usos: ['TESORERIA', 'CLIENTES'] }),

  g('1.1.02', 'Inversiones', 'ACTIVO'),
  c('1.1.02.01', 'Plazo fijo', 'ACTIVO', { usos: ['TESORERIA'] }),
  c('1.1.02.02', 'Fondos comunes de inversión', 'ACTIVO', { usos: ['TESORERIA'] }),
  c('1.1.02.03', 'Títulos y acciones con cotización', 'ACTIVO', { usos: ['TESORERIA'] }),

  g('1.1.03', 'Créditos por ventas', 'ACTIVO'),
  c('1.1.03.01', 'Deudores por ventas', 'ACTIVO', {
    nucleo: true,
    usos: ['VENTAS', 'CLIENTES', 'TESORERIA'],
    rol: 'CLIENTES',
  }),
  c('1.1.03.02', 'Documentos a cobrar', 'ACTIVO', { usos: ['CLIENTES', 'TESORERIA'] }),
  c('1.1.03.03', 'Cheques de pago diferido a cobrar', 'ACTIVO', {
    nucleo: true,
    usos: ['CLIENTES', 'TESORERIA'],
  }),
  c('1.1.03.04', 'Tarjetas de crédito y débito a cobrar', 'ACTIVO', {
    nucleo: true,
    usos: ['VENTAS', 'TESORERIA'],
  }),
  c('1.1.03.05', 'Deudores morosos', 'ACTIVO', { usos: ['CLIENTES'] }),
  c('1.1.03.06', 'Deudores en gestión judicial', 'ACTIVO', {
    usos: ['CLIENTES'],
    especializada: true,
  }),
  c('1.1.03.90', 'Previsión para deudores incobrables', 'ACTIVO', {
    nucleo: true,
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['CIERRE'],
  }),

  g('1.1.04', 'Otros créditos', 'ACTIVO'),
  c('1.1.04.01', 'IVA crédito fiscal', 'ACTIVO', {
    nucleo: true,
    usos: ['COMPRAS', 'IMPUESTOS'],
    rol: 'IVA_CREDITO',
    taxRole: 'IVA_CF',
  }),
  c('1.1.04.02', 'IVA saldo a favor', 'ACTIVO', { nucleo: true, usos: ['IMPUESTOS'] }),
  c('1.1.04.03', 'Percepciones de IVA sufridas', 'ACTIVO', {
    nucleo: true,
    usos: ['COMPRAS', 'IMPUESTOS'],
    taxRole: 'PERCEPCION',
  }),
  c('1.1.04.04', 'Retenciones de IVA sufridas', 'ACTIVO', {
    nucleo: true,
    usos: ['TESORERIA', 'IMPUESTOS'],
    taxRole: 'RETENCION',
  }),
  c('1.1.04.05', 'Retenciones de impuesto a las ganancias sufridas', 'ACTIVO', {
    nucleo: true,
    usos: ['TESORERIA', 'IMPUESTOS'],
    taxRole: 'RETENCION',
  }),
  c('1.1.04.06', 'Percepciones y retenciones de ingresos brutos sufridas', 'ACTIVO', {
    nucleo: true,
    usos: ['COMPRAS', 'TESORERIA', 'IMPUESTOS'],
    taxRole: 'PERCEPCION',
  }),
  c('1.1.04.07', 'Anticipos de impuestos', 'ACTIVO', { usos: ['IMPUESTOS', 'TESORERIA'] }),
  c('1.1.04.08', 'Anticipos a proveedores', 'ACTIVO', {
    nucleo: true,
    usos: ['COMPRAS', 'PROVEEDORES'],
  }),
  c('1.1.04.09', 'Créditos con propietarios y partes relacionadas', 'ACTIVO', { usos: [] }),
  c('1.1.04.10', 'Gastos pagados por adelantado', 'ACTIVO', { usos: ['CIERRE'] }),
  c('1.1.04.11', 'Otros créditos diversos', 'ACTIVO', { usos: [] }),

  g('1.1.05', 'Bienes de cambio', 'ACTIVO'),
  c('1.1.05.01', 'Mercaderías de reventa', 'ACTIVO', {
    nucleo: true,
    usos: ['COMPRAS', 'STOCK', 'VENTAS'],
    rol: 'MERCADERIA',
  }),
  c('1.1.05.02', 'Materias primas', 'ACTIVO', { usos: ['COMPRAS', 'STOCK'] }),
  c('1.1.05.03', 'Productos en proceso', 'ACTIVO', { usos: ['STOCK'], especializada: true }),
  c('1.1.05.04', 'Productos terminados', 'ACTIVO', { usos: ['STOCK', 'VENTAS'] }),
  c('1.1.05.05', 'Mercaderías en tránsito', 'ACTIVO', { usos: ['COMPRAS', 'STOCK'] }),

  g('1.1.09', 'Otros activos corrientes', 'ACTIVO'),
  c('1.1.09.01', 'Activos no corrientes mantenidos para la venta', 'ACTIVO', {
    usos: ['ACTIVOS'],
    especializada: true,
  }),

  g('1.2', 'Activo no corriente', 'ACTIVO'),

  g('1.2.02', 'Inversiones no corrientes', 'ACTIVO'),
  c('1.2.02.01', 'Participaciones permanentes en otras entidades', 'ACTIVO', {
    usos: [],
    especializada: true,
    nota:
      'El valor patrimonial proporcional NO está implementado. La cuenta existe para ' +
      'registración manual con criterio profesional.',
  }),
  c('1.2.02.02', 'Otras inversiones no corrientes', 'ACTIVO', { usos: ['TESORERIA'] }),

  c('1.2.03', 'Créditos no corrientes', 'ACTIVO', { usos: ['CLIENTES'] }),
  c('1.2.04', 'Créditos con propietarios y partes relacionadas no corrientes', 'ACTIVO', {
    usos: [],
  }),

  g('1.2.05', 'Bienes de uso', 'ACTIVO'),
  c('1.2.05.01', 'Terrenos', 'ACTIVO', {
    usos: ['ACTIVOS'],
    nota: 'No se amortiza: es la única de bienes de uso sin par regularizador.',
  }),
  c('1.2.05.02', 'Inmuebles', 'ACTIVO', { usos: ['ACTIVOS'] }),
  c('1.2.05.03', 'Maquinarias y equipos', 'ACTIVO', { usos: ['ACTIVOS'] }),
  c('1.2.05.04', 'Rodados', 'ACTIVO', { nucleo: true, usos: ['ACTIVOS'] }),
  c('1.2.05.05', 'Muebles y útiles', 'ACTIVO', { nucleo: true, usos: ['ACTIVOS'] }),
  c('1.2.05.06', 'Equipos de computación', 'ACTIVO', { nucleo: true, usos: ['ACTIVOS'] }),
  c('1.2.05.07', 'Instalaciones', 'ACTIVO', { usos: ['ACTIVOS'] }),
  c('1.2.05.08', 'Obras en curso', 'ACTIVO', {
    usos: ['ACTIVOS'],
    nota: 'Cuenta patrimonial genérica. V1 no trae módulo de obra ni activación de costos.',
  }),
  c('1.2.05.92', 'Amortización acumulada de inmuebles', 'ACTIVO', {
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),
  c('1.2.05.93', 'Amortización acumulada de maquinarias y equipos', 'ACTIVO', {
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),
  c('1.2.05.94', 'Amortización acumulada de rodados', 'ACTIVO', {
    nucleo: true,
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),
  c('1.2.05.95', 'Amortización acumulada de muebles y útiles', 'ACTIVO', {
    nucleo: true,
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),
  c('1.2.05.96', 'Amortización acumulada de equipos de computación', 'ACTIVO', {
    nucleo: true,
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),
  c('1.2.05.97', 'Amortización acumulada de instalaciones', 'ACTIVO', {
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),

  g('1.2.06', 'Activos intangibles', 'ACTIVO'),
  c('1.2.06.01', 'Licencias y software', 'ACTIVO', { nucleo: true, usos: ['ACTIVOS'] }),
  c('1.2.06.02', 'Marcas y patentes', 'ACTIVO', { usos: ['ACTIVOS'], especializada: true }),
  c('1.2.06.90', 'Amortización acumulada de activos intangibles', 'ACTIVO', {
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),

  g('1.2.09', 'Otros activos no corrientes', 'ACTIVO'),
  c('1.2.09.01', 'Propiedades de inversión', 'ACTIVO', {
    usos: ['ACTIVOS'],
    especializada: true,
    nota: 'V1 no automatiza las alternativas de medición del ¶377.',
  }),
  c('1.2.09.02', 'Activo por impuesto diferido', 'ACTIVO', {
    usos: ['IMPUESTOS'],
    especializada: true,
    nota: 'El método del impuesto diferido NO está implementado. Registración profesional.',
  }),

  // ══ 2 · PASIVO ═════════════════════════════════════════════════════════
  g('2', 'Pasivo', 'PASIVO'),
  g('2.1', 'Pasivo corriente', 'PASIVO'),

  g('2.1.01', 'Deudas comerciales', 'PASIVO'),
  c('2.1.01.01', 'Proveedores', 'PASIVO', {
    nucleo: true,
    usos: ['COMPRAS', 'PROVEEDORES', 'TESORERIA'],
    rol: 'PROVEEDORES',
  }),
  c('2.1.01.02', 'Documentos a pagar', 'PASIVO', { usos: ['PROVEEDORES', 'TESORERIA'] }),
  c('2.1.01.03', 'Anticipos de clientes', 'PASIVO', { nucleo: true, usos: ['VENTAS', 'CLIENTES'] }),
  c('2.1.01.04', 'Provisión para gastos a pagar', 'PASIVO', { nucleo: true, usos: ['CIERRE'] }),

  g('2.1.02', 'Deudas bancarias y financieras', 'PASIVO'),
  c('2.1.02.01', 'Préstamos bancarios', 'PASIVO', { nucleo: true, usos: ['TESORERIA'] }),
  c('2.1.02.02', 'Adelantos en cuenta corriente', 'PASIVO', { usos: ['TESORERIA'] }),
  c('2.1.02.03', 'Cheques de pago diferido emitidos', 'PASIVO', {
    nucleo: true,
    usos: ['TESORERIA', 'PROVEEDORES'],
  }),
  c('2.1.02.90', 'Intereses a devengar', 'PASIVO', {
    naturaleza: 'DEUDORA',
    regularizadora: true,
    usos: ['CIERRE'],
    nota:
      'Regulariza la deuda: naturaleza deudora dentro de un rubro acreedor. Solo tiene ' +
      'sentido si se segregan los componentes financieros implícitos.',
  }),

  g('2.1.03', 'Deudas sociales y previsionales', 'PASIVO'),
  c('2.1.03.01', 'Sueldos y jornales a pagar', 'PASIVO', {
    nucleo: true,
    usos: ['SUELDOS', 'TESORERIA'],
  }),
  c('2.1.03.02', 'Cargas sociales a pagar', 'PASIVO', {
    nucleo: true,
    usos: ['SUELDOS', 'TESORERIA'],
  }),
  c('2.1.03.03', 'Provisión para SAC y cargas sociales', 'PASIVO', {
    nucleo: true,
    usos: ['SUELDOS', 'CIERRE'],
  }),
  c('2.1.03.04', 'Provisión para vacaciones y cargas sociales', 'PASIVO', {
    usos: ['SUELDOS', 'CIERRE'],
  }),

  g('2.1.04', 'Deudas fiscales', 'PASIVO'),
  c('2.1.04.01', 'IVA débito fiscal', 'PASIVO', {
    nucleo: true,
    usos: ['VENTAS', 'IMPUESTOS'],
    rol: 'IVA_DEBITO',
    taxRole: 'IVA_DF',
  }),
  c('2.1.04.02', 'IVA a pagar', 'PASIVO', { nucleo: true, usos: ['IMPUESTOS', 'TESORERIA'] }),
  c('2.1.04.03', 'Percepciones y retenciones a depositar', 'PASIVO', {
    nucleo: true,
    usos: ['IMPUESTOS', 'TESORERIA'],
    taxRole: 'RETENCION',
  }),
  c('2.1.04.04', 'Ingresos brutos a pagar', 'PASIVO', { nucleo: true, usos: ['IMPUESTOS'] }),
  c('2.1.04.05', 'Impuesto a las ganancias a pagar', 'PASIVO', {
    nucleo: true,
    usos: ['IMPUESTOS', 'CIERRE'],
  }),
  c('2.1.04.06', 'Otros impuestos a pagar', 'PASIVO', { usos: ['IMPUESTOS'] }),

  g('2.1.05', 'Otras deudas', 'PASIVO'),
  c('2.1.05.01', 'Deudas con propietarios y partes relacionadas', 'PASIVO', { usos: [] }),
  c('2.1.05.02', 'Acreedores varios', 'PASIVO', { nucleo: true, usos: ['TESORERIA'] }),
  c('2.1.05.03', 'Dividendos a pagar', 'PASIVO', { usos: ['CIERRE'] }),

  c('2.1.08', 'Previsiones', 'PASIVO', { usos: ['CIERRE'], especializada: true }),
  c('2.1.09', 'Ingresos diferidos', 'PASIVO', { usos: ['CIERRE'], especializada: true }),

  g('2.2', 'Pasivo no corriente', 'PASIVO'),
  c('2.2.01', 'Deudas comerciales no corrientes', 'PASIVO', { usos: ['PROVEEDORES'] }),
  c('2.2.02', 'Deudas bancarias y financieras no corrientes', 'PASIVO', {
    nucleo: true,
    usos: ['TESORERIA'],
  }),
  c('2.2.03', 'Otras deudas no corrientes', 'PASIVO', { usos: [] }),
  c('2.2.04', 'Pasivo por impuesto diferido', 'PASIVO', {
    usos: ['IMPUESTOS'],
    especializada: true,
    nota: 'El método del impuesto diferido NO está implementado. Registración profesional.',
  }),
  c('2.2.08', 'Previsiones no corrientes', 'PASIVO', { usos: ['CIERRE'], especializada: true }),
  c('2.2.09', 'Ingresos diferidos no corrientes', 'PASIVO', {
    usos: ['CIERRE'],
    especializada: true,
  }),

  // ══ 3 · PATRIMONIO NETO ════════════════════════════════════════════════
  g('3', 'Patrimonio neto', 'PN'),

  g('3.1', 'Capital social', 'PN'),
  c('3.1.01', 'Capital suscripto', 'PN', { nucleo: true, usos: ['ESTADOS'] }),
  c('3.1.02', 'Aportes irrevocables', 'PN', { usos: ['ESTADOS'] }),

  g('3.2', 'Primas de emisión y ajustes al capital', 'PN'),
  c('3.2.01', 'Ajuste de capital', 'PN', { nucleo: true, usos: ['ESTADOS'] }),
  c('3.2.02', 'Prima de emisión', 'PN', { usos: ['ESTADOS'] }),

  g('3.3', 'Reservas', 'PN'),
  c('3.3.01', 'Reserva legal', 'PN', { nucleo: true, usos: ['CIERRE', 'ESTADOS'] }),
  c('3.3.02', 'Otras reservas', 'PN', { usos: ['CIERRE', 'ESTADOS'] }),

  g('3.4', 'Resultados acumulados', 'PN'),
  c('3.4.01', 'Resultados no asignados', 'PN', { nucleo: true, usos: ['CIERRE', 'ESTADOS'] }),
  c('3.4.02', 'Resultado del ejercicio', 'PN', {
    nucleo: true,
    usos: ['CIERRE', 'ESTADOS'],
    closingRole: 'RESULTADO_DEL_EJERCICIO',
  }),
  c('3.4.03', 'Ajuste de resultados de ejercicios anteriores', 'PN', {
    usos: ['CIERRE', 'ESTADOS'],
    especializada: true,
    nota: 'Corrección retroactiva del ¶69. Se expone en el EEPN, que es V2.',
  }),

  g('3.9', 'Otros rubros del patrimonio neto', 'PN'),
  c('3.9.01', 'Resultados diferidos', 'PN', {
    usos: ['ESTADOS'],
    especializada: true,
    nota: 'Parte de la estructura patrimonial del ¶645 b). El EEPN que los expone es V2.',
  }),

  // ══ 4 · INGRESOS ═══════════════════════════════════════════════════════
  g('4', 'Ingresos', 'INGRESO'),

  g('4.1', 'Ventas de bienes', 'INGRESO'),
  c('4.1.01', 'Ventas de mercaderías', 'INGRESO', {
    nucleo: true,
    usos: ['VENTAS'],
    rol: 'VENTAS',
  }),
  c('4.1.90', 'Devoluciones y bonificaciones sobre ventas', 'INGRESO', {
    nucleo: true,
    naturaleza: 'DEUDORA',
    regularizadora: true,
    usos: ['VENTAS'],
  }),
  c('4.1.91', 'Descuentos concedidos', 'INGRESO', {
    naturaleza: 'DEUDORA',
    regularizadora: true,
    usos: ['VENTAS'],
  }),

  g('4.2', 'Prestación de servicios', 'INGRESO'),
  c('4.2.01', 'Ingresos por servicios', 'INGRESO', { nucleo: true, usos: ['VENTAS'] }),

  g('4.5', 'Resultados financieros y de tenencia — ganancias', 'INGRESO'),
  c('4.5.01', 'Intereses ganados', 'INGRESO', { nucleo: true, usos: ['TESORERIA'] }),
  c('4.5.02', 'Diferencias de cambio positivas', 'INGRESO', {
    nucleo: true,
    usos: ['TESORERIA'],
    taxRole: 'DIFERENCIA_CAMBIO',
  }),
  c('4.5.03', 'RECPAM — ganancia', 'INGRESO', {
    usos: ['CIERRE'],
    especializada: true,
    nota: 'Solo con ajuste por inflación aplicado (¶176-200). V1 no lo activa automáticamente.',
  }),

  g('4.6', 'Otros ingresos ordinarios', 'INGRESO'),
  c('4.6.01', 'Ganancia por medición de bienes de cambio a valor neto de realización', 'INGRESO', {
    usos: ['STOCK'],
    especializada: true,
    nota: 'Depende de la política de medición declarada. No se usa automáticamente.',
  }),
  // El nombre no repite el del rubro que la contiene: dos filas idénticas en un
  // desplegable son una imputación equivocada esperando.
  c('4.6.02', 'Ingresos varios', 'INGRESO', { usos: [] }),

  // ══ 5 · COSTOS ═════════════════════════════════════════════════════════
  g('5', 'Costo de ventas y de servicios prestados', 'COSTO'),
  g('5.1', 'Costo de ventas', 'COSTO'),
  c('5.1.01', 'Costo de mercaderías vendidas', 'COSTO', {
    nucleo: true,
    usos: ['VENTAS', 'STOCK'],
    rol: 'COSTO_DE_VENTAS',
  }),
  c('5.1.02', 'Costo de servicios prestados', 'COSTO', { nucleo: true, usos: ['VENTAS'] }),
  c('5.1.03', 'Compras de mercaderías', 'COSTO', {
    nucleo: true,
    usos: ['COMPRAS'],
    rol: 'COMPRAS',
    nota:
      'CON INVENTARIO PERMANENTE SU SALDO CORRECTO ES CERO. La compra debita ' +
      '1.1.05.01 (Mercaderías de reventa) y el costo se reconoce en la venta contra ' +
      '5.1.01. Esta cuenta existe porque el rol COMPRAS exige una cuenta de tipo ' +
      'COSTO o GASTO (trigger assert_cuenta_del_rol), y para la empresa que lleve ' +
      'inventario periódico, que ahí sí la usa y la refunde contra existencias al ' +
      'cierre. Imputar acá con inventario permanente duplica el costo: una vez en la ' +
      'compra y otra en el costo de ventas.',
  }),
  c('5.1.04', 'Pérdida por medición de bienes de cambio a valor neto de realización', 'COSTO', {
    usos: ['STOCK'],
    especializada: true,
    nota: 'Depende de la política de medición declarada. No se usa automáticamente.',
  }),
  c('5.1.05', 'Fletes sobre compras', 'COSTO', {
    usos: ['COMPRAS', 'STOCK'],
    nota: 'Es costo del bien, no gasto de estructura.',
  }),
  c('5.1.90', 'Devoluciones y bonificaciones sobre compras', 'COSTO', {
    nucleo: true,
    naturaleza: 'ACREEDORA',
    regularizadora: true,
    usos: ['COMPRAS'],
  }),

  // ══ 6 · GASTOS ═════════════════════════════════════════════════════════
  g('6', 'Gastos ordinarios', 'GASTO'),

  g('6.1', 'Gastos de administración', 'GASTO'),
  c('6.1.01', 'Sueldos y jornales — administración', 'GASTO', { nucleo: true, usos: ['SUELDOS'] }),
  c('6.1.02', 'Cargas sociales — administración', 'GASTO', { nucleo: true, usos: ['SUELDOS'] }),
  c('6.1.03', 'Retribuciones de administradores', 'GASTO', {
    usos: ['SUELDOS'],
    nota:
      'Art. 64 inc. I. b) 1 de la Ley 19.550 pide exponer el monto por separado. ' +
      'Que corresponda o no depende del tipo de ente: es una regla de aplicabilidad, ' +
      'no un motivo para sacar la cuenta del catálogo general.',
  }),
  c('6.1.04', 'Honorarios profesionales', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),
  c('6.1.05', 'Alquileres', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),
  c('6.1.06', 'Servicios (energía, gas, agua, internet)', 'GASTO', {
    nucleo: true,
    usos: ['COMPRAS'],
  }),
  c('6.1.07', 'Papelería, librería e insumos', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),
  c('6.1.08', 'Seguros', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),
  c('6.1.09', 'Mantenimiento y reparaciones', 'GASTO', { usos: ['COMPRAS'] }),
  c('6.1.10', 'Amortizaciones — administración', 'GASTO', {
    nucleo: true,
    usos: ['ACTIVOS', 'CIERRE'],
  }),
  c('6.1.99', 'Otros gastos de administración', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),

  g('6.2', 'Gastos de comercialización', 'GASTO'),
  c('6.2.01', 'Sueldos y jornales — comercialización', 'GASTO', {
    nucleo: true,
    usos: ['SUELDOS'],
  }),
  c('6.2.02', 'Cargas sociales — comercialización', 'GASTO', { nucleo: true, usos: ['SUELDOS'] }),
  c('6.2.03', 'Comisiones sobre ventas', 'GASTO', { nucleo: true, usos: ['VENTAS'] }),
  c('6.2.04', 'Publicidad y promoción', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),
  c('6.2.05', 'Fletes sobre ventas', 'GASTO', { nucleo: true, usos: ['VENTAS', 'COMPRAS'] }),
  c('6.2.06', 'Impuesto sobre los ingresos brutos', 'GASTO', {
    nucleo: true,
    usos: ['VENTAS', 'IMPUESTOS'],
  }),
  c('6.2.07', 'Amortizaciones — comercialización', 'GASTO', { usos: ['ACTIVOS', 'CIERRE'] }),
  c('6.2.99', 'Otros gastos de comercialización', 'GASTO', { nucleo: true, usos: ['COMPRAS'] }),

  g('6.3', 'Gastos de financiación', 'GASTO'),
  c('6.3.01', 'Intereses perdidos', 'GASTO', { nucleo: true, usos: ['TESORERIA'] }),
  c('6.3.02', 'Diferencias de cambio negativas', 'GASTO', {
    nucleo: true,
    usos: ['TESORERIA'],
    taxRole: 'DIFERENCIA_CAMBIO',
  }),
  c('6.3.03', 'Impuesto a los débitos y créditos bancarios', 'GASTO', {
    nucleo: true,
    usos: ['TESORERIA', 'IMPUESTOS'],
  }),
  c('6.3.04', 'Gastos y comisiones bancarias', 'GASTO', { nucleo: true, usos: ['TESORERIA'] }),
  c('6.3.05', 'RECPAM — pérdida', 'GASTO', {
    usos: ['CIERRE'],
    especializada: true,
    nota: 'Solo con ajuste por inflación aplicado (¶176-200). V1 no lo activa automáticamente.',
  }),

  g('6.4', 'Otros gastos ordinarios', 'GASTO'),
  c('6.4.01', 'Deudores incobrables', 'GASTO', { nucleo: true, usos: ['CLIENTES', 'CIERRE'] }),
  c('6.4.02', 'Impuesto a las ganancias', 'GASTO', {
    nucleo: true,
    usos: ['IMPUESTOS', 'CIERRE'],
    nota: 'Renglón propio en el estado de resultados: ¶629 i).',
  }),
  c('6.4.03', 'Gastos varios', 'GASTO', { usos: [] }),

  // ══ 7 · CUENTAS DE ORDEN ═══════════════════════════════════════════════
  // Funcionalidad contable de NEXO. NO es un rubro exigido por la RT 54, que no
  // regula cuentas de orden. Fuera del patrimonio: no entra en el ESP, no entra
  // en el ER, no afecta el resultado y no participa de la ecuación patrimonial.
  g('7', 'Cuentas de orden', 'ORDEN'),
  g('7.1', 'Cuentas de orden deudoras', 'ORDEN'),
  c('7.1.01', 'Documentos endosados', 'ORDEN', { usos: [], especializada: true }),
  c('7.1.02', 'Garantías otorgadas', 'ORDEN', { usos: [], especializada: true }),
  g('7.2', 'Cuentas de orden acreedoras', 'ORDEN', { naturaleza: 'ACREEDORA' }),
  c('7.2.01', 'Endoso de documentos (contrapartida)', 'ORDEN', {
    naturaleza: 'ACREEDORA',
    usos: [],
    especializada: true,
  }),
  c('7.2.02', 'Acreedores por garantías otorgadas', 'ORDEN', {
    naturaleza: 'ACREEDORA',
    usos: [],
    especializada: true,
  }),
];

/**
 * Los prefijos que el renglón `PN_RESULTADO` del ESP tiene que enumerar.
 *
 * Es el espejo exacto de los renglones de resultado del estado de resultados.
 * Vive acá y no en la plantilla porque **la propiedad que protege es del
 * catálogo**: una cuenta de resultado con un código fuera de esta lista queda sin
 * renglón en los dos estados a la vez y bloquea la emisión, que es el
 * comportamiento buscado. Si estuviera solo en la plantilla, agregar una cuenta
 * nueva la dejaría en el ESP y afuera del ER sin que nada avisara.
 */
export const PREFIJOS_DE_RESULTADO = [
  '4.1',
  '4.2',
  '4.5',
  '4.6.01',
  '4.6.02',
  '5.1.01',
  '5.1.02',
  '5.1.03',
  '5.1.04',
  '5.1.05',
  '5.1.90',
  '6.1',
  '6.2',
  '6.3',
  '6.4.01',
  '6.4.02',
  '6.4.03',
];

/** Los ocho roles de `company_account_map`, con la cuenta que los cumple. */
export const ROLES = {
  CLIENTES: '1.1.03.01',
  PROVEEDORES: '2.1.01.01',
  IVA_DEBITO: '2.1.04.01',
  IVA_CREDITO: '1.1.04.01',
  VENTAS: '4.1.01',
  COMPRAS: '5.1.03',
  MERCADERIA: '1.1.05.01',
  COSTO_DE_VENTAS: '5.1.01',
};

/** La cuenta que recibe la refundición. `accounts.closing_role` de la 0038. */
export const CUENTA_DE_CIERRE = '3.4.02';

/** Las clases que NO integran el patrimonio ni el resultado. */
export const CLASES_FUERA_DE_LOS_ESTADOS = ['7'];
