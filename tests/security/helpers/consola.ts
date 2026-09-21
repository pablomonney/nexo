/**
 * Cómo se lee la consola: una sola vez, para los dos barridos que la miran.
 *
 * S-12 comprueba que cada llamada de la consola resuelva contra una ruta que
 * existe. S-25 mira la dirección contraria: que cada capacidad tenga por dónde
 * entrarle. Los dos necesitan reconstruir las URL que el HTML puede emitir, y si
 * cada uno lo hiciera a su manera terminarían discrepando —uno vería una llamada
 * que el otro no— y la discrepancia no se notaría: los dos darían verde.
 *
 * Ya pasó una vez con un solo barrido: `bajarCsv` llamaba a `fetch` adentro de
 * un ayudante, la URL no aparecía al lado de ninguna de las dos formas
 * conocidas, y el dominio `exports` figuró como inalcanzable teniendo botón. El
 * instrumento estaba ciego, no la consola sin puerta.
 */
export const VARIABLE = '§';

/**
 * Reconstruye la URL de una expresión de concatenación.
 *
 * `'/documents/' + id + '/extract'` → `/documents/<var>/extract`
 *
 * Se recorre carácter por carácter en vez de partir por `+`: hay expresiones con
 * ternarios adentro —`(cursor ? '&cursor=' + cursor : '')`— y partirlas daría
 * basura.
 */
function reconstruir(expresion: string): string {
  let salida = '';
  let i = 0;
  let pendiente = false; // hay un tramo no literal sin anotar todavía

  while (i < expresion.length) {
    const c = expresion[i]!;

    if (c === "'") {
      const fin = expresion.indexOf("'", i + 1);
      if (fin === -1) break;
      if (pendiente) { salida += VARIABLE; pendiente = false; }
      salida += expresion.slice(i + 1, fin);
      i = fin + 1;
      continue;
    }

    // Un grupo entre paréntesis o corchetes se salta entero.
    //
    // Sin esto, `'/predictions/' + E('iap-id').value + '/review'` se leía como
    // `/predictions/§iap-id`: el literal de **adentro** de la llamada se tomaba
    // por un tramo de la URL. La ruta quedaba irreconocible y el barrido la
    // daba por inalcanzable teniendo botón — un falso rojo, que es lo único que
    // este ayudante no se puede permitir.
    if (c === '(' || c === '[') {
      let profundidad = 0;
      let comilla: string | null = null;
      for (; i < expresion.length; i += 1) {
        const d = expresion[i]!;
        if (comilla !== null) {
          if (d === '\\') i += 1;
          else if (d === comilla) comilla = null;
          continue;
        }
        if (d === "'" || d === '"' || d === '`') comilla = d;
        else if (d === '(' || d === '[') profundidad += 1;
        else if (d === ')' || d === ']') {
          profundidad -= 1;
          if (profundidad === 0) { i += 1; break; }
        }
      }
      pendiente = true;
      continue;
    }

    if (!/\s|\+/u.test(c)) pendiente = true;
    i += 1;
  }
  if (pendiente) salida += VARIABLE;

  // La query no forma parte de la ruta registrada.
  const corte = salida.indexOf('?');
  return corte === -1 ? salida : salida.slice(0, corte);
}

/**
 * Lee el argumento de URL a partir de una posición, respetando comillas y
 * paréntesis.
 *
 * Una expresión regular no alcanza: hay argumentos con paréntesis adentro
 * —`'/x?' + q.toString()`, `(cursor ? '…' : '')`— y cortar por el primer `,` o
 * `)` daría una URL a medias, que es peor que ninguna: haría fallar el barrido
 * por un defecto del barrido.
 */
function leerArgumento(texto: string, desde: number): { expresion: string; fin: number } {
  let i = desde;
  let profundidad = 0;
  let comilla: string | null = null;
  for (; i < texto.length; i += 1) {
    const c = texto[i]!;
    if (comilla !== null) {
      if (c === '\\') i += 1;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      comilla = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      profundidad += 1;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (profundidad === 0) break;
      profundidad -= 1;
      continue;
    }
    if (c === ',' && profundidad === 0) break;
  }
  return { expresion: texto.slice(desde, i), fin: i };
}

