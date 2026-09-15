/**
 * De dónde sale el proveedor de pagos. Un solo lugar.
 *
 * Mismo archivo que `correo/fabrica.ts`, `ai/proveedor.ts` y `secrets/fabrica.ts`,
 * con el mismo reparto de responsabilidades. La lección que dejó escrita
 * `ai/proveedor.ts` es que **dos copias de una decisión se desincronizan y nadie
 * lo nota, porque las dos siguen contestando**.
 *
 * ## Los tres estados
 *
 *     DESHABILITADO  `none`. No hay pasarela, y **es un modo de operación**: el
 *                    ciclo emite, lleva la cobranza y los cobros por
 *                    transferencia se registran a mano. Es lo que NEXO hace hoy.
 *     PREPARADO      `mercadopago` sin token o sin URL de retorno. El adaptador
 *                    está; la cuenta no. **No es un error** y no impide
 *                    facturar: se devuelve `SinPasarela` y el arranque dice qué
 *                    falta, con el nombre de la variable.
 *     CONFIGURADO    `mercadopago` con todo. Puede cobrar.
 *
 * Igual que en el correo, ni siquiera `CONFIGURADO` significa «conectado». Que
 * haya token no prueba que sirva, ni que la cuenta exista, ni que esté aprobada
 * para cobrar. Lo único que prueba una conexión es **un cobro que volvió**, y
 * eso lo dice `payment_intents`, no una variable de entorno. Este archivo no
 * afirma nunca lo contrario, y el documento de estado tampoco.
 *
 * Nótese que **no hay `SIMULADO`**. Un cobro simulado no tiene equivalente
 * honesto: o entró la plata o no entró, y un adaptador que dijera `PAGADO` sin
 * haber cobrado es exactamente la mentira que `SIN_PASARELA` existe para no
 * decir. Los tests inyectan su propio `fetch`, que es más preciso.
 *
 * Un valor de `PAYMENTS_PROVIDER` que no sea ninguno de los dos **no existe como
 * estado**: el arranque falla. Ver `verificarProveedorDePagos`.
 */

import { EnvSecretProvider, type SecretProvider, type SecretRef } from '@aai/secrets';
import { config } from '../config.js';
import { SinPasarela, type ProveedorDePagos } from './puerto.js';
import { ProveedorDeMercadoPago, type FetchLike } from './mercadopago.js';

export type EstadoDeLosPagos = 'DESHABILITADO' | 'PREPARADO' | 'CONFIGURADO';

/** Los dos valores que `PAYMENTS_PROVIDER` admite. */
export const PROVEEDORES_DE_PAGO = ['none', 'mercadopago'] as const;

/** Los dos valores que `PAYMENTS_ENV` admite. */
export const AMBIENTES_DE_PAGO = ['sandbox', 'production'] as const;

export interface ConfiguracionDePagos {
  readonly provider: string;
  readonly ambiente: string;
  /** La referencia al secreto, no el secreto. */
  readonly accessTokenRef: string | null;
  readonly webhookSecretRef: string | null;
  readonly backUrl: string | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
}

/**
 * Qué le falta a `mercadopago` para poder cobrar.
 *
 * Se devuelve la lista y no un booleano por lo mismo que en el correo y en la
 * IA: «preparado» sin decir qué falta obliga a adivinar entre tres variables.
 *
 * **`PAYMENTS_WEBHOOK_SECRET` no está en esta lista**, y es una decisión, no un
 * olvido. Sin él se puede cobrar —el token alcanza para crear la suscripción y
 * Mercado Pago cobra sola cada mes—; lo que no se puede es *enterarse*, porque
 * las notificaciones llegan sin poder verificarse y se rechazan. Es un estado
 * degradado real y visible, y lo nombra `modoDePagos`, pero no es lo mismo que
 * no poder arrancar el cobro.
 */
export function faltantesDeMercadoPago(pagos: ConfiguracionDePagos): string[] {
  const faltan: string[] = [];
  if (pagos.accessTokenRef === null || pagos.accessTokenRef === '') {
    faltan.push('PAYMENTS_ACCESS_TOKEN');
  }
  if (pagos.backUrl === null || pagos.backUrl === '') faltan.push('PAYMENTS_BACK_URL');
  return faltan;
}

