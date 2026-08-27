/**
 * arca-emision — solicitar CAE en homologación, y solo ahí.
 *
 * Vive separado de `@aai/arca` porque hace algo distinto en naturaleza: aquél
 * consulta, éste **emite**. Con un certificado de producción, emitir es un acto
 * fiscal a nombre del contribuyente.
 *
 * El MVP declara la emisión fuera de alcance. Este paquete existe para generar
 * datos de prueba en homologación, que es para lo que ese ambiente está, y el
 * lint de arquitectura impide que la API lo alcance: la separación es una arista
 * del grafo de módulos, no un comentario.
 *
 * El candado de `homologacion.ts` pregunta al revés que lo intuitivo — prueba que
 * el destino ES el de homologación en vez de comprobar que no es producción — y
 * dice explícitamente lo que NO prueba: con qué certificado se emite.
 */

export * from './contracts.js';
export * from './homologacion.js';
export * from './qr.js';
export * from './wsfev1.js';
