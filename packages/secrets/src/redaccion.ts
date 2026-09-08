/**
 * Sacarle el secreto a un texto antes de que llegue a un log.
 *
 * El caso que este archivo existe para atajar no es hipotético y no se arregla
 * con disciplina:
 *
 *     https://proveedor.example/v1/completions?api_key=SECRETO
 *
 * Una excepción de red trae la URL completa en el mensaje. Nadie la escribió a
 * mano en un `console.log`: la escribió `fetch`, la propagó un `catch` que
 * relanza, y la serializó el logger. Para cuando alguien la ve, ya está en
 * disco.
 *
 * ## Por qué acá y no en el logger
 *
 * El `redact` de pino trabaja por **camino** —`req.headers.authorization`— y eso
 * cubre lo que viaja en un lugar conocido. Un secreto adentro de un string no
 * tiene camino: hay que mirar el texto. Las dos cosas son necesarias y ninguna
 * reemplaza a la otra.
 *
 * ## Lo que no puede hacer
 *
 * Reconocer un secreto que no está en un lugar reconocible. Un valor suelto en
 * medio de una frase pasa. Por eso esto es la última línea y no la primera: la
 * primera es no meter el secreto en el texto.
 */

/**
 * Nombres de parámetro que llevan material sensible.
 *
 * No es una lista cerrada de los que existen —cada proveedor inventa el suyo—
 * sino de los que se ven. Se comparan sin distinguir mayúsculas ni separadores,
 * así que `api_key`, `apiKey` y `API-KEY` caen los tres.
 */
const PARAMETROS_SENSIBLES = [
  'apikey',
  'api',
  'key',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'auth',
  'signature',
  'sig',
  'credential',
  'sastoken',
];

/**
 * Con qué se reemplaza lo que se tapa.
 *
 * Sin corchetes **a propósito**: dentro de una URL, `URLSearchParams` los
 * percent-encodea y el log termina diciendo `api_key=%5Bredactado%5D`, que es
 * correcto y se lee peor. El logger de Fastify usa `[redactado]` porque ahí no
 * pasa por ninguna serialización de URL.
 */
export const CENSURA = 'REDACTADO';

function esSensible(nombre: string): boolean {
  const normalizado = nombre.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return PARAMETROS_SENSIBLES.includes(normalizado);
}

/**
 * Una URL sin sus parámetros sensibles.
 *
 * Se preserva todo lo demás —el host, la ruta, los parámetros inocuos— porque
 * un log con la URL borrada entera no sirve para diagnosticar nada, y entonces
 * alguien la vuelve a poner.
 *
 * También se saca el `usuario:contraseña@` del principio, que es la otra forma
 * de meter una credencial en una URL y la que menos se mira.
 */
export function redactarUrl(url: string): string {
  let analizada: URL;
  try {
    analizada = new URL(url);
  } catch {
    // No es una URL: se devuelve tal cual. Inventar una redacción sobre algo
    // que no se pudo interpretar daría una falsa sensación de haber limpiado.
    return url;
  }

  if (analizada.username !== '' || analizada.password !== '') {
    analizada.username = CENSURA;
    analizada.password = '';
  }

  for (const clave of [...analizada.searchParams.keys()]) {
    if (esSensible(clave)) analizada.searchParams.set(clave, CENSURA);
  }

  return analizada.toString();
}

/**
 * Un texto con sus URLs redactadas, venga de donde venga.
 *
 * Es lo que se aplica al mensaje de una excepción antes de propagarla: ahí la
 * URL no está sola, está embebida en una frase como
 * `connect ECONNREFUSED https://…?key=…`.
 */
export function redactarTexto(texto: string): string {
  return texto.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/giu, (url) => redactarUrl(url));
}

/**
 * Un valor conocido, tapado en cualquier lado donde aparezca.
 *
 * Se usa cuando el secreto **se tiene a mano** y hay que asegurarse de que no
 * salga: el caso típico es un cuerpo de error de un proveedor que devuelve el
 * pedido completo, con la cabecera de autorización adentro.
 *
 * Los valores muy cortos no se tapan: reemplazar cada aparición de un secreto
 * de tres caracteres destruiría el texto sin proteger nada que valga.
 */
export function taparValor(texto: string, valor: string | null | undefined): string {
  if (valor === null || valor === undefined || valor.length < 8) return texto;
  return texto.split(valor).join(CENSURA);
}