export function estadoDeLosPagos(pagos: ConfiguracionDePagos): EstadoDeLosPagos {
  if (pagos.provider === 'none') return 'DESHABILITADO';
  return faltantesDeMercadoPago(pagos).length === 0 ? 'CONFIGURADO' : 'PREPARADO';
}

/**
 * Se corre antes de escuchar.
 *
 * Un `PAYMENTS_PROVIDER` desconocido —`mercadoPago`, `mercado_pago`, el nombre
 * de una pasarela que no está implementada— **arrancaría sin cobrar y sin
 * avisar**. No falla nada, las facturas se emiten, y la plata simplemente no
 * entra hasta que alguien mire la conciliación bancaria dentro de dos meses.
 */
export function verificarProveedorDePagos(pagos: ConfiguracionDePagos): string | null {
  if ((PROVEEDORES_DE_PAGO as readonly string[]).includes(pagos.provider)) return null;
  return (
    `PAYMENTS_PROVIDER="${pagos.provider}" no es una pasarela conocida. ` +
    `Los valores admitidos son: ${PROVEEDORES_DE_PAGO.join(', ')}.`
  );
}

/**
 * El prefijo que Mercado Pago le pone a cada clase de credencial.
 *
 * Son públicos y documentados: los tokens de prueba empiezan con `TEST-` y los
 * de producción con `APP_USR-`. No es un secreto y no lo revela: un prefijo de
 * seis caracteres no ayuda a nadie a adivinar los sesenta que siguen.
 */
const PREFIJO_DE_PRUEBA = 'TEST-';
const PREFIJO_DE_PRODUCCION = 'APP_USR-';

/**
 * ¿El token que hay coincide con el ambiente que se declaró?
 *
 * **Este es el control más importante del módulo**, y existe por una asimetría
 * incómoda con ARCA: allá, homologación y producción son dos hosts distintos, y
 * apuntar mal se nota porque el certificado no valida. Acá **la URL es la
 * misma**. Lo único que separa una prueba de un cobro real es el prefijo de una
 * cadena que vive en un archivo de entorno, y esa clase de barrera no aguanta un
 * copiar-pegar a las once de la noche.
 *
 * Así que se declara el ambiente aparte y se comprueba que las dos cosas digan
 * lo mismo. La comprobación no puede evitar todos los errores —nadie impide
 * declarar `production` con un token de producción por accidente— pero sí evita
 * el que de verdad ocurre: creer que se está probando y estar cobrando.
 *
 * Devuelve el problema o `null`. **No recibe el token; recibe su prefijo ya
 * separado**, para que quien llame no tenga excusa para pasar el secreto entero
 * a una función que devuelve texto destinado a un log.
 */
export function problemaDeAmbiente(ambiente: string, prefijo: string): string | null {
  if (!(AMBIENTES_DE_PAGO as readonly string[]).includes(ambiente)) {
    return (
      `PAYMENTS_ENV="${ambiente}" no es un ambiente conocido. ` +
      `Los valores admitidos son: ${AMBIENTES_DE_PAGO.join(', ')}.`
    );
  }

  const esDePrueba = prefijo.startsWith(PREFIJO_DE_PRUEBA);
  const esDeProduccion = prefijo.startsWith(PREFIJO_DE_PRODUCCION);

  // Un token que no empieza con ninguno de los dos no se rechaza. Mercado Pago
  // puede cambiar sus prefijos, y romperle el arranque a una instalación que
  // funciona por un cambio cosmético del proveedor sería peor que el problema
  // que este control resuelve. Lo que sí se hace es no afirmar nada: quien
  // llama informa «no se pudo comprobar», que es la verdad.
  if (!esDePrueba && !esDeProduccion) return null;

  if (ambiente === 'sandbox' && esDeProduccion) {
    return (
      'PAYMENTS_ENV="sandbox" pero el access token es de producción. ' +
      'Con esta combinación cada cobro de prueba mueve plata real: ' +
      'Mercado Pago usa la misma URL para los dos ambientes y solo los distingue por la ' +
      'credencial. Corregí PAYMENTS_ENV o cambiá el token.'
    );
  }

  if (ambiente === 'production' && esDePrueba) {
    return (
      'PAYMENTS_ENV="production" pero el access token es de prueba. ' +
      'Las suscripciones se van a crear en la cuenta de prueba y no va a entrar ' +
      'ningún cobro, sin que nada falle.'
    );
  }

  return null;
}

