/**
 * De qué cuentas puede aprender una empresa.
 *
 * El aprendizaje guarda una correlación entre una señal —un proveedor, un
 * concepto— y una cuenta. Esa correlación solo vale si la cuenta se puede
 * imputar: existe, es de esta empresa, está activa y admite imputación directa.
 *
 * Sin esas cuatro condiciones el aprendizaje acumula sugerencias que la base va
 * a rechazar, y el contador descubre el problema recién al querer registrar el
 * asiento. Peor: una preferencia hacia una cuenta ajena sería contabilidad de
 * otra empresa entrando por la puerta de atrás.
 *
 * ## Por qué se prueba `aplicarCambio` y no una función auxiliar
 *
 * Es **la** función que la ruta de revisión llama por cada cambio
 * (`predictions.ts`, dentro de `POST /predictions/:id/review`). No es un
 * ayudante: es el escritor. Probarla con una transacción real deja fuera la
 * autenticación y el armado del contexto, y ejercita exactamente la escritura
 * que corre en producción, incluida la comprobación que ahora vive adentro del
 * `INSERT`.
 *
 * El caso de la empresa ajena se prueba acá y no por HTTP porque por HTTP no se
 * puede llegar: la cabecera `x-company-id` gobierna el contexto. Lo que se fija
 * es que la invariante **no dependa** de que esa cabecera sea la correcta.
 */

import { closePool, initPool, withCompany } from '@aai/db';
import { aplicarCambio } from '@aai/api/routes/predictions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

