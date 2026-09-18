/**
 * El plan de cuentas NEXO PYME Argentina, verificado contra el esquema que lo va
 * a recibir.
 *
 * ## Por qué un control y no una revisión a ojo
 *
 * Este catálogo todavía no está en la base: es la fuente de la que después van a
 * salir `chart_templates → chart_template_accounts → account_charts → accounts`.
 * Entre esa fuente y la base hay reglas que ya existen y que no perdonan:
 *
 *   · `accounts.code` admite `^[0-9.]+$` y hasta 40 caracteres (0003);
 *   · el trigger `accounts_parent_not_postable` vuelve no imputable a toda
 *     cuenta que reciba una hija;
 *   · `assert_cuenta_del_rol` exige que la cuenta de cada rol sea imputable y
 *     del tipo esperado;
 *   · `accounts_resultado_es_pn_imputable` exige que la del cierre sea PN,
 *     imputable y activa, y hay un índice único que impide dos por empresa;
 *   · `CUENTA_SIN_RUBRO` **bloquea la emisión** de un estado contable si una
 *     cuenta imputable no cae en ningún renglón.
 *
 * Descubrir cualquiera de esas cosas el día de la siembra es descubrirla tarde.
 * Acá se descubren sin base de datos y en milisegundos.
 *
 * ## Lo que este archivo NO comprueba
 *
 * Que el catálogo sea contablemente adecuado para una PYME. Eso lo dice un
 * contador matriculado, no un test.
 */

import { describe, expect, it } from 'vitest';
import {
  CUENTAS,
  CUENTA_DE_CIERRE,
  naturalezaDe,
  nivelDe,
  padreDe,
  PLANTILLA,
  PREFIJOS_DE_RESULTADO,
  ROLES,
  USOS,
} from '../../scripts/plan-de-cuentas-nexo-pyme-ar.mjs';

/** Los tipos que admite `accounts.type` en la migración 0003. */
const TIPOS_DE_LA_BASE = ['ACTIVO', 'PASIVO', 'PN', 'INGRESO', 'COSTO', 'GASTO', 'ORDEN'];

/** Los valores que admite `accounts.tax_role`. */
const TAX_ROLES_DE_LA_BASE = [
  'IVA_CF',
  'IVA_DF',
  'PERCEPCION',
  'RETENCION',
  'DIFERENCIA_CAMBIO',
];

/** El tipo que `assert_cuenta_del_rol` (0074/0079) espera para cada rol. */
const TIPO_ESPERADO_POR_ROL: Record<string, string[]> = {
  CLIENTES: ['ACTIVO'],
  PROVEEDORES: ['PASIVO'],
  IVA_DEBITO: ['PASIVO'],
  IVA_CREDITO: ['ACTIVO'],
  VENTAS: ['INGRESO'],
  COMPRAS: ['COSTO', 'GASTO'],
  MERCADERIA: ['ACTIVO'],
  COSTO_DE_VENTAS: ['COSTO'],
};

interface Cuenta {
  codigo: string;
  nombre: string;
  tipo: string;
  imputable: boolean;
  nucleo: boolean;
  usos: string[];
  naturaleza?: string;
  regularizadora?: boolean;
  especializada?: boolean;
  rol?: string;
  taxRole?: string;
  closingRole?: string;
  nota?: string;
}

const cuentas = CUENTAS as Cuenta[];
const porCodigo = new Map(cuentas.map((cuenta) => [cuenta.codigo, cuenta]));
const imputables = cuentas.filter((cuenta) => cuenta.imputable);
const agrupadoras = cuentas.filter((cuenta) => !cuenta.imputable);
const conHijas = new Set(
  cuentas.map((cuenta) => padreDe(cuenta.codigo)).filter((padre): padre is string => padre !== null),
);