/** El prefijo de un token, para pasárselo a `problemaDeAmbiente` sin el resto. */
export function prefijoDeToken(token: string): string {
  return token.slice(0, PREFIJO_DE_PRODUCCION.length);
}

/**
 * Se corre antes de escuchar, después de `verificarProveedorDePagos`.
 *
 * Resuelve el token **una vez, al arrancar**, para comprobar su prefijo contra
 * el ambiente declarado. Es la única vez que el arranque toca esta credencial, y
 * lo que sale de acá es un texto para un log: por eso `problemaDeAmbiente` no
 * recibe el token sino su prefijo, y por eso el error de resolución tampoco lo
 * incluye.
 *
 * Devuelve el problema o `null`. **No falla si el gestor no puede resolverlo**:
 * eso no es un error de ambiente sino de configuración de secretos, ya se ve en
 * la primera llamada, e impedir el arranque por no poder *comprobar* dejaría
 * caído todo el ERP por una credencial de una integración opcional.
 */
export async function verificarAmbienteDePagos(
  pagos: ConfiguracionDePagos = config.pagos,
  secretos?: SecretProvider,
): Promise<string | null> {
  if (estadoDeLosPagos(pagos) !== 'CONFIGURADO') {
    // Sin pasarela configurada no hay token que comprobar, pero el ambiente
    // declarado igual tiene que ser uno de los dos: un `PAYMENTS_ENV=prod`
    // —así, abreviado— dejaría de coincidir con `ambiente_pago` en la base y
    // ninguna suscripción se podría consultar.
    return problemaDeAmbiente(pagos.ambiente, '');
  }

  const proveedor = secretos ?? new EnvSecretProvider();
  let token: string;
  try {
    token = (await proveedor.get(refDelTokenDePagos(pagos.accessTokenRef!, 'access-token'))).valor;
  } catch {
    return null;
  }

  return problemaDeAmbiente(pagos.ambiente, prefijoDeToken(token));
}

/**
 * De la referencia configurada a la identidad del secreto.
 *
 * Misma forma que `refDeLaClaveDeCorreo`, y a propósito: el día que haya un
 * gestor de secretos, lo único que cambia es el prefijo (`kms:` en vez de `env:`)
 * y ninguna otra línea del sistema se entera.
 *
 * La pasarela es **del despliegue, no de una empresa**: la referencia no lleva
 * `companyId`. NEXO cobra sus propias suscripciones con su propia cuenta; las
 * empresas clientes no cobran a través de NEXO. El día que eso cambie, este es
 * el único lugar que hay que tocar — y va a ser evidente, porque `SecretRef` ya
 * tiene el campo esperando.
 */
export function refDelTokenDePagos(referencia: string, nombre: string): SecretRef {
  const corte = referencia.indexOf(':');
  if (corte === -1) {
    // Sin prefijo se asume el entorno, igual que en la IA y en el correo: es lo
    // que alguien escribe primero, y romperle la configuración por eso sería
    // gratuito.
    return { companyId: null, scope: 'env', name: referencia };
  }
  const prefijo = referencia.slice(0, corte);
  const resto = referencia.slice(corte + 1);
  return prefijo === 'env'
    ? { companyId: null, scope: 'env', name: resto }
    : { companyId: null, scope: 'pagos', name: nombre };
}

export interface OpcionesDeFabricaDePagos {
  readonly pagos?: ConfiguracionDePagos;
  readonly secretos?: SecretProvider;
  /** Se inyecta en los tests. En producción se usa el `fetch` de Node. */
  readonly fetch?: FetchLike;
  readonly esperar?: (ms: number) => Promise<void>;
}

