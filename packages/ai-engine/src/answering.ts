/**
 * El respondedor: `Contador IA` sobre datos reales.
 *
 * Es la pieza más peligrosa del producto, y la razón es específica. Un
 * clasificador que se equivoca produce una propuesta que un humano revisa contra
 * un comprobante. Un respondedor que se equivoca produce **una frase con un
 * número adentro**, y esa frase se lee, se copia a un mail y se manda al cliente.
 * Nadie la revisa contra nada, porque no se ve como una propuesta: se ve como una
 * respuesta.
 *
 * ## El control central: todo número de la respuesta tiene que estar en el contexto
 *
 * No es una instrucción del prompt —"no inventes cifras" no es un control— sino
 * una verificación mecánica sobre la salida:
 *
 *     1. Se extraen todos los numerales de la respuesta.
 *     2. Se comparan contra los que se le pasaron al modelo.
 *     3. Cualquiera que no esté es una alucinación y la respuesta se rechaza.
 *
 * Rechaza entera, no tacha el número. Una respuesta con un agujero donde estaba
 * la cifra sigue teniendo la frase que la rodeaba, y esa frase afirmaba algo.
 *
 * ## Lo que el respondedor no hace
 *
 * No calcula. Si la pregunta es "cuánto vendí en marzo", el número lo trae el
 * motor contable y el modelo lo redacta. La aritmética que hace un modelo de
 * lenguaje no es auditable y no hace falta: el sistema ya sabe sumar.
 *
 * No escribe. No hay ninguna función acá que devuelva algo que un repositorio
 * pueda persistir en la contabilidad. Es ADR-001, y el lint de arquitectura lo
 * verifica en el grafo de dependencias.
 */


/**
 * Un dato que el sistema le pasa al modelo para que lo use.
 *
 * `valor` es **texto**, ya formateado por quien sabe formatear. Pasarlo como
 * número obligaría al modelo a convertirlo, y ahí es donde un saldo de
 * 1.234.567,89 vuelve como 1.234.568.
 */
export interface DatoDelContexto {
  readonly etiqueta: string;
  readonly valor: string;
  /** De dónde salió: renglón del balance, cuenta, período. Se cita en la respuesta. */
  readonly origen: string;
}

export interface ContextoDeRespuesta {
  readonly companyId: string;
  readonly pregunta: string;
  readonly datos: readonly DatoDelContexto[];
  /** Normas citables. Mismo criterio que la clasificación: solo lo archivado. */
  readonly normas: readonly { readonly id: string; readonly etiqueta: string }[];
  /** Período al que se refiere la consulta, si lo hay. */
  readonly periodo: string | null;
}

export interface RespuestaPropuesta {
  readonly texto: string;
  /** Etiquetas de los datos que el modelo dice haber usado. */
  readonly datosUsados: readonly string[];
  readonly normasCitadas: readonly string[];
  readonly abstencion: boolean;
}

export type CodigoRechazoRespuesta =
  | 'CIFRA_INVENTADA'
  | 'NORMA_NO_CITABLE'
  | 'DATO_INEXISTENTE'
  | 'SIN_DATOS_Y_SIN_ABSTENERSE'
  | 'RESPUESTA_VACIA';

export interface RechazoRespuesta {
  readonly codigo: CodigoRechazoRespuesta;
  readonly detalle: string;
  /**
   * `true` cuando el modelo afirmó algo que no estaba en el contexto.
   *
   * Se distingue de un error de forma por la misma razón que en la clasificación:
   * inventar y equivocarse no se corrigen igual, y mezclarlos en una sola métrica
   * hace invisible al primero.
   */
  readonly esAlucinacion: boolean;
}

/**
 * Extrae los numerales de un texto.
 *
 * Reconoce las formas en que un número aparece en una respuesta en castellano:
 * `1.234.567,89`, `1234567.89`, `1.234`, `45`, `21%`. Se normaliza cada uno a
 * sus dígitos para poder compararlo con el contexto sin depender del formato.
 *
 * Se ignoran los números pegados a letras (`RG 5616`, `art. 63`) **no**: esos
 * también se verifican. Un modelo que cita el "art. 47" de una norma que tiene 12
 * artículos está inventando igual que si inventara un saldo.
 */