describe('Plan de cuentas NEXO PYME Argentina — estructura', () => {
  it('los conteos son los declarados', () => {
    // Si este test falla después de agregar o sacar una cuenta, lo que hay que
    // corregir es el informe, no el test: el número sale del catálogo.
    expect(cuentas.length).toBe(185);
    expect(agrupadoras.length).toBe(42);
    expect(imputables.length).toBe(143);
  });

  it('no hay códigos repetidos', () => {
    expect(porCodigo.size).toBe(cuentas.length);
  });

  it('no hay nombres repetidos', () => {
    // Dos cuentas con el mismo nombre en distinto rubro son una imputación
    // equivocada esperando: el desplegable las muestra idénticas.
    const nombres = cuentas.map((cuenta) => cuenta.nombre);
    expect(new Set(nombres).size).toBe(nombres.length);
  });

  it('todos los códigos entran en la columna `accounts.code`', () => {
    for (const cuenta of cuentas) {
      expect(cuenta.codigo, cuenta.codigo).toMatch(/^[0-9.]+$/u);
      expect(cuenta.codigo.length).toBeLessThanOrEqual(40);
      expect(cuenta.nombre.length).toBeLessThanOrEqual(200);
      expect(cuenta.nombre.trim()).toBe(cuenta.nombre);
    }
  });

  it('todos los tipos existen en el CHECK de la base', () => {
    for (const cuenta of cuentas) {
      expect(TIPOS_DE_LA_BASE, cuenta.codigo).toContain(cuenta.tipo);
    }
  });

  it('cada cuenta tiene padre existente, y la raíz de cada clase no tiene padre', () => {
    for (const cuenta of cuentas) {
      const padre = padreDe(cuenta.codigo);
      if (padre === null) {
        expect(nivelDe(cuenta.codigo), cuenta.codigo).toBe(1);
        continue;
      }
      expect(porCodigo.has(padre), `${cuenta.codigo} cuelga de ${padre}, que no existe`).toBe(true);
    }
  });

  it('una cuenta con hijas nunca es imputable', () => {
    // Es la regla que el trigger `accounts_parent_not_postable` aplica sola. Que
    // el catálogo ya la cumpla evita que la siembra "arregle" una cuenta en
    // silencio y el archivo diga una cosa y la base otra.
    for (const cuenta of cuentas) {
      if (conHijas.has(cuenta.codigo)) {
        expect(cuenta.imputable, `${cuenta.codigo} tiene hijas y está marcada imputable`).toBe(
          false,
        );
      }
    }
  });

  it('no hay agrupadoras sin hijas', () => {
    // Una agrupadora sin hijas no agrupa nada y no recibe imputaciones: es una
    // fila que ninguna cuenta puede usar.
    for (const cuenta of agrupadoras) {
      expect(conHijas.has(cuenta.codigo), `${cuenta.codigo} no agrupa nada`).toBe(true);
    }
  });

  it('toda hoja es imputable', () => {
    for (const cuenta of cuentas) {
      if (!conHijas.has(cuenta.codigo)) {
        expect(cuenta.imputable, `${cuenta.codigo} es hoja y no es imputable`).toBe(true);
      }
    }
  });

  it('el tipo de una cuenta coincide con el de su clase', () => {
    // Una cuenta de gasto dentro del activo rompería el alcance de los estados:
    // el control `CUENTA_FUERA_DE_ALCANCE` la marcaría al emitir.
    for (const cuenta of cuentas) {
      const clase = porCodigo.get(cuenta.codigo[0]!);
      expect(clase, `falta la clase ${cuenta.codigo[0]}`).toBeDefined();
      expect(cuenta.tipo, cuenta.codigo).toBe(clase!.tipo);
    }
  });

  it('los niveles son los previstos, con las ocho excepciones declaradas', () => {
    // La regla conceptual es nivel 3 = rubro, nivel 4 = imputable. Las
    // excepciones son rubros que en una PYME no necesitan apertura. Están
    // enumeradas: una excepción sin nombre es una regla que no existe.
    const EXCEPCIONES = ['1.2.03', '1.2.04', '2.1.08', '2.1.09', '2.2.01', '2.2.02', '2.2.03', '2.2.04', '2.2.08', '2.2.09'];
    const imputablesDeNivel3EnActivoYPasivo = imputables
      .filter((cuenta) => ['1', '2'].includes(cuenta.codigo[0]!) && nivelDe(cuenta.codigo) === 3)
      .map((cuenta) => cuenta.codigo);
    expect(imputablesDeNivel3EnActivoYPasivo.sort()).toEqual([...EXCEPCIONES].sort());

    for (const cuenta of cuentas) {
      expect(nivelDe(cuenta.codigo)).toBeLessThanOrEqual(4);
    }
  });
});

