/**
 * De una referencia a un secreto, con la base en el medio.
 *
 * `@aai/secrets` define el puerto y los tres proveedores que no tocan nada — el
 * nulo, el del entorno y el de memoria—. Este archivo tiene el que consulta
 * `secret_refs` y decide, según el prefijo de la referencia, quién entrega el
 * material.
 *
 * Vive en `apps/api` y no en el paquete por lo mismo que `DbCredentialStore`:
 * toca la base, y un paquete de dominio no puede (lint `dominio-sin-io`).
 *
 * ## El aislamiento, y cuántas capas hay de verdad
 *
 * Un secreto de una empresa que otra pueda leer es la falla más cara de este
 * módulo. Son **tres** defensas, y cada una se puede ver actuar:
 *
 *   1. **La ruta.** `requireCompany` rechaza con 403 una empresa en la que el
 *      usuario no tiene rol, así que a este módulo nunca le llega un
 *      `companyId` ajeno. Es la que corta el caso realista.
 *   2. **El `WHERE` de la consulta**, que filtra por la empresa pedida.
 *   3. **RLS con `FORCE`** sobre `secret_refs`. La base no devuelve la fila por
 *      más que la consulta la pida, y es la que queda si las dos de arriba
 *      fallan. Un test la ejercita **aflojando la política a propósito**: una
 *      capa que nunca se vio actuar no está probada.
 *
 * Acá hubo una cuarta —comparar la empresa de la fila contra la pedida— y se
 * quitó: la consulta ya filtra por ese mismo valor, así que la comparación era
 * un valor contra sí mismo. **Nunca podía fallar, y por lo tanto nunca podía
 * proteger.** Lo demostró una mutación deliberada: sacarla no rompió ningún
 * test, ni siquiera con el RLS aflojado. Una defensa que no se puede ver actuar
 * no es una defensa, es un comentario con sintaxis.
 *
 * ## Lo que no cachea, y por qué
 *
 * El material. Se resuelve por llamada y se descarta, igual que hace
 * `DbCredentialStore` con la clave privada de ARCA: un caché lo dejaría en
 * memoria del proceso por tiempo indefinido, y el objetivo es lo contrario.
 */

import {
  ErrorDeSecreto,
  EnvSecretProvider,
  describir,
  type BackendDeSecreto,
  type ContextoDeGestion,
  type SecretAdmin,
  type SecretMaterial,
  type SecretMetadata,
  type SecretProvider,
  type SecretRef,
} from '@aai/secrets';
import { recordAudit, withCompany, withoutCompany, type Tx } from '@aai/db';

interface FilaDeReferencia {
  id: string;
  company_id: string | null;
  scope: string;
  name: string;
  version: number;
  reference: string;
  status: string;
  expires_at: Date | null;
  created_at: Date;
  created_by: string;
}

/**
 * El resolvedor de referencias.
 *
 * Implementa las dos caras —leer y administrar— porque el backend es el mismo,
 * pero **las rutas usan permisos distintos**: `secret:manage` para lo segundo, y
 * nada especial para lo primero, porque leer un secreto no lo hace un usuario:
 * lo hace un adaptador en medio de una operación que el usuario sí puede hacer.
 */
export class DbSecretProvider implements SecretProvider, SecretAdmin {
  readonly id: BackendDeSecreto = 'db';

  readonly #actorId: string;
  readonly #entorno: SecretProvider;

  constructor(actorId: string, entorno: SecretProvider = new EnvSecretProvider()) {
    this.#actorId = actorId;
    this.#entorno = entorno;
  }

  async get(ref: SecretRef): Promise<SecretMaterial> {
    const fila = await this.#leer(ref);
    if (fila === null) {
      throw new ErrorDeSecreto(
        'SECRET_NOT_FOUND',
        ref,
        'no hay ninguna referencia activa declarada',
      );
    }

    if (fila.expires_at !== null && fila.expires_at.getTime() <= Date.now()) {
      throw new ErrorDeSecreto(
        'SECRET_INVALID',
        ref,
        `la referencia venció el ${fila.expires_at.toISOString().slice(0, 10)}`,
      );
    }

    return this.#resolver(ref, fila);
  }

