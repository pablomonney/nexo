/**
 * Proyectos: horas, tarifa declarada y rentabilidad.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que los ingresos y los costos salgan del Mayor.** No se cargan en el
 *      módulo: se leen por el centro de costo que el proyecto cita. Guardarlos
 *      acá sería una segunda contabilidad.
 *   2. **Que el margen no se afirme cuando no se puede.** Sin centro de costo,
 *      o con horas sin tarifa declarada para su fecha, el margen es `null` —y
 *      `null` no es cero.
 *   3. **Que la tarifa que se use sea la del día en que se trabajó**, no la de
 *      hoy.
 *   4. **Que el libro de horas sea inmutable** y que un proyecto cerrado no
 *      reciba horas nuevas.
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

interface Proyecto {
  readonly id: string;
  readonly status: string;
  readonly horas: string;
  readonly horasSinTarifa: string;
  readonly costoHoras: string | null;
  readonly avancePct: string | null;
  readonly ingresos: string;
  readonly costos: string;
  readonly margen: string | null;
}

suite('Proyectos', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let proyecto: string;
  let sinCentro: string;

  const pedir = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(payload === undefined ? {} : { payload }),
    });

  const ver = async (id: string): Promise<Proyecto> =>
    (await pedir('GET', `/projects/${id}`)).json<{ proyecto: Proyecto }>().proyecto;

  /** Asiento aprobado imputado al centro de costo del proyecto. */
  const asiento = async (
    cuentaDebe: string,
    cuentaHaber: string,
    importe: string,
    centro: string,
    descripcion: string,
  ): Promise<void> => {
    const r = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: '2026-06-30',
      description: descripcion,
      currency: 'ARS',
      lines: [
        { accountCode: cuentaDebe, debit: importe, credit: '0', costCenterCode: centro },
        { accountCode: cuentaHaber, debit: '0', credit: importe, costCenterCode: centro },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: descripcion,
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${id}/approve`)).statusCode).toBe(200);
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
          `fundador-proy-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio proy ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa proy ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-proy-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `jefa-proy-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Jefa de proyectos', password: PASSWORD, level: 'MEMBER' },
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
        razonSocial: `Cliente proy ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;

    expect(
      (await pedir('POST', '/fiscal-years', {
        code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
      })).statusCode,
    ).toBe(201);

    for (const cuenta of [
      { code: '1.1.02', name: 'Deudores por servicios', type: 'ACTIVO' },
      { code: '4.1.01', name: 'Honorarios ganados', type: 'INGRESO' },
      { code: '5.1.01', name: 'Servicios contratados', type: 'GASTO' },
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }

    expect(
      (await pedir('POST', '/cost-centers', {
        code: `CC-${stamp}`, name: 'Reforma del galpón',
      })).statusCode,
    ).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin centro de costo, el proyecto no puede atribuirse nada y la bandeja lo dice', async () => {
    const r = await pedir('POST', '/projects', {
      codigo: `SIN-CC-${stamp}`,
      nombre: 'Trabajo sin medir',
      fechaInicio: '2026-01-01',
    });
    expect(r.statusCode, r.body).toBe(201);
    sinCentro = r.json<{ id: string }>().id;

    const p = await ver(sinCentro);
    expect(p.ingresos).toBe('0');
    expect(p.costos).toBe('0');
    // Sin centro de costo no hay nada que atribuir: el margen no se afirma.
    expect(p.margen).toBeNull();

    const items = (await pedir('GET', '/work-queue?entidad=projects&limite=200'))
      .json<{ items: { rama: string; entityId: string; evidenciaFaltante: string[] | null }[] }>()
      .items;
    const aviso = items.find(
      (i) => i.rama === 'PROYECTO_SIN_CENTRO_DE_COSTO' && i.entityId === sinCentro,
    );
    expect(aviso, 'un proyecto sin centro de costo es una planilla al costado').toBeDefined();
    expect(aviso!.evidenciaFaltante).toContain('CENTRO_DE_COSTO');
  });

  it('las horas se cargan y el avance se mide contra el presupuesto declarado', async () => {
    const r = await pedir('POST', '/projects', {
      codigo: `GALPON-${stamp}`,
      nombre: 'Reforma del galpón',
      terceroId: clienteId,
      centroDeCosto: `CC-${stamp}`,
      fechaInicio: '2026-01-01',
      fechaFinEstimada: '2026-12-31',
      presupuestoHoras: '100.00',
    });
    expect(r.statusCode, r.body).toBe(201);
    proyecto = r.json<{ id: string }>().id;

    for (const horas of ['10.00', '15.00']) {
      expect(
        (await pedir('POST', `/projects/${proyecto}/time-entries`, {
          fecha: '2026-03-15', horas, persona: 'Equipo de obra', detalle: 'Trabajo en el techo',
        })).statusCode,
      ).toBe(201);
    }

    const p = await ver(proyecto);
    expect(p.horas).toBe('25.00');
    expect(p.avancePct, '25 de 100 horas declaradas').toBe('25.00');

    // Sin tarifa declarada todavía: las horas se informan y no se costean.
    expect(p.horasSinTarifa).toBe('25.00');
    expect(p.costoHoras, 'costear a cero diría que salieron gratis').toBeNull();
    expect(p.margen).toBeNull();
  });

  it('las horas sin tarifa llegan a la bandeja diciendo por qué no hay margen', async () => {
    const items = (await pedir('GET', '/work-queue?entidad=projects&limite=200'))
      .json<{ items: { rama: string; entityId: string; motivo: string }[] }>().items;

    const aviso = items.find((i) => i.rama === 'HORAS_SIN_TARIFA' && i.entityId === proyecto);
    expect(aviso, 'decirlo es más útil que mostrar un guion').toBeDefined();
    expect(aviso!.motivo).toContain('margen');
  });

  it('la hora se valúa a la tarifa que regía el día en que se trabajó', async () => {
    // Primero la del período viejo, después la nueva: si el sistema usara «la
    // última cargada» en vez de «la vigente ese día», el costo saldría mal.
    expect(
      (await pedir('POST', `/projects/${proyecto}/rates`, {
        tarifa: '1000.00', vigenciaDesde: '2026-01-01', vigenciaHasta: '2026-03-31',
      })).statusCode,
    ).toBe(201);
    expect(
      (await pedir('POST', `/projects/${proyecto}/rates`, {
        tarifa: '2000.00', vigenciaDesde: '2026-04-01',
      })).statusCode,
    ).toBe(201);

    // Una hora en abril: le toca la tarifa nueva.
    expect(
      (await pedir('POST', `/projects/${proyecto}/time-entries`, {
        fecha: '2026-04-10', horas: '5.00', persona: 'Equipo de obra',
        detalle: 'Terminaciones',
      })).statusCode,
    ).toBe(201);

    const p = await ver(proyecto);
    expect(p.horas).toBe('30.00');
    expect(p.horasSinTarifa, 'ya no queda ninguna sin tarifa').toBe('0');
    // 25 h × 1.000 (marzo) + 5 h × 2.000 (abril) = 35.000
    expect(p.costoHoras).toBe('35000.00');
  });

  it('dos tarifas vigentes el mismo día no se aceptan', async () => {
    const r = await pedir('POST', `/projects/${proyecto}/rates`, {
      tarifa: '3000.00', vigenciaDesde: '2026-05-01', vigenciaHasta: '2026-05-31',
    });
    // Se superpone con la abierta desde el 1/4: elegir por orden de carga sería
    // azar disfrazado de regla.
    expect(r.statusCode).toBe(409);
  });

  it('los ingresos y los costos salen del Mayor, y el margen cierra', async () => {
    await asiento('1.1.02', '4.1.01', '500000.00', `CC-${stamp}`, 'Honorarios de la reforma');
    await asiento('5.1.01', '2.1.01', '120000.00', `CC-${stamp}`, 'Subcontrato de la reforma');

    const p = await ver(proyecto);
    expect(p.ingresos, 'de la cuenta de INGRESO con ese centro de costo').toBe('500000.00');
    expect(p.costos, 'de la cuenta de GASTO con ese centro de costo').toBe('120000.00');
    // 500.000 − 120.000 − 35.000 de horas = 345.000
    expect(p.margen).toBe('345000.00');

    // Y nada de eso está guardado en el módulo: son columnas derivadas.
    const columnas = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'`,
      )
    ).rows.map((c) => c.column_name);
    for (const prohibida of ['ingresos', 'costos', 'margen', 'horas']) {
      expect(columnas, `guardar ${prohibida} sería una segunda contabilidad`)
        .not.toContain(prohibida);
    }
  });

  it('la rentabilidad se informa con su método, y dice cuándo no puede afirmarse', async () => {
    const r = await pedir('GET', '/analysis/proyectos');
    expect(r.statusCode).toBe(200);
    const a = r.json<{
      proyectos: { codigo: string; margen: string | null; margenPct: string | null;
                   metodologia: string }[];
      sinMargenAfirmable: number;
      alcance: string;
    }>();

    const galpon = a.proyectos.find((p) => p.codigo === `GALPON-${stamp}`)!;
    expect(galpon.margen).toBe('345000.00');
    // 345.000 sobre 500.000 = 69 %
    expect(galpon.margenPct).toBe('69.00');
    expect(galpon.metodologia).toContain('tarifa declarada');

    const sin = a.proyectos.find((p) => p.codigo === `SIN-CC-${stamp}`)!;
    expect(sin.margen).toBeNull();
    expect(sin.metodologia, 'dice qué le falta, no un guion').toContain('Sin centro de costo');
    expect(a.sinMargenAfirmable).toBeGreaterThanOrEqual(1);
  });

  it('el libro de horas no se edita ni se borra, y la tarea es del proyecto', async () => {
    const parte = (
      await db.query<{ id: string }>(
        'SELECT id FROM time_entries WHERE company_id = $1 LIMIT 1',
        [empresa],
      )
    ).rows[0]!.id;

    await expect(
      db.query('UPDATE time_entries SET horas = 1 WHERE id = $1', [parte]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM time_entries WHERE id = $1', [parte]),
    ).rejects.toThrow();

    // Una tarea de otro proyecto contaría las horas donde no se trabajaron.
    const tareaAjena = (
      await pedir('POST', `/projects/${sinCentro}/tasks`, {
        codigo: 'T1', nombre: 'Tarea del otro proyecto',
      })
    ).json<{ id: string }>().id;

    const r = await pedir('POST', `/projects/${proyecto}/time-entries`, {
      fecha: '2026-04-11', horas: '1.00', persona: 'Equipo', detalle: 'Prueba',
      tareaId: tareaAjena,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('TAREA_DE_OTRO_PROYECTO');
  });

  it('un proyecto cerrado no recibe horas nuevas, ni por SQL directo', async () => {
    const cierre = await pedir('POST', `/projects/${proyecto}/close`, {
      status: 'CERRADO', fecha: '2026-12-20', motivo: 'Obra entregada y conforme del cliente',
    });
    expect(cierre.statusCode, cierre.body).toBe(200);
    const r = cierre.json<{ margenAlCerrar: string; alcance: string }>();
    expect(r.margenAlCerrar, 'el margen queda escrito en la bitácora al cerrar').toBe('345000.00');
    expect(r.alcance).toContain('No se generó ningún asiento');

    const tardias = await pedir('POST', `/projects/${proyecto}/time-entries`, {
      fecha: '2026-12-21', horas: '2.00', persona: 'Equipo', detalle: 'Tardías',
    });
    expect(tardias.statusCode).toBe(409);

    await expect(
      db.query(
        `INSERT INTO time_entries
           (company_id, project_id, fecha, horas, persona, detalle, created_by)
         VALUES ($1,$2,'2026-12-21','2.00','Equipo','Por la ventana','test')`,
        [empresa, proyecto],
      ),
    ).rejects.toThrow(/E_PROY_CERRADO/);

    // Y no se cierra dos veces.
    expect(
      (await pedir('POST', `/projects/${proyecto}/close`, {
        status: 'CERRADO', fecha: '2026-12-21', motivo: 'Otra vez',
      })).statusCode,
    ).toBe(409);
  });

  it('un proyecto se cierra o se cancela, no se borra', async () => {
    await expect(
      db.query('DELETE FROM projects WHERE id = $1', [proyecto]),
    ).rejects.toThrow(/E_PROY_NO_BORRA/);
  });

  it('las vistas de proyectos conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('project_time_valuation', 'project_status', 'analytics_proyectos',
                          'work_queue_proyectos')`,
    );
    expect(r.rowCount).toBe(4);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