describe('Plan de cuentas NEXO PYME Argentina — naturaleza y regularizadoras', () => {
  const NATURAL: Record<string, string> = {
    ACTIVO: 'DEUDORA',
    PASIVO: 'ACREEDORA',
    PN: 'ACREEDORA',
    INGRESO: 'ACREEDORA',
    COSTO: 'DEUDORA',
    GASTO: 'DEUDORA',
    ORDEN: 'DEUDORA',
  };

  it('una cuenta es regularizadora si, y solo si, tiene la naturaleza invertida', () => {
    for (const cuenta of cuentas) {
      // Las cuentas de orden acreedoras no son regularizadoras: son el otro lado
      // del par, y su naturaleza invertida es su razón de ser.
      if (cuenta.codigo.startsWith('7.2')) continue;
      const invertida = naturalezaDe(cuenta) !== NATURAL[cuenta.tipo];
      expect(Boolean(cuenta.regularizadora), `${cuenta.codigo}`).toBe(invertida);
    }
  });

  it('las doce regularizadoras están donde tienen que estar', () => {
    const codigos = cuentas
      .filter((cuenta) => cuenta.regularizadora)
      .map((cuenta) => cuenta.codigo)
      .sort();
    expect(codigos).toEqual([
      '1.1.03.90',
      '1.2.05.92',
      '1.2.05.93',
      '1.2.05.94',
      '1.2.05.95',
      '1.2.05.96',
      '1.2.05.97',
      '1.2.06.90',
      '2.1.02.90',
      '4.1.90',
      '4.1.91',
      '5.1.90',
    ]);
  });

  it('cada regularizadora vive dentro del prefijo del rubro que corrige', () => {
    // Es lo que hace que reste en el renglón correcto sin necesitar un renglón
    // propio: el selector por prefijo la captura junto con lo que regulariza.
    for (const cuenta of cuentas.filter((x) => x.regularizadora)) {
      const padre = padreDe(cuenta.codigo);
      expect(padre, cuenta.codigo).not.toBeNull();
      expect(porCodigo.get(padre!)!.imputable).toBe(false);
    }
  });

  it('todas las regularizadoras son imputables', () => {
    for (const cuenta of cuentas.filter((x) => x.regularizadora)) {
      expect(cuenta.imputable, cuenta.codigo).toBe(true);
    }
  });
});

