/**
 * Integration Hub: la puerta por la que entra lo de afuera.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que un conector no pueda escribir en el motor contable.** Lo que llega
 *      queda en la zona de aterrizaje y no es nada de NEXO hasta que alguien lo
 *      resuelva. Es ADR-001 aplicado a los sistemas externos.
 *   2. **Que lo planificado no se pueda conectar.** La distinción entre lo que
 *      existe y lo que está por venir es un candado de la base, no un cartel.
 *   3. **Que el payload sea inmutable.** Es prueba de lo que dijo el proveedor.
 *   4. **Que la idempotencia funcione.** El mismo pedido por sincronización,
 *      webhook y reintento es una fila, no tres ventas.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { cuitCheckDigit, totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('Integration Hub', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let integracion: string;
  let clienteId: string;

  const pedir = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-int-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio int ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa int ${stamp}`, withCheckDigit(`24${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-int-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-int-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId, role },
      });
    }

    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
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
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST',
      url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });

    clienteId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Cliente de la tienda ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  // -------------------------------------------------------------------------
  it('el catálogo distingue lo disponible de lo planificado', async () => {
    const r = await pedir('GET', '/integration-providers');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      proveedores: { code: string; estado: string }[];
      alcance: string;
    }>();

    const disponibles = cuerpo.proveedores.filter((p) => p.estado === 'DISPONIBLE');
    const planificados = cuerpo.proveedores.filter((p) => p.estado === 'PLANIFICADO');

    expect(disponibles.map((p) => p.code)).toEqual(['IMPORTACION_MANUAL']);
    expect(planificados.map((p) => p.code)).toContain('TIENDANUBE');
    expect(cuerpo.alcance).toContain('la base rechaza el intento');
  });

  it('un proveedor planificado no se puede conectar', async () => {
    // El candado está en la base. Sin él, la pantalla diría CONECTADA sobre algo
    // que no tiene conector.
    const r = await pedir('POST', '/integrations', {
      provider: 'TIENDANUBE',
      cuentaExterna: 'tienda-123',
      alias: 'Mi tienda',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('PROVEEDOR_NO_DISPONIBLE');
  });

  it('conecta el proveedor disponible y queda en la bitácora', async () => {
    const r = await pedir('POST', '/integrations', {
      provider: 'IMPORTACION_MANUAL',
      cuentaExterna: `export-tienda-${stamp}`,
      alias: 'Exportación de la tienda',
    });
    expect(r.statusCode, r.body).toBe(201);
    integracion = r.json<{ id: string }>().id;

    const bitacora = await db.query(
      `SELECT 1 FROM audit_logs WHERE object_id = $1 AND action = 'CONECTAR_INTEGRACION'`,
      [integracion],
    );
    expect(bitacora.rowCount).toBe(1);
  });

  it('la misma cuenta externa no se conecta dos veces', async () => {
    const r = await pedir('POST', '/integrations', {
      provider: 'IMPORTACION_MANUAL',
      cuentaExterna: `export-tienda-${stamp}`,
      alias: 'Duplicada',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('INTEGRACION_DUPLICADA');
  });

  // -------------------------------------------------------------------------
  // La zona de aterrizaje
  // -------------------------------------------------------------------------
  it('lo que entra NO se convierte en nada de NEXO por sí solo', async () => {
    const antesTerceros = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM parties WHERE company_id = $1',
      [empresa],
    );
    const antesComprobantes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tax_transactions WHERE company_id = $1',
      [empresa],
    );

    const r = await pedir('POST', `/integrations/${integracion}/records`, {
      tipoDeCorrida: 'INICIAL',
      registros: [
        {
          kind: 'CLIENTE',
          externalId: 'cli-4821',
          payload: { nombre: 'Comprador de la tienda', email: 'comprador@tienda.test' },
        },
        {
          kind: 'ORDEN',
          externalId: 'ord-9001',
          ocurridoEn: '2026-03-15T14:00:00.000Z',
          payload: { total: '12100.00', items: 3, cliente: 'cli-4821' },
        },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ recibidos: number; nuevos: number; duplicados: number; alcance: string }>();
    expect(cuerpo.nuevos).toBe(2);
    expect(cuerpo.alcance).toContain('Todavía no son nada de NEXO');

    // Ni un tercero, ni un comprobante, ni un asiento aparecieron solos.
    const despuesTerceros = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM parties WHERE company_id = $1',
      [empresa],
    );
    const despuesComprobantes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tax_transactions WHERE company_id = $1',
      [empresa],
    );
    expect(despuesTerceros.rows[0]!.n).toBe(antesTerceros.rows[0]!.n);
    expect(despuesComprobantes.rows[0]!.n).toBe(antesComprobantes.rows[0]!.n);
  });

  it('el mismo registro por reintento es una sola fila', async () => {
    // Sincronización inicial, webhook y reintento traen el mismo pedido. Sin
    // idempotencia la venta entraría tres veces y el error saldría en el balance.
    const r = await pedir('POST', `/integrations/${integracion}/records`, {
      tipoDeCorrida: 'WEBHOOK',
      registros: [
        { kind: 'ORDEN', externalId: 'ord-9001', payload: { total: '12100.00', items: 3 } },
        { kind: 'ORDEN', externalId: 'ord-9002', payload: { total: '5000.00', items: 1 } },
      ],
    });
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ nuevos: number; duplicados: number }>();
    expect(cuerpo.nuevos).toBe(1);
    expect(cuerpo.duplicados).toBe(1);

    const filas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM external_records
        WHERE company_id = $1 AND kind = 'ORDEN' AND external_id = 'ord-9001'`,
      [empresa],
    );
    expect(filas.rows[0]!.n).toBe('1');
  });

  it('las cuentas de la corrida cierran: recibidos = nuevos + duplicados', async () => {
    const r = await db.query<{ mal: string }>(
      `SELECT count(*)::text AS mal FROM integration_sync_runs
        WHERE company_id = $1 AND records_received <> records_new + records_duplicados`,
      [empresa],
    );
    expect(r.rows[0]!.mal).toBe('0');
  });

  it('lo que informó el proveedor no se edita', async () => {
    const fila = await db.query<{ id: string }>(
      `SELECT id FROM external_records WHERE company_id = $1 AND external_id = 'ord-9001'`,
      [empresa],
    );
    await expect(
      db.query(`UPDATE external_records SET payload = '{"total":"1.00"}'::jsonb WHERE id = $1`, [
        fila.rows[0]!.id,
      ]),
    ).rejects.toThrow();

    await expect(
      db.query('DELETE FROM external_records WHERE id = $1', [fila.rows[0]!.id]),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // La resolución
  // -------------------------------------------------------------------------
  it('un registro sin resolver aparece en la bandeja', async () => {
    const bandeja = await pedir('GET', '/work-queue?limite=200');
    expect(bandeja.statusCode, bandeja.body).toBe(200);
    const items = bandeja.json<{ items: { rama: string; entidad: string }[] }>().items;
    expect(
      items.some((i) => i.rama === 'EXTERNO_SIN_RESOLVER' && i.entidad === 'external_records'),
      'el diseño crea este trabajo a propósito: nada entra solo',
    ).toBe(true);
  });

  it('resolver un registro lo vincula a la entidad y lo firma', async () => {
    const lista = await pedir('GET', '/external-records?status=SIN_RESOLVER&kind=CLIENTE');
    const registro = lista.json<{ registros: { id: string }[] }>().registros[0]!;

    const r = await pedir('POST', `/external-records/${registro.id}/resolve`, {
      destino: 'tercero',
      entidadId: clienteId,
    });
    expect(r.statusCode, r.body).toBe(200);

    const fila = await db.query<{ party_id: string; resolved_by: string; status: string }>(
      'SELECT party_id, resolved_by, status FROM external_records WHERE id = $1',
      [registro.id],
    );
    expect(fila.rows[0]!.status).toBe('RESUELTO');
    expect(fila.rows[0]!.party_id).toBe(clienteId);
    expect(fila.rows[0]!.resolved_by.startsWith('user:')).toBe(true);

    // Y desaparece de la bandeja porque cambió el hecho.
    const bandeja = await pedir('GET', '/work-queue?limite=200');
    const ids = bandeja.json<{ items: { entityId: string }[] }>().items.map((i) => i.entityId);
    expect(ids).not.toContain(registro.id);
  });

  it('un registro ya resuelto no se resuelve de nuevo', async () => {
    const lista = await pedir('GET', '/external-records?status=RESUELTO');
    const registro = lista.json<{ registros: { id: string }[] }>().registros[0]!;
    const r = await pedir('POST', `/external-records/${registro.id}/resolve`, {
      destino: 'tercero',
      entidadId: clienteId,
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('REGISTRO_YA_RESUELTO');
  });

  it('no se resuelve contra una entidad de otra empresa', async () => {
    const ajena = await db.query<{ id: string }>(
      'SELECT id FROM parties WHERE company_id <> $1 LIMIT 1',
      [empresa],
    );
    if (ajena.rowCount === 0) return;

    const lista = await pedir('GET', '/external-records?status=SIN_RESOLVER');
    const registro = lista.json<{ registros: { id: string }[] }>().registros[0]!;
    const r = await pedir('POST', `/external-records/${registro.id}/resolve`, {
      destino: 'tercero',
      entidadId: ajena.rows[0]!.id,
    });
    // La clave foránea lleva la empresa adentro: el tercero de otra empresa no
    // existe desde acá.
    expect(r.statusCode, r.body).not.toBe(200);
  });

  it('descartar exige motivo y conserva el payload', async () => {
    const lista = await pedir('GET', '/external-records?status=SIN_RESOLVER');
    const registro = lista.json<{ registros: { id: string }[] }>().registros[0]!;

    const sinMotivo = await pedir('POST', `/external-records/${registro.id}/discard`, {});
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const r = await pedir('POST', `/external-records/${registro.id}/discard`, {
      motivo: 'La plataforma mandó el pedido incompleto',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ alcance: string }>().alcance).toContain('no se borra ni se edita');

    const fila = await db.query<{ payload: unknown; status: string }>(
      'SELECT payload, status FROM external_records WHERE id = $1',
      [registro.id],
    );
    expect(fila.rows[0]!.status).toBe('DESCARTADO');
    expect(fila.rows[0]!.payload).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Salud y desconexión
  // -------------------------------------------------------------------------
  it('la salud de la integración se deriva de los hechos', async () => {
    const r = await pedir('GET', '/integrations');
    expect(r.statusCode, r.body).toBe(200);
    const fila = r
      .json<{
        integraciones: {
          id: string; status: string; resueltos: number; descartados: number;
          ultimaSincronizacion: string | null; tokenVencido: boolean;
        }[];
      }>()
      .integraciones.find((i) => i.id === integracion)!;

    expect(fila.status).toBe('CONECTADA');
    expect(fila.resueltos).toBeGreaterThan(0);
    expect(fila.descartados).toBeGreaterThan(0);
    expect(fila.ultimaSincronizacion).not.toBeNull();
    expect(fila.tokenVencido).toBe(false);
  });

  it('la respuesta de integraciones nunca trae tokens', async () => {
    const r = await pedir('GET', '/integrations');
    const crudo = JSON.stringify(r.json());
    for (const prohibido of ['access_token', 'accessToken', 'refresh_token', 'refreshToken',
                             'key_encryption_ref', 'keyEncryptionRef']) {
      expect(crudo, `la respuesta no puede contener ${prohibido}`).not.toContain(prohibido);
    }
  });

  it('desconectar borra los tokens y conserva lo que ya entró', async () => {
    const antes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM external_records WHERE integration_id = $1',
      [integracion],
    );

    const r = await pedir('POST', `/integrations/${integracion}/disconnect`, {
      motivo: 'La empresa dejó de vender por ese canal',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ alcance: string }>().alcance).toContain('se conserva');

    const fila = await db.query<{
      status: string; access_token_encrypted: string | null; disconnected_by: string | null;
    }>(
      `SELECT status, access_token_encrypted, disconnected_by
         FROM company_integrations WHERE id = $1`,
      [integracion],
    );
    expect(fila.rows[0]!.status).toBe('DESCONECTADA');
    expect(fila.rows[0]!.access_token_encrypted).toBeNull();
    expect(fila.rows[0]!.disconnected_by).not.toBeNull();

    const despues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM external_records WHERE integration_id = $1',
      [integracion],
    );
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  });

  it('una integración desconectada no recibe datos nuevos', async () => {
    const r = await pedir('POST', `/integrations/${integracion}/records`, {
      registros: [{ kind: 'ORDEN', externalId: 'ord-tardio', payload: { total: '1.00' } }],
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('INTEGRACION_DESCONECTADA');
  });

  it('la integración se desconecta, no se borra', async () => {
    await expect(
      db.query('DELETE FROM company_integrations WHERE id = $1', [integracion]),
    ).rejects.toThrow();
  });
});
