/**
 * «Mis clientes»: la empresa propietaria ve cuántas cuentas entran y cuántas suscripciones pagan, y ninguna otra (migración 0140).
 *
 * Lo que se afirma contra PostgreSQL y la API real:
 *
 *   1. **Sólo ella.** Sin propietaria designada, o con otra designada, `GET /propietario/resumen` es un **404** (la ruta «no existe»).
 *   2. **Los números son exactos.** Se mide por diferencia (la base de pruebas arrastra empresas de otras suites): una empresa con
 *      cargo pagado suma una que paga; una ACTIVA sin cobro **no** suma como que paga y se informa aparte; la prueba vencida se
 *      cuenta como vencida sin convertir; lo cobrado por moneda sube exactamente el importe.
 *   3. **La propietaria no se cuenta a sí misma**, aunque tenga suscripción y cobros.
 *   4. La aplicación **no puede leer ni escribir** `platform_owner`: una empresa no se designa sola.
 *   5. La función se niega por SQL directo desde cualquier otra empresa y sin empresa en contexto (`42501`).
 *   6. `GET /companies/current` dice si la empresa en contexto es la propietaria (lo que decide si la consola dibuja el menú).
 */

import { withCheckDigit } from '@aai/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, type Client } from './helpers/db.js';
import { crearEntorno, type EntornoApi } from './helpers/entorno-api.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * Los cobros de esta suite van en una moneda que ninguna otra suite usa: las suites corren en paralelo contra la misma base, y
 * cualquier total en ARS puede moverlo otra mientras ésta mide. Con una moneda propia la suma es exacta, y la propietaria
 * —que también cobra en ella— demuestra que no se cuenta. Los conteos globales (empresas, suscripciones) se miden como cota
 * inferior por la misma razón; lo exacto es lo que se afirma sobre las filas de ESTA suite.
 */
const MONEDA_PROPIA = 'ZZZ';

interface Resumen {
  usuarios: { registrados: number; conCorreoVerificado: number; pendientesDeVerificar: number; nuevos7Dias: number; nuevos30Dias: number };
  empresas: { total: number; nuevas7Dias: number; nuevas30Dias: number; sinSuscripcion: number; porMes: Array<{ mes: string; nuevas: number }> };
  suscripciones: Record<string, number>;
  pagan: {
    suscripcionesQuePagan: number;
    activasSinCobro: number;
    conPagoEnLosUltimos35Dias: number;
    cobradoPorMoneda: Array<{ moneda: string; importe: string }>;
    porPlan: Array<{ plan: string; pagan: number }>;
  };
  clientes: Array<{ empresa: string; estado: string; paga: boolean; plan: string; ultimoPago: string | null }>;
}

