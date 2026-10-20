/**
 * Los puestos predeterminados, contra la API real (migración 0143).
 *
 * Lo que se afirma:
 *
 *   1. **Se pueden dar.** `POST /companies/:id/roles` acepta los cinco puestos nuevos; uno que no existe es un 400.
 *   2. **Cada persona ve los módulos de su puesto y nada más.** Una persona por puesto, con su token: lo permitido responde, lo que no le
 *      toca responde 403.
 *   3. **El segundo factor.** Gerente y Tesorero (mueven plata) no pasan sin segundo factor; Vendedor, Comprador y Depósito sí.
 *   4. **`GET /puestos`** lista los once, con sus permisos y si exigen segundo factor: de ahí sale lo que la consola muestra al dar un puesto.
 */

import { totp, withCheckDigit } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

suite('los puestos predeterminados', () => {
  let env: EntornoApi;
  let hash = '';
  const personas = new Map<string, { email: string; token: string; secret?: string }>();

  const entrar = async (email: string): Promise<string> =>
    (await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })).json<{ token: string }>().token;

  /** Una persona del estudio con ese puesto en la empresa. `conSegundoFactor` hace el alta del MFA y lo verifica. */
  const crearPersona = async (puesto: string, conSegundoFactor: boolean): Promise<string> => {
    const stamp = await sufijoUnico(env.db);
    const email = `${puesto.toLowerCase()}-${stamp}@estudio.test`;
    const id = (
      await env.db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, puesto, hash])
    ).rows[0]!.id;
    await env.db.query(`INSERT INTO organization_members (organization_id, user_id, level) VALUES ($1, $2, 'MEMBER')`, [env.organizationId, id]);

    // El puesto se da por la API, con la persona que administra la empresa: es el camino real (valida el puesto y la autorización).
    const dado = await env.pedir('POST', `/companies/${env.empresa}/roles`, { userId: id, role: puesto });
    expect(dado.statusCode, dado.body).toBe(200);

    let token = await entrar(email);
    if (conSegundoFactor) {
      const secret = (await env.app.inject({ method: 'POST', url: '/auth/mfa/setup', headers: { authorization: `Bearer ${token}` } })).json<{ secret: string }>().secret;
      await env.app.inject({ method: 'POST', url: '/auth/mfa/confirm', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${token}` } });
      token = await entrar(email);
      await env.app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { code: totp(secret, Date.now()) }, headers: { authorization: `Bearer ${token}` } });
    }
    personas.set(puesto, { email, token });
    return token;
  };

  const como = (puesto: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    env.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${personas.get(puesto)!.token}`, 'x-company-id': env.empresa },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  beforeAll(async () => {
    env = await crearEntorno('puestos');
    const { hash: argon } = await import('@node-rs/argon2');
    hash = await argon(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    await crearPersona('VENDEDOR', false);
    await crearPersona('COMPRADOR', false);
    await crearPersona('DEPOSITO', false);
    await crearPersona('TESORERO', true);
    await crearPersona('GERENTE', true);
  });

  afterAll(async () => {
    await env.cerrar();
  });

  it('un puesto que no existe no se puede dar', async () => {
    const r = await env.pedir('POST', `/companies/${env.empresa}/roles`, { userId: env.userId, role: 'JEFE_DE_TODO' });
    expect(r.statusCode).toBe(400);
  });

  it('GET /puestos lista los once, con permisos, y marca los que exigen segundo factor', async () => {
    const r = await env.pedir('GET', '/puestos');
    expect(r.statusCode, r.body).toBe(200);
    const { puestos } = r.json<{ puestos: Array<{ codigo: string; nombre: string; permisos: string[]; exigeSegundoFactor: boolean }> }>();
    expect(puestos.map((p) => p.codigo)).toEqual([
      'ADMINISTRADOR', 'CONTADOR', 'AUDITOR', 'GERENTE', 'VENDEDOR', 'COMPRADOR', 'TESORERO', 'DEPOSITO', 'USUARIO_EMPRESA', 'CARGADOR', 'SOLO_LECTURA',
    ]);
    const por = (c: string) => puestos.find((p) => p.codigo === c)!;
    expect(por('VENDEDOR').permisos).toContain('commercial:write');
    expect(por('VENDEDOR').permisos).not.toContain('journal_entry:create');
    expect(por('GERENTE').exigeSegundoFactor).toBe(true);
    expect(por('TESORERO').exigeSegundoFactor).toBe(true);
    expect(por('VENDEDOR').exigeSegundoFactor).toBe(false);
    expect(por('DEPOSITO').exigeSegundoFactor).toBe(false);
  });

  it('el Vendedor ve clientes y no ve la contabilidad ni la tesorería', async () => {
    expect((await como('VENDEDOR', 'GET', '/parties')).statusCode).toBe(200);
    expect((await como('VENDEDOR', 'GET', '/journal-entries')).statusCode).toBe(403);
    expect((await como('VENDEDOR', 'GET', '/payment-orders')).statusCode).toBe(403);
    expect((await como('VENDEDOR', 'GET', '/cash-boxes')).statusCode).toBe(403);
  });

  it('el Tesorero ve caja y pagos y no ve la contabilidad; arma pagos pero no los aprueba', async () => {
    expect((await como('TESORERO', 'GET', '/cash-boxes')).statusCode).toBe(200);
    expect((await como('TESORERO', 'GET', '/payment-orders')).statusCode).toBe(200);
    expect((await como('TESORERO', 'GET', '/journal-entries')).statusCode).toBe(403);
    const aprobar = await como('TESORERO', 'POST', '/payment-orders/00000000-0000-7000-8000-000000000000/aprobar', {});
    expect(aprobar.statusCode, 'sin permiso de aprobar se corta antes de buscar la orden').toBe(403);
  });

  it('el Comprador ve los pagos pero no la caja, y el Encargado de depósito no ve ni clientes ni pagos', async () => {
    expect((await como('COMPRADOR', 'GET', '/payment-orders')).statusCode).toBe(200);
    expect((await como('COMPRADOR', 'GET', '/cash-boxes')).statusCode).toBe(403);
    expect((await como('DEPOSITO', 'GET', '/parties')).statusCode).toBe(403);
    expect((await como('DEPOSITO', 'GET', '/payment-orders')).statusCode).toBe(403);
  });

  it('el Gerente ve la contabilidad en lectura y puede aprobar pagos, pero no escribe asientos', async () => {
    expect((await como('GERENTE', 'GET', '/journal-entries')).statusCode).toBe(200);
    expect((await como('GERENTE', 'POST', '/journal-entries', {})).statusCode).toBe(403);
    const c = (await como('GERENTE', 'GET', '/companies/current')).json<{ permissions: string[] }>();
    expect(c.permissions).toContain('payment_order:approve');
    expect(c.permissions).toContain('purchase_request:approve');
  });

  it('Gerente y Tesorero no pasan sin segundo factor; Vendedor, Comprador y Depósito sí', async () => {
    for (const puesto of ['GERENTE', 'TESORERO']) {
      const sinMfa = await crearPersona(puesto, false);
      const r = await env.app.inject({ method: 'GET', url: '/companies/current', headers: { authorization: `Bearer ${sinMfa}`, 'x-company-id': env.empresa } });
      expect(r.statusCode, `${puesto} sin segundo factor`).toBe(403);
    }
    for (const puesto of ['VENDEDOR', 'COMPRADOR', 'DEPOSITO']) {
      const sinMfa = await crearPersona(puesto, false);
      const r = await env.app.inject({ method: 'GET', url: '/companies/current', headers: { authorization: `Bearer ${sinMfa}`, 'x-company-id': env.empresa } });
      expect(r.statusCode, `${puesto} sin segundo factor`).toBe(200);
    }
  });

  it('el Gerente y el Tesorero de arriba no se pueden dar a alguien de otro estudio', async () => {
    // El destinatario tiene que pertenecer al estudio: ni un puesto nuevo abre esa puerta.
    const stamp = await sufijoUnico(env.db);
    const ajena = (
      await env.db.query<{ id: string }>('INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id', [`ajena-${stamp}@otro.test`, 'Ajena', hash])
    ).rows[0]!.id;
    for (const role of ['GERENTE', 'TESORERO', 'VENDEDOR']) {
      const r = await env.pedir('POST', `/companies/${env.empresa}/roles`, { userId: ajena, role });
      expect(r.statusCode, role).toBe(403);
    }
    void withCheckDigit;
  });
});
