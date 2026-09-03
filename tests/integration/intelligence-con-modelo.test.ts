/**
 * El camino completo con proveedor de modelo, y lo que queda escrito.
 *
 * La suite principal de inteligencia corre sin proveedor —el modo por defecto—.
 * Esta corre con el simulado, que es la única forma de recorrer el camino
 * entero: contexto → proveedor → validación → `ai_answers`.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que el proveedor simulado se abstenga**, y que su abstención se
 *      informe como lo que es. Un mock que redactara un párrafo produciría algo
 *      indistinguible de una respuesta real.
 *   2. **Que la cifra llegue igual.** La abstención del modelo no se lleva
 *      puesta la respuesta determinística.
 *   3. **Que quede registrada** con el contexto exacto que se usó: sin él, una
 *      respuesta guardada es una frase sin forma de saber de dónde salió.
 *
 * Se importa todo dinámicamente después de tocar `AI_PROVIDER`, porque `config`
 * lee el entorno al importarse y el resto de las suites tienen que seguir
 * corriendo sin proveedor.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('NEXO Intelligence con proveedor simulado', () => {
  let app: FastifyInstance;
  let db: Client;
  let cerrarPool: () => Promise<void>;
  let stamp: string;
  let token: string;
  let empresa: string;

  beforeAll(async () => {
    process.env.AI_PROVIDER = 'mock';
    vi.resetModules();

    // Con los módulos reiniciados, `@aai/db` es otro: su pool arranca sin
    // inicializar y hay que hacerlo sobre **esta** instancia, no sobre la que
    // importó otra suite.
    const dbMod = await import('@aai/db');
    dbMod.initPool(process.env.DATABASE_URL!);
    cerrarPool = dbMod.closePool;

    const { buildServer } = await import('@aai/api/server');
    const { withCheckDigit, totp } = await import('@aai/shared');
    const { ANSWERING_V1 } = await import('@aai/ai-engine');

    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    // El prompt archivado. `ai_answers.prompt_hash` tiene FK contra esta tabla:
    // sin el texto guardado, el hash sería la huella de algo ilegible. Es lo
    // que hace `npm run prompts:register` en una instalación.
    await db.query(
      `INSERT INTO prompt_versions (hash, name, version, texto)
       VALUES ($1, $2, $3, $4) ON CONFLICT (hash) DO NOTHING`,
      [ANSWERING_V1.hash, ANSWERING_V1.name, ANSWERING_V1.version, ANSWERING_V1.texto],
    );

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-mock-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio mock ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa mock ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-mock-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-mock-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { userId, role: 'CONTADOR' },
    });

    const inicial = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({
        method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD },
      })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await cerrarPool?.();
    process.env.AI_PROVIDER = 'none';
  });

  it('el catálogo informa que hay proveedor', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/intelligence/preguntas',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json<{ narracion: { disponible: boolean; proveedor: string } }>();
    expect(c.narracion.disponible).toBe(true);
    expect(c.narracion.proveedor).toBe('mock');
  });

  it('el simulado se abstiene, la cifra llega igual, y queda registrado', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/intelligence/preguntar',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      payload: { pregunta: '¿cuánto vendí este mes?' },
    });
    expect(r.statusCode, r.body).toBe(200);

    const d = r.json<{
      entendida: boolean;
      respuesta: { valor: string | null; origen: string[] };
      narracion: { disponible: boolean; motivo: string; registrada: boolean; explicacion: string };
    }>();

    expect(d.entendida).toBe(true);
    // Sin comprobantes cargados el neto es cero, y cero es una respuesta: lo
    // que importa acá es que la cifra viene del motor y no del modelo.
    expect(d.respuesta.valor).toBe('0,00');
    expect(d.respuesta.origen).toContain('analytics_operaciones_mensuales');

    expect(d.narracion.motivo).toBe('ABSTENCION');
    expect(d.narracion.disponible).toBe(false);
    expect(d.narracion.explicacion).toContain('no tiene valor');
    expect(d.narracion.registrada).toBe(true);

    // Y quedó en la bitácora del asistente, con el contexto exacto.
    const guardada = await db.query<{
      pregunta: string; abstencion: boolean; aceptada: boolean;
      cifras_inventadas: number; model_provider: string; contexto: { datos: unknown[] };
    }>(
      `SELECT pregunta, abstencion, aceptada, cifras_inventadas, model_provider, contexto
         FROM ai_answers WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [empresa],
    );
    expect(guardada.rowCount).toBe(1);
    const fila = guardada.rows[0]!;
    expect(fila.pregunta).toContain('vendí');
    expect(fila.abstencion).toBe(true);
    expect(fila.aceptada).toBe(true);
    expect(fila.cifras_inventadas).toBe(0);
    expect(fila.model_provider).toBe('mock');
    // El contexto guardado es el que se le pasó: sin él no se puede rehacer la
    // verificación de cifras ni explicar por qué dijo lo que dijo.
    expect(fila.contexto.datos.length).toBeGreaterThan(1);
  });

  it('una respuesta registrada no se edita', async () => {
    // Es un hecho pasado. Si la pregunta se vuelve a hacer, queda la nueva al
    // lado de la anterior.
    await expect(
      db.query(`UPDATE ai_answers SET respuesta = 'otra cosa' WHERE company_id = $1`, [empresa]),
    ).rejects.toThrow(/no se edita/);
  });
});
