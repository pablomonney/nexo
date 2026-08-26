/**
 * Las plantillas del ESP y del ER, transcriptas de la Ley 19.550 (T.O. 1984).
 *
 * Fuente: `INFOLEG_LGS_19550_texto_actualizado.htm`, archivada con sha256.
 * Art. 63 (balance general) y art. 64 (estado de resultados). Cada RUBRO cita su
 * inciso — el validador lo exige, y con razón: un rubro sin cita es una
 * agrupación que alguien decidió.
 *
 * ## Lo que estas plantillas asumen, y hay que saberlo antes de usarlas
 *
 * El art. 63 pide separar créditos de bienes de cambio, y bienes de uso de
 * inmateriales. Ninguna de esas distinciones se puede deducir de
 * `accounts.type`, que solo dice ACTIVO / PASIVO / PN / INGRESO / COSTO / GASTO
 * / ORDEN. Tampoco la de corriente y no corriente que exige el inciso 4) a).
 *
 * Así que los selectores usan **prefijos de código**, y eso ata la plantilla a
 * una convención de plan de cuentas. La convención está declarada abajo, y es la
 * de uso más difundido en Argentina. Pero cada empresa arma su plan: el esquema
 * lo dice desde la 0003 —*"el plan del §8 es una PLANTILLA de arranque, no una
 * imposición"*— y una empresa con otra codificación **no puede usar estas
 * plantillas**.
 *
 * Lo importante es cómo falla ese caso: no en silencio. El control
 * `CUENTA_SIN_RUBRO` de `construirEstado` marca cada cuenta que ningún renglón
 * capturó, así que un plan que no sigue la convención produce un estado con
 * decenas de cuentas señaladas — imposible de confundir con un balance correcto.
 * Esa empresa carga su propia plantilla: `statement_templates.company_id` existe
 * exactamente para eso.
 *
 * ## Los signos: todo el ER va INVERTIDO
 *
 * En el Mayor un saldo acreedor es negativo. En un estado contable el pasivo se
 * expone positivo y el costo se resta. Poner `INVERTIDO` en los ingresos y
 * también en los costos y gastos hace que **cada TOTAL sea una suma llana**:
 * ventas positivas, costos negativos, y el resultado sale solo.
 *
 * La alternativa era que los totales supieran restar según el nodo, y eso es
 * volver a poner contabilidad en el código — que es justo lo que la plantilla
 * declarativa existe para evitar.
 */

/**
 * La convención de codificación que estas plantillas dan por supuesta.
 *
 * Se imprime al sembrar. Un supuesto que no se enuncia se descubre cuando el
 * balance de alguien sale con cuarenta cuentas sin rubro.
 */
export const CONVENCION_DE_CODIGOS = [
  '1.1.*  Activo corriente          1.2.*  Activo no corriente',
  '2.1.*  Pasivo corriente          2.2.*  Pasivo no corriente',
  '3.*    Patrimonio neto',
  '4.1-4.7  Ingresos ordinarios   4.8  Ganancias de ejercicios anteriores   4.9  Ganancias extraordinarias',
  '5.*    Costo de ventas y de servicios prestados',
  '6.1 Administración · 6.2 Comercialización · 6.3 Financiación · 6.4 Otros gastos ordinarios',
  '6.8 Pérdidas de ejercicios anteriores · 6.9 Pérdidas extraordinarias',
  '7.*    Cuentas de orden',
];

const ART63 = 'Ley 19.550 (T.O. 1984), art. 63';
const ART64 = 'Ley 19.550 (T.O. 1984), art. 64';

function renglon(codigo, etiqueta, fundamento, selector, presentacion = 'NATURAL') {
  return { codigo, etiqueta, tipo: 'RENGLON', fundamento, presentacion, selector };
}

function rubro(codigo, etiqueta, fundamento, hijos) {
  return { codigo, etiqueta, tipo: 'RUBRO', fundamento, hijos };
}

function total(codigo, etiqueta, suma) {
  return { codigo, etiqueta, tipo: 'TOTAL', suma };
}

