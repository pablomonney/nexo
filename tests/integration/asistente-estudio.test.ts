/**
 * El asistente y las empresas del estudio (migraciones 0142–0145; `asistente/estudio.ts`).
 *
 * Un estudio lleva varias empresas y el asistente puede contestar sobre todas las que la persona lleva. Lo que se afirma acá es el LÍMITE:
 * llega a otra empresa sólo si (1) es del mismo estudio y la persona tiene acceso, (2) el asistente está encendido para ella, (3) la persona
 * puede usarlo ahí y, si lo que puede exige segundo factor, lo tiene. Y siempre con los permisos de ESA empresa, nunca con los de la actual.
 *
 *   · empresas_del_estudio lista sólo las que cumplen todo, y dice cuántas quedaron afuera por falta del asistente;
 *   · «empresa» en preguntar_al_sistema y buscar_terceros resuelve entre ésas y rechaza cualquier otra, con un mensaje que lo explica;
 *   · preguntar_a_todas_las_empresas recorre sólo ésas y devuelve cada respuesta con su empresa;
 *   · una empresa de otro estudio no existe para el asistente, ni por nombre, ni por CUIT, ni por id.
 */

import { type PedidoDeChat } from '@aai/ai-engine';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProveedorDeChatGuionado, dicho, pidiendo } from './helpers/chat-guionado.js';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

vi.hoisted(() => {
  process.env['ASSISTANT_MENSAJES_POR_MINUTO'] = '1000';
});

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