  async existe(ref: SecretRef): Promise<boolean> {
    // No trae el material: una pantalla que solo quiere saber si está
    // configurado no tiene por qué hacer que el secreto pase por memoria.
    return (await this.#leer(ref)) !== null;
  }

  /**
   * Del prefijo al backend.
   *
   * Es el mismo criterio que `desenvolver()` para las credenciales de ARCA: el
   * prefijo dice quién lo tiene, y eso permite agregar un backend sin migrar las
   * filas que ya están.
   */
  async #resolver(ref: SecretRef, fila: FilaDeReferencia): Promise<SecretMaterial> {
    const [prefijo, resto] = partir(fila.reference);
    const comun = {
      ref,
      version: fila.version,
      expiraEl: fila.expires_at,
    };

    if (prefijo === 'env') {
      // La referencia nombra la variable; el `EnvSecretProvider` la lee. No se
      // lee `process.env` acá para que el mismo camino sea testeable inyectando
      // un entorno falso.
      const material = await this.#entorno.get({
        companyId: null,
        scope: 'env',
        name: resto,
      });
      return { ...comun, valor: material.valor, backend: 'env' };
    }

    if (prefijo === 'kms') {
      throw new ErrorDeSecreto(
        'SECRET_PROVIDER_UNAVAILABLE',
        ref,
        'la referencia apunta a un gestor de secretos externo y no hay ninguno conectado. ' +
          'Es lo que falta para operar en producción — ver SECURITY.md §5.',
      );
    }

    if (prefijo === 'db') {
      // **No hay tabla de material genérica, y es deliberado.**
      //
      // Un secreto por empresa guardado con la llave del entorno no está
      // protegido contra la amenaza que importa: la KEK vive en el mismo lugar
      // que el ciphertext. `desenvolver()` en el store de ARCA ya llegó a esa
      // conclusión y se niega en producción.
      //
      // Crear una tabla de material genérica ahora agregaría un lugar más donde
      // guardar secretos con esa misma protección aparente, y una tabla que
      // nadie escribe todavía — el defecto que S-17 persigue. El material por
      // empresa que hoy existe vive en la tabla de su módulo
      // (`company_arca_credentials`), con su propio sobre y su propia negativa
      // en producción; unificarlo es una migración que necesita **primero** la
      // decisión de qué gestor de secretos se usa.
      throw new ErrorDeSecreto(
        'SECRET_PROVIDER_UNAVAILABLE',
        ref,
        'el material por empresa vive en la tabla de su módulo, no en un almacén genérico. ' +
          'Unificarlo exige antes elegir un gestor de secretos: guardarlo acá con la llave ' +
          'del entorno sería el mismo sobre aparente en un lugar más.',
      );
    }

    throw new ErrorDeSecreto(
      'SECRET_CONFIGURATION_ERROR',
      ref,
      `prefijo de referencia desconocido: "${prefijo}"`,
    );
  }

  async #leer(ref: SecretRef): Promise<FilaDeReferencia | null> {
    return enContexto(ref.companyId, this.#actorId,
      async (tx: Tx) => {
        // Sin versión pedida, la vigente. Con versión, esa exacta —incluso si
        // ya fue supersedida—: es lo que permite comprobar una credencial nueva
        // antes de apagar la anterior.
        const r = await tx.query<FilaDeReferencia>(
          `SELECT id, company_id, scope, name, version, reference, status,
                  expires_at, created_at, created_by
             FROM secret_refs
            WHERE company_id IS NOT DISTINCT FROM $1
              AND scope = $2 AND name = $3
              AND ($4::int IS NULL OR version = $4)
              AND status <> 'REVOCADO'
            ORDER BY version DESC
            LIMIT 1`,
          [ref.companyId, ref.scope, ref.name, ref.version ?? null],
        );
        return r.rows[0] ?? null;
      },
    );
  }

  // -------------------------------------------------------------------------
  // Gestión
  // -------------------------------------------------------------------------

  /**
   * Declara una versión nueva y la deja vigente.
   *
   * Rotar es esto y no un método aparte: sería el mismo acto con otro nombre. La
   * versión anterior queda `SUPERSEDIDO` —no revocada— y esa ventana en la que
   * las dos existen es lo que permite comprobar la nueva antes de apagar la
   * vieja.
   *
   * **`valor` es la referencia, no el material.** El nombre del parámetro viene
   * del puerto; acá lo que se guarda es `env:AI_API_KEY` o `kms:<arn>`. Guardar
   * material es otro camino, y está abajo.
   */
  async put(
    ref: SecretRef,
    referencia: string,
    contexto: ContextoDeGestion,
  ): Promise<SecretMetadata> {
    return enContexto(ref.companyId, contexto.actorId,
      async (tx: Tx) => {
        const anterior = await tx.query<{ version: number }>(
          `SELECT version FROM secret_refs
            WHERE company_id IS NOT DISTINCT FROM $1 AND scope = $2 AND name = $3
            ORDER BY version DESC LIMIT 1`,
          [ref.companyId, ref.scope, ref.name],
        );
        const version = (anterior.rows[0]?.version ?? 0) + 1;

        // La anterior deja de ser la vigente antes de que la nueva lo sea: el
        // índice único de la 0095 no admite dos activas, y hacerlo al revés
        // fallaría.
        await tx.query(
          `UPDATE secret_refs SET status = 'SUPERSEDIDO'
            WHERE company_id IS NOT DISTINCT FROM $1 AND scope = $2 AND name = $3
              AND status = 'ACTIVO'`,
          [ref.companyId, ref.scope, ref.name],
        );

        const fila = await tx.query<FilaDeReferencia>(
          `INSERT INTO secret_refs
             (company_id, scope, name, version, reference, created_by, motivo)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, company_id, scope, name, version, reference, status,
                     expires_at, created_at, created_by`,
          [ref.companyId, ref.scope, ref.name, version, referencia, contexto.actorId, contexto.motivo],
        );

        if (ref.companyId !== null) {
          await recordAudit(tx, ref.companyId, {
            actorType: 'USER',
            actorId: contexto.actorId,
            action: version === 1 ? 'DECLARAR_REFERENCIA_DE_SECRETO' : 'ROTAR_REFERENCIA_DE_SECRETO',
            objectType: 'secret_refs',
            objectId: fila.rows[0]!.id,
            // La identidad y el backend, **nunca el valor ni la referencia
            // completa**: un ARN en la bitácora dice de más sobre la
            // infraestructura, y no hace falta para auditar el acto.
            newValue: {
              secreto: describir(ref),
              version,
              backend: partir(referencia)[0],
            },
            motivo: contexto.motivo,
          });
        }

        return metadataDe(fila.rows[0]!);
      },
    );
  }

  async revocar(ref: SecretRef, contexto: ContextoDeGestion): Promise<void> {
    await enContexto(ref.companyId, contexto.actorId,
      async (tx: Tx) => {
        const r = await tx.query<{ id: string; version: number }>(
          `UPDATE secret_refs
              SET status = 'REVOCADO', revoked_at = now(), revoked_by = $4,
                  motivo_revocacion = $5
            WHERE company_id IS NOT DISTINCT FROM $1 AND scope = $2 AND name = $3
              AND status <> 'REVOCADO'
              AND ($6::int IS NULL OR version = $6)
            RETURNING id, version`,
          [
            ref.companyId,
            ref.scope,
            ref.name,
            contexto.actorId,
            contexto.motivo,
            ref.version ?? null,
          ],
        );

        if (r.rowCount === 0) {
          throw new ErrorDeSecreto('SECRET_NOT_FOUND', ref, 'no hay nada que revocar');
        }

        if (ref.companyId !== null) {
          for (const fila of r.rows) {
            await recordAudit(tx, ref.companyId, {
              actorType: 'USER',
              actorId: contexto.actorId,
              action: 'REVOCAR_REFERENCIA_DE_SECRETO',
              objectType: 'secret_refs',
              objectId: fila.id,
              newValue: { secreto: describir(ref), version: fila.version },
              motivo: contexto.motivo,
            });
          }
        }
      },
    );
  }

  async listar(companyId: string | null, scope?: string): Promise<readonly SecretMetadata[]> {
    return enContexto(companyId, this.#actorId,
      async (tx: Tx) => {
        const r = await tx.query<FilaDeReferencia & { backend: string }>(
          `SELECT id, company_id, scope, name, version, status, backend,
                  expires_at, created_at, created_by
             FROM secret_refs_public
            WHERE company_id IS NOT DISTINCT FROM $1
              AND ($2::text IS NULL OR scope = $2)
            ORDER BY scope, name, version DESC`,
          [companyId, scope ?? null],
        );
        // La vista no trae `reference` completa a propósito: acá se rearma con
        // el prefijo, que es lo único que una pantalla necesita saber.
        return r.rows.map((f) => metadataDe({ ...f, reference: `${f.backend}:…` }));
      },
    );
  }
}

