/**
 * E2 — la caché de tickets del WSAA compartida entre procesos (`TicketCacheDb`).
 *
 * El WSAA da UN ticket por (CUIT, servicio) y niega el segundo mientras el primero viva. Lo que se afirma, contra la base de
 * verdad y con un «WSAA» de mentira que cuenta cuántas veces le pidieron un ticket:
 *
 *   1. Ocho pedidos simultáneos reciben el **mismo** ticket y el WSAA recibe **un** login.
 *   2. Un ticket vencido se renueva **una sola vez**, aunque lo pidan seis a la vez.
 *   3. Un ticket vigente no pide nada.
 *   4. El ambiente es parte de la identidad: el de homologación no sirve en producción.
 *   5. Un ticket por vencer, con el WSAA diciendo «ya tenés uno vivo», se sigue usando; con cualquier otro error, el error sale.
 *   6. Un login que falla no escribe nada ni deja el candado tomado.
 *   7. Un proceso lento no pisa un ticket más nuevo.
 */

import { randomUUID } from 'node:crypto';
import { WsaaFaultError, type AccessTicket, type ServiceName } from '@aai/arca';
import { closePool, initPool } from '@aai/db';
import { TicketCacheDb, esTicketYaEmitido } from '@aai/api/arca/ticket-cache-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL, hasDatabase, type Client } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const SERVICIO = 'wsfe' as ServiceName;
const HORA = 3_600_000;

function ticketDe(cuit: string, token: string, venceEnMs: number): AccessTicket {
  const ahora = Date.now();
  return {
    token,
    sign: `firma-${token}`,
    cuit,
    service: SERVICIO,
    generationTime: new Date(ahora - 60_000),
    expirationTime: new Date(ahora + venceEnMs),
  };
}

/** Un WSAA de mentira: cada login tarda un poco (para que los pedidos se superpongan) y se cuenta. */
function wsaaFalso(cuit: string, venceEnMs = 12 * HORA) {
  let logins = 0;
  return {
    get logins() {
      return logins;
    },
    crear: async (): Promise<AccessTicket> => {
      logins += 1;
      const n = logins;
      await new Promise((r) => setTimeout(r, 150));
      return ticketDe(cuit, `T${n}`, venceEnMs);
    },
  };
}

