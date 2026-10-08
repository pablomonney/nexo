/**
 * El detector de S-37: formas de sacar «el día de hoy» (o el mes, o el año) del
 * reloj de UTC o de la zona del proceso, en vez de la del negocio.
 *
 * Vive acá y no dentro del test para poder **probarlo a sí mismo**: un control
 * que detecta texto y nunca se verificó contra casos conocidos puede estar
 * ciego sin que nadie lo note (la versión anterior dejaba pasar 7 de 9
 * variantes peligrosas: una variable intermedia, `substring`, `split('T')`,
 * getters locales…).
 *
 * ## Qué es y qué no es
 *
 * Es una búsqueda sobre el **código sin comentarios**, no un análisis de flujo:
 * no sabe de dónde viene el `Date` que se formatea. Por eso la regla es
 * deliberadamente más ancha que «`new Date()` directo» —cualquier
 * `.toISOString()` seguido de un recorte a fecha o mes— y los usos legítimos se
 * declaran **uno por uno**, con motivo, en la propia línea:
 *
 *     // s37-permite: <por qué esta línea no es «hoy en UTC»>
 *
 * Una anotación sin motivo es un hallazgo. Así una excepción es visible donde
 * vive y no en una lista aparte que nadie lee.
 *
 * ## Las preguntas que hay que hacerse antes de anotar una línea
 *
 *   ¿Es un INSTANTE (cuándo pasó algo)?           → UTC está bien; no se recorta a fecha.
 *   ¿Es una FECHA DE NEGOCIO (qué día es hoy)?    → hoyEnZonaDeNegocio / CURRENT_DATE.
 *   ¿Es una FECHA DE CALENDARIO (AAAA-MM-DD)?     → aritmética sobre sus partes, sin reloj.
 */

export interface HallazgoDeUtc {
  readonly patron: string;
  readonly linea: number;
  readonly texto: string;
}

interface Patron {
  readonly nombre: string;
  readonly expresion: RegExp;
}

const PATRONES: readonly Patron[] = [
  {
    nombre: 'toISOString() recortado a fecha o mes (cualquier receptor)',
    expresion:
      /\.\s*(?:toISOString|toJSON)\(\)\s*\.\s*(?:slice|substring|substr)\(\s*0\s*,\s*(?:7|10)\s*\)|\.\s*(?:toISOString|toJSON)\(\)\s*\.\s*split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/,
  },
  {
    // El instante «bonito» en UTC: `2026-10-06 00:30:00` para algo de las 21:30 ART.
    nombre: 'toISOString().replace("T", …) o .replace("T", " ").slice(0, n) (instante mostrado en UTC)',
    expresion:
      /\.\s*(?:toISOString|toJSON)\(\)\s*\.\s*replace\(\s*['"]T['"]|\.\s*replace\(\s*['"]T['"]\s*,\s*['"] ['"]\s*\)\s*\.\s*slice\(\s*0\s*,\s*(?:10|16|19)\s*\)/,
  },
  // Sumar o restar un desfase a mano (`getTimezoneOffset`) no sabe de horario de verano.
  { nombre: 'getTimezoneOffset()', expresion: /\.\s*getTimezoneOffset\(\)/ },
  { nombre: 'getUTCFullYear()', expresion: /\.\s*getUTCFullYear\(\)/ },
  { nombre: 'getUTCMonth()', expresion: /\.\s*getUTCMonth\(\)/ },
  { nombre: 'getUTCDate()', expresion: /\.\s*getUTCDate\(\)/ },
  // Los getters locales usan la zona del proceso: UTC en un contenedor, ART en
  // la máquina de quien desarrolla. Ninguna de las dos es la del negocio.
  { nombre: 'getFullYear()/getMonth()/getDate() (zona del proceso)', expresion: /\.\s*get(?:FullYear|Month|Date)\(\)/ },
  // Solo las variantes que son de fecha: `Number.toLocaleString` es de números.
  {
    nombre: 'toLocaleDateString/toLocaleTimeString sin timeZone',
    expresion: /\.\s*toLocale(?:Date|Time)String\((?![^)]*timeZone)[^)]*\)/,
  },
  { nombre: 'Intl.DateTimeFormat sin timeZone', expresion: /Intl\.DateTimeFormat\((?![^)]*timeZone)[^)]*\)/ },
];

/** `// s37-permite: motivo` con un motivo de verdad (≥ 8 caracteres). */
const ANOTACION = /s37-permite/;
const ANOTACION_CON_MOTIVO = /s37-permite:\s*\S[^\n]{7,}/;

/** Quita comentarios `/* … *\/` y `// …` conservando los saltos de línea (los números de línea valen). */
function sinComentarios(fuente: string): string {
  const blanquear = (m: string) => m.replace(/[^\n]/g, ' ');
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, blanquear)
    .replace(/(^|[^:\\])(\/\/[^\n]*)/g, (_todo, antes: string, comentario: string) => antes + blanquear(comentario));
}

export function hallazgosDeUtc(fuente: string): HallazgoDeUtc[] {
  const hallazgos: HallazgoDeUtc[] = [];

  // 1) Las líneas anotadas se apartan antes de buscar, y las anotaciones vacías son un hallazgo.
  const lineas = fuente.split('\n').map((texto, i) => {
    if (!ANOTACION.test(texto)) return texto;
    if (!ANOTACION_CON_MOTIVO.test(texto)) {
      hallazgos.push({ patron: 's37-permite sin motivo', linea: i + 1, texto: texto.trim() });
    }
    return '';
  });

  // 2) Búsqueda sobre el código sin comentarios, con el número de línea del original.
  const codigo = sinComentarios(lineas.join('\n'));
  for (const { nombre, expresion } of PATRONES) {
    const global = new RegExp(expresion.source, 'g');
    for (let m = global.exec(codigo); m !== null; m = global.exec(codigo)) {
      const linea = codigo.slice(0, m.index).split('\n').length;
      hallazgos.push({ patron: nombre, linea, texto: (fuente.split('\n')[linea - 1] ?? '').trim() });
    }
  }

  // 3) El mismo recorte, pero sobre una variable que guarda el ISO:
  //      const iso = ahora.toISOString();  …  iso.slice(0, 10)
  //    Sigue una sola asignación hacia adelante; no es un análisis de flujo, pero
  //    cubre la forma más común de escapar de la búsqueda por cadena.
  const nombres = new Set<string>();
  for (const m of codigo.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.\s*(?:toISOString|toJSON)\(\)\s*(?:;|\n|$)/g)) {
    nombres.add(m[1]!);
  }
  for (const nombre of nombres) {
    const expresion = new RegExp(
      `\\b${nombre.replace(/\$/g, '\\$')}\\s*\\.\\s*(?:slice|substring|substr)\\(\\s*0\\s*,\\s*(?:7|10)\\s*\\)|\\b${nombre.replace(/\$/g, '\\$')}\\s*\\.\\s*split\\(\\s*['"]T['"]\\s*\\)\\s*\\[\\s*0\\s*\\]`,
      'g',
    );
    for (let m = expresion.exec(codigo); m !== null; m = expresion.exec(codigo)) {
      const linea = codigo.slice(0, m.index).split('\n').length;
      hallazgos.push({
        patron: `${nombre} (un toISOString()) recortado a fecha o mes`,
        linea,
        texto: (fuente.split('\n')[linea - 1] ?? '').trim(),
      });
    }
  }
  return hallazgos;
}