export function numeralesDe(texto: string): string[] {
  const encontrados = texto.match(/\d[\d.,]*/gu) ?? [];
  return encontrados.map(normalizarNumeral).filter((numeral) => numeral !== '');
}

/**
 * Normaliza un numeral a sus dígitos significativos.
 *
 * `1.234.567,89`, `1234567,89` y `1234567.89` dan todos `123456789`. Es
 * deliberadamente laxo en el formato y estricto en los dígitos: el objetivo no es
 * validar la puntuación sino detectar una cifra que no está en ningún lado.
 *
 * Los ceros a la izquierda se descartan para que `007` y `7` no se vean distintos.
 */
export function normalizarNumeral(bruto: string): string {
  const digitos = bruto.replace(/\D/gu, '').replace(/^0+/u, '');
  return digitos;
}

/**
 * El control. Cada numeral de la respuesta tiene que aparecer en el contexto.
 *
 * Los números de una a dos cifras se admiten sin estar en el contexto: son
 * ordinales, cantidades de ítems y años abreviados que aparecen naturalmente en
 * una redacción ("las tres cuentas", "el 30 de junio"). Exigirlos haría que el
 * control rechace respuestas correctas, y un control que rechaza lo correcto se
 * apaga en una semana.
 *
 * De tres dígitos para arriba —donde viven los importes, los números de norma y
 * los artículos— no hay excepción.
 */
export const DIGITOS_MINIMOS_VERIFICADOS = 3;

export function verificarCifras(
  respuesta: RespuestaPropuesta,
  contexto: ContextoDeRespuesta,
): RechazoRespuesta[] {
  const permitidos = new Set<string>();
  for (const dato of contexto.datos) {
    for (const numeral of numeralesDe(dato.valor)) permitidos.add(numeral);
    for (const numeral of numeralesDe(dato.etiqueta)) permitidos.add(numeral);
    for (const numeral of numeralesDe(dato.origen)) permitidos.add(numeral);
  }
  for (const norma of contexto.normas) {
    for (const numeral of numeralesDe(norma.etiqueta)) permitidos.add(numeral);
  }
  if (contexto.periodo !== null) {
    for (const numeral of numeralesDe(contexto.periodo)) permitidos.add(numeral);
  }

  const inventados = numeralesDe(respuesta.texto).filter(
    (numeral) => numeral.length >= DIGITOS_MINIMOS_VERIFICADOS && !permitidos.has(numeral),
  );

  if (inventados.length === 0) return [];

  return [
    {
      codigo: 'CIFRA_INVENTADA',
      detalle: `La respuesta contiene ${inventados.length} cifra(s) que no están en el contexto: ${[...new Set(inventados)].join(', ')}. La respuesta se rechaza entera: tachar el número dejaría la frase que lo rodeaba, y esa frase afirmaba algo.`,
      esAlucinacion: true,
    },
  ];
}

/**
 * Lo que sale de la validación.
 *
 * `RespuestaPropuesta` en el nombre y en el tipo: lo que este módulo produce es
 * algo que el sistema **propone decir**, y la UI tiene que mostrarlo como tal
 * (§42). No se reutiliza `Proposal<T>` —el envoltorio de las propuestas de
 * clasificación— porque tiene campos que acá no aplican (`confidence`,
 * `normativeSources`) y forzar el tipo obligaría a inventarlos.
 */
export type ResultadoDeRespuesta =
  | { readonly ok: true; readonly respuesta: RespuestaPropuesta; readonly advertencia: string }
  | { readonly ok: false; readonly rechazos: readonly RechazoRespuesta[] };

/**
 * La puerta única. Ninguna respuesta llega al usuario sin pasar por acá.
 */