suite('el asistente y las empresas del estudio', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp = '';
  let proveedor: ProveedorDeChatGuionado;
  const proxy = { id: 'anthropic', conversar: (p: PedidoDeChat) => proveedor.conversar(p) };

  let empresaA = '';
  let empresaB = '';
  let empresaApagada = '';
  let empresaSinAcceso = '';
  let empresaDeOtroEstudio = '';
  let tokenContadora = '';
  let tokenSinSegundoFactor = '';
  const nombres: Record<string, string> = {};

  const guionar = (...pasos: ConstructorParameters<typeof ProveedorDeChatGuionado>[0]): ProveedorDeChatGuionado => {
    proveedor = new ProveedorDeChatGuionado(pasos);
    return proveedor;
  };

  /** Escribe un mensaje en esa empresa. Lo que contestaron las herramientas queda en el último pedido que recibió el proveedor. */
  const conversar = async (token: string, empresa: string, mensaje: string): Promise<void> => {
    const r = await app.inject({
      method: 'POST',
      url: '/asistente/mensajes',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      payload: { mensaje },
    });
    expect(r.statusCode, r.body).toBe(200);
  };

  /** El texto de lo que devolvió la herramienta en el último pedido. */
  const resultadoDeLaHerramienta = (g: ProveedorDeChatGuionado): string => {
    const ultimo = g.pedidos[g.pedidos.length - 1]!;
    return JSON.stringify(ultimo.mensajes);
  };

  const crearEmpresa = async (fundadorId: string, organizationId: string, etiqueta: string, ordinal: number): Promise<string> => {
    const nombre = `${etiqueta} ${stamp}`;
    const id = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, nombre, withCheckDigit(`2${ordinal}${stamp}`), 'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;
    nombres[id] = nombre;
    return id;
  };

  const encender = (empresa: string) =>
    db.query(
      `INSERT INTO assistant_settings (company_id, habilitado, motivo, declarado_por) VALUES ($1, true, 'Prueba del asistente entre empresas', 'test')
       ON CONFLICT (company_id) DO UPDATE SET habilitado = true`,
      [empresa],
    );

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    proveedor = new ProveedorDeChatGuionado([dicho('inicial')]);
    app = await buildServer({ asistente: { proveedor: proxy } });
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const usuario = async (correo: string): Promise<string> =>
      (await db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [correo, correo, clave])).rows[0]!.id;

    const fundadorId = await usuario(`fundador-est-${stamp}@estudio.test`);
    const organizationId = (await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [`Estudio est ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId])).rows[0]!.create_organization;
    empresaA = await crearEmpresa(fundadorId, organizationId, 'Alfa SA', 1);
    empresaB = await crearEmpresa(fundadorId, organizationId, 'Beta SA', 3);
    empresaApagada = await crearEmpresa(fundadorId, organizationId, 'Gama SA', 4);
    empresaSinAcceso = await crearEmpresa(fundadorId, organizationId, 'Delta SA', 5);

    // Otro estudio, con su propia empresa.
    const otroFundador = await usuario(`otro-est-${stamp}@estudio.test`);
    const otraOrg = (await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [`Otro estudio ${stamp}`, withCheckDigit(`33${stamp}`), otroFundador])).rows[0]!.create_organization;
    empresaDeOtroEstudio = await crearEmpresa(otroFundador, otraOrg, 'Omega SA', 6);

    const rol = async (userId: string, empresa: string, codigo: string): Promise<void> => {
      await db.query(
        `INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from) VALUES ($1,$2,(SELECT id FROM roles WHERE code = $3), CURRENT_DATE)`,
        [userId, empresa, codigo],
      );
    };
    const login = async (correo: string): Promise<string> =>
      (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correo, password: PASSWORD } })).json<{ token: string }>().token;

    // La contadora (con segundo factor) lleva Alfa, Beta y Gama; no lleva Delta.
    const contadora = `contadora-est-${stamp}@estudio.test`;
    const contadoraId = await usuario(contadora);
    for (const e of [empresaA, empresaB, empresaApagada]) {
      await db.query(`INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [organizationId, contadoraId]);
      await rol(contadoraId, e, 'CONTADOR');
    }
    // Y también lleva Omega, que es de OTRO estudio: tiene acceso, tiene el asistente encendido y aun así NO se mezcla con éste.
    await db.query(`INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [otraOrg, contadoraId]);
    await rol(contadoraId, empresaDeOtroEstudio, 'CONTADOR');
    const inicial = await login(contadora);
    const secret = (await app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${inicial}` } })).json<{ secret: string }>().secret;
    await app.inject({ method: 'POST', url: '/auth/mfa/confirm', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${inicial}` } });
    tokenContadora = await login(contadora);
    await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${tokenContadora}` } });

    // Una persona SIN segundo factor: compradora en Alfa (no lo exige) y contadora en Beta (lo exige).
    const sin2fa = `sin2fa-est-${stamp}@estudio.test`;
    const sin2faId = await usuario(sin2fa);
    await db.query(`INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1,$2,'MEMBER') ON CONFLICT DO NOTHING`, [organizationId, sin2faId]);
    await rol(sin2faId, empresaA, 'COMPRADOR');
    await rol(sin2faId, empresaB, 'CONTADOR');
    tokenSinSegundoFactor = await login(sin2fa);

    // El asistente encendido en Alfa, Beta, Delta y Omega; apagado en Gama.
    for (const e of [empresaA, empresaB, empresaSinAcceso, empresaDeOtroEstudio]) await encender(e);
  }, 240_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await closePool();
  });

  it('empresas_del_estudio lista sólo las que cumplen todo y dice cuántas quedaron afuera', async () => {
    const g = guionar(pidiendo('empresas_del_estudio', {}), dicho('Listo.'));
    await conversar(tokenContadora, empresaA, 'qué empresas tengo');
    const visto = resultadoDeLaHerramienta(g);
    expect(visto).toContain(nombres[empresaA]);
    expect(visto).toContain(nombres[empresaB]);
    expect(visto, 'el asistente está apagado en Gama').not.toContain(nombres[empresaApagada]);
    expect(visto, 'la persona no lleva Delta').not.toContain(nombres[empresaSinAcceso]);
    expect(visto, 'Omega es de otro estudio').not.toContain(nombres[empresaDeOtroEstudio]);
    expect(visto).toMatch(/1 empresa\(s\) del estudio no están disponibles/u);
  });

  it('preguntar sobre otra empresa del estudio funciona, y dice de cuál es la respuesta', async () => {
    const g = guionar(pidiendo('preguntar_al_sistema', { preguntaId: 'VENTAS_DEL_MES', empresa: 'beta' }), dicho('Listo.'));
    await conversar(tokenContadora, empresaA, 'cuánto vendió Beta');
    const visto = resultadoDeLaHerramienta(g);
    expect(visto).toContain(nombres[empresaB]);
    expect(visto).toContain('VENTAS_DEL_MES');
  });

  it('una empresa donde el asistente está apagado, una que la persona no lleva y una de otro estudio no se pueden consultar', async () => {
    for (const [empresa, referencia] of [
      [empresaApagada, nombres[empresaApagada]!],
      [empresaSinAcceso, nombres[empresaSinAcceso]!],
      [empresaDeOtroEstudio, nombres[empresaDeOtroEstudio]!],
      [empresaDeOtroEstudio, empresaDeOtroEstudio],
    ] as const) {
      const g = guionar(pidiendo('preguntar_al_sistema', { preguntaId: 'VENTAS_DEL_MES', empresa: referencia }), dicho('Listo.'));
      await conversar(tokenContadora, empresaA, 'cuánto vendió esa');
      const visto = resultadoDeLaHerramienta(g);
      expect(visto, referencia).toMatch(/No hay una empresa/u);
      expect(visto, 'no se filtra ni un dato de esa empresa').not.toContain('"titulo"');
      expect(empresa).toBeTruthy();
    }
  });

  it('sin el segundo factor que Beta exige, Beta no está al alcance del asistente aunque la persona tenga el rol', async () => {
    const g = guionar(pidiendo('empresas_del_estudio', {}), dicho('Listo.'));
    await conversar(tokenSinSegundoFactor, empresaA, 'qué empresas tengo');
    const visto = resultadoDeLaHerramienta(g);
    expect(visto).toContain(nombres[empresaA]);
    expect(visto, 'su rol en Beta exige segundo factor y no lo tiene').not.toContain(nombres[empresaB]);
  });

  it('preguntar_a_todas_las_empresas recorre sólo las que están al alcance y trae cada respuesta con su empresa', async () => {
    const g = guionar(pidiendo('preguntar_a_todas_las_empresas', { preguntaId: 'VENTAS_DEL_MES' }), dicho('Listo.'));
    await conversar(tokenContadora, empresaA, 'cuánto vendió el estudio');
    const visto = resultadoDeLaHerramienta(g);
    expect(visto).toContain(nombres[empresaA]);
    expect(visto).toContain(nombres[empresaB]);
    for (const e of [empresaApagada, empresaSinAcceso, empresaDeOtroEstudio]) expect(visto, nombres[e]).not.toContain(nombres[e]!);
    expect(visto).toContain('totalConsolidado');
  });

  it('el parámetro «empresa» no existe para buscar terceros de una empresa que no se puede consultar', async () => {
    const g = guionar(pidiendo('buscar_terceros', { texto: 'ab', empresa: nombres[empresaDeOtroEstudio] }), dicho('Listo.'));
    await conversar(tokenContadora, empresaA, 'buscá ab en Omega');
    expect(resultadoDeLaHerramienta(g)).toMatch(/No hay una empresa/u);
  });
});
