/**
 * De dónde sale el proveedor de correo. Un solo lugar.
 *
 * Es el mismo archivo que `ai/proveedor.ts` y `secrets/fabrica.ts`, con el
 * mismo reparto de responsabilidades, y no por simetría estética: la lección
 * que dejó escrita `ai/proveedor.ts` es que **dos copias de una decisión se
 * desincronizan y nadie lo nota, porque las dos siguen contestando**. Antes de
 * este archivo la decisión vivía en `routes/auth.ts`, escrita como
 * `new SinProveedorDeCorreo()` en medio de una función. Con un solo proveedor
 * eso alcanzaba; con dos, el segundo lugar que necesitara mandar un correo
 * habría copiado la línea.
 *
 * ## Los cuatro estados, y por qué no son dos
 *
 *     DESHABILITADO  `none`. No hay proveedor, y **es un modo de operación**:
 *                    lo que se encola queda en `email_outbox` con
 *                    `SIN_PROVEEDOR` y lo entrega el operador a mano.
 *     PREPARADO      `resend` sin credencial o sin remitente. El transporte
 *                    está; la conexión no. **No es un error** y no rompe el
 *                    alta: se devuelve `SinProveedorDeCorreo` y el arranque
 *                    dice qué falta, con el nombre de la variable.
 *     CONFIGURADO    `resend` con las dos cosas. Puede mandar.
 *
 * Igual que con el modelo, ni siquiera `CONFIGURADO` dice «conectado»: que haya
 * credencial no prueba que sirva. Lo único que prueba una conexión es un envío
 * que volvió, y eso lo dice `email_outbox`, no una variable de entorno.
 *
 * Nótese que **no hay `SIMULADO`**. El proveedor de modelo tiene un `mock` que
 * se abstiene, y ahí tiene sentido porque una abstención es una respuesta
 * legítima. Un correo simulado no tiene equivalente: o el mensaje sale o no
 * sale, y un adaptador que dijera `ENVIADO` sin mandar nada es exactamente la
 * mentira que `SIN_PROVEEDOR` existe para no decir. Los tests inyectan su
 * propio `fetch`, que es más honesto y más preciso.
 *
 * Un valor que no es ninguno de los dos **no existe como estado**: el arranque
 * falla. Ver `verificarProveedorDeCorreo`.
 */

import { EnvSecretProvider, type SecretProvider, type SecretRef } from '@aai/secrets';
import { config } from '../config.js';
import { SinProveedorDeCorreo, type ProveedorDeCorreo } from './puerto.js';
import { ProveedorDeResend, type FetchLike } from './resend.js';

export type EstadoDelCorreo = 'DESHABILITADO' | 'PREPARADO' | 'CONFIGURADO';

/** Los dos valores que `EMAIL_PROVIDER` admite. */
export const PROVEEDORES_DE_CORREO = ['none', 'resend'] as const;