export function validarRespuesta(
  respuesta: RespuestaPropuesta,
  contexto: ContextoDeRespuesta,
): ResultadoDeRespuesta {
  const rechazos: RechazoRespuesta[] = [];

  if (respuesta.abstencion) {
    // Abstenerse es una salida prevista, no un error. Se acepta sin más control:
    // no hay nada que verificar en un "no tengo con qué responder eso".
    return { ok: true, respuesta, advertencia: ADVERTENCIA_OBLIGATORIA };
  }

  if (respuesta.texto.trim() === '') {
    rechazos.push({
      codigo: 'RESPUESTA_VACIA',
      detalle: 'La respuesta está vacía y no está marcada como abstención.',
      esAlucinacion: false,
    });
  }

  if (contexto.datos.length === 0) {
    rechazos.push({
      codigo: 'SIN_DATOS_Y_SIN_ABSTENERSE',
      detalle:
        'No se le pasó ningún dato y aun así respondió. Sin contexto la única respuesta correcta es abstenerse: lo que haya dicho sale de su memoria, no de la contabilidad de esta empresa.',
      esAlucinacion: true,
    });
  }

  rechazos.push(...verificarCifras(respuesta, contexto));

  const etiquetas = new Set(contexto.datos.map((dato) => dato.etiqueta));
  for (const usado of respuesta.datosUsados) {
    if (!etiquetas.has(usado)) {
      rechazos.push({
        codigo: 'DATO_INEXISTENTE',
        detalle: `Dice haber usado "${usado}", que no está en el contexto.`,
        esAlucinacion: true,
      });
    }
  }

  const normasValidas = new Set(contexto.normas.map((norma) => norma.id));
  for (const citada of respuesta.normasCitadas) {
    if (!normasValidas.has(citada)) {
      rechazos.push({
        codigo: 'NORMA_NO_CITABLE',
        detalle: `Cita ${citada}, que no está entre las normas archivadas que se le pasaron. Una norma "de memoria" no se puede abrir ni verificar.`,
        esAlucinacion: true,
      });
    }
  }

  if (rechazos.length > 0) return { ok: false, rechazos };

  return { ok: true, respuesta, advertencia: ADVERTENCIA_OBLIGATORIA };
}

/**
 * El texto que acompaña a toda respuesta aceptada.
 *
 * No es un descargo legal decorativo: es el §42. Una respuesta sobre la
 * contabilidad de una empresa, redactada por un modelo, no es asesoramiento
 * profesional — y quien la lee tiene que saberlo sin tener que deducirlo del tono.
 */
export const ADVERTENCIA_OBLIGATORIA =
  'Esta respuesta la redactó un asistente con los datos del sistema. Las cifras salen de la ' +
  'contabilidad registrada y se pueden abrir hasta el comprobante. La interpretación profesional ' +
  'de lo que significan es del contador.';

/**
 * Qué preguntas el respondedor no contesta, y por qué.
 *
 * Está en código y no en el prompt porque un prompt es una sugerencia. Estas se
 * verifican antes de armar el contexto: si la pregunta cae en una de estas
 * categorías, no se llama al modelo.
 */
export const PREGUNTAS_QUE_NO_SE_CONTESTAN = [
  {
    categoria: 'PROYECCION',
    ejemplo: '¿Cuánto voy a pagar de ganancias el año que viene?',
    motivo:
      'Exige aplicar normativa a hechos futuros. El sistema no tiene ni los hechos ni —en la mayoría de los casos— la norma archivada.',
  },
  {
    categoria: 'CONSEJO_FISCAL',
    ejemplo: '¿Me conviene ser monotributista o responsable inscripto?',
    motivo:
      'Es asesoramiento profesional. El §42 lo prohíbe explícitamente, y no es una limitación técnica que se pueda levantar con más contexto.',
  },
  {
    categoria: 'NORMATIVA_NO_ARCHIVADA',
    ejemplo: '¿Qué dice la Ley 23.349 sobre el crédito fiscal?',
    motivo:
      'La norma no está archivada. La respuesta correcta es FUENTE NO ENCONTRADA, no lo que el modelo recuerde de ella.',
  },
  {
    categoria: 'CALCULO_NUEVO',
    ejemplo: '¿Cuánto sería el IVA si vendiera 3 millones más?',
    motivo:
      'Pide una cifra que el sistema no calculó. Un número que el modelo produce no pasa el control de cifras — y está bien que no pase.',
  },
] as const;
