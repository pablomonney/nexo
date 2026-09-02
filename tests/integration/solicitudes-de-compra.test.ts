/**
 * La solicitud de compra: pedir no es comprar.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que una solicitud no lleve precios.** Dice qué y cuánto; a quién y a
 *      cuánto lo dice el proveedor después.
 *   2. **Que enviar signifique algo**: una solicitud vacía no se manda a
 *      aprobar, y una enviada ya no la edita el que la pidió.
 *   3. **Que «convertida» no sea una palabra**: exige citar una orden de compra
 *      de verdad —de compras y pedido—, y la base lo verifica.
 *   4. **Que rechazar y anular exijan motivo**, y que ninguno de los dos borre
 *      nada.
 *   5. **Que lo que espera se vea**: enviada sin responder y aprobada sin orden
 *      llegan a la bandeja, sin bloquear.
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

suite('Solicitudes de compra', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let proveedorId: string;
  let hoy: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const armar = async (
    renglones: { descripcion: string; cantidad: string }[] = [
      { descripcion: 'Resmas A4', cantidad: '10' },
    ],
  ): Promise<string> => {
    const r = await pedir('POST', '/purchase-requests', {
      fecha: hoy,
      justificacion: 'Se acabó el papel en el depósito',
      renglones,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  };

  const ver = async (id: string) => {
    const r = await pedir('GET', `/purchase-requests/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{
      solicitud: {
        numero: string; estado: string; renglones: number; situacion: string;
        diasEsperando: number | null; ordenNumero: number | null;
      };
      renglones: { descripcion: string; cantidad: string; unidad: string }[];
    }>();
  };

  /** Una orden de compra de verdad, por el camino de siempre. */
  const ordenDeCompra = async (): Promise<string> => {
    const r = await pedir('POST', '/commercial-documents', {
      direccion: 'COMPRAS',
      tipo: 'PEDIDO',
      terceroId: proveedorId,
      fecha: hoy,
      moneda: 'ARS',
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    hoy = new Date().toISOString().slice(0, 10);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-sol-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio sol ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa sol ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-sol-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-sol-${stamp}@estudio.test`;
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

    proveedorId = (
      await pedir('POST', '/parties', {
        tipoDocumento: 'CUIT',
        numeroDocumento: `30${stamp}${cuitCheckDigit(`30${stamp}`)}`,
        razonSocial: `Proveedor sol ${stamp}`,
        roles: ['PROVEEDOR'],
      })
    ).json<{ id: string }>().id;

    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`, startDate: `${anio}-01-01`, endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('se numera sola y pide cosas, no importes', async () => {
    const id = await armar([
      { descripcion: 'Resmas A4', cantidad: '10' },
      { descripcion: 'Tóner negro', cantidad: '2' },
    ]);

    const { solicitud, renglones } = await ver(id);
    expect(Number(solicitud.numero)).toBeGreaterThan(0);
    expect(solicitud.estado).toBe('BORRADOR');
    expect(solicitud.renglones).toBe(2);
    expect(renglones[0]!.unidad).toBe('UNIDAD');
    // Lo que este módulo no tiene, y es a propósito.
    expect(Object.keys(renglones[0]!)).not.toContain('precioUnitario');
  });

  it('una solicitud sin justificación no se carga', async () => {
    const r = await pedir('POST', '/purchase-requests', {
      fecha: hoy, justificacion: 'x', renglones: [],
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('una solicitud vacía no se manda a aprobar', async () => {
    const id = await armar([]);

    const r = await pedir('POST', `/purchase-requests/${id}/enviar`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('SOLICITUD_SIN_RENGLONES');
  });

  it('enviada, el que pidió ya no la edita', async () => {
    const id = await armar();
    expect((await pedir('POST', `/purchase-requests/${id}/enviar`)).statusCode).toBe(200);

    const r = await pedir('PUT', `/purchase-requests/${id}/renglones`, {
      renglones: [{ descripcion: 'Otra cosa', cantidad: '99' }],
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('SOLICITUD_NO_EDITABLE');
  });

  it('esperando respuesta, aparece en la bandeja sin bloquear', async () => {
    const id = await armar();
    expect((await pedir('POST', `/purchase-requests/${id}/enviar`)).statusCode).toBe(200);

    const { solicitud } = await ver(id);
    // Los días se cuentan; no se llaman atraso.
    expect(solicitud.diasEsperando).toBe(0);
    expect(solicitud.situacion).toContain('Esperando respuesta');

    const items = (await pedir('GET', '/work-queue?entidad=purchase_requests&limite=200'))
      .json<{ items: { rama: string; entityId: string; bloquea: boolean }[] }>().items;
    const item = items.find(
      (i) => i.entityId === id && i.rama === 'SOLICITUD_SIN_RESPONDER',
    );
    expect(item, 'la solicitud enviada tiene que estar en la bandeja').toBeDefined();
    expect(item!.bloquea, 'pedir no bloquea ningún hecho contable').toBe(false);
  });

  it('rechazar exige motivo, y el motivo se ve', async () => {
    const id = await armar();
    expect((await pedir('POST', `/purchase-requests/${id}/enviar`)).statusCode).toBe(200);

    const sinMotivo = await pedir('POST', `/purchase-requests/${id}/rechazar`, {});
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const r = await pedir('POST', `/purchase-requests/${id}/rechazar`, {
      motivo: 'Hay stock suficiente en la sucursal',
    });
    expect(r.statusCode, r.body).toBe(200);

    const { solicitud } = await ver(id);
    expect(solicitud.estado).toBe('RECHAZADA');
    expect(solicitud.situacion).toContain('stock suficiente');
  });

  it('aprobada y sin orden de compra, sigue esperando en la bandeja', async () => {
    const id = await armar();
    expect((await pedir('POST', `/purchase-requests/${id}/enviar`)).statusCode).toBe(200);
    expect((await pedir('POST', `/purchase-requests/${id}/aprobar`)).statusCode).toBe(200);

    const { solicitud } = await ver(id);
    expect(solicitud.estado).toBe('APROBADA');
    expect(solicitud.situacion).toContain('no salen de acá');

    const items = (await pedir('GET', '/work-queue?entidad=purchase_requests&limite=200'))
      .json<{ items: { rama: string; entityId: string }[] }>().items;
    expect(
      items.find((i) => i.entityId === id && i.rama === 'SOLICITUD_SIN_ORDEN'),
    ).toBeDefined();
  });

  it('«convertida» exige una orden de compra de verdad', async () => {
    const id = await armar();
    expect((await pedir('POST', `/purchase-requests/${id}/enviar`)).statusCode).toBe(200);
    expect((await pedir('POST', `/purchase-requests/${id}/aprobar`)).statusCode).toBe(200);

    // Un presupuesto de ventas no es una orden de compra, aunque sea un
    // documento comercial válido.
    const presupuesto = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS', tipo: 'PRESUPUESTO', terceroId: proveedorId,
      fecha: hoy, moneda: 'ARS',
    });
    expect(presupuesto.statusCode, presupuesto.body).toBe(201);

    const malo = await pedir('POST', `/purchase-requests/${id}/convertir`, {
      ordenDeCompraId: presupuesto.json<{ id: string }>().id,
    });
    expect(malo.statusCode, malo.body).toBe(422);
    expect(malo.json<{ error: string }>().error).toBe('ORDEN_INVALIDA');

    const orden = await ordenDeCompra();
    const bueno = await pedir('POST', `/purchase-requests/${id}/convertir`, {
      ordenDeCompraId: orden,
    });
    expect(bueno.statusCode, bueno.body).toBe(200);

    const { solicitud } = await ver(id);
    expect(solicitud.estado).toBe('CONVERTIDA');
    expect(solicitud.ordenNumero).not.toBeNull();
    expect(solicitud.situacion).toContain('Convertida en la orden de compra');

    // Y ya no vuelve: convertida es final.
    const revivir = await pedir('POST', `/purchase-requests/${id}/aprobar`);
    expect(revivir.statusCode, revivir.body).toBe(422);
    expect(revivir.json<{ error: string }>().error).toBe('TRANSICION_INVALIDA');
  });

  it('una solicitud que salió del borrador se anula con motivo, no se borra', async () => {
    const id = await armar();
    expect((await pedir('POST', `/purchase-requests/${id}/enviar`)).statusCode).toBe(200);

    await expect(
      db.query('DELETE FROM purchase_requests WHERE id = $1', [id]),
    ).rejects.toThrow(/E_SOL_NO_SE_BORRA/);

    const r = await pedir('POST', `/purchase-requests/${id}/anular`, {
      motivo: 'Se pidió por duplicado',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await ver(id)).solicitud.situacion).toContain('duplicado');
  });

  it('no se aprueba lo que nunca se envió', async () => {
    const id = await armar();

    const r = await pedir('POST', `/purchase-requests/${id}/aprobar`);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('TRANSICION_INVALIDA');
  });
});
