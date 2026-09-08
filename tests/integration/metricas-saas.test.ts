/**
 * Las métricas del negocio de NEXO: que la fórmula sea la que dice ser.
 *
 * ## Por qué casi nada se afirma sobre el total
 *
 * Estas vistas agregan sobre **todas** las empresas de la base, y la base de
 * pruebas es compartida: otras suites dan de alta suscripciones con sus propios
 * importes. Un test que exigiera «MRR = 2000» pasaría hoy y fallaría mañana por
 * algo que ocurrió en otro archivo, y el que lo viera fallar iría a buscar el
 * defecto donde no está.
 *
 * Así que se prueba lo que **no** depende de qué más haya en la base:
 *
 *   1. la normalización fila por fila —un plan anual aporta su doceava parte—,
 *      medida sobre suscripciones propias;
 *   2. las identidades del agregado: `arr = mrr × 12`, `arpu = mrr / n`;
 *   3. que lo que no tiene importe quede **afuera del MRR y adentro de la lista
 *      de excluidos**, que es la mitad que hace auditable al número;
 *   4. que una baja aparezca con su fecha, tomada de la bitácora.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

suite('Métricas SaaS', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;
  let mensual: string;
  let anual: string;
  let sinImporte: string;
  let empresaMensual: string;
  let empresaAnual: string;
  let empresaSinImporte: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'metricas-saas');
    planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    empresaMensual = await nuevaEmpresa('mensual');
    empresaAnual = await nuevaEmpresa('anual');
    empresaSinImporte = await nuevaEmpresa('sin-importe');

    mensual = await suscribir(empresaMensual, 'MENSUAL', '1000.00');
    anual = await suscribir(empresaAnual, 'ANUAL', '12000.00');
    sinImporte = await suscribirSinCondiciones(empresaSinImporte);
  });

  afterAll(async () => {
    await db.end();
  });

  async function nuevaEmpresa(etiqueta: string): Promise<string> {
    const sufijo = await sufijoUnico(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type,
                              jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [fx.organizationId, `Métricas ${etiqueta} ${sufijo}`, `30${sufijo}3`],
    );
    return r.rows[0]!.id;
  }

  async function suscribir(
    companyId: string,
    periodicidad: string,
    importe: string,
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion)
       VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, 'test', $3, 'ARS', $4::numeric, CURRENT_DATE)
       RETURNING id`,
      [companyId, planId, periodicidad, importe],
    );
    return r.rows[0]!.id;
  }

  async function suscribirSinCondiciones(companyId: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by)
       VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, 'test') RETURNING id`,
      [companyId, planId],
    );
    return r.rows[0]!.id;
  }

  it('un plan anual aporta su doceava parte al MRR', async () => {
    // Es la única normalización que hace comparables las dos periodicidades. Sin
    // ella, un cliente anual de 12.000 se contaría como 12.000 de ingreso
    // mensual: el MRR quedaría doce veces inflado por cada anual que entre.
    const { rows } = await db.query<{ subscription_id: string; mensualizado: string }>(
      `SELECT subscription_id, mensualizado::text AS mensualizado
         FROM saas_suscripciones_vigentes
        WHERE subscription_id = ANY($1::uuid[]) ORDER BY mensualizado`,
      [[mensual, anual]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(Number(r.mensualizado)).toBe(1000);
  });

  it('la que no tiene importe queda afuera del MRR y adentro de la lista de excluidas', async () => {
    // Las dos mitades, y la segunda es la que hace auditable al número: un MRR
    // sin la lista de lo que quedó afuera no se puede revisar.
    const dentro = await db.query(
      `SELECT 1 FROM saas_suscripciones_vigentes
        WHERE subscription_id = $1 AND mensualizado IS NOT NULL`,
      [sinImporte],
    );
    expect(dentro.rowCount).toBe(0);

    const excluida = await db.query<{ subscription_id: string }>(
      'SELECT subscription_id FROM saas_sin_importe WHERE subscription_id = $1',
      [sinImporte],
    );
    expect(excluida.rowCount).toBe(1);
  });

  it('el ARR es doce veces el MRR y el ARPU es el MRR sobre las suscripciones', async () => {
    // Las identidades no dependen de qué más haya en la base, que es lo que las
    // hace comprobables acá.
    const { rows } = await db.query<{
      mrr: string;
      arr: string;
      arpu: string | null;
      activas: string;
      prueba: string;
      suspendidas: string;
    }>(`SELECT mrr::text, arr::text, arpu::text,
               suscripciones_activas::text AS activas,
               en_prueba::text AS prueba,
               suspendidas::text AS suspendidas
          FROM saas_ingreso_recurrente WHERE moneda = 'ARS'`);

    expect(rows).toHaveLength(1);
    const m = rows[0]!;
    expect(Number(m.arr)).toBeCloseTo(Number(m.mrr) * 12, 2);

    // Los contadores vuelven como texto: `pg` no convierte `bigint` a `number`
    // por su cuenta, y con razón — un bigint no siempre entra en un number.
    const n = Number(m.activas) + Number(m.prueba) + Number(m.suspendidas);
    expect(n).toBeGreaterThan(0);
    expect(Number(m.arpu)).toBeCloseTo(Number(m.mrr) / n, 2);
  });

  it('nunca suma monedas distintas', async () => {
    // Un total que mezcla monedas no significa nada y se ve igual que uno que
    // sí. La vista agrupa por moneda; que haya una fila por moneda es la forma
    // de que no se pueda pedir el total mezclado.
    const { rows } = await db.query<{ moneda: string }>(
      'SELECT moneda FROM saas_ingreso_recurrente',
    );
    expect(new Set(rows.map((r) => r.moneda)).size).toBe(rows.length);
  });

  it('una baja aparece con su fecha, tomada de la bitácora', async () => {
    // La fecha no está en `company_subscriptions`: ahí vive el estado actual.
    // Cuándo pasó a estarlo lo sabe la bitácora, y agregar una columna sería un
    // segundo registro del mismo hecho (ADR-022).
    await db.query(
      `UPDATE company_subscriptions SET estado = 'CANCELADA', motivo = 'Baja de prueba'
        WHERE id = $1`,
      [mensual],
    );
    await db.query(
      `INSERT INTO audit_logs
         (company_id, actor_type, actor_id, action, object_type, object_id,
          old_value, new_value, motivo, prev_hash, hash)
       VALUES ($1, 'USER', 'test:operador', 'CAMBIAR_ESTADO_DE_PLAN',
               'company_subscriptions', $2,
               '{"estado":"ACTIVA"}'::jsonb, '{"estado":"CANCELADA"}'::jsonb,
               'Baja de prueba', '', '')`,
      [empresaMensual, mensual],
    );

    const { rows } = await db.query<{ tipo: string; motivo: string }>(
      `SELECT tipo, motivo FROM saas_movimientos
        WHERE company_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [empresaMensual],
    );
    expect(rows[0]!.tipo).toBe('BAJA_VOLUNTARIA');
    expect(rows[0]!.motivo).toBe('Baja de prueba');
  });

  it('la baja voluntaria y la suspensión por falta de pago no se mezclan', async () => {
    // Sumarlas en un solo «churn» hace que arreglar el cobro se vea como
    // retener clientes, que es exactamente la conclusión equivocada.
    await db.query(
      `INSERT INTO audit_logs
         (company_id, actor_type, actor_id, action, object_type, object_id,
          new_value, motivo, prev_hash, hash)
       VALUES ($1, 'SYSTEM', 'test:ciclo', 'SUSPENDER_POR_FALTA_DE_PAGO',
               'company_subscription', $2, '{"estado":"SUSPENDIDA"}'::jsonb,
               'Documento impago', '', '')`,
      [empresaAnual, anual],
    );

    const { rows } = await db.query<{ tipo: string }>(
      'SELECT tipo FROM saas_movimientos WHERE company_id = $1',
      [empresaAnual],
    );
    expect(rows.map((r) => r.tipo)).toContain('SUSPENSION_POR_PAGO');
    expect(rows.map((r) => r.tipo)).not.toContain('BAJA_VOLUNTARIA');
  });

  it('una suscripción cancelada sale del ingreso recurrente', async () => {
    const { rowCount } = await db.query(
      'SELECT 1 FROM saas_suscripciones_vigentes WHERE subscription_id = $1',
      [mensual],
    );
    expect(rowCount).toBe(0);
  });
});
