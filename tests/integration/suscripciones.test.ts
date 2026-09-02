/**
 * Suscripciones del propio NEXO.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que no haya precios ni datos de tarjeta.** Ni en el esquema ni en las
 *      respuestas. El precio es una decisión comercial sin tomar; los datos de
 *      tarjeta no se guardan nunca.
 *   2. **Que el límite no bloquee.** Excedido el plan, la empresa sigue
 *      pudiendo registrar comprobantes: los libros no se dejan incompletos por
 *      una cuestión comercial.
 *   3. **Que un tope sin declarar no sea «ilimitado».** Se informa como
 *      `SIN_TOPE_DECLARADO`, que no es lo mismo que estar dentro del tope.
 *   4. **Que el uso se cuente, no se guarde.**
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

interface Recurso {
  readonly recurso: string;
  readonly uso: number;
  readonly tope: number | null;
  readonly estado: string;
}

interface Suscripcion {
  readonly plan: { id: string; codigo: string; estado: string } | null;
  readonly recursos: Recurso[];
  readonly historial: { planCodigo: string; estado: string }[];
  readonly alcance: string;
}

suite('Suscripciones', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let cuitCliente: string;
  let planPyme: string;
  let numeroCbte = 9000;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  const haceDias = (dias: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
  };

  const ver = async (): Promise<Suscripcion> =>
    (await pedir('GET', '/subscription')).json<Suscripcion>();

  /** Una venta cualquiera, para mover el contador de comprobantes del mes. */
  const venta = async (): Promise<void> => {
    numeroCbte += 1;
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="sub-${stamp}-${numeroCbte}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<comprobante><n>${numeroCbte}</n></comprobante>\r\n--X--\r\n`;

    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);

    const op = await pedir('POST', `/documents/${subida.json<{ id: string }>().id}/tax-transaction`, {
      direction: 'VENTAS',
      cbteTipo: 1,
      puntoVenta: 1,
      numero: numeroCbte,
      fecha: hoy,
      cuitContraparte: cuitCliente,
      razonSocial: 'Cliente',
      condicionIva: 'RESPONSABLE_INSCRIPTO',
      neto: '1000.00', iva: '0', noGravado: '0', exento: '0', percepciones: '0',
      total: '1000.00',
    });
    expect(op.statusCode, op.body).toBe(201);
  };

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
          `fundador-sub-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio sub ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa sub ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-sub-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `admin-sub-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Administradora', password: PASSWORD, level: 'MEMBER' },
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

    cuitCliente = `30${stamp}${cuitCheckDigit(`30${stamp}`)}`;
    const anio = new Date().getUTCFullYear();
    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ${anio}-${stamp}`,
        startDate: `${anio}-01-01`,
        endDate: `${anio}-12-31`,
      })).statusCode,
    ).toBe(201);

    planPyme = (
      await db.query<{ id: string }>(
        `SELECT id FROM subscription_plans WHERE code = 'PYME'`,
      )
    ).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('el esquema no tiene precios ni datos de tarjeta', async () => {
    const columnas = (
      await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name IN ('subscription_plans', 'plan_limits', 'company_subscriptions')`,
      )
    ).rows.map((c) => `${c.table_name}.${c.column_name}`);

    // El precio es una decisión comercial sin tomar (§15). Los datos de tarjeta
    // no se guardan nunca (§13 de la definición SaaS).
    for (const prohibida of [
      'precio', 'importe', 'monto', 'moneda', 'tarjeta', 'card', 'cvv', 'vencimiento_tarjeta',
    ]) {
      expect(
        columnas.filter((c) => c.includes(prohibida)),
        `ninguna columna con «${prohibida}»`,
      ).toHaveLength(0);
    }
  });

  it('los planes se listan sin precios, y sin topes no son «ilimitados»', async () => {
    const r = await pedir('GET', '/subscription-plans');
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json<{
      planes: { codigo: string; topes: unknown[] }[];
      alcance: string;
    }>();

    expect(p.planes.map((x) => x.codigo)).toEqual([
      'GRATUITO', 'PYME', 'PROFESIONAL', 'EMPRESA', 'CONTADOR',
    ]);
    // Ningún tope sembrado: cuántos usuarios entran en el plan Pyme es una
    // decisión comercial, y ponerle un número la tomaría por quien corresponde.
    for (const plan of p.planes) expect(plan.topes).toHaveLength(0);
    expect(p.alcance).toContain('no está');
    expect(JSON.stringify(p.planes)).not.toContain('precio');
  });

  it('una empresa sin plan aparece en la bandeja y no se le impide operar', async () => {
    const s = await ver();
    expect(s.plan).toBeNull();

    const items = (await pedir('GET', '/work-queue?entidad=company_subscriptions&limite=200'))
      .json<{ items: { rama: string; bloquea: boolean; evidenciaFaltante: string[] | null }[] }>()
      .items;
    const aviso = items.find((i) => i.rama === 'EMPRESA_SIN_PLAN');
    expect(aviso).toBeDefined();
    expect(aviso!.bloquea, 'no bloquea: los libros no se dejan incompletos').toBe(false);
    expect(aviso!.evidenciaFaltante).toContain('PLAN');

    // Y de hecho puede facturar sin plan.
    await venta();
  });

  it('el uso se cuenta en el momento: no hay contadores guardados', async () => {
    expect(
      (await pedir('POST', '/subscription', { plan: 'PYME', vigenciaDesde: haceDias(10) }))
        .statusCode,
    ).toBe(201);

    const s = await ver();
    expect(s.plan!.codigo).toBe('PYME');

    const comprobantes = s.recursos.find((x) => x.recurso === 'COMPROBANTES_MES')!;
    expect(comprobantes.uso, 'la venta de recién ya está contada').toBe(1);

    await venta();
    const despues = await ver();
    expect(
      despues.recursos.find((x) => x.recurso === 'COMPROBANTES_MES')!.uso,
      'sin tocar ningún contador',
    ).toBe(2);

    const columnas = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'company_subscriptions'`,
      )
    ).rows.map((c) => c.column_name);
    for (const prohibida of ['usuarios', 'comprobantes', 'documentos', 'uso']) {
      expect(columnas, `un contador de ${prohibida} se desincroniza y nadie se entera`)
        .not.toContain(prohibida);
    }
  });

  it('un tope sin declarar no es «ilimitado»', async () => {
    const s = await ver();
    for (const r of s.recursos) {
      expect(r.tope).toBeNull();
      expect(r.estado, 'nadie escribió el tope: no es «dentro del tope»')
        .toBe('SIN_TOPE_DECLARADO');
    }

    // Y sin topes declarados la bandeja no llama exceso a nada.
    const items = (await pedir('GET', '/work-queue?entidad=company_subscriptions&limite=200'))
      .json<{ items: { rama: string }[] }>().items;
    expect(items.some((i) => i.rama === 'PLAN_EXCEDIDO')).toBe(false);
  });

  it('excedido el tope declarado, avisa y no bloquea', async () => {
    // La empresa declara su propio tope: un comprobante por mes, que ya está
    // superado por las dos ventas de antes.
    await db.query(
      `INSERT INTO plan_limits (plan_id, recurso, tope, declarado_por)
       VALUES ($1, 'COMPROBANTES_MES', 1, 'test')`,
      [planPyme],
    );

    const s = await ver();
    const c = s.recursos.find((x) => x.recurso === 'COMPROBANTES_MES')!;
    expect(c.tope).toBe(1);
    expect(c.estado).toBe('EXCEDIDO');

    const items = (await pedir('GET', '/work-queue?entidad=company_subscriptions&limite=200'))
      .json<{ items: { rama: string; bloquea: boolean; disponibilidad: string }[] }>().items;
    const aviso = items.find((i) => i.rama === 'PLAN_EXCEDIDO');
    expect(aviso).toBeDefined();
    expect(aviso!.bloquea).toBe(false);
    expect(aviso!.disponibilidad, 'lo resuelve alguien de afuera del sistema contable')
      .toBe('INFORMATIVO');

    // **Lo importante**: sigue pudiendo registrar. Un sistema contable que se
    // niega a asentar un hecho por una cuestión comercial deja los libros
    // incompletos, y eso no se arregla pagando.
    await venta();
    expect((await ver()).recursos.find((x) => x.recurso === 'COMPROBANTES_MES')!.uso).toBe(3);

    await db.query(`DELETE FROM plan_limits WHERE plan_id = $1`, [planPyme]);
  });

  it('dos planes vigentes a la vez no se aceptan', async () => {
    const r = await pedir('POST', '/subscription', {
      plan: 'PROFESIONAL', vigenciaDesde: hoy,
    });
    // Con dos, el tope aplicable saldría por orden de carga.
    expect(r.statusCode).toBe(409);
  });

  it('suspender exige motivo y no toca ni un dato del cliente', async () => {
    const s = await ver();

    const sinMotivo = await pedir('POST', `/subscription/${s.plan!.id}/estado`, {
      estado: 'SUSPENDIDA',
    });
    expect(sinMotivo.statusCode).toBe(400);

    const antes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tax_transactions WHERE company_id = $1',
      [empresa],
    );

    const r = await pedir('POST', `/subscription/${s.plan!.id}/estado`, {
      estado: 'SUSPENDIDA', motivo: 'Falta de pago informada por el proveedor de cobros',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ alcance: string }>().alcance).toContain('no toca ni un dato del cliente');

    const despues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tax_transactions WHERE company_id = $1',
      [empresa],
    );
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);

    // Y la suspensión llega a la bandeja como informativa: quien la resuelve no
    // está adentro del sistema contable.
    const items = (await pedir('GET', '/work-queue?entidad=company_subscriptions&limite=200'))
      .json<{ items: { rama: string; disponibilidad: string }[] }>().items;
    const aviso = items.find((i) => i.rama === 'SUSCRIPCION_SUSPENDIDA');
    expect(aviso).toBeDefined();
    expect(aviso!.disponibilidad).toBe('INFORMATIVO');

    // Con el plan suspendido, la empresa sigue registrando.
    await venta();
  });

  it('las vistas de suscripción conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('subscription_usage', 'subscription_status',
                          'work_queue_suscripcion')`,
    );
    expect(r.rowCount).toBe(3);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
