/**
 * Bienes de uso y amortizaciones.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que el plan se calcule y no se guarde.** Registrar una mejora cambia
 *      la base y el plan se recalcula solo. Un plan almacenado quedaría viejo
 *      ese mismo día, y el error no se ve hasta el balance.
 *   2. **Que el importe del asiento tenga que coincidir.** Sin esa
 *      comprobación el vínculo sería decorativo: la bandeja dejaría de avisar y
 *      el cargo del ejercicio podría ser cualquiera.
 *   3. **Que el valor de libros diga lo que dice el Diario.** Lo calculado y no
 *      asentado no baja el valor del bien.
 *   4. **Que las cuentas sirvan**, y en particular que la amortización
 *      acumulada no termine en PASIVO, que es el error clásico.
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

suite('Bienes de uso y amortizaciones', () => {
  let app: FastifyInstance;
  let db: Client;
  let stamp: string;
  let token: string;
  let empresa: string;
  let ejercicio: string;

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
          `fundador-act-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio act ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa act ${stamp}`, withCheckDigit(`23${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `fundador-act-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-act-${stamp}@estudio.test`;
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

    const ej = await pedir('POST', '/fiscal-years', {
      code: `EJ2026-${stamp}`, startDate: '2026-01-01', endDate: '2026-12-31',
    });
    expect(ej.statusCode, ej.body).toBe(201);
    ejercicio = ej.json<{ id: string }>().id;

    for (const cuenta of [
      { code: '1.2.01', name: 'Rodados', type: 'ACTIVO' },
      { code: '1.2.02', name: 'Amortización acumulada rodados', type: 'ACTIVO' },
      { code: '5.2.01', name: 'Amortizaciones del ejercicio', type: 'GASTO' },
      { code: '2.1.01', name: 'Proveedores', type: 'PASIVO' },
      { code: '1', name: 'Activo (rubro)', type: 'ACTIVO', isPostable: false },
    ]) {
      expect((await pedir('POST', '/accounts', cuenta)).statusCode).toBe(201);
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await closePool();
  });

  /** Un bien de 120.000 a 60 meses dado de alta el 1/1/2026: 2.000 por mes. */
  async function alta(codigo: string, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await pedir('POST', '/fixed-assets', {
      codigo,
      nombre: 'Camioneta',
      costo: '120000.00',
      fechaAlta: '2026-01-01',
      vidaUtilMeses: 60,
      valorResidual: '0',
      cuentaBien: '1.2.01',
      cuentaAcumulada: '1.2.02',
      cuentaGasto: '5.2.01',
      ...extra,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ id: string }>().id;
  }

  /** Asiento aprobado de amortización por el importe indicado. */
  async function asiento(importe: string): Promise<string> {
    const r = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: '2026-12-31',
      description: 'Amortización del ejercicio',
      currency: 'ARS',
      lines: [
        { accountCode: '5.2.01', debit: importe, credit: '0' },
        { accountCode: '1.2.02', debit: '0', credit: importe },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Amortización calculada del ejercicio',
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json<{ id: string }>().id;
    expect((await pedir('POST', `/journal-entries/${id}/approve`)).statusCode).toBe(200);
    return id;
  }

  // -------------------------------------------------------------------------
  it('el plan se calcula: doce meses de uso dan la cuota anual', async () => {
    const id = await alta(`CAM-${stamp}`);
    const r = await pedir('GET', `/fixed-assets/${id}`);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      plan: { ejercicio: string; meses: number; amortizacion: string; base: string }[];
      valor: { valorDeLibros: string; amortizado: string };
      alcance: string;
    }>();

    const anio = cuerpo.plan.find((p) => p.ejercicio.startsWith('EJ2026'));
    expect(anio!.meses).toBe(12);
    // 120.000 / 60 meses × 12 meses = 24.000
    expect(anio!.amortizacion).toBe('24000.00');
    // Nada asentado todavía: el valor de libros sigue siendo el costo.
    expect(cuerpo.valor.amortizado).toBe('0.00');
    expect(cuerpo.valor.valorDeLibros).toBe('120000.00');
    expect(cuerpo.alcance).toContain('dice lo que dice el Diario');
  });

  it('una mejora cambia la base y el plan se recalcula solo', async () => {
    const id = await alta(`MEJ-${stamp}`);
    expect(
      (await pedir('POST', `/fixed-assets/${id}/improvements`, {
        descripcion: 'Caja de carga reforzada',
        importe: '30000.00',
        fecha: '2026-01-01',
      })).statusCode,
    ).toBe(201);

    const r = await pedir('GET', `/fixed-assets/${id}`);
    const plan = r.json<{ plan: { ejercicio: string; base: string; amortizacion: string }[] }>().plan;
    const anio = plan.find((p) => p.ejercicio.startsWith('EJ2026'))!;
    expect(anio.base).toBe('150000.00');
    // 150.000 / 60 × 12 = 30.000. Ninguna fila se actualizó: no hay filas.
    expect(anio.amortizacion).toBe('30000.00');
  });

  it('no hay ninguna tabla con las cuotas calculadas', async () => {
    const tablas = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('depreciation_schedule', 'asset_depreciation_lines',
                             'cuotas_de_amortizacion')`,
    );
    expect(tablas.rows).toEqual([]);

    // Y la tabla que sí existe no guarda el importe: lo tiene el asiento.
    const columnas = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'fixed_asset_depreciations'
          AND column_name IN ('importe', 'amortizacion', 'monto')`,
    );
    expect(columnas.rows).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // El asiento tiene que coincidir
  // -------------------------------------------------------------------------
  it('vincular el asiento exige que el importe sea el calculado', async () => {
    const id = await alta(`VIN-${stamp}`);
    const equivocado = await asiento('20000.00');

    const mal = await pedir('POST', `/fixed-assets/${id}/depreciations`, {
      ejercicioId: ejercicio, entryId: equivocado,
    });
    expect(mal.statusCode, mal.body).toBe(422);
    expect(mal.json<{ error: string }>().error).toBe('IMPORTE_NO_COINCIDE');

    const correcto = await asiento('24000.00');
    const bien = await pedir('POST', `/fixed-assets/${id}/depreciations`, {
      ejercicioId: ejercicio, entryId: correcto,
    });
    expect(bien.statusCode, bien.body).toBe(201);

    // Recién ahora baja el valor de libros.
    const r = await pedir('GET', `/fixed-assets/${id}`);
    const valor = r.json<{ valor: { amortizado: string; valorDeLibros: string } }>().valor;
    expect(valor.amortizado).toBe('24000.00');
    expect(valor.valorDeLibros).toBe('96000.00');
  });

  it('un asiento sin aprobar no amortiza', async () => {
    const id = await alta(`BOR-${stamp}`);
    const alta2 = await pedir('POST', '/journal-entries', {
      journalCode: 'GENERAL',
      entryDate: '2026-12-31',
      description: 'Amortización en borrador',
      currency: 'ARS',
      lines: [
        { accountCode: '5.2.01', debit: '24000.00', credit: '0' },
        { accountCode: '1.2.02', debit: '0', credit: '24000.00' },
      ],
      source: { type: 'MANUAL', id: null },
      manualJustification: 'Sin aprobar',
    });

    const r = await pedir('POST', `/fixed-assets/${id}/depreciations`, {
      ejercicioId: ejercicio, entryId: alta2.json<{ id: string }>().id,
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('ASIENTO_SIN_APROBAR');
  });

  it('un ejercicio no se amortiza dos veces', async () => {
    const id = await alta(`DOS-${stamp}`);
    expect(
      (await pedir('POST', `/fixed-assets/${id}/depreciations`, {
        ejercicioId: ejercicio, entryId: await asiento('24000.00'),
      })).statusCode,
    ).toBe(201);

    const r = await pedir('POST', `/fixed-assets/${id}/depreciations`, {
      ejercicioId: ejercicio, entryId: await asiento('24000.00'),
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('EJERCICIO_YA_AMORTIZADO');
  });

  // -------------------------------------------------------------------------
  // Las cuentas
  // -------------------------------------------------------------------------
  it('la amortización acumulada no va en PASIVO', async () => {
    // Es el error clásico: es regularizadora del activo, no una deuda.
    const r = await pedir('POST', '/fixed-assets', {
      codigo: `MALA-${stamp}`, nombre: 'Camioneta', costo: '1000.00',
      fechaAlta: '2026-01-01', vidaUtilMeses: 12,
      cuentaBien: '1.2.01', cuentaAcumulada: '2.1.01', cuentaGasto: '5.2.01',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTA_ACUMULADA_INVALIDA');
  });

  it('la cuenta del bien tiene que ser imputable', async () => {
    const r = await pedir('POST', '/fixed-assets', {
      codigo: `RUBRO-${stamp}`, nombre: 'Camioneta', costo: '1000.00',
      fechaAlta: '2026-01-01', vidaUtilMeses: 12,
      cuentaBien: '1', cuentaAcumulada: '1.2.02', cuentaGasto: '5.2.01',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTA_DEL_BIEN_INVALIDA');
  });

  it('el bien y su amortización acumulada no comparten cuenta', async () => {
    const r = await pedir('POST', '/fixed-assets', {
      codigo: `IGUAL-${stamp}`, nombre: 'Camioneta', costo: '1000.00',
      fechaAlta: '2026-01-01', vidaUtilMeses: 12,
      cuentaBien: '1.2.01', cuentaAcumulada: '1.2.01', cuentaGasto: '5.2.01',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('CUENTAS_IGUALES');
  });

  it('el valor residual no puede igualar al costo', async () => {
    const r = await pedir('POST', '/fixed-assets', {
      codigo: `RES-${stamp}`, nombre: 'Camioneta', costo: '1000.00',
      valorResidual: '1000.00', fechaAlta: '2026-01-01', vidaUtilMeses: 12,
      cuentaBien: '1.2.01', cuentaAcumulada: '1.2.02', cuentaGasto: '5.2.01',
    });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json<{ error: string }>().error).toBe('RESIDUAL_INVALIDO');
  });

  // -------------------------------------------------------------------------
  // Baja y bandeja
  // -------------------------------------------------------------------------
  it('la baja exige motivo y avisa que no produce asiento', async () => {
    const id = await alta(`BAJA-${stamp}`);
    const sinMotivo = await pedir('POST', `/fixed-assets/${id}/baja`, { fecha: '2026-06-30' });
    expect(sinMotivo.statusCode, sinMotivo.body).toBe(400);

    const r = await pedir('POST', `/fixed-assets/${id}/baja`, {
      fecha: '2026-06-30', motivo: 'Vendida a un tercero', valorDeVenta: '90000.00',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ alcance: string }>().alcance).toContain('no produce asiento');

    // Y el plan deja de amortizar después de la baja: seis meses, no doce.
    const plan = (await pedir('GET', `/fixed-assets/${id}`))
      .json<{ plan: { ejercicio: string; meses: number }[] }>().plan;
    expect(plan.find((p) => p.ejercicio.startsWith('EJ2026'))!.meses).toBe(6);
  });

  it('un bien dado de baja no admite mejoras', async () => {
    const id = await alta(`NOMEJ-${stamp}`);
    await pedir('POST', `/fixed-assets/${id}/baja`, {
      fecha: '2026-06-30', motivo: 'Siniestro total',
    });
    const r = await pedir('POST', `/fixed-assets/${id}/improvements`, {
      descripcion: 'Mejora imposible', importe: '100.00', fecha: '2026-07-01',
    });
    expect(r.statusCode, r.body).toBe(409);
  });

  it('la amortización sin asentar aparece y bloquea cuando el ejercicio entra en cierre', async () => {
    const id = await alta(`CIE-${stamp}`);

    // Antes del cierre no está atrasada: todavía no llegó su momento.
    const antes = await pedir('GET', '/work-queue?limite=200');
    expect(
      antes.json<{ items: { rama: string; entityId: string }[] }>().items
        .some((i) => i.rama === 'AMORTIZACION_PENDIENTE' && i.entityId === id),
    ).toBe(false);

    await db.query("UPDATE fiscal_years SET status = 'EN_CIERRE' WHERE id = $1", [ejercicio]);

    const durante = await pedir('GET', '/work-queue?limite=200');
    const item = durante
      .json<{ items: { rama: string; entityId: string; bloquea: boolean }[] }>()
      .items.find((i) => i.rama === 'AMORTIZACION_PENDIENTE' && i.entityId === id);
    expect(item, 'cerrar sin amortizar sobrevalúa el activo').toBeDefined();
    expect(item!.bloquea).toBe(true);

    await db.query("UPDATE fiscal_years SET status = 'ABIERTO' WHERE id = $1", [ejercicio]);
  });

  it('el reporte del ejercicio dice cuántas amortizaciones faltan', async () => {
    const r = await pedir('GET', `/reports/depreciation?ejercicioId=${ejercicio}`);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{ bienes: unknown[]; pendientes: number; alcance: string }>();
    expect(cuerpo.bienes.length).toBeGreaterThan(0);
    expect(cuerpo.pendientes).toBeGreaterThan(0);
    expect(cuerpo.alcance).toContain('NEXO no los asienta');
  });

  it('el borrado físico de un bien está prohibido', async () => {
    const id = await alta(`DEL-${stamp}`);
    await expect(db.query('DELETE FROM fixed_assets WHERE id = $1', [id])).rejects.toThrow();
  });
});
