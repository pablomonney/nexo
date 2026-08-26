/**
 * Vigilancia normativa: detectar que **apareció algo**, no qué dice.
 *
 * Esta es la parte del sistema donde la tentación es más grande y el daño más
 * silencioso. Un servicio que monitorea el Boletín Oficial y datos.gob.ar puede,
 * con muy poco código de más, empezar a cargar normas solo. Y funcionaría: el
 * 95% de las veces el texto que baja es el texto correcto.
 *
 * El 5% restante son títulos truncados, PDF escaneados, anexos que se publican
 * aparte, resoluciones que se rectifican al día siguiente. Y una norma mal
 * cargada no se ve mal: se ve como una norma. El sistema la cita, el contador la
 * lee citada, y la cadena de trazabilidad —que existe justamente para que eso no
 * pase— la avala.
 *
 * Por eso este archivo produce **candidatos**, nunca normas.
 *
 *     CANDIDATO ──(un humano archiva el documento y verifica)──► NORMA
 *
 * Un candidato no tiene `norm_version_id`, no se puede citar, no entra al motor
 * de resolución y no aparece en ningún contexto de IA. Lo único que hace es
 * decir: *apareció la RG 5912/2026, no la tenemos, andá a verla*.
 *
 * ## Por qué el Boletín Oficial se trata como un aviso y no como una fuente
 *
 * Es el riesgo R-22, relevado en FASE 1: el BO no es una fuente de texto
 * automatizable. Su edición web cambia de estructura, publica anexos como
 * imágenes y no ofrece un identificador estable por norma. Se puede detectar de
 * forma razonablemente confiable **que un número nuevo apareció**; sacar de ahí
 * el articulado es adivinar con buena presentación.
 *
 * La consecuencia práctica: el vigilante abre una tarea, no carga un texto.
 */

import type { CalendarDate } from '@aai/shared';

export type FuenteDeVigilancia = 'CKAN_DATOS_GOB_AR' | 'BOLETIN_OFICIAL' | 'SITIO_ORGANISMO';

/**
 * Un ítem tal como lo devuelve la fuente. Texto crudo, sin interpretar.
 *
 * No hay un campo `articulado` ni `texto`: si lo hubiera, alguien lo llenaría.
 */
export interface ItemDeVigilancia {
  readonly fuente: FuenteDeVigilancia;
  /** Identificador que da la fuente. Puede no ser estable — por eso no es la clave. */
  readonly idExterno: string;
  readonly titulo: string;
  readonly url: string;
  readonly publicadoEl: CalendarDate | null;
  /** Lo que la fuente dijo, sin normalizar. Se guarda para poder auditar la lectura. */
  readonly crudo: string;
}

export type EstadoCandidato =
  /** Detectado, nadie lo miró todavía. */
  | 'NUEVO'
  /** Ya está archivado y sembrado: no hay nada que hacer. */
  | 'YA_ARCHIVADO'
  /** Alguien lo miró y decidió que no aplica al producto. */
  | 'DESCARTADO'
  /** No se pudo identificar de qué norma habla. */
  | 'NO_IDENTIFICABLE';

/**
 * Identificación de una norma a partir del título.
 *
 * Deliberadamente **conservadora**: reconoce las formas que los organismos usan
 * de manera consistente y devuelve `null` para todo lo demás. Un identificador
 * equivocado es peor que ninguno — manda a alguien a buscar la norma que no es, o
 * hace creer que ya está archivada cuando no.
 */
export interface NormaIdentificada {
  readonly organismo: string;
  readonly tipo: string;
  readonly numero: string;
  readonly anio: number;
}

export interface Candidato {
  readonly item: ItemDeVigilancia;
  readonly identificada: NormaIdentificada | null;
  readonly estado: EstadoCandidato;
  readonly motivo: string;
  /** Qué tiene que hacer una persona. Vacío solo cuando no hay nada que hacer. */
  readonly accion: string;
}

/**
 * Patrones de identificación.
 *
 * Cada uno reconoce una forma que el organismo usa; ninguno intenta ser general.
 * Se prueban en orden y el primero que engancha gana.
 *
 * El número admite de uno a cinco dígitos. La primera versión pedía tres como
 * mínimo —las RG de ARCA hace años que son de cuatro— y con eso la RG 9/2026 de
 * ARCA quedaba sin identificar mientras la 9/2026 de IGJ sí se reconocía. El
 * rango angosto no protegía de nada: el patrón ya exige que el organismo aparezca
 * en el título, que es lo que evita los falsos positivos.
 */
const PATRONES: readonly {
  readonly organismo: string;
  readonly tipo: string;
  readonly regex: RegExp;
}[] = [
  {
    organismo: 'ARCA',
    tipo: 'RG',
    regex: /\b(?:ARCA|AFIP)\b[\s\S]{0,40}?\bResoluci[oó]n\s+General\s+N?[°º]?\s*(\d{1,5})\s*\/\s*(\d{4})/iu,
  },
  {
    organismo: 'ARCA',
    tipo: 'RG',
    regex: /\bResoluci[oó]n\s+General\s+(?:ARCA|AFIP)\s+N?[°º]?\s*(\d{1,5})\s*\/\s*(\d{4})/iu,
  },
  {
    organismo: 'IGJ',
    tipo: 'RG',
    regex: /\b(?:IGJ|Inspecci[oó]n\s+General\s+de\s+Justicia)\b[\s\S]{0,40}?\bResoluci[oó]n\s+General\s+N?[°º]?\s*(\d{1,4})\s*\/\s*(\d{4})/iu,
  },
  {
    organismo: 'FACPCE',
    tipo: 'RT',
    regex: /\bResoluci[oó]n\s+T[eé]cnica\s+N?[°º]?\s*(\d{1,3})\b[\s\S]{0,30}?(\d{4})/iu,
  },
];