export interface ConfiguracionDeCorreo {
  readonly provider: string;
  /** La referencia al secreto, no el secreto: `env:EMAIL_API_KEY`, `kms:<arn>`. */
  readonly apiKeyRef: string | null;
  /** El remitente. Sin él, Resend rechaza todo con 422. */
  readonly from: string | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/**
 * Qué le falta a `resend` para poder mandar.
 *
 * Se devuelve la lista y no un booleano por lo mismo que en la IA: «preparado»
 * sin decir qué falta obliga a adivinar entre dos variables.
 */
export function faltantesDeResend(correo: ConfiguracionDeCorreo): string[] {
  const faltan: string[] = [];
  if (correo.apiKeyRef === null || correo.apiKeyRef === '') faltan.push('EMAIL_API_KEY');
  if (correo.from === null || correo.from === '') faltan.push('EMAIL_FROM');
  return faltan;
}

export function estadoDelCorreo(correo: ConfiguracionDeCorreo): EstadoDelCorreo {
  if (correo.provider === 'none') return 'DESHABILITADO';
  return faltantesDeResend(correo).length === 0 ? 'CONFIGURADO' : 'PREPARADO';
}

/**
 * Se corre antes de escuchar.
 *
 * Un `EMAIL_PROVIDER` desconocido —`resemd`, `sendgrid`, el nombre de un
 * proveedor que no está implementado— **arrancaría sin correo y sin avisar**.
 * Es la forma más cara de equivocarse en este módulo en particular: no falla
 * nada, el alta contesta 200, y los usuarios simplemente nunca confirman su
 * cuenta. Nadie va a ir a leer `email_outbox` para descubrir por qué.
 */
export function verificarProveedorDeCorreo(correo: ConfiguracionDeCorreo): string | null {
  if ((PROVEEDORES_DE_CORREO as readonly string[]).includes(correo.provider)) return null;
  return (
    `EMAIL_PROVIDER="${correo.provider}" no es un proveedor de correo conocido. ` +
    `Los valores admitidos son: ${PROVEEDORES_DE_CORREO.join(', ')}.`
  );
}

/**
 * De la referencia configurada a la identidad del secreto.
 *
 * Misma forma que `refDeLaClave` de la IA, y a propósito: el día que haya un
 * gestor de secretos, lo único que cambia es el prefijo (`kms:` en vez de
 * `env:`) y ninguna otra línea del sistema se entera.
 *
 * El proveedor de correo es **del despliegue, no de una empresa**: la
 * referencia no lleva `companyId`. Los cuatro tipos de mensaje que NEXO manda
 * —verificación, recuperación, aviso de cobranza y aviso— salen de la
 * instalación, no de la contabilidad de nadie.
 */
export function refDeLaClaveDeCorreo(referencia: string): SecretRef {
  const corte = referencia.indexOf(':');
  if (corte === -1) {
    // Sin prefijo se asume el entorno, igual que en la IA: es lo que alguien
    // escribe primero, y romperle la configuración por eso sería gratuito.
    return { companyId: null, scope: 'env', name: referencia };
  }
  const prefijo = referencia.slice(0, corte);
  const resto = referencia.slice(corte + 1);
  return prefijo === 'env'
    ? { companyId: null, scope: 'env', name: resto }
    : { companyId: null, scope: 'email', name: 'api-key' };
}

export interface OpcionesDeFabrica {
  readonly correo?: ConfiguracionDeCorreo;
  readonly secretos?: SecretProvider;
  /** Se inyecta en los tests. En producción se usa el `fetch` de Node. */
  readonly fetch?: FetchLike;
  readonly esperar?: (ms: number) => Promise<void>;
}

/**
 * El proveedor que corresponde a la configuración.
 *
 * `PREPARADO` devuelve `SinProveedorDeCorreo`, y eso **no es una degradación
 * silenciosa**: el arranque ya dijo qué variable falta, y la respuesta del alta
 * dice `SIN_PROVEEDOR` con su motivo. Nadie afirma que hay proveedor.
 *
 * Que devuelva el sin-proveedor en vez de tirar es deliberado y es lo que
 * protege el alta: una instalación a la que le falta `EMAIL_FROM` tiene que
 * poder seguir registrando usuarios y dejando los mensajes en la bandeja, que
 * es exactamente lo que hacía antes de que existiera este archivo.
 */
export function crearProveedorDeCorreo(opciones: OpcionesDeFabrica = {}): ProveedorDeCorreo {
  const correo = opciones.correo ?? config.correo;

  const error = verificarProveedorDeCorreo(correo);
  if (error !== null) throw new Error(error);

  switch (estadoDelCorreo(correo)) {
    case 'DESHABILITADO':
    case 'PREPARADO':
      return new SinProveedorDeCorreo();

    case 'CONFIGURADO': {
      const secretos = opciones.secretos ?? new EnvSecretProvider();
      return new ProveedorDeResend({
        // La credencial se resuelve **por llamada**. Este objeto puede vivir
        // tanto como el proceso; el secreto vive el tiempo del envío.
        apiKey: async () => (await secretos.get(refDeLaClaveDeCorreo(correo.apiKeyRef!))).valor,
        from: correo.from!,
        timeoutMs: correo.timeoutMs,
        maxRetries: correo.maxRetries,
        ...(opciones.fetch === undefined ? {} : { fetch: opciones.fetch }),
        ...(opciones.esperar === undefined ? {} : { esperar: opciones.esperar }),
      });
    }
  }
}

/**
 * En qué modo corre el correo, para el banner del arranque.
 *
 * Esta fila la agregó la auditoría B-2, cuando encontró que el banner —que
 * existe para que ningún modo degradado sea invisible— no nombraba ni el correo
 * ni el cobro, que eran los dos únicos apagados del todo. Antes era un texto
 * fijo porque no había nada que elegir; ahora sale de la configuración, que es
 * lo que hace que conectar un proveedor y decir que está conectado sean el
 * mismo cambio.
 */
export function modoDeCorreo(correo: ConfiguracionDeCorreo = config.correo): {
  readonly nombre: string;
  readonly valor: string;
  readonly real: boolean;
  readonly detalle: string;
} {
  switch (estadoDelCorreo(correo)) {
    case 'DESHABILITADO':
      return {
        nombre: 'correo',
        valor: 'none',
        real: false,
        detalle:
          'no hay proveedor: lo encolado queda SIN_PROVEEDOR en email_outbox y se lee con ' +
          '`npm run correo:bandeja`. Un alta autoservicio no se completa sola',
      };

    case 'PREPARADO':
      return {
        nombre: 'correo',
        valor: correo.provider,
        real: false,
        detalle: `preparado, no conectado: falta ${faltantesDeResend(correo).join(', ')}`,
      };

    case 'CONFIGURADO':
      return {
        nombre: 'correo',
        valor: correo.provider,
        // `real` significa que hay un proveedor externo del otro lado, no que
        // el último mensaje haya salido. Eso lo dice `email_outbox`.
        real: true,
        detalle: `remitente ${correo.from!}`,
      };
  }
}
