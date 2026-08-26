/**
 * Relevamiento de habilitaciones: qué servicios de ARCA tiene realmente este CUIT.
 *
 * El roadmap advierte que *"el alcance real depende de qué servicios tenga
 * habilitado cada CUIT. Se diseña para degradar sin romper."* Este archivo es esa
 * frase hecha código, y todo él gira alrededor de una distinción:
 *
 *     NO ESTÁ DELEGADO  ≠  NO SE PUDO AVERIGUAR
 *
 * Un servicio que el contribuyente no delegó al certificado es un hecho estable:
 * hasta que alguien vaya al portal y lo delegue, no va a funcionar. Un servicio
 * que no respondió porque ARCA estaba caído es un hecho de hace treinta segundos.
 *
 * Tratarlos igual produce el peor de los dos mundos: **una caída de veinte
 * minutos del organismo deja el sistema creyendo, para siempre, que el estudio no
 * tiene habilitado el padrón.** Nadie vuelve a intentarlo porque la tabla dice que
 * no está habilitado, y el dato queda congelado. Por eso `NO_VERIFICABLE` nunca
 * se escribe como `enabled = false`: no se escribe.
 *
 * La segunda decisión: **una habilitación tiene fecha de vencimiento.** Un
 * relevamiento de hace seis meses no es evidencia sobre hoy — las delegaciones se
 * revocan, los certificados vencen. Pasado el plazo, la respuesta no es "no
 * habilitado" sino `VENCIDO`, que es otra cosa: hay que volver a preguntar.
 */

import type { ArcaEnvironment, ServiceName } from './environment.js';
import { SERVICE_NAMES } from './environment.js';

export type EstadoHabilitacion =
  /** El servicio respondió para este CUIT. */
  | 'HABILITADO'
  /** WSAA rechazó el servicio: el contribuyente no lo delegó a este certificado. */
  | 'NO_DELEGADO'
  /** No se pudo averiguar. **No** es lo mismo que no estar habilitado. */
  | 'NO_VERIFICABLE'
  /** No hay certificado cargado para este CUIT y ambiente. */
  | 'SIN_CREDENCIAL'
  /** Se relevó, pero hace demasiado. Hay que volver a preguntar. */
  | 'VENCIDO'
  /** Nunca se relevó. */
  | 'NO_RELEVADO';

export interface Habilitacion {
  readonly service: ServiceName;
  readonly estado: EstadoHabilitacion;
  /** Cuándo se comprobó. `null` cuando nunca se pudo. */
  readonly verificadoEl: string | null;
  readonly detalle: string;
}

/**
 * Cuánto vale un relevamiento.
 *
 * Treinta días es un compromiso: las delegaciones no cambian todos los días, y
 * volver a pedir un TA por cada servicio en cada arranque es exactamente lo que
 * hace que el organismo bloquee al cliente.
 */
export const VIGENCIA_RELEVAMIENTO_DIAS = 30;

/** El resultado crudo de intentar autenticarse contra un servicio. */
export interface IntentoDeLogin {
  readonly service: ServiceName;
  readonly ok: boolean;
  /** Código o mensaje que devolvió WSAA, si respondió. */
  readonly respuesta: string | null;
  /** `true` si el fallo fue de red o de disponibilidad, no de autorización. */
  readonly fallaDeTransporte: boolean;
  readonly sinCredencial: boolean;
}

/**
 * Clasifica un intento de login en un estado de habilitación.
 *
 * Es una función pura sobre el resultado del intento, separada del que hace la
 * llamada, para poder probar exhaustivamente la parte que decide — que es donde
 * está el riesgo. La llamada de red se prueba contra el mock.
 *
 * El caso que importa: `fallaDeTransporte` gana sobre cualquier otra lectura.
 * Un timeout no dice nada sobre las delegaciones del CUIT.
 */
export function clasificarIntento(intento: IntentoDeLogin, ahora: string): Habilitacion {
  if (intento.sinCredencial) {
    return {
      service: intento.service,
      estado: 'SIN_CREDENCIAL',
      verificadoEl: null,
      detalle:
        'No hay certificado cargado para este CUIT y ambiente. No se preguntó nada al organismo.',
    };
  }

  if (intento.fallaDeTransporte) {
    return {
      service: intento.service,
      estado: 'NO_VERIFICABLE',
      verificadoEl: null,
      detalle: `No se pudo consultar (${intento.respuesta ?? 'sin respuesta'}). NO se registra como no habilitado: una caída del organismo no dice nada sobre las delegaciones del CUIT.`,
    };
  }

  if (intento.ok) {
    return {
      service: intento.service,
      estado: 'HABILITADO',
      verificadoEl: ahora,
      detalle: 'WSAA emitió ticket de acceso para este servicio.',
    };
  }

  return {
    service: intento.service,
    estado: 'NO_DELEGADO',
    verificadoEl: ahora,
    detalle: `WSAA rechazó el servicio (${intento.respuesta ?? 'sin detalle'}). El contribuyente tiene que delegarlo al certificado desde el portal de ARCA.`,
  };
}

export interface HabilitacionGuardada {
  readonly service: ServiceName;
  readonly enabled: boolean;
  readonly verifiedAt: string | null;
  readonly notes: string | null;
}

/**
 * Lee una habilitación guardada y decide si todavía sirve.
 *
 * Tres respuestas, no dos. La tercera —`VENCIDO`— es la que evita el error de
 * seguir usando un relevamiento viejo como si fuera actual, y también el de
 * tratarlo como una negativa.
 */