/** Todas las llamadas HTTP que la consola puede emitir. */
export function llamadasDe(html: string): { metodo: string; url: string }[] {
  const salida: { metodo: string; url: string }[] = [];

  // api('GET', <url>, …)
  const porApi = /api\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*/g;
  let m: RegExpExecArray | null;
  while ((m = porApi.exec(html)) !== null) {
    const url = reconstruir(leerArgumento(html, porApi.lastIndex).expresion);
    if (url.startsWith('/')) salida.push({ metodo: m[1]!, url });
  }

  // fetch(<url>, { … }) — la descarga de la evidencia.
  const porFetch = /fetch\(\s*/g;
  while ((m = porFetch.exec(html)) !== null) {
    const url = reconstruir(leerArgumento(html, porFetch.lastIndex).expresion);
    if (url.startsWith('/')) salida.push({ metodo: 'GET', url });
  }

  // bajarCsv(<url>, …) — las exportaciones.
  //
  // Se agregó cuando el barrido inverso marcó el dominio `exports` como
  // inalcanzable: las descargas pasan por un ayudante que llama a `fetch`
  // adentro, así que la url no aparecía al lado de ninguna de las dos formas
  // que este barrido conocía. El instrumento estaba ciego a una forma de
  // llamada, no la consola sin puerta — y es exactamente por eso que el
  // control mira en las dos direcciones.
  const porDescarga = /bajarCsv\(\s*/g;
  while ((m = porDescarga.exec(html)) !== null) {
    const url = reconstruir(leerArgumento(html, porDescarga.lastIndex).expresion);
    if (url.startsWith('/')) salida.push({ metodo: 'GET', url });
  }

  return salida;
}

/**
 * Una ruta y una llamada, escritas de la misma forma.
 *
 * Fastify registra `/documents/:documentId/extract`; la consola arma
 * `/documents/§/extract`. Son la misma puerta escrita distinto, y compararlas
 * sin normalizar daría todas las rutas con parámetro por inalcanzables.
 */
export function normalizar(url: string): string {
  return url
    .split('/')
    .map((parte) => (parte.startsWith(':') || parte === VARIABLE ? '<var>' : parte))
    .join('/');
}

// ── La puerta, con el método ────────────────────────────────────────────────
//
// ## Por qué esto cambió, y qué escondía antes
//
// Hasta el 2026-09-21 esta función recibía **la ruta y nada más**:
//
//     tienePuerta(ruta: string, html: string)
//
// Se hizo así a propósito y el motivo estaba escrito: la consola pasa URL por
// ayudantes y ternarios, y un barrido que solo mirara `llamadasDe` habría
// marcado como inalcanzables rutas **que tienen botón**. Un control con falsos
// rojos dura hasta que alguien lo apaga.
//
// Lo que ese diseño no previó es lo que esconde. Si la consola hace
// `GET /fiscal-years` para listar, la forma `/fiscal-years` aparece en el texto
// y el `POST /fiscal-years` figura con puerta **sin que ningún botón lo llame**.
// Fue exactamente lo que pasó: una empresa nueva no podía abrir su ejercicio
// desde la consola, el paso estaba declarado como bloqueante en la puesta en
// marcha, y este control daba verde. Lo encontró una persona usando el producto.
//
// ## Cómo se resuelve sin volver a los falsos rojos
//
// La respuesta al problema original no era soltar el método: era saber leer las
// tres formas indirectas. Son **tres** en toda la consola, y las tres terminan
// en un `api('POST', url)`:
//
//     1. const url = accion === 'confirm' ? '/a/' + id + '/confirm'
//                                         : '/a/' + id + '/cancel';
//     2. const url = accion === 'emit' ? … : … ? … : …        (cuatro ramas)
//     3. async function actoSobreSolicitud(url, …) { api('POST', url) }
//
// Las dos primeras se resuelven partiendo la expresión por el ternario **al
// nivel cero** y reconstruyendo cada rama; la tercera, atribuyendo el método a
// los lugares que llaman al ayudante.
//
// ## Y si aparece una cuarta forma
//
// `puertasDe` devuelve también las que **no pudo resolver**. El control las
// exige vacías. Así, el día que alguien escriba una forma nueva, lo que falla
// dice «el instrumento no sabe leer esto» en vez de acusar a una pantalla de no
// existir. Es la misma lección que dejó `bajarCsv`: el instrumento estaba
// ciego, no la consola sin puerta.

/** Una llamada que llega a `api()` con la URL en una variable. */
interface Indirecta {
  readonly metodo: string;
  readonly identificador: string;
  readonly posicion: number;
}

/** La función que contiene una posición del texto. */
function funcionQueContiene(
  html: string,
  posicion: number,
): { nombre: string; parametros: string[]; cuerpo: string } | null {
  const declaracion = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gu;
  let ultima: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = declaracion.exec(html)) !== null) {
    if (m.index > posicion) break;
    ultima = m;
  }
  if (ultima === null) return null;

  // Del `{` de la declaración hasta su llave de cierre.
  let i = ultima.index + ultima[0].length;
  let profundidad = 1;
  let comilla: string | null = null;
  for (; i < html.length && profundidad > 0; i += 1) {
    const c = html[i]!;
    if (comilla !== null) {
      if (c === '\\') i += 1;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') comilla = c;
    else if (c === '{') profundidad += 1;
    else if (c === '}') profundidad -= 1;
  }
  if (posicion > i) return null;

  return {
    nombre: ultima[1]!,
    parametros: ultima[2]!.split(',').map((p) => p.trim()).filter((p) => p !== ''),
    cuerpo: html.slice(ultima.index, i),
  };
}

/** Lo que hay hasta el `;` de nivel cero: el cuerpo de una asignación. */
function hastaElPuntoYComa(texto: string): string {
  let profundidad = 0;
  let comilla: string | null = null;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i]!;
    if (comilla !== null) {
      if (c === '\\') i += 1;
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') comilla = c;
    else if (c === '(' || c === '[' || c === '{') profundidad += 1;
    else if (c === ')' || c === ']' || c === '}') profundidad -= 1;
    else if (c === ';' && profundidad === 0) return texto.slice(0, i);
  }
  return texto;
}