describe('Plan de cuentas NEXO PYME Argentina — roles de automatización', () => {
  it('los ocho roles apuntan a una cuenta que existe, es imputable y es del tipo que el trigger espera', () => {
    for (const [rol, codigo] of Object.entries(ROLES as Record<string, string>)) {
      const cuenta = porCodigo.get(codigo);
      expect(cuenta, `${rol} → ${codigo} no existe`).toBeDefined();
      expect(cuenta!.imputable, `${rol} → ${codigo} no es imputable`).toBe(true);
      expect(TIPO_ESPERADO_POR_ROL[rol], `${rol} → ${codigo}`).toContain(cuenta!.tipo);
    }
  });

  it('cada rol está declarado en su propia cuenta, y no hay dos cuentas con el mismo rol', () => {
    const declarados = cuentas
      .filter((cuenta) => cuenta.rol !== undefined)
      .map((cuenta) => [cuenta.rol!, cuenta.codigo] as const);
    expect(new Set(declarados.map(([rol]) => rol)).size).toBe(declarados.length);
    expect(Object.fromEntries(declarados)).toEqual(ROLES);
  });

  it('hay exactamente una cuenta de cierre, y cumple el CHECK de la 0038', () => {
    const conCierre = cuentas.filter((cuenta) => cuenta.closingRole !== undefined);
    expect(conCierre.length).toBe(1);
    expect(conCierre[0]!.codigo).toBe(CUENTA_DE_CIERRE);
    expect(conCierre[0]!.closingRole).toBe('RESULTADO_DEL_EJERCICIO');
    expect(conCierre[0]!.tipo).toBe('PN');
    expect(conCierre[0]!.imputable).toBe(true);
  });

  it('los `tax_role` declarados existen en la base y están en cuentas imputables', () => {
    for (const cuenta of cuentas.filter((x) => x.taxRole !== undefined)) {
      expect(TAX_ROLES_DE_LA_BASE, cuenta.codigo).toContain(cuenta.taxRole);
      expect(cuenta.imputable, cuenta.codigo).toBe(true);
    }
  });

  it('IVA crédito es activo y IVA débito es pasivo', () => {
    // Invertirlos es el error que más caro sale y el más fácil de cometer.
    expect(porCodigo.get(ROLES.IVA_CREDITO)!.taxRole).toBe('IVA_CF');
    expect(porCodigo.get(ROLES.IVA_CREDITO)!.tipo).toBe('ACTIVO');
    expect(porCodigo.get(ROLES.IVA_DEBITO)!.taxRole).toBe('IVA_DF');
    expect(porCodigo.get(ROLES.IVA_DEBITO)!.tipo).toBe('PASIVO');
  });

  it('todos los `usos` declarados pertenecen al conjunto conocido', () => {
    for (const cuenta of cuentas) {
      for (const uso of cuenta.usos) {
        expect(USOS, `${cuenta.codigo}: uso ${uso}`).toContain(uso);
      }
      // Una agrupadora no recibe imputaciones: no puede tener uso.
      if (!cuenta.imputable) expect(cuenta.usos.length, cuenta.codigo).toBe(0);
    }
  });
});

describe('Plan de cuentas NEXO PYME Argentina — bajas y ausencias', () => {
  it('no existen las tres cuentas dadas de baja', () => {
    for (const codigo of ['1.2.07', '4.8', '6.8']) {
      expect(porCodigo.has(codigo), `${codigo} volvió al catálogo`).toBe(false);
    }
  });

  it('ninguna cuenta cuelga de las ramas dadas de baja', () => {
    for (const prefijo of ['1.2.07', '4.8', '6.8']) {
      const hijas = cuentas.filter((cuenta) => cuenta.codigo.startsWith(`${prefijo}.`));
      expect(hijas.map((c) => c.codigo)).toEqual([]);
    }
  });

  it('no existe ninguna cuenta de resultados extraordinarios', () => {
    // RT 54 (T.O. RT 59) ¶630: «Una entidad no presentará partida alguna como
    // resultado extraordinario».
    for (const cuenta of cuentas) {
      expect(cuenta.codigo.startsWith('4.9'), cuenta.codigo).toBe(false);
      expect(cuenta.codigo.startsWith('6.9'), cuenta.codigo).toBe(false);
      expect(cuenta.nombre.toLowerCase()).not.toContain('extraordinari');
    }
  });
});

