/**
 * De dónde salen los secretos. Un solo lugar, igual que con el proveedor de
 * modelo.
 *
 * La lección de la fase anterior fue que dos copias de la misma decisión se
 * desincronizan y nadie lo nota, porque las dos siguen contestando. Acá se
 * evita desde el principio: quien necesita un secreto pide el proveedor a esta
 * función y no construye ninguno.
 *
 * ## Los tres modos, y ninguno es un placeholder
 *
 *     none  `NullSecretProvider`. **No hay gestor de secretos.** Es un modo de
 *           operación: el ERP funciona entero y lo que no está disponible son
 *           las integraciones que necesitan una credencial. Cada una lo dice.
 *     env   `EnvSecretProvider` sobre `DbSecretProvider`. Los del despliegue
 *           salen del entorno; los de una empresa, de su referencia declarada.
 *           Es el modo normal hoy.
 *     kms   **No existe todavía.** Un valor que lo pida hace fallar el arranque
 *           en vez de degradar a `env` en silencio: un sistema que dice tener
 *           un gestor de secretos y no lo tiene es peor que uno que dice que no.
 *
 * Es exactamente la misma semántica estricta que `AI_PROVIDER`, y por el mismo
 * motivo: el error caro no es el que falla, es el que no falla.
 */

import {
  EnvSecretProvider,
  NullSecretProvider,
  type SecretProvider,
} from '@aai/secrets';
import { config } from '../config.js';
import { DbSecretProvider } from './proveedor.js';

export const GESTORES_CONOCIDOS = ['none', 'env', 'kms'] as const;

/**
 * Se corre antes de escuchar. Un valor desconocido **no cae a `none`**: el
 * sistema arrancaría sin secretos y las integraciones fallarían una por una con
 * `SECRET_NOT_FOUND`, que se lee como «falta configurar esa integración» y no
 * como «el gestor está mal escrito en el entorno».
 */
export function verificarGestor(nombre: string): string | null {
  if ((GESTORES_CONOCIDOS as readonly string[]).includes(nombre)) return null;
  return (
    `SECRETS_PROVIDER="${nombre}" no es un gestor de secretos conocido. ` +
    `Los valores admitidos son: ${GESTORES_CONOCIDOS.join(', ')}.`
  );
}

/**
 * El proveedor que corresponde a la configuración.
 *
 * `actorId` viaja porque las lecturas van por `withCompany`, que exige saber
 * quién pregunta: es lo que hace que una consulta de secretos quede sujeta al
 * mismo aislamiento que cualquier otra.
 */
export function crearProveedorDeSecretos(
  actorId: string,
  nombre: string = config.secrets.provider,
): SecretProvider {
  const error = verificarGestor(nombre);
  if (error !== null) throw new Error(error);

  if (nombre === 'none') return new NullSecretProvider();

  if (nombre === 'kms') {
    // No se llega acá con el arranque en orden: `verificarGestor` lo admite
    // como nombre conocido —para poder nombrarlo en la configuración— y el
    // preflight lo rechaza por no estar implementado. Se contempla igual, por
    // lo mismo que el trigger de la 0091 contempla lo que la clave foránea ya
    // impide: una rama que se da por imposible es una rama que falla en
    // silencio el día que deja de serlo.
    throw new Error(
      'SECRETS_PROVIDER=kms: no hay ningún gestor de secretos externo conectado. Conectarlo ' +
        'es lo que falta para operar en producción — ver SECURITY.md §5.',
    );
  }

  return new DbSecretProvider(actorId, new EnvSecretProvider());
}

/**
 * En qué modo corre la gestión de secretos, para el banner del arranque.
 *
 * `real` significa **hay un gestor externo**, y hoy es siempre `false`. Que los
 * secretos del despliegue salgan del entorno funciona y es legítimo; lo que no
 * es, es llamarlo gestión de secretos.
 */
export function modoDeSecretos(nombre: string = config.secrets.provider): {
  readonly nombre: string;
  readonly valor: string;
  readonly real: boolean;
  readonly detalle: string;
} {
  if (nombre === 'none') {
    return {
      nombre: 'Secretos',
      valor: 'none',
      real: false,
      detalle: 'sin gestor: las integraciones que necesitan credencial no están disponibles',
    };
  }

  return {
    nombre: 'Secretos',
    valor: nombre,
    real: false,
    detalle:
      'del entorno y de referencias declaradas. No hay gestor externo: un secreto por ' +
      'empresa no se puede resolver todavía, y el material local no se abre en producción',
  };
}