suite('El aprendizaje solo aprende de cuentas que se pueden imputar', () => {
  let raw: Client;
  let empresaA: string;
  let empresaB: string;
  let imputableA: string;
  let archivadaA: string;
  let agrupadoraA: string;
  let imputableB: string;

  /** Una cuenta cualquiera, creada por SQL para no depender de la API. */
  const crearCuenta = async (
    companyId: string,
    chartId: string,
    code: string,
    opciones: { postable?: boolean; status?: string } = {},
  ): Promise<string> => {
    const r = await raw.query<{ id: string }>(
      `INSERT INTO accounts
         (company_id, chart_id, code, name, type, nature, is_postable, status)
       VALUES ($1, $2, $3, $4, 'GASTO', 'DEUDORA', $5, $6) RETURNING id`,
      [companyId, chartId, code, `Cuenta ${code}`, opciones.postable ?? true, opciones.status ?? 'ACTIVE'],
    );
    return r.rows[0]!.id;
  };

  const crearEmpresa = async (etiqueta: string): Promise<{ companyId: string; chartId: string }> => {
    const sufijo = await sufijoUnico(raw);
    const org = await raw.query<{ id: string }>(
      'INSERT INTO organizations (name, tax_id) VALUES ($1, $2) RETURNING id',
      [`Estudio ${etiqueta} ${sufijo}`, `30${sufijo}0`],
    );
    const empresa = await raw.query<{ id: string }>(
      `INSERT INTO companies
         (organization_id, legal_name, cuit, entity_type, jurisdiction, fiscal_year_end)
       VALUES ($1, $2, $3, 'SA', 'AR-C', '12-31') RETURNING id`,
      [org.rows[0]!.id, `Empresa ${etiqueta}`, `30${sufijo}1`],
    );
    const companyId = empresa.rows[0]!.id;
    const chart = await raw.query<{ id: string }>(
      `INSERT INTO account_charts (company_id, name) VALUES ($1, 'Plan') RETURNING id`,
      [companyId],
    );
    return { companyId, chartId: chart.rows[0]!.id };
  };

  const aprender = async (
    companyId: string,
    cuentaId: string,
    opciones: { signal?: string; delta?: number; confirmar?: boolean } = {},
  ) =>
    withCompany({ companyId, actorId: 'test:aprendizaje' }, async (tx) =>
      aplicarCambio(tx, companyId, {
        signal: opciones.signal ?? 'proveedor:30712345671',
        cuentaId,
        delta: opciones.delta ?? 1,
        confirmar: opciones.confirmar ?? true,
      }),
    );

  const preferencias = async (companyId: string) =>
    (
      await raw.query<{ suggested_account_id: string; support_count: number; last_confirmed_at: Date | null }>(
        `SELECT suggested_account_id, support_count, last_confirmed_at
           FROM classification_preferences WHERE company_id = $1 ORDER BY support_count DESC`,
        [companyId],
      )
    ).rows;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    raw = await connect();

    const a = await crearEmpresa('A');
    const b = await crearEmpresa('B');
    empresaA = a.companyId;
    empresaB = b.companyId;

    imputableA = await crearCuenta(empresaA, a.chartId, '6.1.01');
    archivadaA = await crearCuenta(empresaA, a.chartId, '6.1.02', { status: 'ARCHIVED' });
    agrupadoraA = await crearCuenta(empresaA, a.chartId, '6.2', { postable: false });
    imputableB = await crearCuenta(empresaB, b.chartId, '6.1.01');
  });

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  it('cuenta activa, imputable y de la empresa: aprende', async () => {
    expect(await aprender(empresaA, imputableA)).toBe('APLICADO');

    const filas = await preferencias(empresaA);
    expect(filas.length).toBe(1);
    expect(filas[0]!.suggested_account_id).toBe(imputableA);
    expect(filas[0]!.support_count).toBe(1);
    expect(filas[0]!.last_confirmed_at).not.toBeNull();
  });

  it('cuenta archivada: no aprende', async () => {
    expect(await aprender(empresaA, archivadaA)).toBe('CUENTA_INVALIDA');
    expect((await preferencias(empresaA)).some((f) => f.suggested_account_id === archivadaA)).toBe(
      false,
    );
  });

  it('cuenta agrupadora: no aprende', async () => {
    // Una agrupadora no admite imputación directa. Aprenderla sería guardar una
    // sugerencia que el trigger de la 0003 rechaza en el momento de imputar.
    expect(await aprender(empresaA, agrupadoraA)).toBe('CUENTA_INVALIDA');
    expect((await preferencias(empresaA)).some((f) => f.suggested_account_id === agrupadoraA)).toBe(
      false,
    );
  });

  it('cuenta inexistente: no aprende', async () => {
    const inventada = '01a0b000-0000-7000-8000-000000000000';
    expect(await aprender(empresaA, inventada)).toBe('CUENTA_INVALIDA');
    expect((await preferencias(empresaA)).some((f) => f.suggested_account_id === inventada)).toBe(
      false,
    );
  });

  it('cuenta de OTRA empresa: no aprende, aunque el contexto diga que sí', async () => {
    // El aislamiento no puede depender de que la capa de arriba haya mandado el
    // company_id correcto: acá se le pasa el de la empresa A con una cuenta de
    // la B, que es exactamente lo que una cabecera equivocada produciría.
    expect(await aprender(empresaA, imputableB)).toBe('CUENTA_INVALIDA');
    expect((await preferencias(empresaA)).some((f) => f.suggested_account_id === imputableB)).toBe(
      false,
    );
    // Y la empresa B tampoco aprendió nada de rebote.
    expect(await preferencias(empresaB)).toEqual([]);
  });

  it('una preferencia válida existente sigue funcionando', async () => {
    const antes = (await preferencias(empresaA)).find((f) => f.suggested_account_id === imputableA)!;
    expect(await aprender(empresaA, imputableA)).toBe('APLICADO');

    const despues = (await preferencias(empresaA)).find(
      (f) => f.suggested_account_id === imputableA,
    )!;
    expect(despues.support_count).toBe(antes.support_count + 1);
  });

  it('`support_count` sigue determinando el candidato', async () => {
    // Dos cuentas para la misma señal: gana la más confirmada. El algoritmo de
    // frecuencia no cambió — esto lo fija para que no cambie por accidente.
    const chart = await raw.query<{ chart_id: string }>(
      'SELECT chart_id FROM accounts WHERE id = $1',
      [imputableA],
    );
    const segunda = await crearCuenta(empresaA, chart.rows[0]!.chart_id, '6.1.03');

    await aprender(empresaA, segunda, { delta: 5 });

    const filas = await preferencias(empresaA);
    expect(filas[0]!.suggested_account_id).toBe(segunda);
    expect(filas[0]!.support_count).toBe(5);
  });

  it('`last_confirmed_at` sigue moviéndose solo cuando se confirma', async () => {
    const antes = (await preferencias(empresaA)).find((f) => f.suggested_account_id === imputableA)!;

    // Un rechazo resta apoyo y NO confirma: la fecha queda donde estaba.
    expect(await aprender(empresaA, imputableA, { delta: -1, confirmar: false })).toBe('APLICADO');
    const despues = (await preferencias(empresaA)).find(
      (f) => f.suggested_account_id === imputableA,
    )!;

    expect(despues.support_count).toBe(antes.support_count - 1);
    expect(despues.last_confirmed_at?.getTime()).toBe(antes.last_confirmed_at?.getTime());
  });
});
