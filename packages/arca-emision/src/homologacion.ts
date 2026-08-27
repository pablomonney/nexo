/**
 * El candado de emisión: probar que el destino es homologación.
 *
 * ## Por qué este paquete existe separado de `@aai/arca`
 *
 * `@aai/arca` consulta: constata comprobantes, pregunta al padrón, revisa
 * apócrifos. Todas son operaciones de lectura. Este paquete **emite**, y con un
 * certificado de producción emitiría facturas reales, con CAE real, ante el
 * organismo, a nombre del contribuyente.
 *
 * El MVP declara la emisión fuera de alcance a propósito. Está acá porque hace
 * falta **generar datos de prueba en homologación**, que es para lo que ese
 * ambiente existe. Vive en su propio paquete para que el lint de arquitectura
 * pueda prohibir que la API lo importe: la separación es una arista del grafo de
 * módulos, no un comentario que alguien tiene que leer.
 *
 * ## El candado pregunta al revés, igual que el sandbox del §34
 *
 * No comprueba que el destino **no** sea producción. Eso falla abierto: un
 * endpoint nuevo, un proxy, un hostname que ARCA cambie, y pasa.
 *
 * Comprueba que el destino **sea** exactamente el que este repositorio declara
 * para homologación en `endpointsFor('homologacion')`. Igualdad, no `includes`.
 * Cualquier otra cosa —incluido un endpoint de homologación que alguien escriba
 * a mano con una barra de más— se rechaza.
 *
 * ## Lo que este candado NO prueba, y hay que decirlo
 *
 * Prueba **a dónde** se emite. No prueba **con qué credencial**.
 *
 * Un certificado de producción apuntando a homologación no va a funcionar —el
 * WSAA de homologación no lo va a reconocer— pero eso lo decide ARCA, no este
 * código. Verificar acá que el certificado es de homologación exigiría conocer
 * los DN de las dos autoridades certificantes, y este repositorio no los tiene
 * archivados. Inventarlos sería peor que no tenerlos: un chequeo que parece
 * verificar algo y no verifica nada.
 *
 * Por eso `describirCertificado()` existe y el script lo imprime antes de cada
 * corrida: la decisión sobre la credencial la toma una persona mirando el emisor
 * y la huella, no una comparación contra una constante inventada.
 */

import { endpointsFor, type ArcaEnvironment } from '@aai/arca';

export type MotivoDeRechazoEmision =
  /** El ambiente pedido no es homologación. */
  | 'AMBIENTE_NO_ES_HOMOLOGACION'
  /** El endpoint no es idéntico al que el repositorio declara para homologación. */
  | 'ENDPOINT_NO_DECLARADO'
  /** El endpoint coincide con el de producción. */
  | 'ENDPOINT_DE_PRODUCCION'
  /** El WSAA al que se pediría el ticket tampoco es el de homologación. */
  | 'WSAA_NO_ES_DE_HOMOLOGACION';

export interface RechazoEmision {
  readonly motivo: MotivoDeRechazoEmision;
  readonly explicacion: string;
}

/**
 * Permiso de emisión, como unión discriminada.
 *
 * `emitirLote()` lo pide en su firma y el tipo no se puede construir desde
 * afuera de este módulo. No hay forma de emitir sin haber pasado por acá, y no
 * depende de que alguien se acuerde de llamarlo primero.
 */
export type PermisoDeEmision =
  | { readonly permitido: true; readonly endpoint: string; readonly wsaa: string }
  | { readonly permitido: false; readonly rechazos: readonly RechazoEmision[] };

export interface DestinoDeEmision {
  readonly ambiente: ArcaEnvironment;
  readonly endpointWsfev1: string;
  readonly endpointWsaa: string;
}

export function verificarDestinoDeEmision(destino: DestinoDeEmision): PermisoDeEmision {
  const rechazos: RechazoEmision[] = [];
  const homologacion = endpointsFor('homologacion');
  const produccion = endpointsFor('produccion');

  if (destino.ambiente !== 'homologacion') {
    rechazos.push({
      motivo: 'AMBIENTE_NO_ES_HOMOLOGACION',
      explicacion:
        `El ambiente pedido es "${destino.ambiente}". Este paquete solo emite en homologación: ` +
        'con un certificado de producción, emitir es un acto fiscal a nombre del contribuyente.',
    });
  }

  if (destino.endpointWsfev1 === produccion.wsfev1) {
    rechazos.push({
      motivo: 'ENDPOINT_DE_PRODUCCION',
      explicacion: `El endpoint es el de producción (${produccion.wsfev1}).`,
    });
  } else if (destino.endpointWsfev1 !== homologacion.wsfev1) {
    // Igualdad y no `includes('homo')`: un endpoint que contiene la palabra no
    // es el endpoint, y este es justamente el control que no conviene aflojar.
    rechazos.push({
      motivo: 'ENDPOINT_NO_DECLARADO',
      explicacion:
        `El endpoint "${destino.endpointWsfev1}" no es idéntico al que este repositorio declara ` +
        `para homologación (${homologacion.wsfev1}). Si ARCA lo cambió, cambialo en ` +
        '`packages/arca/src/environment.ts`, que es donde el resto del sistema lo lee.',
    });
  }

  if (destino.endpointWsaa !== homologacion.wsaa) {
    rechazos.push({
      motivo: 'WSAA_NO_ES_DE_HOMOLOGACION',
      explicacion:
        `El ticket se pediría a "${destino.endpointWsaa}" y el WSAA de homologación es ` +
        `${homologacion.wsaa}. Un ticket de producción sirve para emitir en producción.`,
    });
  }

  if (rechazos.length > 0) return { permitido: false, rechazos };
  return { permitido: true, endpoint: destino.endpointWsfev1, wsaa: destino.endpointWsaa };
}

export function explicarRechazoEmision(permiso: PermisoDeEmision): string {
  if (permiso.permitido) return '';
  return [
    'No se emitió nada: el destino no probó ser homologación.',
    '',
    ...permiso.rechazos.map((r) => `  · ${r.motivo}: ${r.explicacion}`),
    '',
    'Ninguno de estos controles pregunta si el destino es producción. Preguntan si es el',
    'de homologación que el repositorio declara, que es la pregunta que falla del lado',
    'seguro cuando la respuesta no está.',
    '',
    'Y ninguno prueba con QUÉ certificado se emite: eso lo mira una persona en la salida',
    'de `describirCertificado()`, porque verificarlo acá exigiría los DN de las dos',
    'autoridades certificantes y este repositorio no los tiene archivados.',
  ].join('\n');
}
