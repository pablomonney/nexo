/**
 * La puerta de la emisión fiscal productiva. **Cerrada, y con llave doble.**
 *
 * ## Por qué no es una variable de entorno
 *
 * `ENABLE_ARCA=true` sería una puerta que se abre por accidente: una variable
 * copiada de un `.env` de homologación, un despliegue con la configuración del
 * anterior, un typo al revés. Y del otro lado de esa puerta hay facturas reales
 * a nombre de un contribuyente, que no se deshacen.
 *
 * Así que la puerta pregunta por **todas** las condiciones que tienen que
 * cumplirse, las evalúa juntas, y devuelve la lista de las que faltan. Abrirla
 * exige que ninguna falte — no que alguien se acuerde de revisarlas.
 *
 * ## El interruptor que hoy está soldado
 *
 * `EMISION_HABILITADA` es una constante de este archivo y **no** una variable de
 * entorno, a propósito y por ahora. Mientras la fase B2.5.4.1 no cierre, la
 * emisión no se habilita ni siquiera configurándola: hay que editar código,
 * pasar por revisión y correr la suite.
 *
 * El día que se habilite, esta constante pasa a leerse de la configuración
 * **y las demás condiciones siguen valiendo**. Es un candado más, no el único.
 */

import { config } from '../config.js';

/**
 * ¿La capacidad de emitir está habilitada en esta versión del producto?
 *
 * `false` mientras B2.5.4.1 esté abierta. No se lee del entorno: ver arriba.
 */
export const EMISION_HABILITADA = false;

/** Cada cosa que tiene que ser cierta para poder emitir. */
export type CondicionDeEmision =
  /** La capacidad está habilitada en el producto. */
  | 'CAPACIDAD_HABILITADA'
  /** El ambiente es uno donde emitir significa algo. */
  | 'AMBIENTE_FISCAL'
  /** El transporte de emisión es alcanzable desde la aplicación. */
  | 'TRANSPORTE_DISPONIBLE'
  /** Hay una credencial de ARCA vigente para esa empresa y ese ambiente. */
  | 'CREDENCIAL_VIGENTE'
  /** El servicio `wsfe` está autorizado para ese CUIT en WSASS. */
  | 'SERVICIO_AUTORIZADO'
  /** Hay un punto de venta declarado y vigente. */
  | 'PUNTO_DE_VENTA'
  /** Hay con qué resolver una emisión que quede en duda. */
  | 'RECONCILIADOR';

export interface FaltaParaEmitir {
  readonly condicion: CondicionDeEmision;
  readonly explicacion: string;
}

/**
 * Lo que la puerta sabe sobre el estado del sistema.
 *
 * Se recibe como dato en vez de consultarse acá: mantiene la función pura y
 * —lo que importa más— permite ejercitar **cada combinación de faltantes**,
 * incluidas las que en producción no se verían nunca.
 */
export interface EstadoParaEmitir {
  readonly ambiente: string;
  readonly hayCredencialVigente: boolean;
  readonly wsfeAutorizado: boolean;
  readonly hayPuntoDeVenta: boolean;
  readonly hayReconciliador: boolean;
}

/**
 * ¿Se puede emitir? Y si no, qué falta.
 *
 * Devuelve **todas** las condiciones incumplidas, no la primera. Informar de a
 * una obliga a intentar, fallar, arreglar, intentar y fallar por lo siguiente,
 * y en un trámite ante un organismo cada vuelta cuesta un día.
 */
export function faltaParaEmitir(estado: EstadoParaEmitir): FaltaParaEmitir[] {
  const faltan: FaltaParaEmitir[] = [];

  if (!EMISION_HABILITADA) {
    faltan.push({
      condicion: 'CAPACIDAD_HABILITADA',
      explicacion:
        'La emisión fiscal no está habilitada en esta versión. Es deliberado: B2.5.4.1 dejó ' +
        'la seguridad construida y la capacidad cerrada. Habilitarla exige editar ' +
        'EMISION_HABILITADA, no configurar una variable.',
    });
  }

  // `mock` no es un ambiente donde emitir signifique algo, y dejarlo pasar
  // produciría comprobantes con CAE inventado que el sistema informaría como
  // reales. Es el mismo criterio que el factory de `@aai/arca`.
  if (estado.ambiente !== 'homologacion' && estado.ambiente !== 'produccion') {
    faltan.push({
      condicion: 'AMBIENTE_FISCAL',
      explicacion:
        `El ambiente es "${estado.ambiente}". Emitir solo tiene sentido contra homologación ` +
        'o producción: en mock no hay organismo del otro lado.',
    });
  }

  // El transporte sigue fuera del grafo de la aplicación por una regla del
  // dependency-cruiser. Mientras esté, no hay forma de llamar a ARCA aunque
  // todo lo demás esté en orden — y la puerta lo dice en vez de dejar que el
  // error aparezca como un import que no resuelve.
  faltan.push({
    condicion: 'TRANSPORTE_DISPONIBLE',
    explicacion:
      '`@aai/arca-emision` está aislado del grafo de la aplicación por la regla ' +
      '`la-emision-no-llega-a-la-aplicacion`. Sacarla es una decisión a tomar a sabiendas, ' +
      'después de que esta puerta esté completa.',
  });

  if (!estado.hayCredencialVigente) {
    faltan.push({
      condicion: 'CREDENCIAL_VIGENTE',
      explicacion:
        'No hay certificado de ARCA vigente para esta empresa y este ambiente. Ver ' +
        'docs/api/arca-onboarding.md.',
    });
  }

  if (!estado.wsfeAutorizado) {
    faltan.push({
      condicion: 'SERVICIO_AUTORIZADO',
      explicacion:
        'El servicio `wsfe` no figura autorizado para este CUIT. Es un trámite en WSASS, ' +
        'aparte del certificado.',
    });
  }

  if (!estado.hayPuntoDeVenta) {
    faltan.push({
      condicion: 'PUNTO_DE_VENTA',
      explicacion:
        'No hay punto de venta declarado y vigente. El número de comprobante lo pone el ' +
        'emisor, y sin punto de venta no hay numeración que reservar.',
    });
  }

  if (!estado.hayReconciliador) {
    faltan.push({
      condicion: 'RECONCILIADOR',
      explicacion:
        'No hay con qué resolver una emisión que quede en duda. Emitir sin eso significa que ' +
        'un timeout deja una venta bloqueada sin forma de averiguar si se facturó.',
    });
  }

  return faltan;
}

/** El atajo, para cuando solo importa el sí o el no. */
export function puedeEmitir(estado: EstadoParaEmitir): boolean {
  return faltaParaEmitir(estado).length === 0;
}

/**
 * El estado tal como está hoy, sin consultar la base.
 *
 * Sirve para el banner y para contestar «¿por qué no puedo emitir?» sin tener
 * una empresa en contexto. Las condiciones por empresa —credencial, servicio,
 * punto de venta— se asumen incumplidas: es el lado conservador, y de todas
 * formas las dos primeras ya alcanzan para que la puerta esté cerrada.
 */
export function faltaParaEmitirHoy(): FaltaParaEmitir[] {
  return faltaParaEmitir({
    ambiente: config.arca.environment,
    hayCredencialVigente: false,
    wsfeAutorizado: false,
    hayPuntoDeVenta: false,
    hayReconciliador: false,
  });
}
