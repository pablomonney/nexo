/**
 * Secretos: el puerto, la identidad y los errores.
 *
 * Este paquete **no guarda nada, no cifra nada y no habla con nadie**. Define
 * qué es un secreto para NEXO y por dónde se pide. Las implementaciones viven
 * afuera: la que lee la base está en `apps/api`, porque toca la base y un
 * paquete de dominio no puede (lint `dominio-sin-io`).
 *
 * ## Lo que ya existía, y por qué esto no lo reemplaza
 *
 * `packages/arca` define `CredentialStore` desde el principio, y
 * `apps/api/src/arca/credential-store.ts` lo implementa con un sobre y una
 * **referencia de envoltura** —`local:` o `kms:`— que se niega a operar en
 * producción con la llave del entorno. Ese diseño es correcto y es el que se
 * generaliza acá: lo que le faltaba era ser general.
 *
 * Al medirlo había **dos implementaciones de sobre independientes**, con la
 * misma forma `v1.<iv>.<tag>.<ct>` y decisiones opuestas sobre lo mismo:
 *
 *     auth/crypto.ts          secreto TOTP, sin prefijo de referencia,
 *                             **exige** una KEK del entorno en producción.
 *     arca/credential-store   clave privada, con prefijo de referencia,
 *                             **se niega** a usar una KEK del entorno en producción.
 *
 * Las dos protegen material equivalente contra la misma amenaza —un volcado de
 * la base— y llegan a conclusiones contrarias. Este puerto es el lugar donde esa
 * decisión se toma una sola vez.
 *
 * ## Lo que este puerto NO hace
 *
 * No trae ningún proveedor de nube. Ni AWS, ni Azure, ni Google, ni Vault. El
 * dominio no puede nombrarlos y el lint de arquitectura lo impide. Conectar uno
 * es escribir un adaptador que implemente `SecretProvider`, del otro lado de
 * esta interfaz.
 */

/**
 * De dónde sale un secreto.
 *
 * Es un prefijo y no un enum de proveedores por lo mismo que
 * `key_encryption_ref`: permite agregar un backend sin migrar las filas que ya
 * están, y permite convivir con las que se escribieron con el anterior.
 */
export type BackendDeSecreto =
  /** Variable de entorno. Bootstrap, desarrollo y secretos globales del despliegue. */
  | 'env'
  /** La base, con sobre local. Solo desarrollo y homologación: ver `apps/api`. */
  | 'db'
  /** Un gestor de secretos externo. **Todavía no hay ninguno conectado.** */
  | 'kms'
  /** Memoria del proceso. Solo tests. */
  | 'mem';

/**
 * La identidad de un secreto. **Nunca su valor.**
 *
 * Cuatro campos, y cada uno contesta una pregunta distinta:
 *
 *     companyId  ¿de quién es?   `null` = del despliegue, no de una empresa.
 *     scope      ¿para qué integración?  `ai`, `arca`, `pagos`…
 *     name       ¿cuál de esa integración?  `api-key`, `clave-privada`…
 *     version    ¿cuál generación?  Sube al rotar; `null` = la vigente.
 *
 * `companyId` es el primero a propósito: es el que decide si dos secretos son el
 * mismo, y confundirlo es la falla que este diseño existe para hacer imposible.
 */
export interface SecretRef {
  readonly companyId: string | null;
  readonly scope: string;
  readonly name: string;
  readonly version?: number;
}

/**
 * El material, y lo que se sabe de él.
 *
 * `valor` está separado de la metadata a propósito: todo lo demás se puede
 * mostrar, guardar y loguear, y `valor` no. Tenerlos en el mismo objeto plano
 * invita a serializarlo entero «para debuggear».
 */
export interface SecretMaterial {
  readonly valor: string;
  readonly ref: SecretRef;
  readonly version: number;
  /** Qué backend lo entregó. Sirve para saber qué se está usando de verdad. */
  readonly backend: BackendDeSecreto;
  /** Si el backend lo informa. **No se inventa una vigencia.** */
  readonly expiraEl?: Date | null;
}

/**
 * Metadata de un secreto, sin el material.
 *
 * Es lo único que puede salir por la API, llegar a una pantalla o quedar en la
 * bitácora. Nótese que no hay ningún campo donde entre el valor: no es una
 * regla que alguien pueda olvidarse de aplicar, es que no existe el lugar.
 */
export interface SecretMetadata {
  readonly ref: SecretRef;
  readonly version: number;
  readonly backend: BackendDeSecreto;
  /** La referencia externa: un ARN, una ruta de Vault, un nombre de variable. */
  readonly referencia: string;
  readonly estado: 'ACTIVO' | 'REVOCADO' | 'SUPERSEDIDO';
  readonly creadoEl: Date;
  readonly creadoPor: string;
  readonly expiraEl?: Date | null;
}

