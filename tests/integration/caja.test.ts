/**
 * Caja y arqueo.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que el saldo teórico no se pueda escribir.** No hay columna ni
 *      endpoint: sale de sumar los movimientos al inicial declarado. Una
 *      columna guardada sería una segunda verdad, y cuando dos verdades se
 *      contradicen la que gana es la que alguien tipeó.
 *   2. **Que la diferencia no necesite umbral.** `contado - teórico` distinto
 *      de cero es un hecho aritmético y va a la bandeja sin que nadie declare
 *      cuánto es mucho. Es lo contrario de las señales (0058), donde sin
 *      umbral declarado no se afirma nada.
 *   3. **Que arquear no toque el Mayor.** Cerrar una caja no crea ningún
 *      asiento: el movimiento de caja del período lo firma una persona.
 *   4. **Que los candados vivan en la base.** Agregarle un movimiento a una
 *      sesión ya arqueada tiene que ser imposible por SQL directo, no solo por
 *      el camino que pasa por la API.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

interface Sesion {
  readonly id: string;
  readonly status: string;
  readonly saldoInicial: string;
  readonly ingresos: string;
  readonly egresos: string;
  readonly saldoTeorico: string;
  readonly saldoContado: string | null;
  readonly diferencia: string | null;
}

suite('Caja y arqueo', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let cajaId: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const hoy = new Date().toISOString().slice(0, 10);

  const enDias = (dias: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  };

  const sesion = async (id: string): Promise<Sesion> =>
    (await pedir('GET', `/cash-sessions/${id}`)).json<{ sesion: Sesion }>().sesion;

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
          `fundador-caja-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio caja ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa caja ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-caja-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `cajera-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Cajera', password: PASSWORD, level: 'MEMBER' },
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

    // La cuenta contable de la caja: es lo que permite comparar el efectivo
    // real contra el Mayor sin que este módulo escriba un asiento.
    expect(
      (await pedir('POST', '/accounts', { code: '1.1.01', name: 'Caja', type: 'ACTIVO' }))
        .statusCode,
    ).toBe(201);

    const alta = await pedir('POST', '/cash-boxes', {
      codigo: `CAJA-${stamp}`,
      nombre: 'Caja mostrador',
      cuenta: '1.1.01',
    });
    expect(alta.statusCode, alta.body).toBe(201);
    cajaId = alta.json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('el saldo teórico se deriva de los movimientos y no existe como columna', async () => {
    const abierta = await pedir('POST', '/cash-sessions', {
      cajaId, fecha: hoy, saldoInicial: '1000.00',
    });
    expect(abierta.statusCode).toBe(201);
    const id = abierta.json<{ id: string }>().id;

    // Lo primero: que no haya dónde escribirlo. Si mañana alguien agrega la
    // columna «para que la consulta sea más rápida», este test lo dice antes
    // de que las dos verdades tengan tiempo de separarse.
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cash_sessions'`,
    );
    const nombres = columnas.rows.map((c) => c.column_name);
    expect(nombres, 'el teórico es derivado: guardarlo sería una segunda verdad')
      .not.toContain('saldo_teorico');
    expect(nombres, 'la diferencia también se deriva').not.toContain('diferencia');
    expect(nombres, 'lo declarado sí se guarda: sale de contar billetes')
      .toContain('saldo_contado');

    expect(
      (await pedir('POST', `/cash-sessions/${id}/movimientos`, {
        tipo: 'INGRESO', importe: '500.50', fecha: hoy, concepto: 'Venta de mostrador',
      })).statusCode,
    ).toBe(201);
    expect(
      (await pedir('POST', `/cash-sessions/${id}/movimientos`, {
        tipo: 'EGRESO', importe: '200.25', fecha: hoy, concepto: 'Flete al depósito',
      })).statusCode,
    ).toBe(201);

    const s = await sesion(id);
    expect(s.ingresos).toBe('500.50');
    expect(s.egresos).toBe('200.25');
    expect(s.saldoTeorico, '1000 + 500.50 - 200.25').toBe('1300.25');

    // Mientras no se contó, la diferencia es `null` y no cero: cero afirmaría
    // que coincidía, y nadie miró todavía.
    expect(s.saldoContado).toBeNull();
    expect(s.diferencia, '«no se contó» no es «coincidió»').toBeNull();
  });

  it('un movimiento sin concepto no se registra', async () => {
    const abierta = await pedir('POST', '/cash-sessions', {
      cajaId: (await pedir('POST', '/cash-boxes', {
        codigo: `CAJA-CONCEPTO-${stamp}`, nombre: 'Caja auxiliar',
      })).json<{ id: string }>().id,
      fecha: hoy,
      saldoInicial: '0.00',
    });
    const id = abierta.json<{ id: string }>().id;

    // Plata que se movió porque sí: al arquear nadie puede reconstruir qué pasó.
    const sinConcepto = await pedir('POST', `/cash-sessions/${id}/movimientos`, {
      tipo: 'INGRESO', importe: '10.00', fecha: hoy, concepto: '',
    });
    expect(sinConcepto.statusCode).toBe(400);
  });

  it('una caja no puede tener dos sesiones abiertas', async () => {
    const segunda = await pedir('POST', '/cash-sessions', {
      cajaId, fecha: hoy, saldoInicial: '0.00',
    });

    // Con dos, un movimiento no sabría a cuál pertenece y el arqueo dejaría de
    // significar algo.
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json<{ message: string }>().message).toContain('sesión abierta');
  });

  it('arquear registra la diferencia, la lleva a la bandeja y no escribe ningún asiento', async () => {
    const abiertas = (await pedir('GET', '/cash-sessions?status=ABIERTA'))
      .json<{ sesiones: { id: string; cajaCodigo: string }[] }>().sesiones;
    const id = abiertas.find((s) => s.cajaCodigo === `CAJA-${stamp}`)!.id;

    const asientosAntes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
      [empresa],
    );

    // Se contó menos de lo que decía el libro: faltan 300.25.
    const cierre = await pedir('POST', `/cash-sessions/${id}/close`, {
      fecha: hoy, saldoContado: '1000.00',
    });
    expect(cierre.statusCode).toBe(200);
    const r = cierre.json<{ saldoTeorico: string; diferencia: string; alcance: string }>();
    expect(r.saldoTeorico).toBe('1300.25');
    expect(r.diferencia).toBe('-300.25');

    const s = await sesion(id);
    expect(s.status).toBe('CERRADA');
    expect(s.diferencia, 'la diferencia queda escrita, no se corrige').toBe('-300.25');

    // No hay umbral declarado en ningún lado: la resta que no da cero es un
    // hecho, y alcanza para pedir una explicación.
    const items = (await pedir('GET', '/work-queue?entidad=cash_sessions&limite=200'))
      .json<{ items: { rama: string; entityId: string; evidenciaFaltante: string[] | null }[] }>()
      .items;
    const aviso = items.find((i) => i.rama === 'ARQUEO_CON_DIFERENCIA' && i.entityId === id);
    expect(aviso, 'la diferencia llega a la bandeja sin umbral declarado').toBeDefined();
    expect(aviso!.evidenciaFaltante, 'y lo que falta es la explicación').toContain('EXPLICACION');

    const asientosDespues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM journal_entries WHERE company_id = $1',
      [empresa],
    );
    expect(asientosDespues.rows[0]!.n, 'arquear no escribe en el Mayor')
      .toBe(asientosAntes.rows[0]!.n);
  });

  it('una sesión cerrada no admite movimientos nuevos, ni por SQL directo', async () => {
    const cerradas = (await pedir('GET', '/cash-sessions?status=CERRADA'))
      .json<{ sesiones: { id: string; cajaCodigo: string }[] }>().sesiones;
    const id = cerradas.find((s) => s.cajaCodigo === `CAJA-${stamp}`)!.id;

    const porApi = await pedir('POST', `/cash-sessions/${id}/movimientos`, {
      tipo: 'INGRESO', importe: '1.00', fecha: hoy, concepto: 'Tardío',
    });
    expect(porApi.statusCode).toBe(409);

    // Y el candado vive en la base: un movimiento nuevo cambiaría el teórico
    // contra el que se contó, y dejaría la diferencia sin sentido.
    await expect(
      db.query(
        `INSERT INTO cash_movements
           (company_id, session_id, tipo, importe, fecha, concepto, created_by)
         VALUES ($1,$2,'INGRESO','1.00',$3,'Por la ventana','test')`,
        [empresa, id, hoy],
      ),
    ).rejects.toThrow(/E_CAJA_CERRADA/);

    // Cerrar dos veces tampoco: se arquea una sola vez.
    const otraVez = await pedir('POST', `/cash-sessions/${id}/close`, {
      fecha: hoy, saldoContado: '1300.25',
    });
    expect(otraVez.statusCode).toBe(409);
  });

  it('el libro de caja no se edita ni se borra', async () => {
    const mov = await db.query<{ id: string }>(
      'SELECT id FROM cash_movements WHERE company_id = $1 LIMIT 1',
      [empresa],
    );
    const id = mov.rows[0]!.id;

    await expect(
      db.query('UPDATE cash_movements SET importe = 1 WHERE id = $1', [id]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM cash_movements WHERE id = $1', [id]),
    ).rejects.toThrow();
  });

  it('una caja que quedó abierta de ayer va a la bandeja', async () => {
    const caja = (await pedir('POST', '/cash-boxes', {
      codigo: `CAJA-AYER-${stamp}`, nombre: 'Caja que quedó abierta',
    })).json<{ id: string }>().id;

    const id = (await pedir('POST', '/cash-sessions', {
      cajaId: caja, fecha: enDias(-3), saldoInicial: '100.00',
    })).json<{ id: string }>().id;

    const items = (await pedir('GET', '/work-queue?entidad=cash_sessions&limite=200'))
      .json<{ items: { rama: string; entityId: string }[] }>().items;

    // Es una comparación de fechas, no un umbral: una caja que quedó abierta de
    // ayer ya no se puede arquear contando, porque lo que había ayer no está.
    expect(
      items.find((i) => i.rama === 'CAJA_SIN_CERRAR' && i.entityId === id),
      'la caja sin arquear llega a la bandeja',
    ).toBeDefined();
  });

  it('lo disponible suma el teórico de las cajas abiertas y el Mayor de los bancos', async () => {
    const r = await pedir('GET', '/analysis/disponible');
    expect(r.statusCode).toBe(200);
    const d = r.json<{
      porFuente: { fuente: string; saldo: string }[];
      total: string;
      alcance: string;
    }>();

    const caja = d.porFuente.find((f) => f.fuente === 'CAJA');
    expect(caja, 'el efectivo es una fuente propia, separada de bancos').toBeDefined();
    // Solo la sesión de tres días atrás sigue abierta: la otra se arqueó.
    expect(caja!.saldo).toBe('100.00');
    expect(d.porFuente.some((f) => f.fuente === 'BANCOS')).toBe(true);
    expect(d.alcance, 'bancos es el Mayor, no el extracto').toContain('Mayor');
  });

  it('el flujo de fondos arranca desde lo disponible (ADR-018)', async () => {
    const r = await pedir('GET', '/analysis/flujo-de-fondos');
    expect(r.statusCode).toBe(200);
    const f = r.json<{
      puntoDePartida: { fuente: string; saldo: string }[] | null;
      saldoProyectado: { tramo: string; neto: string; saldo: string }[] | null;
      sinPuntoDePartida: string | null;
    }>();

    // Sin punto de partida, «entra 100 y sale 80» no contesta «¿llego a fin de
    // mes?»: falta saber que había 5. Es lo que este módulo le aporta a la
    // capa de decisión.
    expect(f.sinPuntoDePartida).toBeNull();
    expect(f.puntoDePartida).not.toBeNull();
    expect(f.puntoDePartida!.some((p) => p.fuente === 'CAJA')).toBe(true);

    expect(f.saldoProyectado).not.toBeNull();
    expect(f.saldoProyectado!.map((t) => t.tramo))
      .toEqual(['VENCIDO', 'PROXIMOS_30', 'DE_31_A_60', 'MAS_DE_60']);

    // Esta empresa no tiene comprobantes: no hay nada proyectado que sumar ni
    // restar, así que los cuatro tramos valen exactamente el punto de partida.
    // La comparación es contra el string exacto que devuelve `numeric`: pasar
    // plata por IEEE 754 para compararla sería perder lo que este esquema
    // cuida en todas las demás cifras.
    const disponible = (await pedir('GET', '/analysis/disponible'))
      .json<{ total: string }>().total;
    for (const tramo of f.saldoProyectado!) {
      expect(tramo.neto, `${tramo.tramo}: sin comprobantes no hay nada proyectado`).toBe('0');
      expect(tramo.saldo, `${tramo.tramo} arranca del disponible`).toBe(disponible);
    }
  });

  it('las vistas de caja conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('cash_session_status', 'analytics_disponible', 'work_queue_caja')`,
    );
    expect(r.rowCount).toBe(3);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