suite('«Mis clientes» · sólo la propietaria', () => {
  let env: EntornoApi;
  let db: Client;
  let planId: string;
  let propietariaOriginal: string | null = null;

  const resumen = async (): Promise<{ estado: number; datos: Resumen }> => {
    const r = await env.pedir('GET', '/propietario/resumen');
    return { estado: r.statusCode, datos: r.json() as Resumen };
  };

  const designar = async (empresaId: string | null): Promise<void> => {
    await db.query('DELETE FROM platform_owner');
    if (empresaId !== null) {
      await db.query(`INSERT INTO platform_owner (empresa_propietaria_id, designada_por, motivo) VALUES ($1, 'test', 'prueba de integración')`, [empresaId]);
    }
  };

  const crearEmpresa = async (nombre: string): Promise<string> => {
    const stamp = await sufijoUnico(db);
    // Por SQL directo: el usuario del entorno es MEMBER del estudio y no puede crear empresas por la función de la aplicación.
    return (
      await db.query<{ id: string }>(
        `INSERT INTO companies (organization_id, legal_name, cuit, entity_type, jurisdiction, regulator, fiscal_year_end)
         VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
        [env.organizationId, `${nombre} ${stamp}`, withCheckDigit(`30${stamp}`)],
      )
    ).rows[0]!.id;
  };

  const suscribir = async (companyId: string, estado: string, desde = '2026-10-01', hasta: string | null = null): Promise<string> =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO company_subscriptions (company_id, plan_id, estado, vigencia_desde, vigencia_hasta, created_by, motivo)
         VALUES ($1, $2, $3, $4::date, $5::date, 'test', $6) RETURNING id`,
        [companyId, planId, estado, desde, hasta, estado === 'ACTIVA' || estado === 'PRUEBA' ? null : 'prueba'],
      )
    ).rows[0]!.id;

  const cobrar = async (companyId: string, subId: string, importe: string): Promise<void> => {
    const periodo = await db.query<{ id: string }>(
      `INSERT INTO billing_periods (company_id, subscription_id, desde, hasta, estado, moneda, importe, created_by)
       VALUES ($1, $2, '2026-10-01'::date, '2026-10-31'::date, 'FACTURADO', '${MONEDA_PROPIA}', $3, 'test') RETURNING id`,
      [companyId, subId, importe],
    );
    await db.query(
      `INSERT INTO billing_documents (company_id, subscription_id, period_id, tipo, estado, moneda, importe_total, emitido_el, vence_el, pagado_el, created_by)
       VALUES ($1, $2, $3, 'CARGO', 'PAGADO', '${MONEDA_PROPIA}', $4, '2026-10-01'::date, '2026-10-11'::date, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'test')`,
      [companyId, subId, periodo.rows[0]!.id, importe],
    );
  };

  beforeAll(async () => {
    env = await crearEntorno('propietario');
    db = env.db;
    planId = (await db.query<{ id: string }>(`SELECT id FROM subscription_plans WHERE code = 'PYME' LIMIT 1`)).rows[0]!.id;
    const previa = await db.query<{ empresa_propietaria_id: string }>('SELECT empresa_propietaria_id FROM platform_owner');
    propietariaOriginal = previa.rows[0]?.empresa_propietaria_id ?? null;
    await db.query('DELETE FROM platform_owner');
  });

  afterAll(async () => {
    await designar(propietariaOriginal);
    await env.cerrar();
  });

  it('sin propietaria designada, la ruta no existe (404) y la empresa no figura como propietaria', async () => {
    expect((await resumen()).estado).toBe(404);
    const c = await env.pedir('GET', '/companies/current');
    expect((c.json() as { esPropietaria: boolean }).esPropietaria).toBe(false);
  });

  it('con OTRA empresa designada, la nuestra sigue sin ver nada (404)', async () => {
    const otra = await crearEmpresa('Otra propietaria');
    await designar(otra);
    expect((await resumen()).estado).toBe(404);
    expect(((await env.pedir('GET', '/companies/current')).json() as { esPropietaria: boolean }).esPropietaria).toBe(false);
  });

  it('la aplicación no puede leer ni escribir platform_owner: una empresa no se designa sola', async () => {
    let lectura = '';
    let escritura = '';
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      await db.query('SAVEPOINT a');
      try {
        await db.query('SELECT * FROM platform_owner');
      } catch (e) {
        lectura = (e as { code?: string }).code ?? '';
      }
      await db.query('ROLLBACK TO a');
      try {
        await db.query(`INSERT INTO platform_owner (empresa_propietaria_id, designada_por, motivo) VALUES ($1, 'x', 'intento de designarse')`, [env.empresa]);
      } catch (e) {
        escritura = (e as { code?: string }).code ?? '';
      }
    } finally {
      await db.query('ROLLBACK');
    }
    expect(lectura, 'aai_app puede leer platform_owner').toBe('42501');
    expect(escritura, 'aai_app puede escribir platform_owner').toBe('42501');
  });

  it('por SQL directo, la función se niega desde otra empresa y sin empresa en contexto (42501)', async () => {
    const otra = await crearEmpresa('Intrusa');
    const llamar = async (empresaEnContexto: string | null): Promise<string> => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE aai_app');
        if (empresaEnContexto !== null) await db.query('SELECT set_config($1, $2, true)', ['app.company_id', empresaEnContexto]);
        await db.query('SELECT resumen_de_cuentas_del_propietario()');
        return '';
      } catch (e) {
        return (e as { code?: string }).code ?? '';
      } finally {
        await db.query('ROLLBACK');
      }
    };
    await designar(env.empresa);
    expect(await llamar(otra)).toBe('42501');
    expect(await llamar(null)).toBe('42501');
    expect(await llamar(env.empresa)).toBe('');
  });

  it('la propietaria ve los números, y son exactos (por diferencia)', async () => {
    await designar(env.empresa);
    const antes = await resumen();
    expect(antes.estado).toBe(200);
    expect(((await env.pedir('GET', '/companies/current')).json() as { esPropietaria: boolean }).esPropietaria).toBe(true);

    // La propietaria misma: con suscripción activa y un cobro. NO tiene que contarse en nada.
    const subPropia = await suscribir(env.empresa, 'ACTIVA');
    await cobrar(env.empresa, subPropia, '999.00');

    // Cuatro clientes.
    const paga = await crearEmpresa('Cliente que paga');
    await cobrar(paga, await suscribir(paga, 'ACTIVA'), '3000.00');
    const sinCobro = await crearEmpresa('Cliente activo sin cobro');
    await suscribir(sinCobro, 'ACTIVA', '2026-10-01', '2099-12-31');
    const enPrueba = await crearEmpresa('Cliente en prueba');
    await suscribir(enPrueba, 'PRUEBA', '2026-10-10', '2099-01-01');
    const vencida = await crearEmpresa('Cliente con prueba vencida');
    await suscribir(vencida, 'PRUEBA', '2026-01-01', '2026-02-01');

    const despues = await resumen();
    expect(despues.estado).toBe(200);
    const d = despues.datos;
    const a = antes.datos;

    // Cotas inferiores: otras suites crean empresas y suscripciones en paralelo sobre la misma base.
    expect(d.empresas.total - a.empresas.total, 'empresas').toBeGreaterThanOrEqual(4);
    expect(d.empresas.nuevas7Dias - a.empresas.nuevas7Dias).toBeGreaterThanOrEqual(4);
    expect(d.suscripciones['activa']! - a.suscripciones['activa']!, 'activas').toBeGreaterThanOrEqual(2);
    expect(d.suscripciones['prueba']! - a.suscripciones['prueba']!, 'en prueba').toBeGreaterThanOrEqual(2);
    expect(d.suscripciones['pruebasVencidasSinConvertir']! - a.suscripciones['pruebasVencidasSinConvertir']!).toBeGreaterThanOrEqual(1);
    expect(d.pagan.suscripcionesQuePagan - a.pagan.suscripcionesQuePagan, 'pagan').toBeGreaterThanOrEqual(1);
    expect(d.pagan.activasSinCobro - a.pagan.activasSinCobro, 'activas sin cobro').toBeGreaterThanOrEqual(1);
    expect(d.pagan.conPagoEnLosUltimos35Dias - a.pagan.conPagoEnLosUltimos35Dias).toBeGreaterThanOrEqual(1);
    // Dentro de UNA misma respuesta las dos mitades de «activa» tienen que sumar el total: no hay carrera que lo explique.
    expect(d.pagan.suscripcionesQuePagan + d.pagan.activasSinCobro).toBe(d.suscripciones['activa']);

    // Exacto (por diferencia: la base se arrastra entre corridas): nadie más cobra en esta moneda, y la propietaria (que cobró 999.00 en ella) no se cuenta.
    const propia = (r: Resumen): bigint => BigInt((r.pagan.cobradoPorMoneda.find((m) => m.moneda === MONEDA_PROPIA)?.importe ?? '0').replace('.', ''));
    expect(propia(d) - propia(a), 'lo cobrado en la moneda de la suite, sin la propietaria').toBe(300000n);

    const porNombre = (nombre: string) => d.clientes.find((c) => c.empresa.startsWith(nombre));
    expect(porNombre('Cliente que paga')).toMatchObject({ paga: true, estado: 'ACTIVA', plan: 'PYME' });
    expect(porNombre('Cliente activo sin cobro')).toMatchObject({ paga: false, estado: 'ACTIVA' });
    expect(porNombre('Cliente en prueba')).toMatchObject({ paga: false, estado: 'PRUEBA' });
    expect(d.clientes.find((c) => c.empresa === `Empresa propietario ${env.stamp}`), 'la propietaria no se lista').toBeUndefined();
  });

  it('por mes: las empresas nuevas de este mes aparecen en el último mes de la serie', async () => {
    await designar(env.empresa);
    const { datos } = await resumen();
    expect(datos.empresas.porMes).toHaveLength(12);
    const ultimo = datos.empresas.porMes.at(-1)!;
    expect(ultimo.nuevas).toBeGreaterThanOrEqual(4);
  });
});