/**
 * Leer un secreto para usarlo. **Solo lectura, y en tiempo de ejecución.**
 *
 * Está separado de la administración por lo mismo que `arca:use` está separado
 * de `arca_credential:manage`: quien puede **usar** una integración no
 * necesariamente puede **ver** su credencial, y casi nunca debería poder
 * cambiarla. Un puerto con `get` y `put` juntos obliga a darle las dos cosas a
 * quien solo necesita una.
 */
export interface SecretProvider {
  /** Con qué backend responde. Sirve para que el arranque diga la verdad. */
  readonly id: BackendDeSecreto;

  /**
   * El material, o una excepción tipada.
   *
   * **No devuelve `null`.** Un `null` obliga a cada llamador a inventar qué
   * hacer, y el error correcto —«no hay secreto» contra «no tengo permiso»
   * contra «el gestor está caído»— se pierde en el camino.
   */
  get(ref: SecretRef): Promise<SecretMaterial>;

  /**
   * ¿Está configurado? Sin traerlo.
   *
   * Es lo que contesta una pantalla de configuración: `configurado: true` es
   * información; el valor no. Un endpoint que tuviera que llamar a `get` para
   * saber si existe traería el material a memoria sin necesitarlo.
   */
  existe(ref: SecretRef): Promise<boolean>;
}

/**
 * Administrar referencias de secretos.
 *
 * Un proveedor puede implementar solo `SecretProvider` —el caso de un lector de
 * KMS al que la aplicación no le escribe— y eso es correcto: no todo backend
 * admite que NEXO le cree secretos.
 */
export interface SecretAdmin {
  /**
   * Declara una versión nueva y la deja vigente.
   *
   * Rotar es esto: no hay `rotate` aparte porque sería el mismo acto con otro
   * nombre. La versión anterior queda `SUPERSEDIDO` y se puede revocar después
   * —una ventana en la que las dos existen es lo que permite rotar sin cortar—.
   */
  put(ref: SecretRef, valor: string, contexto: ContextoDeGestion): Promise<SecretMetadata>;

  /** Apaga una versión. No borra: la bitácora tiene que poder citarla. */
  revocar(ref: SecretRef, contexto: ContextoDeGestion): Promise<void>;

  /** Metadata de lo que hay, sin material. */
  listar(companyId: string | null, scope?: string): Promise<readonly SecretMetadata[]>;
}

export interface ContextoDeGestion {
  readonly actorId: string;
  readonly motivo: string;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * Por qué no se pudo entregar un secreto.
 *
 * Son códigos y no prosa porque el llamador tiene que poder distinguirlos sin
 * leer un mensaje —«no está configurado» y «el gestor está caído» llevan a
 * acciones opuestas— y porque un mensaje de un backend externo puede traer
 * adentro cosas que no queremos propagar.
 */
export type CodigoDeErrorDeSecreto =
  | 'SECRET_NOT_FOUND'
  | 'SECRET_ACCESS_DENIED'
  | 'SECRET_PROVIDER_UNAVAILABLE'
  | 'SECRET_INVALID'
  | 'SECRET_CONFIGURATION_ERROR'
  | 'SECRET_OPERATION_TIMEOUT';

/**
 * El error, sin el secreto adentro.
 *
 * El constructor **no acepta el valor** y el mensaje se arma solo con la
 * identidad, que no es sensible. Es la misma decisión que toma el adaptador
 * HTTP del proveedor de modelo al no leer el cuerpo de una respuesta de error:
 * ese texto puede traer el pedido completo.
 */
export class ErrorDeSecreto extends Error {
  readonly codigo: CodigoDeErrorDeSecreto;
  readonly ref: SecretRef;

  constructor(codigo: CodigoDeErrorDeSecreto, ref: SecretRef, detalle: string) {
    super(`${codigo}: ${describir(ref)} — ${detalle}`);
    this.name = 'ErrorDeSecreto';
    this.codigo = codigo;
    this.ref = ref;
  }
}

/**
 * Cómo se nombra un secreto por escrito.
 *
 *     empresa/01a0…/ai/api-key@2
 *     despliegue/ai/api-key
 *
 * Se usa en mensajes, en la bitácora y como clave. No lleva el valor, y por eso
 * se puede escribir en cualquier lado.
 */
export function describir(ref: SecretRef): string {
  const quien = ref.companyId === null ? 'despliegue' : `empresa/${ref.companyId}`;
  const version = ref.version === undefined ? '' : `@${ref.version}`;
  return `${quien}/${ref.scope}/${ref.name}${version}`;
}