export function identificarNorma(titulo: string): NormaIdentificada | null {
  for (const patron of PATRONES) {
    const encontrado = patron.regex.exec(titulo);
    if (encontrado === null) continue;
    const numero = encontrado[1];
    const anio = encontrado[2];
    if (numero === undefined || anio === undefined) continue;
    return {
      organismo: patron.organismo,
      tipo: patron.tipo,
      numero,
      anio: Number(anio),
    };
  }
  return null;
}

/** Lo que ya está archivado, para no volver a avisar. */
export interface NormaArchivada {
  readonly organismo: string;
  readonly tipo: string;
  readonly numero: string;
  readonly anio: number;
}

export interface ResultadoVigilancia {
  readonly candidatos: readonly Candidato[];
  readonly nuevos: number;
  readonly noIdentificables: number;
  readonly yaArchivados: number;
  readonly resumen: string;
}

/**
 * Compara lo que la fuente publicó contra lo que el archivo ya tiene.
 *
 * **No descarga nada, no lee ningún texto y no toca `norms`.** Recibe la lista ya
 * traída y el archivo ya cargado, y devuelve qué hay que ir a mirar. Que sea una
 * función pura no es purismo: es lo que garantiza que no exista un camino por el
 * que la vigilancia escriba en el archivo normativo.
 */
export function vigilar(
  items: readonly ItemDeVigilancia[],
  archivadas: readonly NormaArchivada[],
): ResultadoVigilancia {
  const yaTenemos = new Set(archivadas.map(clave));
  const candidatos: Candidato[] = [];

  for (const item of items) {
    const identificada = identificarNorma(item.titulo);

    if (identificada === null) {
      // No se adivina. Un identificador equivocado manda a alguien a buscar la
      // norma que no es, o hace creer que ya está archivada.
      candidatos.push({
        item,
        identificada: null,
        estado: 'NO_IDENTIFICABLE',
        motivo:
          'El título no permite identificar organismo, tipo y número con los patrones conocidos. No se adivina: un identificador equivocado es peor que ninguno.',
        accion: `Abrir ${item.url} y, si aplica, archivar el documento a mano siguiendo el procedimiento de OFFICIAL_SOURCES §9.`,
      });
      continue;
    }

    if (yaTenemos.has(clave(identificada))) {
      candidatos.push({
        item,
        identificada,
        estado: 'YA_ARCHIVADO',
        motivo: `${identificada.organismo} ${identificada.tipo} ${identificada.numero}/${String(identificada.anio)} ya está en el archivo.`,
        accion: '',
      });
      continue;
    }

    candidatos.push({
      item,
      identificada,
      estado: 'NUEVO',
      motivo: `Apareció ${identificada.organismo} ${identificada.tipo} ${identificada.numero}/${String(identificada.anio)} y no está archivada.`,
      // El texto de la acción es el punto entero del módulo: lo que sigue lo
      // hace una persona, y el sistema no ofrece un atajo.
      accion: `Descargar el documento oficial desde ${item.url}, registrar su sha256 en checksums.sha256 y agregar la fila en registro-de-descargas.csv. El sistema NO lo carga solo: hasta que esté archivado y verificado, esta norma no se puede citar.`,
    });
  }

  const nuevos = candidatos.filter((candidato) => candidato.estado === 'NUEVO').length;
  const noIdentificables = candidatos.filter(
    (candidato) => candidato.estado === 'NO_IDENTIFICABLE',
  ).length;
  const yaArchivados = candidatos.filter((candidato) => candidato.estado === 'YA_ARCHIVADO').length;

  return {
    candidatos,
    nuevos,
    noIdentificables,
    yaArchivados,
    resumen: armarResumen(nuevos, noIdentificables, yaArchivados, items.length),
  };
}

function armarResumen(
  nuevos: number,
  noIdentificables: number,
  yaArchivados: number,
  total: number,
): string {
  if (total === 0) {
    return 'La fuente no devolvió ítems. No se relevó nada — que no es lo mismo que no haber novedades.';
  }

  const partes = [`${String(total)} ítem(s) relevados`];
  if (nuevos > 0) partes.push(`${String(nuevos)} norma(s) nuevas para archivar`);
  if (noIdentificables > 0) partes.push(`${String(noIdentificables)} sin identificar`);
  if (yaArchivados > 0) partes.push(`${String(yaArchivados)} ya archivadas`);

  const cola =
    nuevos + noIdentificables > 0
      ? ' Ninguna de estas se cargó ni se puede citar: son candidatos hasta que una persona archive el documento oficial y verifique su hash.'
      : '';

  return `${partes.join(', ')}.${cola}`;
}

function clave(norma: NormaArchivada | NormaIdentificada): string {
  return `${norma.organismo}|${norma.tipo}|${norma.numero}|${String(norma.anio)}`;
}

/**
 * Lo que un candidato **no** habilita.
 *
 * Existe como función para que la respuesta esté disponible en la UI y en la API
 * con las mismas palabras, y para que quede claro que la limitación es de diseño
 * y no una funcionalidad pendiente.
 */
export function loQueUnCandidatoNoHabilita(): readonly string[] {
  return [
    'No se puede citar en una propuesta de clasificación: el enum de normas citables se arma solo con lo archivado.',
    'No entra al motor de resolución: `resolver()` exige nivel V1 y documento con hash.',
    'No alcanza para cargar una alícuota, una regla contable ni una plantilla de estado: las tres exigen `norm_version_id`.',
    'No prueba que la norma diga lo que el título sugiere. El título es lo que publicó la fuente, no el articulado.',
  ];
}