/**
 * La pasarela que corresponde a la configuración.
 *
 * `PREPARADO` devuelve `SinPasarela`, y eso **no es una degradación
 * silenciosa**: el arranque ya dijo qué variable falta y `intentarCobro`
 * devuelve `SIN_PASARELA` con su motivo. Nadie afirma que hay pasarela.
 *
 * Que devuelva el sin-pasarela en vez de tirar es lo que protege la
 * facturación: una instalación a la que le falta `PAYMENTS_BACK_URL` tiene que
 * poder seguir emitiendo documentos y llevando la cobranza, que es exactamente
 * lo que hacía antes de que este archivo existiera.
 */
export function crearProveedorDePagos(
  opciones: OpcionesDeFabricaDePagos = {},
): ProveedorDePagos {
  const pagos = opciones.pagos ?? config.pagos;

  const error = verificarProveedorDePagos(pagos);
  if (error !== null) throw new Error(error);

  switch (estadoDeLosPagos(pagos)) {
    case 'DESHABILITADO':
    case 'PREPARADO':
      return new SinPasarela();

    case 'CONFIGURADO': {
      const secretos = opciones.secretos ?? new EnvSecretProvider();
      return new ProveedorDeMercadoPago({
        // Las credenciales se resuelven **por llamada**. Este objeto puede vivir
        // tanto como el proceso; el secreto vive el tiempo de la llamada.
        accessToken: async () =>
          (await secretos.get(refDelTokenDePagos(pagos.accessTokenRef!, 'access-token'))).valor,

        // El de webhook puede no existir, y su ausencia es un estado legítimo
        // que se propaga como `null` hasta `verificarFirma`. Que un secreto
        // ausente devuelva `null` en vez de tirar es lo que permite distinguir
        // «no configurado» de «firma inválida» en la ruta.
        webhookSecret: async () => {
          if (pagos.webhookSecretRef === null || pagos.webhookSecretRef === '') return null;
          const ref = refDelTokenDePagos(pagos.webhookSecretRef, 'webhook-secret');
          try {
            return (await secretos.get(ref)).valor;
          } catch {
            // Configurado pero no resoluble. Se trata como ausente **a
            // propósito**: la alternativa sería tirar dentro del manejador del
            // webhook, y un 500 le dice a Mercado Pago «reintentá», que es lo
            // último que conviene cuando el problema es local.
            return null;
          }
        },

        timeoutMs: pagos.timeoutMs,
        maxRetries: pagos.maxRetries,
        ...(opciones.fetch === undefined ? {} : { fetch: opciones.fetch }),
        ...(opciones.esperar === undefined ? {} : { esperar: opciones.esperar }),
      });
    }
  }
}

/**
 * En qué modo corre el cobro, para el banner del arranque.
 *
 * Esta fila la pidió la auditoría B-2 junto con la del correo: el banner existe
 * para que ningún modo degradado sea invisible, y el cobro era uno de los dos
 * apagados del todo.
 */
export function modoDePagos(pagos: ConfiguracionDePagos = config.pagos): {
  readonly nombre: string;
  readonly valor: string;
  readonly real: boolean;
  readonly detalle: string;
} {
  switch (estadoDeLosPagos(pagos)) {
    case 'DESHABILITADO':
      return {
        nombre: 'cobro',
        valor: 'none',
        real: false,
        detalle:
          'no hay pasarela: el ciclo emite y lleva la cobranza igual, y los cobros por ' +
          'transferencia se registran a mano',
      };

    case 'PREPARADO':
      return {
        nombre: 'cobro',
        valor: pagos.provider,
        real: false,
        detalle: `preparado, no conectado: falta ${faltantesDeMercadoPago(pagos).join(', ')}`,
      };

    case 'CONFIGURADO': {
      const sinFirma = pagos.webhookSecretRef === null || pagos.webhookSecretRef === '';
      return {
        nombre: 'cobro',
        valor: pagos.provider,
        // `real` significa que hay una pasarela del otro lado, no que el último
        // cobro haya entrado. Eso lo dice `payment_intents`.
        real: true,
        detalle:
          `ambiente ${pagos.ambiente}` +
          (sinFirma
            ? '. Sin PAYMENTS_WEBHOOK_SECRET: las notificaciones no se pueden verificar y se ' +
              'rechazan, así que los cobros no se van a registrar solos'
            : ''),
      };
    }
  }
}
