/**
 * El plan modelo, materializado contra la base de verdad.
 *
 * `plan-de-cuentas-nexo.test.ts` comprueba la forma del catálogo sin base:
 * códigos, jerarquía, roles, espejo con el estado de resultados. Esto comprueba
 * lo otro, que es lo que ningún control estático puede ver: que las 185 cuentas
 * **entran** —con sus tipos, sus naturalezas invertidas, su `tax_role` y su
 * `closing_role`— y que los triggers que ya existen las tratan como se espera.
 *
 * En particular el de la 0003: una cuenta que recibe una hija deja de ser
 * imputable. Si la materialización insertara en el orden equivocado, el plan
 * quedaría con las agrupadoras imputables y las hojas no, y ningún `SELECT
 * count(*)` lo notaría.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { CUENTAS, PLANTILLA } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

suite('La materialización del plan modelo', () => {
  let app: FastifyInstance;
  let raw: Client;
  let companyId: string;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();

    // Una empresa propia y vacía. No se usa el alta HTTP: lo que se prueba es la
    // materialización, no el onboarding.
    const sufijo = await sufijoUnico(raw);
    const org = await raw.query<{ id: string }>(
      `INSERT INTO organizations (name, tax_id) VALUES ($1, $2) RETURNING id`,
      [`Estudio plan ${sufijo}`, `30${sufijo}0`],
    );
    const empresa = await raw.query<{ id: string }>(
      `INSERT INTO companies
         (organization_id, legal_name, cuit, entity_type, jurisdiction, fiscal_year_end)
       VALUES ($1, $2, $3, 'SA', 'AR-C', '12-31') RETURNING id`,
      [org.rows[0]!.id, `Empresa plan ${sufijo}`, `30${sufijo}1`],
    );
    companyId = empresa.rows[0]!.id;
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  /** Lo que quedó en la base para esta empresa. */
  const cuentasDeLaEmpresa = async () => {
    const r = await raw.query<{
      code: string;
      name: string;
      type: string;
      nature: string;
      is_postable: boolean;
      tax_role: string | null;
      closing_role: string | null;
      parent_code: string | null;
    }>(
      `SELECT a.code, a.name, a.type, a.nature, a.is_postable, a.tax_role, a.closing_role,
              p.code AS parent_code
         FROM accounts a
         LEFT JOIN accounts p ON p.id = a.parent_id
        WHERE a.company_id = $1
        ORDER BY a.code`,
      [companyId],
    );
    return r.rows;
  };

  it('entran las 185 cuentas, con su plan y su versión anotados', async () => {
    const { materializarPlanModelo } = await import(
      '@aai/api/contabilidad/materializar-plan'
    );
    const { withCompany } = await import('@aai/db');

    const salida = await withCompany(
      { companyId, actorId: 'test:materializacion' },
      async (tx) => materializarPlanModelo(tx, companyId),
    );

    expect(salida.estado).toBe('MATERIALIZADO');
    if (salida.estado !== 'MATERIALIZADO') return;
    expect(salida.cuentas).toBe(185);

    const chart = await raw.query<{ template_id: string; template_version: number; name: string }>(
      'SELECT template_id, template_version, name FROM account_charts WHERE id = $1',
      [salida.chartId],
    );
    expect(chart.rows[0]!.template_id).toBe(PLANTILLA.templateId);
    expect(chart.rows[0]!.template_version).toBe(PLANTILLA.version);
  });

  it('cada cuenta del catálogo quedó igual en la base', async () => {
    const enBase = new Map((await cuentasDeLaEmpresa()).map((f) => [f.code, f]));
    expect(enBase.size).toBe(CUENTAS.length);

    for (const cuenta of CUENTAS) {
      const fila = enBase.get(cuenta.codigo);
      expect(fila, `falta ${cuenta.codigo}`).toBeDefined();
      expect(fila!.name, cuenta.codigo).toBe(cuenta.nombre);
      expect(fila!.type, cuenta.codigo).toBe(cuenta.tipo);
      expect(fila!.tax_role, cuenta.codigo).toBe(cuenta.taxRole ?? null);
      expect(fila!.closing_role, cuenta.codigo).toBe(cuenta.closingRole ?? null);
    }
  });

  it('las agrupadoras quedaron no imputables y las hojas imputables', async () => {
    // Es el trigger de la 0003 haciendo su trabajo sobre el orden en que se
    // insertó. Con el orden invertido, esto daría exactamente al revés.
    const enBase = await cuentasDeLaEmpresa();
    const porCodigo = new Map(enBase.map((f) => [f.code, f]));

    for (const cuenta of CUENTAS) {
      expect(porCodigo.get(cuenta.codigo)!.is_postable, cuenta.codigo).toBe(cuenta.imputable);
    }
    expect(enBase.filter((f) => !f.is_postable).length).toBe(42);
    expect(enBase.filter((f) => f.is_postable).length).toBe(143);
  });

  it('las doce regularizadoras quedaron con la naturaleza invertida', async () => {
    const porCodigo = new Map((await cuentasDeLaEmpresa()).map((f) => [f.code, f]));
    const regularizadoras = CUENTAS.filter((cuenta) => cuenta.regularizadora === true);
    expect(regularizadoras.length).toBe(12);

    for (const cuenta of regularizadoras) {
      expect(porCodigo.get(cuenta.codigo)!.nature, cuenta.codigo).toBe(cuenta.naturaleza);
    }
  });

  it('el árbol quedó armado: cada cuenta cuelga de quien dice el código', async () => {
    const enBase = await cuentasDeLaEmpresa();
    for (const fila of enBase) {
      const esperado = fila.code.includes('.')
        ? fila.code.slice(0, fila.code.lastIndexOf('.'))
        : null;
      expect(fila.parent_code, fila.code).toBe(esperado);
    }
  });

  it('sobre una empresa que ya tiene plan no se materializa nada', async () => {
    const { materializarPlanModelo } = await import(
      '@aai/api/contabilidad/materializar-plan'
    );
    const { withCompany } = await import('@aai/db');

    const salida = await withCompany(
      { companyId, actorId: 'test:materializacion' },
      async (tx) => materializarPlanModelo(tx, companyId),
    );

    expect(salida.estado).toBe('YA_TIENE_PLAN');
    if (salida.estado !== 'YA_TIENE_PLAN') return;
    expect(salida.cuentas).toBe(185);

    // Y no duplicó: sigue habiendo un solo plan y 185 cuentas.
    const planes = await raw.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM account_charts WHERE company_id = $1',
      [companyId],
    );
    expect(Number(planes.rows[0]!.n)).toBe(1);
    expect((await cuentasDeLaEmpresa()).length).toBe(185);
  });

  it('la cuenta de cierre es única y la base la acepta como tal', async () => {
    const r = await raw.query<{ code: string; n: string }>(
      `SELECT code, count(*) OVER ()::text AS n FROM accounts
        WHERE company_id = $1 AND closing_role = 'RESULTADO_DEL_EJERCICIO'`,
      [companyId],
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]!.code).toBe('3.4.02');
  });
});
