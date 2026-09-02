/**
 * CRM: oportunidades, embudo y el paso al presupuesto.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que no haya un embudo inventado.** Las etapas y sus probabilidades las
 *      declara la empresa. Sin probabilidad declarada no hay valor ponderado, y
 *      `null` no es cero: es «no se puede afirmar».
 *   2. **Que la etapa no se pueda escribir.** No hay columna: sale de la última
 *      transición del libro, igual que el estado de un cheque.
 *   3. **Que perder exija motivo y que lo cerrado no se reabra.** Es lo único
 *      que hace comparable el embudo de un mes con el del siguiente.
 *   4. **Que el pipeline no entre al flujo de fondos.** Una oportunidad no es
 *      un crédito: sumarla metería plata que nadie debe todavía en la
 *      proyección con la que se decide si se paga un sueldo.
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

interface Oportunidad {
  readonly id: string;
  readonly titulo: string;
  readonly quien: string;
  readonly estado: string;
  readonly etapaCodigo: string;
  readonly probabilidad: string | null;
  readonly valorPonderado: string | null;
  readonly presupuestoId: string | null;
  readonly motivoCierre: string | null;
}

suite('CRM', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let clienteId: string;
  let etapaContacto: string;
  let etapaNegociacion: string;
  let etapaGanada: string;
  let etapaPerdida: string;

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

  const etapa = async (
    codigo: string,
    orden: number,
    tipo: string,
    probabilidad?: number,
  ): Promise<string> => {
    const r = await pedir('POST', '/crm/stages', {
      codigo: `${codigo}-${stamp}`,
      nombre: codigo,
      orden,
      tipo,
      ...(probabilidad === undefined ? {} : { probabilidad }),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  };

  const oportunidad = async (id: string): Promise<Oportunidad> =>
    (await pedir('GET', `/crm/opportunities/${id}`))
      .json<{ oportunidad: Oportunidad }>().oportunidad;

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
          `fundador-crm-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio crm ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa crm ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-crm-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `vendedora-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Vendedora', password: PASSWORD, level: 'MEMBER' },
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
        razonSocial: `Cliente crm ${stamp}`,
        roles: ['CLIENTE'],
      })
    ).json<{ id: string }>().id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  it('sin etapas declaradas el embudo está vacío: NEXO no trae uno por defecto', async () => {
    const etapas = await pedir('GET', '/crm/stages');
    expect(etapas.statusCode).toBe(200);
    // Un embudo es cómo vende una empresa. Sembrar «Contacto → Demo →
    // Negociación» haría que los tableros hablaran de algo que nadie acordó.
    expect(etapas.json<{ etapas: unknown[] }>().etapas).toHaveLength(0);

    const embudo = await pedir('GET', '/analysis/embudo');
    expect(embudo.statusCode).toBe(200);
    expect(embudo.json<{ etapas: unknown[] }>().etapas).toHaveLength(0);

    // Y recién ahora se declara el embudo de esta empresa.
    etapaContacto = await etapa('CONTACTO', 1, 'ABIERTA');
    etapaNegociacion = await etapa('NEGOCIACION', 2, 'ABIERTA', 50);
    etapaGanada = await etapa('GANADA', 3, 'GANADA', 100);
    etapaPerdida = await etapa('PERDIDA', 4, 'PERDIDA', 0);
  });

  it('la etapa se deriva del libro y no existe como columna', async () => {
    const r = await pedir('POST', '/crm/opportunities', {
      titulo: `Reforma del depósito ${stamp}`,
      prospecto: 'Ferretería de la esquina',
      etapaId: etapaContacto,
      importeEstimado: '1000000.00',
      fechaEstimadaCierre: enDias(30),
      fecha: hoy,
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json<{ id: string }>().id;

    const columnas = (
      await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'crm_opportunities'`,
      )
    ).rows.map((c) => c.column_name);
    expect(columnas, 'la etapa sale del libro de transiciones').not.toContain('stage_id');
    expect(columnas, 'y el estado también').not.toContain('status');

    const o = await oportunidad(id);
    expect(o.etapaCodigo).toBe(`CONTACTO-${stamp}`);
    expect(o.estado).toBe('ABIERTA');
    // CONTACTO no declaró probabilidad: no se pondera.
    expect(o.probabilidad).toBeNull();
    expect(o.valorPonderado, '«no se puede afirmar» no es «vale cero»').toBeNull();
  });

  it('un prospecto no ensucia el maestro de terceros', async () => {
    const terceros = await pedir('GET', '/parties?limite=200');
    const nombres = terceros
      .json<{ terceros: { razonSocial: string }[] }>().terceros
      .map((t) => t.razonSocial);

    // El maestro exige documento (0047). Crear un tercero por cada prospecto lo
    // llenaría de gente que nunca compró y lo volvería inservible para facturar.
    expect(nombres).not.toContain('Ferretería de la esquina');
  });

  it('una oportunidad sin tercero ni prospecto no se carga', async () => {
    const r = await pedir('POST', '/crm/opportunities', {
      titulo: 'Venta sin dueño',
      etapaId: etapaContacto,
      fecha: hoy,
    });
    expect(r.statusCode).toBe(400);
  });

  it('el ponderado usa la probabilidad declarada, y solo esa', async () => {
    const id = (
      await pedir('POST', '/crm/opportunities', {
        titulo: `Contrato anual ${stamp}`,
        terceroId: clienteId,
        etapaId: etapaContacto,
        importeEstimado: '2000000.00',
        fechaEstimadaCierre: enDias(45),
        fecha: hoy,
      })
    ).json<{ id: string }>().id;

    expect(
      (await pedir('POST', `/crm/opportunities/${id}/transiciones`, {
        etapaId: etapaNegociacion, fecha: hoy,
      })).statusCode,
    ).toBe(201);

    const o = await oportunidad(id);
    expect(o.etapaCodigo).toBe(`NEGOCIACION-${stamp}`);
    expect(o.probabilidad).toBe('50.00');
    expect(o.valorPonderado, '2.000.000 al 50 % declarado').toBe('1000000.00');

    const embudo = (await pedir('GET', '/analysis/embudo')).json<{
      etapas: { etapaCodigo: string; cantidad: number; valorPonderado: string | null;
                metodologia: string }[];
      ponderadoAbierto: string;
      etapasSinProbabilidad: number;
      alcance: string;
    }>();

    const contacto = embudo.etapas.find((e) => e.etapaCodigo === `CONTACTO-${stamp}`)!;
    expect(contacto.cantidad, 'quedó la reforma del depósito').toBe(1);
    expect(contacto.valorPonderado, 'sin probabilidad declarada no se pondera').toBeNull();
    expect(contacto.metodologia).toContain('Sin probabilidad declarada');

    // El total suma solo lo que tiene probabilidad, y lo demás se cuenta aparte:
    // sumarlo como cero diría que no vale nada, y lo que pasa es que no se sabe.
    expect(embudo.ponderadoAbierto).toBe('1000000.00');
    expect(embudo.etapasSinProbabilidad).toBe(1);
    expect(embudo.alcance).toContain('no entra al flujo de fondos');
  });

  it('el embudo no se suma al flujo de fondos', async () => {
    const f = (await pedir('GET', '/analysis/flujo-de-fondos')).json<{
      porFuente: { fuente: string }[];
    }>();

    // Una oportunidad no es un crédito. Si algún día aparece una fuente que
    // venga del embudo, este test lo dice antes de que el número con el que se
    // decide pagar un sueldo incluya plata que nadie debe.
    const fuentes = f.porFuente.map((x) => x.fuente);
    for (const prohibida of ['EMBUDO', 'OPORTUNIDADES', 'PIPELINE', 'CRM']) {
      expect(fuentes, `${prohibida} no es plata que alguien deba`).not.toContain(prohibida);
    }
  });

  it('perder exige decir por qué', async () => {
    const id = (
      await pedir('POST', '/crm/opportunities', {
        titulo: `Licitación ${stamp}`,
        terceroId: clienteId,
        etapaId: etapaContacto,
        importeEstimado: '500000.00',
        fecha: hoy,
      })
    ).json<{ id: string }>().id;

    const sinMotivo = await pedir('POST', `/crm/opportunities/${id}/transiciones`, {
      etapaId: etapaPerdida, fecha: hoy,
    });
    expect(sinMotivo.statusCode).toBe(422);
    expect(sinMotivo.json<{ error: string }>().error).toBe('PERDIDA_SIN_MOTIVO');

    const conMotivo = await pedir('POST', `/crm/opportunities/${id}/transiciones`, {
      etapaId: etapaPerdida, fecha: hoy, motivo: 'Ganó el competidor por precio',
    });
    expect(conMotivo.statusCode).toBe(201);

    const o = await oportunidad(id);
    expect(o.estado).toBe('PERDIDA');
    expect(o.motivoCierre).toBe('Ganó el competidor por precio');

    // Y una vez cerrada no se reabre: si volvió a haber conversación es una
    // oportunidad nueva, y así el embudo del mes que viene sigue comparable.
    const reabrir = await pedir('POST', `/crm/opportunities/${id}/transiciones`, {
      etapaId: etapaNegociacion, fecha: hoy,
    });
    expect(reabrir.statusCode).toBe(409);

    // El candado vive en la base, no en el handler.
    await expect(
      db.query(
        `INSERT INTO crm_stage_transitions
           (company_id, opportunity_id, stage_id, fecha, created_by)
         VALUES ($1,$2,$3,$4,'test')`,
        [empresa, id, etapaNegociacion, hoy],
      ),
    ).rejects.toThrow(/E_CRM_CERRADA/);
  });

  it('una oportunidad se pierde, no se borra', async () => {
    const id = (
      await db.query<{ id: string }>(
        'SELECT id FROM crm_opportunities WHERE company_id = $1 LIMIT 1',
        [empresa],
      )
    ).rows[0]!.id;

    await expect(
      db.query('DELETE FROM crm_opportunities WHERE id = $1', [id]),
    ).rejects.toThrow(/E_CRM_NO_BORRA/);
  });

  it('lo que se registró como hecho no se edita ni se borra', async () => {
    const id = (
      await pedir('POST', '/crm/opportunities', {
        titulo: `Seguimiento ${stamp}`,
        prospecto: 'Distribuidora del sur',
        etapaId: etapaContacto,
        fecha: hoy,
      })
    ).json<{ id: string }>().id;

    expect(
      (await pedir('POST', `/crm/opportunities/${id}/activities`, {
        tipo: 'LLAMADA', fecha: hoy, detalle: 'Pidió que lo llamemos la semana que viene',
      })).statusCode,
    ).toBe(201);

    const actividad = (
      await db.query<{ id: string }>(
        'SELECT id FROM crm_activities WHERE company_id = $1 LIMIT 1',
        [empresa],
      )
    ).rows[0]!.id;

    // Una visita registrada y después borrada deja un seguimiento que parece
    // mejor de lo que fue.
    await expect(
      db.query(`UPDATE crm_activities SET detalle = 'otra cosa' WHERE id = $1`, [actividad]),
    ).rejects.toThrow();
    await expect(
      db.query('DELETE FROM crm_activities WHERE id = $1', [actividad]),
    ).rejects.toThrow();
  });

  it('la oportunidad vencida y la ganada sin presupuesto llegan a la bandeja', async () => {
    const vencida = (
      await pedir('POST', '/crm/opportunities', {
        titulo: `Estimada para ayer ${stamp}`,
        terceroId: clienteId,
        etapaId: etapaContacto,
        fechaEstimadaCierre: enDias(-5),
        fecha: enDias(-30),
      })
    ).json<{ id: string }>().id;

    const ganada = (
      await pedir('POST', '/crm/opportunities', {
        titulo: `Ganada sin papeles ${stamp}`,
        terceroId: clienteId,
        etapaId: etapaContacto,
        importeEstimado: '300000.00',
        fecha: hoy,
      })
    ).json<{ id: string }>().id;
    expect(
      (await pedir('POST', `/crm/opportunities/${ganada}/transiciones`, {
        etapaId: etapaGanada, fecha: hoy,
      })).statusCode,
    ).toBe(201);

    const items = (await pedir('GET', '/work-queue?entidad=crm_opportunities&limite=200'))
      .json<{ items: { rama: string; entityId: string; evidenciaFaltante: string[] | null }[] }>()
      .items;

    expect(
      items.find((i) => i.rama === 'OPORTUNIDAD_VENCIDA' && i.entityId === vencida),
      'una fecha que pasó es un hecho, no un criterio',
    ).toBeDefined();

    const sinPresupuesto = items.find(
      (i) => i.rama === 'GANADA_SIN_PRESUPUESTO' && i.entityId === ganada,
    );
    expect(sinPresupuesto, 'el embudo la cuenta y el circuito comercial no la tiene')
      .toBeDefined();
    expect(sinPresupuesto!.evidenciaFaltante).toContain('PRESUPUESTO');
  });

  it('sin umbral declarado, el silencio no se llama abandono', async () => {
    const rama = 'OPORTUNIDAD_SIN_SEGUIMIENTO';

    const antes = (await pedir('GET', '/work-queue?entidad=crm_opportunities&limite=200'))
      .json<{ items: { rama: string }[] }>().items;
    expect(
      antes.some((i) => i.rama === rama),
      'sin umbral el sistema informa los días y no avisa',
    ).toBe(false);

    // Recién cuando la empresa dice desde cuándo, la rama existe. Vender un
    // galpón y vender café no tienen el mismo ritmo.
    expect(
      (await pedir('PUT', '/analysis/thresholds', {
        caidaVentasPct: null,
        concentracionClientePct: null,
        diasClienteInactivo: null,
        moraPct: null,
        rechazoChequesPct: null,
        crmDiasSinActividad: 1,
      })).statusCode,
    ).toBe(200);

    const despues = (await pedir('GET', '/work-queue?entidad=crm_opportunities&limite=200'))
      .json<{ items: { rama: string }[] }>().items;
    expect(despues.some((i) => i.rama === rama), 'declarado el umbral, la rama avisa').toBe(true);

    const umbrales = (await pedir('GET', '/analysis/thresholds'))
      .json<{ umbrales: { crmDiasSinActividad: number } }>().umbrales;
    expect(umbrales.crmDiasSinActividad).toBe(1);
  });

  it('la oportunidad cita el presupuesto: CRM no crea documentos comerciales', async () => {
    const id = (
      await pedir('POST', '/crm/opportunities', {
        titulo: `Con presupuesto ${stamp}`,
        terceroId: clienteId,
        etapaId: etapaContacto,
        fecha: hoy,
      })
    ).json<{ id: string }>().id;

    const presupuesto = await pedir('POST', '/commercial-documents', {
      direccion: 'VENTAS',
      tipo: 'PRESUPUESTO',
      terceroId: clienteId,
      fecha: hoy,
    });
    expect(presupuesto.statusCode, presupuesto.body).toBe(201);
    const presupuestoId = presupuesto.json<{ id: string }>().id;

    expect(
      (await pedir('PUT', `/crm/opportunities/${id}/presupuesto`, { presupuestoId })).statusCode,
    ).toBe(200);

    expect((await oportunidad(id)).presupuestoId).toBe(presupuestoId);
  });

  it('las vistas de CRM conservan security_invoker', async () => {
    const r = await db.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relname IN ('crm_opportunity_status', 'analytics_embudo', 'work_queue_crm')`,
    );
    expect(r.rowCount).toBe(3);
    for (const v of r.rows) {
      expect(v.reloptions, `${v.relname} sin security_invoker filtra entre empresas`)
        .toContain('security_invoker=true');
    }
  });
});