/** Parte una expresión por los `?` y `:` que están al nivel cero. */
function ramasDelTernario(expresion: string): string[] {
  const ramas: string[] = [];
  let actual = '';
  let profundidad = 0;
  let comilla: string | null = null;
  for (let i = 0; i < expresion.length; i += 1) {
    const c = expresion[i]!;
    if (comilla !== null) {
      actual += c;
      if (c === '\\') { actual += expresion[i + 1] ?? ''; i += 1; }
      else if (c === comilla) comilla = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { comilla = c; actual += c; continue; }
    if (c === '(' || c === '[' || c === '{') profundidad += 1;
    if (c === ')' || c === ']' || c === '}') profundidad -= 1;
    if ((c === '?' || c === ':') && profundidad === 0) {
      ramas.push(actual);
      actual = '';
      continue;
    }
    actual += c;
  }
  ramas.push(actual);
  return ramas;
}

/**
 * Cada método, con las rutas que la consola sabe pedirle.
 *
 * `sinResolver` son las llamadas indirectas que no se pudieron atribuir. El
 * control las exige vacías: ver el bloque de arriba.
 */
export function puertasDe(html: string): {
  puertas: Map<string, Set<string>>;
  sinResolver: string[];
} {
  const puertas = new Map<string, Set<string>>();
  const sinResolver: string[] = [];

  const anotar = (metodo: string, url: string): void => {
    if (!url.startsWith('/')) return;
    const corte = url.indexOf('?');
    const limpia = normalizar(corte === -1 ? url : url.slice(0, corte));
    if (!puertas.has(metodo)) puertas.set(metodo, new Set());
    puertas.get(metodo)!.add(limpia);
  };

  for (const { metodo, url } of llamadasDe(html)) anotar(metodo, url);

  // Las que llegan con la URL en una variable.
  const indirectas: Indirecta[] = [];
  const porVariable = /api\(\s*'(GET|POST|PATCH|PUT|DELETE)'\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/gu;
  let m: RegExpExecArray | null;
  while ((m = porVariable.exec(html)) !== null) {
    indirectas.push({ metodo: m[1]!, identificador: m[2]!, posicion: m.index });
  }

  for (const { metodo, identificador, posicion } of indirectas) {
    const fn = funcionQueContiene(html, posicion);
    if (fn === null) {
      sinResolver.push(`${metodo} <${identificador}> sin función que lo contenga`);
      continue;
    }

    // Caso ayudante: la URL entra por parámetro. El método se atribuye a cada
    // lugar que llama al ayudante.
    if (fn.parametros.includes(identificador)) {
      const llamadas = new RegExp(`(?<![\\w$.])${fn.nombre}\\(\\s*`, 'gu');
      let encontradas = 0;
      let c: RegExpExecArray | null;
      while ((c = llamadas.exec(html)) !== null) {
        if (c.index >= html.indexOf(fn.cuerpo) && c.index < html.indexOf(fn.cuerpo) + fn.cuerpo.length) {
          continue; // la propia declaración
        }
        const url = reconstruir(leerArgumento(html, c.index + c[0].length).expresion);
        if (url.startsWith('/')) { anotar(metodo, url); encontradas += 1; }
      }
      if (encontradas === 0) sinResolver.push(`${metodo} por ${fn.nombre}(): sin llamadas legibles`);
      continue;
    }

    // Caso variable local: `const url = <ternario>;` dentro de la función.
    const asignacion = new RegExp(`(?:const|let|var)\\s+${identificador}\\s*=\\s*`, 'u').exec(fn.cuerpo);
    if (asignacion === null) {
      sinResolver.push(`${metodo} <${identificador}> en ${fn.nombre}(): no se ve la asignación`);
      continue;
    }
    // Hasta el `;` de la asignación y no más: `leerArgumento` corta en la coma
    // o en la llave, y sin este corte la última rama del ternario se arrastraba
    // el `const r = await api(…)` de la línea siguiente. La rama quedaba
    // irreconocible y su ruta figuraba sin puerta teniéndola.
    const expresion = hastaElPuntoYComa(
      fn.cuerpo.slice(asignacion.index + asignacion[0].length),
    );
    let ramas = 0;
    for (const rama of ramasDelTernario(expresion)) {
      const url = reconstruir(rama.trim());
      if (url.startsWith('/')) { anotar(metodo, url); ramas += 1; }
    }
    if (ramas === 0) sinResolver.push(`${metodo} <${identificador}> en ${fn.nombre}(): ninguna rama dio una ruta`);
  }

  return { puertas, sinResolver };
}

/**
 * ¿Puede la consola pedir **esta ruta con este método**?
 *
 * La ruta registrada y la llamada de la consola se comparan normalizadas, que es
 * lo que hace comparables `/documents/:documentId/extract` y `/documents/§/extract`.
 */
export function tienePuerta(metodo: string, ruta: string, html: string): boolean {
  return puertasDe(html).puertas.get(metodo)?.has(normalizar(ruta)) === true;
}