export function leerHabilitacion(
  guardada: HabilitacionGuardada | undefined,
  ahora: Date,
  vigenciaDias = VIGENCIA_RELEVAMIENTO_DIAS,
): Habilitacion {
  if (guardada === undefined) {
    return {
      service: SERVICE_NAMES.wscdc,
      estado: 'NO_RELEVADO',
      verificadoEl: null,
      detalle: 'Nunca se relevó este servicio para esta empresa.',
    };
  }

  if (guardada.verifiedAt === null) {
    return {
      service: guardada.service,
      estado: 'NO_RELEVADO',
      verificadoEl: null,
      detalle: 'Hay una fila cargada pero sin fecha de verificación: nadie confirmó que responda.',
    };
  }

  const dias = diasEntre(new Date(guardada.verifiedAt), ahora);
  if (dias > vigenciaDias) {
    return {
      service: guardada.service,
      estado: 'VENCIDO',
      verificadoEl: guardada.verifiedAt,
      detalle: `El relevamiento tiene ${String(dias)} días y vale ${String(vigenciaDias)}. Las delegaciones se revocan y los certificados vencen: hay que volver a preguntar. VENCIDO no es NO_DELEGADO.`,
    };
  }

  return {
    service: guardada.service,
    estado: guardada.enabled ? 'HABILITADO' : 'NO_DELEGADO',
    verificadoEl: guardada.verifiedAt,
    detalle: guardada.notes ?? '',
  };
}

/**
 * Si el estado permite intentar la llamada.
 *
 * `HABILITADO` obviamente sí. `VENCIDO`, `NO_RELEVADO` y `NO_VERIFICABLE`
 * **también**: en los tres el sistema no sabe, y no saber no es motivo para no
 * intentar. Lo que produce el intento —éxito o un rechazo con motivo— es
 * justamente el dato que falta.
 *
 * Solo `NO_DELEGADO` y `SIN_CREDENCIAL` frenan, porque en esos dos el sistema sí
 * sabe, y sabe que va a fallar. Insistir contra un servicio no delegado es cómo
 * un CUIT termina bloqueado por el organismo.
 */
export function permiteIntentar(estado: EstadoHabilitacion): boolean {
  return estado !== 'NO_DELEGADO' && estado !== 'SIN_CREDENCIAL';
}

/**
 * Si el estado se puede persistir como una afirmación sobre la delegación.
 *
 * Es el candado del archivo: `NO_VERIFICABLE` devuelve `false`, así que no hay
 * camino por el que una caída del organismo se escriba como una negativa.
 */
export function esPersistible(estado: EstadoHabilitacion): boolean {
  return estado === 'HABILITADO' || estado === 'NO_DELEGADO';
}

export interface ResumenDeRelevamiento {
  readonly environment: ArcaEnvironment;
  readonly habilitaciones: readonly Habilitacion[];
  readonly habilitados: number;
  readonly noDelegados: number;
  readonly noVerificables: number;
  /**
   * Qué funciona del producto con lo que hay.
   *
   * Es lo que el usuario quiere saber, y no se deduce de una lista de servicios:
   * hay que decir qué se puede hacer y qué no.
   */
  readonly consecuencias: readonly string[];
}

/**
 * Qué deja de funcionar cuando falta cada servicio.
 *
 * Está acá y no en la UI a propósito: es conocimiento del dominio —qué parte del
 * producto depende de qué servicio— y una pantalla que lo reconstruya con un
 * `switch` se desactualiza en cuanto se agrega un servicio.
 */
const CONSECUENCIAS: Record<string, string> = {
  [SERVICE_NAMES.wscdc]:
    'Sin WSCDC no hay constatación de comprobantes: la validación fiscal del §11 queda en NO_CONSULTADO y todo cae en revisión individual.',
  [SERVICE_NAMES.padronA13]:
    'Sin padrón A13 no se puede verificar la condición del emisor frente al IVA ni si está en la base de apócrifos. Los subdiarios se arman igual, con el hallazgo declarado.',
  [SERVICE_NAMES.padronA100]:
    'Sin padrón A100 los catálogos de parámetros no se sincronizan y quedan en la semilla transcripta del manual.',
  [SERVICE_NAMES.wsfev1]:
    'Sin wsfe no se sincroniza la tabla de tipos de comprobante por fecha. Un código fuera del catálogo bloquea el subdiario en vez de suponerse.',
};

export function resumirRelevamiento(
  environment: ArcaEnvironment,
  habilitaciones: readonly Habilitacion[],
): ResumenDeRelevamiento {
  const consecuencias = habilitaciones
    .filter((habilitacion) => habilitacion.estado !== 'HABILITADO')
    .map((habilitacion) => CONSECUENCIAS[habilitacion.service])
    .filter((texto): texto is string => texto !== undefined);

  return {
    environment,
    habilitaciones,
    habilitados: contar(habilitaciones, 'HABILITADO'),
    noDelegados: contar(habilitaciones, 'NO_DELEGADO'),
    noVerificables: contar(habilitaciones, 'NO_VERIFICABLE'),
    consecuencias,
  };
}

function contar(habilitaciones: readonly Habilitacion[], estado: EstadoHabilitacion): number {
  return habilitaciones.filter((habilitacion) => habilitacion.estado === estado).length;
}

function diasEntre(desde: Date, hasta: Date): number {
  const MS_POR_DIA = 86_400_000;
  return Math.floor((hasta.getTime() - desde.getTime()) / MS_POR_DIA);
}

/** Todos los servicios que el producto usa, para relevarlos de una. */
export const SERVICIOS_DEL_PRODUCTO: readonly ServiceName[] = [
  SERVICE_NAMES.wscdc,
  SERVICE_NAMES.padronA13,
  SERVICE_NAMES.padronA100,
  SERVICE_NAMES.wsfev1,
];