// ---------------------------------------------------------------------------
// Estado de Situación Patrimonial — art. 63
// ---------------------------------------------------------------------------
//
// El orden de los renglones sigue el del inciso 1), que enumera de a) a h). No es
// alfabético ni por importe: es el del artículo.
const ESP = [
  rubro('ACTIVO', 'ACTIVO', `${ART63} inc. 1)`, [
    // Inc. 4) a): "la información deberá agruparse de modo que sea posible
    // distinguir y totalizar el activo corriente del activo no corriente".
    rubro('AC', 'Activo corriente', `${ART63} inc. 4) a)`, [
      renglon('AC_CAJA', 'Caja y bancos', `${ART63} inc. 1) a)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.1.01'],
      }),
      renglon('AC_INV', 'Inversiones', `${ART63} inc. 1) d)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.1.02'],
      }),
      renglon('AC_CRED', 'Créditos por ventas', `${ART63} inc. 1) b)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.1.03'],
      }),
      renglon('AC_OTROS_CRED', 'Otros créditos', `${ART63} inc. 1) b)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.1.04'],
      }),
      renglon('AC_CAMBIO', 'Bienes de cambio', `${ART63} inc. 1) c)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.1.05'],
      }),
      // Inc. 1) h): "todo otro rubro que por su naturaleza corresponda ser
      // incluido como activo". El artículo prevé el cajón; la plantilla también.
      renglon('AC_OTROS', 'Otros activos corrientes', `${ART63} inc. 1) h)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.1.09'],
      }),
    ]),
    rubro('ANC', 'Activo no corriente', `${ART63} inc. 4) a)`, [
      renglon('ANC_INV', 'Inversiones', `${ART63} inc. 1) d)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.2.02'],
      }),
      renglon('ANC_CRED', 'Créditos', `${ART63} inc. 1) b)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.2.03', '1.2.04'],
      }),
      renglon('ANC_USO', 'Bienes de uso', `${ART63} inc. 1) e)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.2.05'],
      }),
      renglon('ANC_INMAT', 'Bienes inmateriales', `${ART63} inc. 1) f)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.2.06'],
      }),
      renglon('ANC_DIF', 'Cargas diferidas', `${ART63} inc. 1) g)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.2.07'],
      }),
      renglon('ANC_OTROS', 'Otros activos no corrientes', `${ART63} inc. 1) h)`, {
        tipos: ['ACTIVO'],
        prefijos: ['1.2.09'],
      }),
    ]),
  ]),
  total('TOTAL_ACTIVO', 'Total del activo', ['ACTIVO']),

  rubro('PASIVO', 'PASIVO', `${ART63} inc. 2) I.`, [
    rubro('PC', 'Pasivo corriente', `${ART63} inc. 4) a)`, [
      // El inciso 2) I. a) enumera qué deudas van separadas: comerciales,
      // bancarias, financieras, con sociedades vinculadas, con organismos de
      // previsión social y de recaudación fiscal.
      renglon('PC_COM', 'Deudas comerciales', `${ART63} inc. 2) I. a)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.01'],
      }, 'INVERTIDO'),
      renglon('PC_FIN', 'Deudas bancarias y financieras', `${ART63} inc. 2) I. a)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.02'],
      }, 'INVERTIDO'),
      renglon('PC_SOC', 'Deudas con organismos de previsión social', `${ART63} inc. 2) I. a)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.03'],
      }, 'INVERTIDO'),
      renglon('PC_FIS', 'Deudas fiscales', `${ART63} inc. 2) I. a)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.04'],
      }, 'INVERTIDO'),
      renglon('PC_OTRAS', 'Otras deudas', `${ART63} inc. 2) I. c)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.05'],
      }, 'INVERTIDO'),
      renglon('PC_PREV', 'Previsiones', `${ART63} inc. 2) I. b)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.08'],
      }, 'INVERTIDO'),
      // Inc. 2) I. d): "las rentas percibidas por adelantado y los ingresos cuya
      // realización corresponda a futuros ejercicios".
      renglon('PC_DIF', 'Ingresos diferidos', `${ART63} inc. 2) I. d)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.1.09'],
      }, 'INVERTIDO'),
    ]),
    rubro('PNC', 'Pasivo no corriente', `${ART63} inc. 4) a)`, [
      renglon('PNC_COM', 'Deudas comerciales', `${ART63} inc. 2) I. a)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.2.01'],
      }, 'INVERTIDO'),
      renglon('PNC_FIN', 'Deudas bancarias y financieras', `${ART63} inc. 2) I. a)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.2.02'],
      }, 'INVERTIDO'),
      renglon('PNC_OTRAS', 'Otras deudas', `${ART63} inc. 2) I. c)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.2.03', '2.2.04', '2.2.05'],
      }, 'INVERTIDO'),
      renglon('PNC_PREV', 'Previsiones', `${ART63} inc. 2) I. b)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.2.08'],
      }, 'INVERTIDO'),
      renglon('PNC_DIF', 'Ingresos diferidos', `${ART63} inc. 2) I. d)`, {
        tipos: ['PASIVO'],
        prefijos: ['2.2.09'],
      }, 'INVERTIDO'),
    ]),
  ]),
  total('TOTAL_PASIVO', 'Total del pasivo', ['PASIVO']),

  rubro('PN', 'PATRIMONIO NETO', `${ART63} inc. 2) II.`, [
    renglon('PN_CAPITAL', 'Capital social', `${ART63} inc. 2) II. a)`, {
      tipos: ['PN'],
      prefijos: ['3.1'],
    }, 'INVERTIDO'),
    // El inciso II. b) nombra las primas de emisión y las provenientes de
    // revaluaciones en la misma frase que las reservas; van separadas igual,
    // porque el artículo las enumera como conceptos distintos.
    renglon('PN_PRIMAS', 'Primas de emisión y ajustes al capital', `${ART63} inc. 2) II. b)`, {
      tipos: ['PN'],
      prefijos: ['3.2'],
    }, 'INVERTIDO'),
    renglon('PN_RESERVAS', 'Reservas', `${ART63} inc. 2) II. b)`, {
      tipos: ['PN'],
      prefijos: ['3.3'],
    }, 'INVERTIDO'),
    renglon('PN_RESULTADOS', 'Resultados acumulados', `${ART63} inc. 2) II. c)`, {
      tipos: ['PN'],
      prefijos: ['3.4'],
    }, 'INVERTIDO'),
    renglon('PN_OTROS', 'Otros rubros del patrimonio neto', `${ART63} inc. 2) II. d)`, {
      tipos: ['PN'],
      prefijos: ['3.9'],
    }, 'INVERTIDO'),
  ]),
  total('TOTAL_PN', 'Total del patrimonio neto', ['PN']),

  // La línea de control del inciso 4): activo = pasivo + PN. El motor la verifica
  // aparte, con los códigos que se le declaran; este total la deja a la vista.
  total('TOTAL_PASIVO_Y_PN', 'Total del pasivo y del patrimonio neto', ['PASIVO', 'PN']),

  // Inc. 3): "los bienes en depósito, los avales y garantías, documentos
  // descontados y toda otra cuenta de orden". Van fuera de la ecuación.
  rubro('ORDEN', 'Cuentas de orden', `${ART63} inc. 3)`, [
    renglon('ORDEN_TODAS', 'Cuentas de orden', `${ART63} inc. 3)`, {
      tipos: ['ORDEN'],
      prefijos: ['7.'],
    }),
  ]),
];

