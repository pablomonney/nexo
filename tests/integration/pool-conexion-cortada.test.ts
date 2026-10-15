/**
 * Una conexión ociosa cortada por PostgreSQL no tira el proceso.
 *
 * El pool de `@aai/db` no tenía manejador de `'error'`. Cuando PostgreSQL corta una conexión que está ociosa en el
 * pool (se reinicia la base, alguien hace `pg_terminate_backend`, se corta la red), `pg` emite `'error'` en el pool; sin
 * manejador, Node lo trata como excepción no capturada y **mata el proceso**, con las peticiones sanas que tuviera en
 * ese momento. `restart: unless-stopped` lo levantaba de nuevo, pero un reinicio de la base no tiene por qué tirar la API.
 *
 * Se corta **sólo la conexión de este pool** (se le pregunta su `pg_backend_pid()`): matar las del rol entero rompería las
 * otras suites que corren en paralelo contra la misma base.
 */

import { closePool, initPool, withoutCompany } from '@aai/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const espera = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

suite('Pool: conexión ociosa cortada', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = await connect();
  });
  afterAll(async () => {
    await admin.end();
  });
  afterEach(async () => {
    await closePool();
    vi.restoreAllMocks();
  });

  const pidDelPool = async (): Promise<number> => {
    const r = await withoutCompany('test:pool', (tx) => tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
    return r.rows[0]!.pid;
  };

  it('cortar la conexión ociosa no mata el proceso, queda registrado y el pool se recupera', async () => {
    const registro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initPool(process.env['DATABASE_URL']!, { max: 1 });

    const pid = await pidDelPool(); // la conexión vuelve al pool, ociosa
    const cortada = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid]);
    expect(cortada.rows[0]!.ok).toBe(true);
    await espera(400); // `pg` emite 'error' en el pool cuando se entera

    // Sin manejador, el 'error' sin capturar habría roto esta suite (y en producción, el proceso).
    const linea = registro.mock.calls.map((c) => String(c[0])).find((l) => l.includes('conexion ociosa del pool cortada'));
    expect(linea, 'el corte de la conexión ociosa no quedó registrado').toBeDefined();
    const dato = JSON.parse(linea!) as { level: string; code: string | null; detalle: string };
    expect(dato.level).toBe('error');
    expect(JSON.stringify(dato)).not.toMatch(/postgres(ql)?:\/\//u); // nunca la cadena de conexión

    // El pool se recupera: el próximo pedido abre otra conexión y anda.
    const otro = await pidDelPool();
    expect(otro).not.toBe(pid);
  });

  it('un error de una conexión EN USO sigue llegando como rechazo de su consulta (no se traga)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initPool(process.env['DATABASE_URL']!, { max: 1 });
    await expect(withoutCompany('test:pool', (tx) => tx.query('SELECT * FROM tabla_que_no_existe_xyz'))).rejects.toThrow(/tabla_que_no_existe_xyz/u);
    expect(await pidDelPool()).toBeGreaterThan(0); // y el pool sigue sirviendo
  });
});
