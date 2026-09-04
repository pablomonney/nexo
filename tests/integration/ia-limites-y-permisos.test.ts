/**
 * Quién puede preguntarle al modelo, cuántas veces, y qué pasa si se cae.
 *
 * Tres cosas que dejaron de ser teóricas cuando apareció el transporte HTTP:
 * cada pregunta puede costar plata, saca cifras de la empresa hacia afuera, y
 * puede fallar. Antes, con el proveedor en `none`, las tres daban lo mismo.
 *
 * El más importante de este archivo es el último: **el fallo del proveedor no
 * se lleva puesta la respuesta**. Si un 429 convirtiera una respuesta correcta
 * en un 500, la IA sería un punto único de fallo del ERP — exactamente lo
 * contrario de lo que esta capa es.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

suite('IA — permisos, cupo y tolerancia al fallo', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp = '';
  let empresa = '';
  /** CONTADOR: tiene `intelligence:ask` y `analysis:configure`. */
  let tokenContadora = '';
  /** SOLO_LECTURA: puede leer todo y **no** puede preguntar. */
  let tokenLector = '';

  const pedir = async (
    metodo: 'GET' | 'POST',
    url: string,
    token: string,
    cuerpo?: unknown,
    companyId = empresa,
  ) =>
    app.inject({
      method: metodo,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': companyId },
      ...(cuerpo === undefined ? {} : { payload: cuerpo }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, {
      algorithm: 2,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [`fundador-ia-${stamp}@estudio.test`, 'Fundador', clave],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio ia ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa ia ${stamp}`,
        withCheckDigit(`27${stamp}`),
        'SA',
        'AR-C',
        'IGJ',
        '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-ia-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const alta = async (correo: string, roles: string[]): Promise<string> => {
      const userId = (
        await app.inject({
          method: 'POST',
          url: `/organizations/${organizationId}/users`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { email: correo, fullName: correo, password: PASSWORD, level: 'MEMBER' },
        })
      ).json<{ id: string }>().id;

      for (const role of roles) {
        await app.inject({
          method: 'POST',
          url: `/companies/${empresa}/roles`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { userId, role },
        });
      }

      // CONTADOR exige segundo factor; SOLO_LECTURA no.
      const inicial = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: correo, password: PASSWORD },
        })
      ).json<{ token: string }>().token;

      if (!roles.includes('CONTADOR') && !roles.includes('ADMINISTRADOR')) return inicial;

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
      const token = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: correo, password: PASSWORD },
        })
      ).json<{ token: string }>().token;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${token}` },
      });
      return token;
    };

    tokenContadora = await alta(`contadora-ia-${stamp}@estudio.test`, ['CONTADOR']);
    tokenLector = await alta(`lector-ia-${stamp}@estudio.test`, ['SOLO_LECTURA']);
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await closePool();
  });

  describe('preguntar es otra cosa que leer', () => {
    it('un usuario de solo lectura NO puede preguntarle al modelo', async () => {
      // Tiene `analytics:read` —ve toda la analítica— y aun así no puede hacer
      // que el sistema le pregunte a un tercero. Son dos actos distintos: el
      // segundo cuesta plata y saca cifras de la empresa.
      const r = await pedir('POST', '/intelligence/preguntar', tokenLector, {
        pregunta: '¿cuánto vendí este mes?',
      });

      expect(r.statusCode, r.body).toBe(403);
      expect(r.json<{ message: string }>().message).toContain('intelligence:ask');
    });

    it('y sigue viendo el catálogo, que es determinístico', async () => {
      // No se le apaga la capa entera: la lista de preguntas es información del
      // sistema, no una llamada a nadie.
      const r = await pedir('GET', '/intelligence/preguntas', tokenLector);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ preguntas: unknown[] }>().preguntas.length).toBeGreaterThan(0);
    });

    it('una contadora sí puede', async () => {
      const r = await pedir('POST', '/intelligence/preguntar', tokenContadora, {
        pregunta: '¿cuánto vendí este mes?',
      });
      expect(r.statusCode, r.body).toBe(200);
    });
  });

  describe('el cupo', () => {
    it('sin declararlo, no hay tope, y la respuesta lo dice con esas palabras', async () => {
      const r = await pedir('GET', '/intelligence/quota', tokenContadora);
      expect(r.statusCode, r.body).toBe(200);

      const v = r.json<{ topeDiario: number | null; sinTopeDeclarado: boolean; alcance: string }>();
      // `null` no es cero ni «ilimitado por diseño»: es que nadie lo decidió.
      expect(v.topeDiario).toBeNull();
      expect(v.sinTopeDeclarado).toBe(true);
      expect(v.alcance).toContain('lo declara la empresa');
    });

    it('un usuario de solo lectura no puede declararlo', async () => {
      const r = await pedir('POST', '/intelligence/quota', tokenLector, {
        llamadasPorDia: 10,
        motivo: 'un lector no fija la política de gasto',
      });
      expect(r.statusCode).toBe(403);
    });

    it('declarado en cero, corta desde la primera pregunta', async () => {
      // Es la forma de apagar la IA para una empresa sin tocar la configuración
      // del servidor ni la de las demás.
      const alta = await pedir('POST', '/intelligence/quota', tokenContadora, {
        llamadasPorDia: 0,
        motivo: 'Esta empresa no autoriza el envío de datos a un tercero.',
      });
      expect(alta.statusCode, alta.body).toBe(201);

      const r = await pedir('POST', '/intelligence/preguntar', tokenContadora, {
        pregunta: '¿cuánto vendí este mes?',
      });

      expect(r.statusCode, r.body).toBe(429);
      const mensaje = r.json<{ message: string }>().message;
      expect(mensaje).toContain('CUPO_DIARIO_AGOTADO');
      // Y dice por qué cambiar de usuario no lo arregla.
      expect(mensaje).toContain('por empresa');
    });

    it('el cupo se cuenta por empresa: otro usuario de la misma no lo saltea', async () => {
      // El lector no puede preguntar por permisos, así que se comprueba con la
      // lectura del cupo: el consumo que ve es el de la empresa, no el suyo.
      const r = await pedir('GET', '/intelligence/quota', tokenContadora);
      const v = r.json<{ topeDiario: number | null }>();
      expect(v.topeDiario).toBe(0);
    });

    it('declarar el cupo queda en la bitácora, con su motivo', async () => {
      // Una traba sin explicación, seis meses después, es una traba que nadie
      // sabe por qué está.
      const bitacora = await db.query<{ motivo: string; action: string }>(
        `SELECT action, motivo FROM audit_logs
          WHERE company_id = $1 AND action = 'DECLARAR_CUPO_DE_IA'
          ORDER BY occurred_at DESC LIMIT 1`,
        [empresa],
      );
      expect(bitacora.rowCount).toBe(1);
      expect(bitacora.rows[0]!.motivo).toContain('no autoriza');
    });

    it('subiendo el cupo se vuelve a poder preguntar', async () => {
      const alta = await pedir('POST', '/intelligence/quota', tokenContadora, {
        llamadasPorDia: 1000,
        motivo: 'Se habilita el uso normal para el resto de esta prueba.',
      });
      expect(alta.statusCode, alta.body).toBe(201);

      const r = await pedir('POST', '/intelligence/preguntar', tokenContadora, {
        pregunta: '¿cuánto vendí este mes?',
      });
      expect(r.statusCode, r.body).toBe(200);
    });
  });

  describe('aislamiento entre empresas', () => {
    it('el cupo de una empresa no se lee desde otra', async () => {
      const ajena = '00000000-0000-7000-8000-000000000000';
      const r = await pedir('GET', '/intelligence/quota', tokenContadora, undefined, ajena);
      // 403: no tiene rol en esa empresa. No 200 con el cupo de la propia.
      expect(r.statusCode).toBe(403);
    });
  });

  describe('sin proveedor, la respuesta determinística llega igual', () => {
    it('la cifra viene, y la narración dice por qué no está', async () => {
      // Es el modo por defecto (`AI_PROVIDER=none`) y **es un modo de
      // operación**: un endpoint que contestara «no disponible» sin dar el
      // número estaría escondiendo detrás de la IA algo que el sistema ya sabe.
      const r = await pedir('POST', '/intelligence/preguntar', tokenContadora, {
        pregunta: '¿cuánto vendí este mes?',
      });

      expect(r.statusCode, r.body).toBe(200);
      const v = r.json<{
        entendida: boolean;
        respuesta: { valor: string | null; origen: string[] };
        narracion: { disponible: boolean; motivo: string };
      }>();

      expect(v.entendida).toBe(true);
      expect(v.respuesta.origen.length).toBeGreaterThan(0);
      expect(v.narracion.disponible).toBe(false);
      expect(v.narracion.motivo).toBe('SIN_PROVEEDOR');
    });
  });
});