// ---------------------------------------------------------------------------
// Estado de Resultados — art. 64
// ---------------------------------------------------------------------------
//
// El art. 64 exige que el estado "muestre por separado la ganancia o pérdida
// proveniente de las operaciones ordinarias y extraordinarias", y que al
// resultado neto se le adicionen o deduzcan las derivadas de ejercicios
// anteriores. Los tres totales de abajo son esa frase.
const ER = [
  // Se enumeran los siete prefijos ordinarios en vez de tomar "4." entero y
  // excluir 4.8 y 4.9. La primera versión hacía eso y estaba mal: `excluir`
  // compara **códigos exactos**, no prefijos, así que "4.9" no excluía a
  // "4.9.01" y la ganancia extraordinaria sumaba en dos renglones.
  //
  // Lo encontró `CUENTA_EN_DOS_RUBROS`, no una lectura del código — que es para
  // lo que ese control existe.
  renglon('VENTAS', 'Ventas y servicios', `${ART64} inc. I. a)`, {
    tipos: ['INGRESO'],
    prefijos: ['4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7'],
  }, 'INVERTIDO'),
  renglon('COSTO', 'Costo de las mercaderías vendidas y servicios prestados', `${ART64} inc. I. a)`, {
    tipos: ['COSTO'],
    prefijos: ['5.'],
  }, 'INVERTIDO'),
  total('RESULTADO_BRUTO', 'Resultado bruto', ['VENTAS', 'COSTO']),

  rubro('GASTOS', 'Gastos ordinarios', `${ART64} inc. I. b)`, [
    renglon('G_ADM', 'Gastos de administración', `${ART64} inc. I. b)`, {
      tipos: ['GASTO'],
      prefijos: ['6.1'],
    }, 'INVERTIDO'),
    renglon('G_COM', 'Gastos de comercialización', `${ART64} inc. I. b)`, {
      tipos: ['GASTO'],
      prefijos: ['6.2'],
    }, 'INVERTIDO'),
    renglon('G_FIN', 'Gastos de financiación', `${ART64} inc. I. b)`, {
      tipos: ['GASTO'],
      prefijos: ['6.3'],
    }, 'INVERTIDO'),
    renglon('G_OTROS', 'Otros gastos ordinarios', `${ART64} inc. I. b)`, {
      tipos: ['GASTO'],
      prefijos: ['6.4'],
    }, 'INVERTIDO'),
  ]),
  total('RESULTADO_ORDINARIO', 'Resultado de las operaciones ordinarias', [
    'RESULTADO_BRUTO',
    'GASTOS',
  ]),

  rubro('EXTRA', 'Resultados extraordinarios', `${ART64} inc. I. c)`, [
    renglon('EXTRA_GAN', 'Ganancias extraordinarias', `${ART64} inc. I. c)`, {
      tipos: ['INGRESO'],
      prefijos: ['4.9'],
    }, 'INVERTIDO'),
    renglon('EXTRA_PER', 'Gastos extraordinarios', `${ART64} inc. I. c)`, {
      tipos: ['GASTO'],
      prefijos: ['6.9'],
    }, 'INVERTIDO'),
  ]),
  total('RESULTADO_EJERCICIO', 'Resultado neto del ejercicio', [
    'RESULTADO_ORDINARIO',
    'EXTRA',
  ]),

  rubro('AEA', 'Ajustes de resultados de ejercicios anteriores', `${ART64} inc. I. d)`, [
    renglon('AEA_GAN', 'Ganancias de ejercicios anteriores', `${ART64} inc. I. d)`, {
      tipos: ['INGRESO'],
      prefijos: ['4.8'],
    }, 'INVERTIDO'),
    renglon('AEA_PER', 'Gastos de ejercicios anteriores', `${ART64} inc. I. d)`, {
      tipos: ['GASTO'],
      prefijos: ['6.8'],
    }, 'INVERTIDO'),
  ]),
  total('RESULTADO_FINAL', 'Resultado del ejercicio y de ejercicios anteriores', [
    'RESULTADO_EJERCICIO',
    'AEA',
  ]),
];