describe('Plan de cuentas NEXO PYME Argentina — espejo con el estado de resultados', () => {
  const esDeResultado = (cuenta: Cuenta) => ['4', '5', '6'].includes(cuenta.codigo[0]!);
  const capturan = (codigo: string) =>
    (PREFIJOS_DE_RESULTADO as string[]).filter(
      (prefijo) => codigo === prefijo || codigo.startsWith(`${prefijo}.`),
    );

  it('cada cuenta de resultado cae en exactamente un prefijo del espejo', () => {
    // Cero prefijos: quedaría sin renglón en el ESP y en el ER a la vez, y
    // `CUENTA_SIN_RUBRO` bloquearía la emisión. Dos: sumaría dos veces.
    for (const cuenta of imputables.filter(esDeResultado)) {
      expect(capturan(cuenta.codigo).length, `${cuenta.codigo}`).toBe(1);
    }
  });

  it('ningún prefijo del espejo queda sin cuentas', () => {
    // Un prefijo que no captura nada es un renglón que el ER va a mostrar
    // siempre en cero: o falta la cuenta, o sobra el prefijo.
    for (const prefijo of PREFIJOS_DE_RESULTADO as string[]) {
      const capturadas = imputables.filter(
        (cuenta) => cuenta.codigo === prefijo || cuenta.codigo.startsWith(`${prefijo}.`),
      );
      expect(capturadas.length, `el prefijo ${prefijo} no captura ninguna cuenta`).toBeGreaterThan(
        0,
      );
    }
  });

  it('el espejo no captura ninguna cuenta patrimonial ni de orden', () => {
    for (const cuenta of imputables.filter((x) => !esDeResultado(x))) {
      expect(capturan(cuenta.codigo).length, cuenta.codigo).toBe(0);
    }
  });

  it('las cuentas de orden quedan fuera del ESP, del ER y del resultado', () => {
    const orden = cuentas.filter((cuenta) => cuenta.codigo[0] === '7');
    expect(orden.length).toBe(7);
    for (const cuenta of orden) {
      expect(cuenta.tipo, cuenta.codigo).toBe('ORDEN');
      expect(capturan(cuenta.codigo).length, cuenta.codigo).toBe(0);
    }
    // Y su par: tantas deudoras como acreedoras, porque van juntas en el asiento
    // y el candado `Debe = Haber` las alcanza igual que a cualquier otra.
    const deudoras = orden.filter((c) => c.codigo.startsWith('7.1') && c.imputable);
    const acreedoras = orden.filter((c) => c.codigo.startsWith('7.2') && c.imputable);
    expect(deudoras.length).toBe(acreedoras.length);
  });
});

describe('Plan de cuentas NEXO PYME Argentina — identidad de la plantilla', () => {
  it('la plantilla se identifica y dice de dónde sale', () => {
    expect(PLANTILLA.templateId).toBe('NEXO_PYME_AR');
    expect(PLANTILLA.version).toBe(1);
    expect(PLANTILLA.origen).toContain('RT 54');
  });

  it('el origen no dice que sea un plan oficial u obligatorio', () => {
    // La RT 54 no contiene un plan de cuentas. Decir lo contrario en el texto
    // que acompaña al modelo sería la clase de afirmación que este repositorio
    // corrigió en la página de precios: una frase escrita a mano que no se
    // corresponde con lo que el sistema puede sostener.
    const texto = `${PLANTILLA.nombre} ${PLANTILLA.descripcion} ${PLANTILLA.origen}`.toLowerCase();
    expect(texto).not.toContain('oficial');
    expect(texto).not.toContain('obligatorio');
  });

  it('ninguna cuenta especializada está en el núcleo', () => {
    // El núcleo es lo que una PYME usa en su primer mes sin preguntarle nada a
    // nadie. Una cuenta que requiere criterio profesional —VPP, impuesto
    // diferido, RECPAM, VNR— no puede estar ahí: ofrecerla de entrada invita a
    // imputar contra ella sin el tratamiento que necesita.
    for (const cuenta of cuentas.filter((x) => x.especializada === true)) {
      expect(cuenta.nucleo, `${cuenta.codigo} es especializada y está en el núcleo`).toBe(false);
    }
  });

  it('la cuenta de compras advierte sobre el inventario permanente', () => {
    // Es la cuenta que existe por un contrato técnico —el rol COMPRAS exige una
    // cuenta de tipo COSTO o GASTO— y cuyo saldo correcto, con inventario
    // permanente, es cero. Si la advertencia se pierde, alguien duplica el costo.
    const compras = porCodigo.get(ROLES.COMPRAS)!;
    expect(compras.nota).toBeDefined();
    expect(compras.nota!.toUpperCase()).toContain('INVENTARIO PERMANENTE');
  });
});
