/**
 * Los proveedores que no necesitan una base ni una nube.
 *
 * Tres, y cada uno es un modo de operación con nombre — ninguno es un
 * marcador de posición:
 *
 *     NullSecretProvider      no hay secretos configurados. Falla con motivo.
 *     EnvSecretProvider       del entorno. Bootstrap y secretos del despliegue.
 *     InMemorySecretProvider  solo tests. Se niega en producción.
 *
 * El que lee la base vive en `apps/api`, porque toca la base.
 */

import {
  ErrorDeSecreto,
  describir,
  type BackendDeSecreto,
  type SecretMaterial,
  type SecretProvider,
  type SecretRef,
} from './contracts.js';

/**
 * Sin secretos.
 *
 * **Es un modo de operación**, igual que `AI_PROVIDER=none`: una organización
 * puede correr NEXO sin ninguna integración externa, y el ERP funciona entero.
 * Lo que no hace es fingir: una operación que necesita un secreto recibe
 * `SECRET_NOT_FOUND` con el motivo, no una cadena vacía que el proveedor de
 * turno interprete como una credencial inválida.
 */
export class NullSecretProvider implements SecretProvider {
  readonly id: BackendDeSecreto = 'env';

  async get(ref: SecretRef): Promise<SecretMaterial> {
    throw new ErrorDeSecreto(
      'SECRET_NOT_FOUND',
      ref,
      'no hay ningún gestor de secretos configurado. Es un modo de operación previsto: el ' +
        'ERP funciona entero, y lo que no está disponible es esta integración.',
    );
  }

  async existe(): Promise<boolean> {
    return false;
  }
}

/**
 * Del entorno.
 *
 * Es el backend de los secretos **del despliegue**: la URL de la base, la clave
 * del almacenamiento de objetos, el token del recolector de métricas. Esos
 * siempre vinieron de ahí y está bien que así sea — son de la instalación, no de
 * una empresa, y quien puede leer el entorno del proceso ya puede leer todo lo
 * demás.
 *
 * ## Lo que **no** hace, y es la mitad del punto
 *
 * **Se niega a resolver un secreto de una empresa.** Un secreto por empresa en
 * una variable de entorno obligaría a reiniciar el proceso para dar de alta un
 * cliente, y a tener las credenciales de todas las empresas en el mismo lugar:
 * un solo volcado del entorno las expone todas juntas. Ese es exactamente el
 * aislamiento que el multiempresa existe para dar.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly id: BackendDeSecreto = 'env';

  /** Se inyecta para poder probarlo sin tocar el entorno del proceso. */
  readonly #entorno: Record<string, string | undefined>;

  constructor(entorno: Record<string, string | undefined> = process.env) {
    this.#entorno = entorno;
  }

  /**
   * Cómo se llama la variable de un secreto.
   *
   *     despliegue/ai/api-key   →  AI_API_KEY      (scope + nombre)
   *     despliegue/env/OTRA_VAR →  OTRA_VAR        (el nombre, tal cual)
   *
   * Dos formas porque hay dos casos, y mezclarlos costó un test:
   *
   * La primera es la normal: el scope y el nombre en mayúsculas unidos por `_`.
   * Derivable en las dos direcciones a propósito, para que no exista un mapa
   * escrito a mano donde el nombre pueda desincronizarse.
   *
   * La segunda es cuando la referencia **nombra la variable directamente** —
   * `env:OTRA_VAR`—, que es lo que permite apuntar a una variable que no sigue
   * la convención sin tener que renombrarla. Ahí el scope ya dijo todo lo que
   * tenía que decir, y prefijarlo otra vez daría `ENV_OTRA_VAR`.
   */
  static variable(ref: SecretRef): string {
    const crudo = ref.scope === 'env' ? ref.name : `${ref.scope}_${ref.name}`;
    return crudo.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  }

  async get(ref: SecretRef): Promise<SecretMaterial> {
    this.#rechazarPorEmpresa(ref);

    const nombre = EnvSecretProvider.variable(ref);
    const valor = this.#entorno[nombre];
    if (valor === undefined || valor === '') {
      throw new ErrorDeSecreto(
        'SECRET_NOT_FOUND',
        ref,
        `la variable ${nombre} no está definida o está vacía`,
      );
    }

    return { valor, ref, version: 1, backend: 'env', expiraEl: null };
  }

  async existe(ref: SecretRef): Promise<boolean> {
    if (ref.companyId !== null) return false;
    const valor = this.#entorno[EnvSecretProvider.variable(ref)];
    return valor !== undefined && valor !== '';
  }

  #rechazarPorEmpresa(ref: SecretRef): void {
    if (ref.companyId === null) return;
    throw new ErrorDeSecreto(
      'SECRET_CONFIGURATION_ERROR',
      ref,
      'el entorno no guarda secretos por empresa: obligaría a reiniciar el proceso para dar ' +
        'de alta un cliente, y dejaría las credenciales de todas las empresas en el mismo ' +
        'lugar. Un secreto por empresa va a un gestor de secretos.',
    );
  }
}

/**
 * En memoria del proceso. **Solo tests.**
 *
 * Se niega a construirse en producción, y no como cortesía: un proveedor que
 * pierde todo al reiniciar y que cualquier parte del proceso puede leer es
 * exactamente lo que no se quiere en un servidor real. Que exista es para que
 * los tests no necesiten una base ni una nube.
 */
export class InMemorySecretProvider implements SecretProvider {
  readonly id: BackendDeSecreto = 'mem';

  readonly #valores = new Map<string, string>();

  constructor(opciones: { readonly esProduccion: boolean }) {
    if (opciones.esProduccion) {
      throw new Error(
        'InMemorySecretProvider no corre en producción: pierde todo al reiniciar y lo lee ' +
          'cualquier parte del proceso. Es para tests.',
      );
    }
  }

  poner(ref: SecretRef, valor: string): void {
    this.#valores.set(describir(sinVersion(ref)), valor);
  }

  async get(ref: SecretRef): Promise<SecretMaterial> {
    const valor = this.#valores.get(describir(sinVersion(ref)));
    if (valor === undefined) {
      throw new ErrorDeSecreto('SECRET_NOT_FOUND', ref, 'no está cargado en este proveedor');
    }
    return { valor, ref, version: 1, backend: 'mem', expiraEl: null };
  }

  async existe(ref: SecretRef): Promise<boolean> {
    return this.#valores.has(describir(sinVersion(ref)));
  }
}

/**
 * La misma identidad, sin la versión.
 *
 * Se escribe así y no con `{ ...ref, version: undefined }` porque
 * `exactOptionalPropertyTypes` distingue «la propiedad no está» de «está y vale
 * `undefined`», y acá son dos cosas distintas: la primera significa «la
 * vigente», que es lo que se quiere buscar.
 */
function sinVersion(ref: SecretRef): SecretRef {
  return { companyId: ref.companyId, scope: ref.scope, name: ref.name };
}