/**
 * Qué exige el art. 64 y estas plantillas NO producen.
 *
 * El inciso I. b) obliga a hacer constar los montos de nueve conceptos —
 * retribuciones de administradores, honorarios por servicios, sueldos y
 * contribuciones, gastos de estudios e investigaciones, regalías, publicidad,
 * impuestos y tasas con sus intereses y multas separados, intereses por deuda
 * discriminados por acreedor, amortizaciones y previsiones—.
 *
 * No están como renglones porque exigirían una convención de codificación de
 * tercer y cuarto nivel que casi ningún plan sigue igual, y un renglón vacío
 * porque el prefijo no existe en el plan de la empresa es peor que la ausencia:
 * afirma que el concepto es cero.
 *
 * El propio artículo prevé la salida cuando estos montos no se exponen en el
 * cuerpo: van en la memoria o, en la práctica actual, en nota. Se declara acá
 * para que sea una omisión conocida y no una que alguien descubra en una
 * auditoría.
 */
export const LO_QUE_ESTAS_PLANTILLAS_NO_EXPONEN = [
  'Art. 64 inc. I. b) puntos 1 a 9: los nueve montos que deben hacerse constar (retribuciones de administradores, honorarios, sueldos y contribuciones, gastos de estudios, regalías, publicidad, impuestos con intereses y multas separados, intereses por acreedor, amortizaciones y previsiones). Van en nota o memoria.',
  'Art. 63 inc. 1) b), d): la apertura de créditos e inversiones con sociedades controlantes, controladas o vinculadas, y los litigiosos. Exige un dato de la contraparte que el plan de cuentas no lleva.',
  'Art. 63 inc. 4) b), c): si los derechos y obligaciones están documentados o con garantía real, y la exposición separada de los saldos en moneda extranjera.',
  'Art. 64 inc. II: el estado de evolución del patrimonio neto. Está fuera del MVP y declarado como tal.',
];

/** Las dos plantillas, listas para validar e insertar. */
export const PLANTILLAS = [
  {
    tipo: 'ESP',
    articulo: 'Ley 19.550 (T.O. 1984), art. 63 — contenido del balance general',
    raiz: ESP,
  },
  {
    tipo: 'ER',
    articulo: 'Ley 19.550 (T.O. 1984), art. 64 — contenido del estado de resultados',
    raiz: ER,
  },
];

/**
 * Para qué combinación se siembran.
 *
 * SA con fiscalización de la IGJ y marco RT FACPCE es el caso más común y el
 * único que estas plantillas cubren. No se replican para los otros once tipos de
 * ente: una cooperativa expone su patrimonio de otra manera (RT 62, capítulo 12)
 * y copiar la plantilla de una SA cambiándole la etiqueta sería afirmar que son
 * iguales.
 */
export const ALCANCE = {
  marco: 'RT_FACPCE',
  tipoEnte: 'SA',
  regulador: 'IGJ',
  // La vigencia del T.O. 1984. No se pone la fecha de hoy: la estructura del art.
  // 63 rige desde entonces, y un estado de 2019 se arma con esta misma plantilla.
  vigenteDesde: '1984-03-30',
};