suite('E2 · TicketCacheDb', () => {
  let db: Client;
  const cuits: string[] = [];
  const nuevoCuit = (): string => {
    const c = `test-${randomUUID()}`;
    cuits.push(c);
    return c;
  };

  beforeAll(async () => {
    initPool(DATABASE_URL);
    db = await connect();
  });

  afterAll(async () => {
    for (const c of cuits) await db.query('DELETE FROM arca_access_tickets WHERE cuit = $1', [c]);
    await db.end();
    await closePool();
  });

  const guardado = async (cuit: string): Promise<Array<{ token: string; environment: string }>> =>
    (await db.query('SELECT token, environment FROM arca_access_tickets WHERE cuit = $1 ORDER BY environment', [cuit])).rows;

  it('ocho pedidos simultáneos reciben el mismo ticket y el WSAA recibe un solo login', async () => {
    const cuit = nuevoCuit();
    const wsaa = wsaaFalso(cuit);
    const cache = new TicketCacheDb('homologacion');

    const r = await Promise.all(Array.from({ length: 8 }, () => cache.obtenerOCrear(cuit, SERVICIO, wsaa.crear)));

    expect(wsaa.logins).toBe(1);
    expect(new Set(r.map((x) => x.ticket.token))).toEqual(new Set(['T1']));
    expect(r.filter((x) => !x.deLaCache)).toHaveLength(1);
    expect(await guardado(cuit)).toEqual([{ token: 'T1', environment: 'homologacion' }]);
  });

  it('dos instancias de la caché (dos procesos) comparten el ticket', async () => {
    const cuit = nuevoCuit();
    const wsaa = wsaaFalso(cuit);
    const a = new TicketCacheDb('homologacion');
    const b = new TicketCacheDb('homologacion');

    const [x, y] = await Promise.all([a.obtenerOCrear(cuit, SERVICIO, wsaa.crear), b.obtenerOCrear(cuit, SERVICIO, wsaa.crear)]);

    expect(wsaa.logins).toBe(1);
    expect(x.ticket.token).toBe(y.ticket.token);
  });

  it('un ticket vencido se renueva UNA sola vez, aunque lo pidan seis a la vez', async () => {
    const cuit = nuevoCuit();
    await db.query(
      `INSERT INTO arca_access_tickets (cuit, service, environment, token, sign, generation_time, expiration_time)
       VALUES ($1, $2, 'homologacion', 'VIEJO', 'x', now() - interval '13 hours', now() - interval '1 hour')`,
      [cuit, SERVICIO],
    );
    const wsaa = wsaaFalso(cuit);
    const cache = new TicketCacheDb('homologacion');

    const r = await Promise.all(Array.from({ length: 6 }, () => cache.obtenerOCrear(cuit, SERVICIO, wsaa.crear)));

    expect(wsaa.logins).toBe(1);
    expect(new Set(r.map((x) => x.ticket.token))).toEqual(new Set(['T1']));
    expect(await guardado(cuit)).toEqual([{ token: 'T1', environment: 'homologacion' }]);
  });

  it('un ticket vigente no le pide nada al WSAA', async () => {
    const cuit = nuevoCuit();
    const cache = new TicketCacheDb('homologacion');
    await cache.put(ticketDe(cuit, 'VIGENTE', 6 * HORA));
    const wsaa = wsaaFalso(cuit);

    const r = await cache.obtenerOCrear(cuit, SERVICIO, wsaa.crear);

    expect(wsaa.logins).toBe(0);
    expect(r).toMatchObject({ deLaCache: true, ticket: { token: 'VIGENTE' } });
    expect((await cache.get(cuit, SERVICIO))?.token).toBe('VIGENTE');
  });

  it('el ambiente es parte de la identidad: el ticket de homologación no sirve en producción', async () => {
    const cuit = nuevoCuit();
    const homo = new TicketCacheDb('homologacion');
    const prod = new TicketCacheDb('produccion');
    await homo.put(ticketDe(cuit, 'HOMO', 6 * HORA));

    expect(await prod.get(cuit, SERVICIO)).toBeNull();
    const wsaa = wsaaFalso(cuit);
    const r = await prod.obtenerOCrear(cuit, SERVICIO, wsaa.crear);

    expect(wsaa.logins).toBe(1);
    expect(r.ticket.token).toBe('T1');
    expect(await guardado(cuit)).toEqual([
      { token: 'HOMO', environment: 'homologacion' },
      { token: 'T1', environment: 'produccion' },
    ]);
  });

  it('el ambiente «mock» no tiene tickets', () => {
    expect(() => new TicketCacheDb('mock')).toThrow(/mock/u);
  });

  it('por vencer y el WSAA dice «ya tenés uno vivo»: se sigue usando el guardado (no se queda sin servicio)', async () => {
    const cuit = nuevoCuit();
    const cache = new TicketCacheDb('homologacion');
    await cache.put(ticketDe(cuit, 'POR-VENCER', 60_000)); // dentro del margen de renovación, pero todavía vale
    let pedidos = 0;

    const r = await cache.obtenerOCrear(cuit, SERVICIO, async () => {
      pedidos += 1;
      throw new WsaaFaultError('ns1:coe.alreadyAuthenticated', 'El CEE ya posee un TA valido', null);
    });

    expect(pedidos).toBe(1);
    expect(r).toMatchObject({ deLaCache: true, ticket: { token: 'POR-VENCER' } });
  });

  it('por vencer y el WSAA falla por OTRA razón: el error sale, no se lo disfraza', async () => {
    const cuit = nuevoCuit();
    const cache = new TicketCacheDb('homologacion');
    await cache.put(ticketDe(cuit, 'POR-VENCER', 60_000));

    await expect(
      cache.obtenerOCrear(cuit, SERVICIO, async () => {
        throw new WsaaFaultError('ns1:cms.cert.expired', 'Certificado expirado', null);
      }),
    ).rejects.toThrow(/expired/u);
  });

  it('ya vencido del todo y el WSAA dice «ya tenés uno»: no hay con qué responder, sale el error', async () => {
    const cuit = nuevoCuit();
    const cache = new TicketCacheDb('homologacion');
    await cache.put(ticketDe(cuit, 'MUERTO', 5_000)); // vence en 5 s: no sirve ni de último recurso

    await expect(
      cache.obtenerOCrear(cuit, SERVICIO, async () => {
        throw new WsaaFaultError('ns1:coe.alreadyAuthenticated', 'ya hay uno', null);
      }),
    ).rejects.toBeInstanceOf(WsaaFaultError);
  });

  it('un login que falla no escribe nada y no deja el candado tomado', async () => {
    const cuit = nuevoCuit();
    const cache = new TicketCacheDb('homologacion');

    await expect(
      cache.obtenerOCrear(cuit, SERVICIO, async () => {
        throw new Error('WSAA caído');
      }),
    ).rejects.toThrow(/caído/u);
    expect(await guardado(cuit)).toEqual([]);

    // El candado se soltó: el siguiente pedido no espera y funciona.
    const wsaa = wsaaFalso(cuit);
    const r = await cache.obtenerOCrear(cuit, SERVICIO, wsaa.crear);
    expect(r.ticket.token).toBe('T1');
  });

  it('dos CUIT distintos no se bloquean entre sí: cada uno pide su ticket', async () => {
    const [a, b] = [nuevoCuit(), nuevoCuit()];
    const wsaaA = wsaaFalso(a);
    const wsaaB = wsaaFalso(b);
    const cache = new TicketCacheDb('homologacion');

    await Promise.all([cache.obtenerOCrear(a, SERVICIO, wsaaA.crear), cache.obtenerOCrear(b, SERVICIO, wsaaB.crear)]);

    expect(wsaaA.logins).toBe(1);
    expect(wsaaB.logins).toBe(1);
  });

  it('un proceso lento no pisa un ticket más nuevo (put sólo reemplaza por uno que vence después)', async () => {
    const cuit = nuevoCuit();
    const cache = new TicketCacheDb('homologacion');
    await cache.put(ticketDe(cuit, 'NUEVO', 10 * HORA));

    await cache.put(ticketDe(cuit, 'VIEJO-QUE-LLEGA-TARDE', 2 * HORA));

    expect((await cache.get(cuit, SERVICIO))?.token).toBe('NUEVO');
  });

  it('esTicketYaEmitido reconoce el código con y sin prefijo de namespace, y nada más', () => {
    expect(esTicketYaEmitido(new WsaaFaultError('ns1:coe.alreadyAuthenticated', '', null))).toBe(true);
    expect(esTicketYaEmitido(new WsaaFaultError('coe.alreadyAuthenticated', '', null))).toBe(true);
    expect(esTicketYaEmitido(new WsaaFaultError('ns1:cms.cert.expired', '', null))).toBe(false);
    expect(esTicketYaEmitido(new Error('coe.alreadyAuthenticated'))).toBe(false);
  });
});
