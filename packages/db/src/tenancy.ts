/**
 * Segunda capa de aislamiento multiempresa (SECURITY.md §4).
 *
 * La primera es RLS en PostgreSQL; la tercera, el prefijo por empresa en el
 * object storage. Esta capa existe para que **no haya forma de emitir una
 * consulta sin empresa en contexto**: no se expone el pool ni un cliente crudo,
 * solo transacciones que ya hicieron `SET LOCAL ROLE aai_app` y fijaron
 * `app.company_id`.
 *
 * Que la aplicación conecte con un rol sin BYPASSRLS es lo que hace que un olvido
 * acá no sea una fuga: RLS sigue filtrando aunque el código se equivoque.
 */

import pg from 'pg';

export interface Tx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface ActorContext {
  /** Empresa en cuyo contexto se opera. */
  readonly companyId: string;
  /** Quién ejecuta: `user:<uuid>`, `system:<proceso>` o `ai:<agente>`. */
  readonly actorId: string;
}

let pool: pg.Pool | undefined;

export function initPool(connectionString: string, options: { max?: number } = {}): void {
  pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Un contexto de empresa mal cerrado no puede sobrevivir a la conexión.
    idleTimeoutMillis: 30_000,
  });
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

function requirePool(): pg.Pool {
  if (pool === undefined) {
    throw new Error('El pool no está inicializado: llamá a initPool() al arrancar.');
  }
  return pool;
}

function wrap(client: pg.PoolClient): Tx {
  return {
    query: (text, values) => client.query(text, values as unknown[]),
  };
}

/**
 * Ejecuta `fn` dentro de una transacción con la empresa fijada en el contexto.
 *
 * `SET LOCAL` y `set_config(..., true)` son locales a la transacción: al terminar,
 * el contexto desaparece con ella. No hay estado que limpiar ni que se filtre a
 * la siguiente operación que tome la misma conexión del pool.
 */
export async function withCompany<T>(
  context: ActorContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aai_app');
    await client.query('SELECT set_config($1, $2, true)', ['app.company_id', context.companyId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', context.actorId]);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Para las operaciones de identidad —login, alta de usuario, sesiones— que son
 * del estudio y no de una empresa.
 *
 * Sigue corriendo como `aai_app`: cualquier tabla con RLS devuelve cero filas
 * porque no hay `app.company_id`. Eso es exactamente lo que se quiere; si una
 * consulta acá necesita datos de empresa, es que está en el lugar equivocado.
 */
export async function withoutCompany<T>(
  actorId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE aai_app');
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId]);
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
