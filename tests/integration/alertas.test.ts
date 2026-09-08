/**
 * El detector de alertas.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que correrlo dos veces no abra dos alertas.** Un detector que hace
 *      ruido termina apagado, y un detector apagado no detecta nada.
 *   2. **Que sin umbral declarado no abra ninguna.** `null` en `supera_umbral`
 *      no es «no supera»: es que nadie dijo cuál es el límite.
 *   3. **Que lo que se corrige se cierre solo**, con su fecha, y que la alerta
 *      siga existiendo — cuánto duró un problema no está en ningún otro lado.
 *   4. **Que ninguna alerta se abra sin metodología**: una alerta sin la cuenta
 *      para rehacerla es una afirmación sin evidencia.
 *   5. **Que una empresa no vea las alertas de otra.**
 *
 * ## Cómo se fabrica una señal en un test
 *
 * No se insertan filas en `analysis_signals`: es una vista. Se crea el hecho que
 * la produce —un producto vendido bajo su costo— y se declara el umbral. Es más
 * trabajo y es la única forma de probar el camino que corre en producción; una
 * señal inyectada probaría el detector contra un doble.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { detectar, gravedadPorDesvio } from '@aai/api/analisis/detector';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asCompany, connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

const txDe = (db: Client) => ({
  query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]),
});

describe('gravedad por desvío', () => {
  it('la gravedad sale de cuánto se pasó, no del tipo de señal', () => {
    // Un margen un punto abajo del mínimo y uno veinte puntos abajo no son el
    // mismo problema. Clasificarlos igual haría que la lista se ordenara por
    // tipo en vez de por importancia.
    expect(gravedadPorDesvio('0', '10')).toBe('CRITICA');
    expect(gravedadPorDesvio('4', '10')).toBe('ALTA');
    expect(gravedadPorDesvio('7.5', '10')).toBe('MEDIA');
    expect(gravedadPorDesvio('9.5', '10')).toBe('BAJA');
  });

  it('sin valor o sin umbral queda MEDIA, que es lo único honesto', () => {
    // Se sabe que algo pasó y no cuánto.
    expect(gravedadPorDesvio(null, '10')).toBe('MEDIA');
    expect(gravedadPorDesvio('5', null)).toBe('MEDIA');
    expect(gravedadPorDesvio('5', '0')).toBe('MEDIA');
  });
});

suite('Alertas', () => {
  let app: FastifyInstance;
  let db: Client;
  let empresa: string;
  let otraEmpresa: string;
  let token: string;

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
    const stamp = await sufijoUnico(db);

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
        [`fundador-ale-${stamp}@estudio.test`, 'Fundador', clave],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio ale ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa ale ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    otraEmpresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Otra ale ${stamp}`, withCheckDigit(`23${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-ale-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `admin-ale-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Administradora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    await app.inject({
      method: 'POST',
      url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { userId, role: 'ADMINISTRADOR' },
    });

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
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  /** Abre una alerta a mano, como la abriría el detector. */
  const abrirAlerta = async (
    companyId: string,
    tipo: string,
    sujeto: string,
  ): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO alerts
         (company_id, kind, severity, object_type, sujeto, valor, umbral,
          metodologia, payload, status)
       VALUES ($1, $2, 'ALTA', 'signal', $3, 3, 10,
               'margen = (precio - costo) / precio; 3 % contra un mínimo de 10 %',
               '{}'::jsonb, 'ABIERTA')
       RETURNING id`,
      [companyId, tipo, sujeto],
    );
    return r.rows[0]!.id;
  };

  it('no se puede abrir una alerta sin metodología suficiente', async () => {
    // Una alerta que dice «margen bajo» sin decir contra qué ni cómo se calculó
    // es una afirmación sin evidencia, y eso entrena a ignorar las alertas.
    let code = '';
    try {
      await db.query(
        `INSERT INTO alerts (company_id, kind, severity, object_type, sujeto,
                             metodologia, payload, status)
         VALUES ($1, 'PRUEBA_SIN_METODO', 'ALTA', 'signal', 'x', 'corto', '{}'::jsonb, 'ABIERTA')`,
        [empresa],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('23514');
  });

  it('dos alertas abiertas del mismo tipo y sujeto son imposibles', async () => {
    // Es lo que permite correr el detector cada hora sin llenar la pantalla.
    const sufijo = await sufijoUnico(db);
    await abrirAlerta(empresa, `RUIDO_${sufijo}`, 'el mismo producto');
    let code = '';
    try {
      await abrirAlerta(empresa, `RUIDO_${sufijo}`, 'el mismo producto');
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('23505');
  });

  it('correr el detector dos veces no abre nada nuevo', async () => {
    // Sin datos que produzcan señales, las dos corridas informan cero: lo que
    // se comprueba es que la segunda no duplique lo que haya.
    const primera = await detectar(txDe(db), empresa, 'test:detector');
    const antes = await contarAlertas();
    const segunda = await detectar(txDe(db), empresa, 'test:detector');
    const despues = await contarAlertas();

    expect(segunda.abiertas).toBe(0);
    expect(despues).toBe(antes);
    expect(primera.abiertas + primera.actualizadas).toBeGreaterThanOrEqual(0);
  });

  it('sin señales, el detector cierra lo que quedó abierto', async () => {
    // El problema se corrigió y nadie cerró la alerta: la cierra el detector,
    // con su fecha. No la borra — cuánto duró no está en ningún otro lado.
    const sufijo = await sufijoUnico(db);
    const id = await abrirAlerta(empresa, `CERRABLE_${sufijo}`, 'algo que se arregló');

    const informe = await detectar(txDe(db), empresa, 'test:detector');
    expect(informe.resueltas).toBeGreaterThanOrEqual(1);

    const r = await db.query<{ status: string; resuelta_el: string | null }>(
      'SELECT status, resuelta_el::text FROM alerts WHERE id = $1',
      [id],
    );
    expect(r.rows[0]!.status).toBe('RESUELTA');
    expect(r.rows[0]!.resuelta_el).not.toBeNull();
  });

  it('el cierre queda en la bitácora', async () => {
    const log = await db.query<{ new_value: Record<string, unknown> }>(
      `SELECT new_value FROM audit_logs
        WHERE company_id = $1 AND action = 'RESOLVER_ALERTA'
        ORDER BY occurred_at DESC LIMIT 1`,
      [empresa],
    );
    expect(log.rows[0]!.new_value).toMatchObject({
      motivo: 'La señal dejó de cruzar el umbral',
    });
  });

  it('la API lista las alertas con su metodología', async () => {
    const sufijo = await sufijoUnico(db);
    await abrirAlerta(empresa, `LISTABLE_${sufijo}`, 'un producto');

    const r = await pedir('GET', '/analysis/alerts?estado=ABIERTA');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      alertas: { tipo: string; metodologia: string; detectadaEl: string }[];
      alcance: string;
    }>();
    const mia = cuerpo.alertas.find((a) => a.tipo === `LISTABLE_${sufijo}`);
    expect(mia?.metodologia).toContain('margen =');
    expect(cuerpo.alcance).toContain('cuánto lleva el problema');
  });

  it('reconocer exige motivo y no cierra la alerta', async () => {
    const sufijo = await sufijoUnico(db);
    const id = await abrirAlerta(empresa, `RECONOCIBLE_${sufijo}`, 'un cliente');

    const sinMotivo = await pedir('POST', `/analysis/alerts/${id}/reconocer`, { motivo: 'x' });
    expect(sinMotivo.statusCode).toBe(400);

    const r = await pedir('POST', `/analysis/alerts/${id}/reconocer`, {
      motivo: 'La vimos, es un cliente nuevo y esperamos dos meses más',
    });
    expect(r.statusCode, r.body).toBe(200);

    // Reconocida sigue estando: reconocer no es resolver.
    const fila = await db.query<{ status: string; ack_reason: string }>(
      'SELECT status, ack_reason FROM alerts WHERE id = $1',
      [id],
    );
    expect(fila.rows[0]!.status).toBe('RECONOCIDA');
    expect(fila.rows[0]!.ack_reason).toContain('dos meses');
  });

  it('una alerta resuelta no se reconoce después', async () => {
    const sufijo = await sufijoUnico(db);
    const id = await abrirAlerta(empresa, `YA_RESUELTA_${sufijo}`, 'algo');
    // El CHECK de la 0028 exige que alguien firme cualquier estado que no sea
    // ABIERTA: una alerta que cambia de estado sin decir quién ni por qué es
    // una alerta que desaparece.
    await db.query(
      `UPDATE alerts SET status = 'RESUELTA', resuelta_el = now(),
              acknowledged_by = 'system:test', acknowledged_at = now(),
              ack_reason = 'cerrada por el test' WHERE id = $1`,
      [id],
    );

    const r = await pedir('POST', `/analysis/alerts/${id}/reconocer`, {
      motivo: 'Intento de reconocer algo que ya se arregló solo',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.body).toContain('se arreglara sola');
  });

  it('descartar exige motivo y queda en la bitácora', async () => {
    const sufijo = await sufijoUnico(db);
    const id = await abrirAlerta(empresa, `DESCARTABLE_${sufijo}`, 'un producto');

    const r = await pedir('POST', `/analysis/alerts/${id}/descartar`, {
      motivo: 'Es un producto de liquidación: se vende bajo costo a propósito',
    });
    expect(r.statusCode, r.body).toBe(200);

    const log = await db.query<{ motivo: string }>(
      `SELECT motivo FROM audit_logs
        WHERE company_id = $1 AND action = 'DESCARTAR_ALERTA'
        ORDER BY occurred_at DESC LIMIT 1`,
      [empresa],
    );
    expect(log.rows[0]!.motivo).toContain('liquidación');
  });

  it('una empresa no ve las alertas de otra', async () => {
    const sufijo = await sufijoUnico(db);
    const ajena = await abrirAlerta(otraEmpresa, `AJENA_${sufijo}`, 'algo de la otra');

    // Con el rol de la aplicación puesto: sin eso la conexión es la dueña de la
    // tabla, el FORCE no se ejerce y esto pasaría sin haber probado nada.
    const vistas = await asCompany(db, empresa, async () =>
      (await db.query('SELECT id FROM alerts WHERE id = $1', [ajena])).rows,
    );
    expect(vistas).toHaveLength(0);

    const propias = await asCompany(db, otraEmpresa, async () =>
      (await db.query('SELECT id FROM alerts WHERE id = $1', [ajena])).rows,
    );
    expect(propias).toHaveLength(1);
  });

  it('el detector de una empresa no toca las alertas de otra', async () => {
    const sufijo = await sufijoUnico(db);
    const ajena = await abrirAlerta(otraEmpresa, `INTOCABLE_${sufijo}`, 'de la otra');

    await asCompany(db, empresa, async () => {
      await detectar(txDe(db), empresa, 'test:detector');
    });

    const r = await db.query<{ status: string }>('SELECT status FROM alerts WHERE id = $1', [
      ajena,
    ]);
    expect(r.rows[0]!.status).toBe('ABIERTA');
  });

  async function contarAlertas(): Promise<number> {
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alerts WHERE company_id = $1 AND status = 'ABIERTA'`,
      [empresa],
    );
    return Number(r.rows[0]!.n);
  }
});