function partir(referencia: string): [string, string] {
  const corte = referencia.indexOf(':');
  if (corte === -1) return [referencia, ''];
  return [referencia.slice(0, corte), referencia.slice(corte + 1)];
}

function metadataDe(fila: FilaDeReferencia): SecretMetadata {
  return {
    ref: {
      companyId: fila.company_id,
      scope: fila.scope,
      name: fila.name,
      version: fila.version,
    },
    version: fila.version,
    backend: partir(fila.reference)[0] as BackendDeSecreto,
    referencia: fila.reference,
    estado: fila.status as SecretMetadata['estado'],
    creadoEl: fila.created_at,
    creadoPor: fila.created_by,
    expiraEl: fila.expires_at,
  };
}

/**
 * La transacción, con o sin empresa en contexto.
 *
 * Un secreto del despliegue no tiene empresa, y forzarle una —la primera, o una
 * «del sistema» inventada— haría que su fila apareciera en el listado de esa
 * empresa. `withoutCompany` es el camino que ya usa el plano normativo para lo
 * mismo: actos que no ocurren adentro de ninguna empresa.
 */
async function enContexto<T>(
  companyId: string | null,
  actorId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return companyId === null
    ? withoutCompany(actorId, fn)
    : withCompany({ companyId, actorId }, fn);
}
