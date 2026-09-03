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
  while (i < expresion.length) {
    if (expresion[i] === "'") {
      const fin = expresion.indexOf("'", i + 1);
      if (fin === -1) break;
      salida += expresion.slice(i + 1, fin);
      i = fin + 1;
      continue;
    }
    // Un tramo que no es literal: una variable, una llamada, un ternario.
    const siguiente = expresion.indexOf("'", i);
    const tramo = (siguiente === -1 ? expresion.slice(i) : expresion.slice(i, siguiente)).trim();
    if (tramo !== '' && tramo !== '+') salida += VARIABLE;
    if (siguiente === -1) break;
    i = siguiente;
  }
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

/**
 * ¿Está esta ruta escrita en algún lado de la consola?
 *
 * `llamadasDe` sabe leer tres formas —`api(…)`, `fetch(…)` y `bajarCsv(…)`— y
 * con eso alcanza para la pregunta de S-12: qué pide la consola, y con qué
 * método. Para la pregunta contraria no alcanza, porque la consola pasa URL por
 * otros caminos:
 *
 *     actoSobreSolicitud('/purchase-requests/' + id + '/enviar', …)
 *     const url = accion === 'emit' ? '/commercial-documents/' + id + '/emit' : …
 *
 * Las dos llegan a `api` una función más adelante, y ninguna aparece al lado de
 * un literal de método. Un barrido inverso que solo mirara `llamadasDe` habría
 * marcado esas rutas como inalcanzables **teniendo botón**, y un control con
 * falsos rojos dura hasta que alguien lo apaga.
 *
 * Así que la pregunta se hace al revés: en vez de reconstruir lo que la consola
 * arma —imposible de hacer bien con ternarios de por medio—, se toma la ruta
 * registrada y se busca su forma en el texto. Un parámetro es cualquier cosa
 * que no cruce el renglón:
 *
 *     /commercial-documents/:id/emit  →  /commercial-documents/…/emit
 *
 * **Qué pierde:** el método. Una pantalla que lista sin botón de guardar cuenta
 * como puerta de las dos rutas. Es una pregunta más chica que la de S-12, y es
 * la que importa acá: que ninguna capacidad quede sin forma de entrarle.
 */
export function tienePuerta(ruta: string, html: string): boolean {
  const patron = ruta
    .split('/')
    .map((parte) =>
      parte.startsWith(':') ? '[^\\n]{0,80}' : parte.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    )
    .join('/');
  // Los dos cortes importan, y el de adelante lo enseñó un falso verde: sin él,
  // `/predictions/metrics` contiene `/metrics` y el recolector de métricas
  // figuraba con puerta. El de atrás impide que `/products` cuente como puerta
  // de `/products-x`.
  return new RegExp('(?<![A-Za-z0-9\\-_/])' + patron + '(?![A-Za-z0-9\\-_])', 'u').test(html);
}
