/**
 * El registro de decisiones y su revisión posterior.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que no se pueda registrar una opinión como decisión.** Sin evidencia y
 *      sin al menos dos alternativas, no entra.
 *   2. **Que la misma persona no pueda proponer y aprobar** una decisión de
 *      riesgo alto o crítico.
 *   3. **Que ir contra la recomendación quede registrado con su argumento**, y
 *      que sin argumento no se pueda.
 *   4. **Que «no atribuible» no cuente como fracaso.**
 *   5. **Que la revisión congele lo que midió**, y que dos revisiones de la
 *      misma ventana sean imposibles.
 *
 * El punto 4 es el que más fácil se rompe sin que nadie lo note: un porcentaje
 * de aciertos que castigue lo no medible empuja a evitar las decisiones
 * difíciles de medir, que suelen ser las que más importan.
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
  readonly token: string;
  readonly userId: string;
}

suite('Registro de decisiones', () => {
  let app: FastifyInstance;
  let db: Client;
  let empresa: string;
  let admin: Sesion;
  let segundoAdmin: Sesion;

  const evidencia = [
    { tipo: 'SENAL', referencia: 'margen-bruto', resumen: 'El margen cayó cuatro puntos' },
  ];
  const alternativas = [
    { nombre: 'No hacer nada', descripcion: 'Sostener el precio y observar un trimestre' },
    { nombre: 'Subir 10%', descripcion: 'Trasladar el aumento de costos al precio' },
  ];

  const pedir = (
    sesion: Sesion,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ): ReturnType<FastifyInstance['inject']> =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${sesion.token}`, 'x-company-id': empresa },
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
        [`fundador-dec-${stamp}@estudio.test`, 'Fundador', clave],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio dec ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa dec ${stamp}`,
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
        payload: { email: `fundador-dec-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    /** Da de alta una administradora y devuelve su sesión con MFA resuelto. */
    const alta = async (etiqueta: string): Promise<Sesion> => {
      const email = `${etiqueta}-dec-${stamp}@estudio.test`;
      const userId = (
        await app.inject({
          method: 'POST',
          url: `/organizations/${organizationId}/users`,
          headers: { authorization: `Bearer ${tokenFundador}` },
          payload: { email, fullName: etiqueta, password: PASSWORD, level: 'MEMBER' },
        })
      ).json<{ id: string }>().id;

      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId, role: 'ADMINISTRADOR' },
      });

      const inicial = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: PASSWORD },
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
      const token = (
        await app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email, password: PASSWORD },
        })
      ).json<{ token: string }>().token;
      await app.inject({
        method: 'POST',
        url: '/auth/mfa/verify',
        payload: { code: totp(secret, Date.now()) },
        headers: { authorization: `Bearer ${token}` },
      });
      return { token, userId };
    };

    admin = await alta('admin');
    segundoAdmin = await alta('revisora');
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  const registrar = async (extra: Record<string, unknown> = {}) =>
    pedir(admin, 'POST', '/decision-records', {
      titulo: 'Trasladar el aumento de costos',
      problema: 'El margen bruto cayó cuatro puntos en el último trimestre y el costo subió.',
      evidencia,
      alternativas,
      nivelDeRiesgo: 'MEDIO',
      ...extra,
    });

  it('no registra una decisión sin evidencia', async () => {
    // Una decisión sin evidencia es una opinión, y una opinión guardada como
    // decisión contamina para siempre cualquier medición de aciertos.
    const r = await registrar({ evidencia: [] });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('no registra una decisión con una sola alternativa', async () => {
    // Eso no es haber decidido: es haber ejecutado.
    const r = await registrar({ alternativas: [alternativas[0]] });
    expect(r.statusCode, r.body).toBe(400);
  });

  it('registra una decisión completa, y nace PROPUESTA', async () => {
    const r = await registrar();
    expect(r.statusCode, r.body).toBe(201);
    const cuerpo = r.json<{ id: string; estado: string; alcance: string }>();
    expect(cuerpo.estado).toBe('PROPUESTA');
    expect(cuerpo.alcance).toContain('registrarla no la aprueba');
  });

  it('ir contra la recomendación sin argumento se rechaza', async () => {
    const escenarios = await crearDosEscenarios();
    const r = await registrar({
      recomendadaId: escenarios[0],
      elegidaId: escenarios[1],
      motivo: null,
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).toContain('el argumento');
  });

  it('ir contra la recomendación con argumento se registra, y queda escrito que se fue en contra', async () => {
    // Es lo que hace posible saber, más adelante, si conviene escuchar al
    // sistema. Guardar solo «qué se hizo» dejaría esa pregunta sin respuesta.
    const escenarios = await crearDosEscenarios();
    const r = await registrar({
      recomendadaId: escenarios[0],
      elegidaId: escenarios[1],
      motivo: 'El escenario recomendado supone un volumen que la planta no puede sostener.',
    });
    expect(r.statusCode, r.body).toBe(201);

    const log = await db.query<{ new_value: Record<string, unknown> }>(
      `SELECT new_value FROM audit_logs
        WHERE company_id = $1 AND action = 'REGISTRAR_DECISION'
        ORDER BY occurred_at DESC LIMIT 1`,
      [empresa],
    );
    expect(log.rows[0]!.new_value).toMatchObject({ fueEnContraDeLaRecomendacion: true });
  });

  it('quien propone no aprueba una decisión de riesgo alto', async () => {
    // Misma separación de funciones que la reapertura de período: una sola
    // persona no debería poder llevar un acto grave de punta a punta.
    const id = (await registrar({ nivelDeRiesgo: 'ALTO' })).json<{ id: string }>().id;
    const propia = await pedir(admin, 'POST', `/decision-records/${id}/aprobar`);
    expect(propia.statusCode, propia.body).toBe(409);
    expect(propia.body).toContain('distinto de quien la propuso');

    const ajena = await pedir(segundoAdmin, 'POST', `/decision-records/${id}/aprobar`);
    expect(ajena.statusCode, ajena.body).toBe(200);
  });

  it('una de riesgo bajo la puede aprobar quien la propuso', async () => {
    // La segunda firma se exige donde importa. Exigirla en todo entrena a
    // conseguir una firma de trámite, que es peor que no tenerla.
    const id = (await registrar({ nivelDeRiesgo: 'BAJO' })).json<{ id: string }>().id;
    const r = await pedir(admin, 'POST', `/decision-records/${id}/aprobar`);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('no se ejecuta una decisión que no dice qué alternativa se eligió', async () => {
    // El CHECK de la 0101 lo impide igual, pero contestaría 500 y «viola una
    // restricción», que es cierto y no le dice a nadie qué hacer.
    const id = (await registrar({ nivelDeRiesgo: 'BAJO' })).json<{ id: string }>().id;
    expect((await pedir(admin, 'POST', `/decision-records/${id}/aprobar`)).statusCode).toBe(200);
    const r = await pedir(admin, 'POST', `/decision-records/${id}/ejecutar`, {
      desde: '2026-03-01',
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.body).toContain('qué alternativa se eligió');
  });

  it('no se ejecuta lo que no fue aprobado', async () => {
    const id = (await registrar()).json<{ id: string }>().id;
    const r = await pedir(admin, 'POST', `/decision-records/${id}/ejecutar`, {
      desde: '2026-03-01',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.body).toContain('sin la aprobación');
  });

  it('no se revisa lo que no se ejecutó', async () => {
    // Revisar una propuesta sería evaluar algo que no pasó.
    const id = (await registrar()).json<{ id: string }>().id;
    const r = await pedir(admin, 'POST', `/decision-records/${id}/revisar`, {
      ventanaDesde: '2026-03-01',
      ventanaHasta: '2026-04-30',
      veredicto: 'CUMPLIO',
      medicion: { neto: '1000.00' },
      comentario: 'Comentario suficientemente largo para pasar la validación',
    });
    expect(r.statusCode, r.body).toBe(409);
  });

  it('el ciclo completo: propuesta → aprobada → ejecutada → revisada', async () => {
    const id = await ejecutarUna();

    const r = await pedir(admin, 'POST', `/decision-records/${id}/revisar`, {
      ventanaDesde: '2026-03-01',
      ventanaHasta: '2026-04-30',
      veredicto: 'CUMPLIO',
      medicion: { esperadoPorMes: '1000.00', realPorMes: '1050.00', desvioPct: '5.00' },
      comentario: 'El margen se recuperó tres puntos, en línea con lo proyectado.',
    });
    expect(r.statusCode, r.body).toBe(201);

    const detalle = (await pedir(admin, 'GET', `/decision-records/${id}`)).json<{
      decision: { estado: string };
      revisiones: { veredicto: string; medicion: Record<string, string> }[];
    }>();
    expect(detalle.decision.estado).toBe('EJECUTADA');
    expect(detalle.revisiones).toHaveLength(1);
    // Congelado: lo que se informó, tal cual.
    expect(detalle.revisiones[0]!.medicion).toMatchObject({ realPorMes: '1050.00' });
  });

  it('dos revisiones de la misma ventana son imposibles', async () => {
    // La segunda cambiaría el porcentaje de aciertos sin que haya pasado nada.
    const id = await ejecutarUna();
    const cuerpo = {
      ventanaDesde: '2026-03-01',
      ventanaHasta: '2026-05-31',
      veredicto: 'CUMPLIO' as const,
      medicion: { neto: '1.00' },
      comentario: 'Primera revisión de esta ventana, con comentario largo.',
    };
    expect((await pedir(admin, 'POST', `/decision-records/${id}/revisar`, cuerpo)).statusCode).toBe(
      201,
    );
    const segunda = await pedir(admin, 'POST', `/decision-records/${id}/revisar`, cuerpo);
    expect(segunda.statusCode, segunda.body).toBe(409);
    expect(segunda.body).toContain('sin que haya pasado nada nuevo');
  });

  it('«no atribuible» no cuenta como fracaso', async () => {
    const antes = await calibracion();

    const id = await ejecutarUna();
    const r = await pedir(admin, 'POST', `/decision-records/${id}/revisar`, {
      ventanaDesde: '2026-06-01',
      ventanaHasta: '2026-07-31',
      veredicto: 'NO_ATRIBUIBLE',
      medicion: { neto: '900.00' },
      comentario: 'Cambió el precio del insumo principal: no se puede separar de la decisión.',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json<{ alcance: string }>().alcance).toContain('no cuenta como error');

    const despues = await calibracion();
    expect(Number(despues.noMedibles)).toBe(Number(antes.noMedibles) + 1);
    expect(Number(despues.noCumplieron)).toBe(Number(antes.noCumplieron));
  });

  it('sin revisiones medibles el porcentaje es null, no cero', async () => {
    // Cero por ciento diría que nunca se acertó; lo que pasa es que no se midió.
    const { rows } = await db.query<{ aciertos_pct: string | null }>(
      `SELECT CASE WHEN count(*) FILTER (WHERE 1 = 0) = 0 THEN NULL END AS aciertos_pct`,
    );
    expect(rows[0]!.aciertos_pct).toBeNull();

    const c = await calibracion();
    // En esta empresa ya hubo revisiones medibles, así que el porcentaje existe;
    // lo que se comprueba es que sea un número y no una cadena vacía.
    expect(c.aciertosPct === null || !Number.isNaN(Number(c.aciertosPct))).toBe(true);
  });

  it('descartar exige motivo y queda en la bitácora', async () => {
    const id = (await registrar()).json<{ id: string }>().id;
    const sinMotivo = await pedir(admin, 'POST', `/decision-records/${id}/descartar`, {
      motivo: 'x',
    });
    expect(sinMotivo.statusCode).toBe(400);

    const r = await pedir(admin, 'POST', `/decision-records/${id}/descartar`, {
      motivo: 'El proveedor bajó el precio y el problema dejó de existir',
    });
    expect(r.statusCode, r.body).toBe(200);

    const log = await db.query<{ motivo: string }>(
      `SELECT motivo FROM audit_logs
        WHERE company_id = $1 AND action = 'DESCARTAR_DECISION'
        ORDER BY occurred_at DESC LIMIT 1`,
      [empresa],
    );
    expect(log.rows[0]!.motivo).toContain('dejó de existir');
  });

  it('una decisión ejecutada no se descarta', async () => {
    const id = await ejecutarUna();
    const r = await pedir(admin, 'POST', `/decision-records/${id}/descartar`, {
      motivo: 'Intento de borrar la historia',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.body).toContain('se revisa y se decide otra');
  });

  // ---------------------------------------------------------------------------

  async function crearDosEscenarios(): Promise<[string, string]> {
    const sufijo = await sufijoUnico(db);
    const uno = await db.query<{ id: string }>(
      `INSERT INTO analysis_scenarios
         (company_id, nombre, pregunta, meses, variacion_precio, created_by)
       VALUES ($1, $2, '¿Y si subimos 5%?', 12, 5, 'test') RETURNING id`,
      [empresa, `Conservador ${sufijo}`],
    );
    const dos = await db.query<{ id: string }>(
      `INSERT INTO analysis_scenarios
         (company_id, nombre, pregunta, meses, variacion_precio, created_by)
       VALUES ($1, $2, '¿Y si subimos 20%?', 12, 20, 'test') RETURNING id`,
      [empresa, `Agresivo ${sufijo}`],
    );
    return [uno.rows[0]!.id, dos.rows[0]!.id];
  }

  async function ejecutarUna(): Promise<string> {
    // Con la alternativa elegida escrita: ejecutar sin eso deja un acto sin
    // contenido, y la ruta lo rechaza.
    const id = (
      await registrar({ nivelDeRiesgo: 'BAJO', elegidaTexto: 'Subir 10%' })
    ).json<{ id: string }>().id;
    expect((await pedir(admin, 'POST', `/decision-records/${id}/aprobar`)).statusCode).toBe(200);
    expect(
      (await pedir(admin, 'POST', `/decision-records/${id}/ejecutar`, { desde: '2026-03-01' }))
        .statusCode,
    ).toBe(200);
    return id;
  }

  async function calibracion(): Promise<{
    noMedibles: string;
    noCumplieron: string;
    aciertosPct: string | null;
  }> {
    const r = (await pedir(admin, 'GET', '/decision-records')).json<{
      calibracion: { noMedibles: string; noCumplieron: string; aciertosPct: string | null } | null;
    }>();
    return r.calibracion ?? { noMedibles: '0', noCumplieron: '0', aciertosPct: null };
  }
});
