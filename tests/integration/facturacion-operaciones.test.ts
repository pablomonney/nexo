/**
 * Las tres operaciones que no son el ciclo: eventos de pasarela, anulación y
 * cambio de plan.
 *
 * Están en su propio archivo y no en `facturacion.test.ts` porque prueban otra
 * cosa. Aquel defiende que el ciclo emita bien y que nadie pueda cobrarse a sí
 * mismo; este defiende las **máquinas de estado**: qué transición es posible,
 * cuál es un reenvío, cuál llegó tarde y cuál es imposible.
 *
 * ## Por qué importa tanto lo repetido y lo atrasado
 *
 * Una pasarela reenvía. El mismo aviso puede llegar dos veces, y puede llegar
 * desordenado. Un sistema que trate el segundo `PAGADO` como un fallo de
 * integración va a hacer que alguien investigue un cobro correcto; uno que
 * aplique el `AUTORIZADO` que llegó después del `PAGADO` va a hacer retroceder
 * un cobro que ya entró. Los dos casos se ven acá.
 */

import { correrCiclo, registrarCobro } from '@aai/api/billing/ciclo';
import {
  anularDocumento,
  cambiarDePlan,
  procesarEventoDePago,
} from '@aai/api/billing/ciclo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const txDe = (db: Client) => ({
  query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]),
});

suite('Facturación — eventos, anulación y cambio de plan', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;
  let sub: string;
  let documento: string;
  let stamp: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'operaciones-facturacion');
    stamp = await sufijoUnico(db);
    planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    sub = await suscribir(fx.companyA, '2026-01-01', '3000.00');
    await correrCiclo(txDe(db), '2026-01-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    documento = (
      await db.query<{ id: string }>(
        'SELECT id FROM billing_documents WHERE subscription_id = $1',
        [sub],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
  });

  /** Una empresa nueva: la 0073 no deja dos suscripciones superpuestas. */
  async function nuevaEmpresa(etiqueta: string): Promise<string> {
    const sufijo = await sufijoUnico(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type,
                              jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [fx.organizationId, `Empresa ${etiqueta} ${sufijo}`, `30${sufijo}4`],
    );
    return r.rows[0]!.id;
  }

  async function suscribir(
    companyId: string,
    desde: string,
    importe: string,
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion)
       VALUES ($1, $2, 'ACTIVA', $3::date, 'test', 'MENSUAL', 'ARS', $4::numeric, $3::date)
       RETURNING id`,
      [companyId, planId, desde, importe],
    );
    return r.rows[0]!.id;
  }

  /** Un intento PENDIENTE contra el que aplicar eventos. */
  async function nuevoIntento(sufijo: string): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO payment_intents
         (company_id, document_id, proveedor, referencia_externa, moneda, importe,
          estado, idempotency_key)
       VALUES ($1, $2, 'TEST_GATEWAY_ONLY', $3, 'ARS', 3000.00, 'PENDIENTE', $4)
       RETURNING id`,
      [fx.companyA, documento, `ref-${stamp}-${sufijo}`, `idem-${stamp}-${sufijo}`],
    );
    return r.rows[0]!.id;
  }

  it('aplica un evento válido y deja el intento en el estado informado', async () => {
    const intento = await nuevoIntento('ok');
    const r = await procesarEventoDePago(txDe(db), {
      proveedor: 'TEST_GATEWAY_ONLY',
      eventoExterno: `evt-${stamp}-ok`,
      tipo: 'payment.succeeded',
      estadoInformado: 'PAGADO',
      intentId: intento,
    });
    expect(r.resultado).toBe('APLICADO');

    const e = await db.query<{ estado: string }>(
      'SELECT estado FROM payment_intents WHERE id = $1',
      [intento],
    );
    expect(e.rows[0]!.estado).toBe('PAGADO');
  });

  it('el mismo evento dos veces es REPETIDO, no un error de integración', async () => {
    // Que el segundo aviso rompa la transacción haría que el proveedor siga
    // reintentando para siempre.
    const r = await procesarEventoDePago(txDe(db), {
      proveedor: 'TEST_GATEWAY_ONLY',
      eventoExterno: `evt-${stamp}-ok`,
      tipo: 'payment.succeeded',
      estadoInformado: 'PAGADO',
    });
    expect(r.resultado).toBe('REPETIDO');
  });

  it('un evento que llega tarde no hace retroceder el cobro', async () => {
    const intento = await nuevoIntento('tarde');
    await procesarEventoDePago(txDe(db), {
      proveedor: 'TEST_GATEWAY_ONLY',
      eventoExterno: `evt-${stamp}-tarde-1`,
      tipo: 'payment.succeeded',
      estadoInformado: 'PAGADO',
      intentId: intento,
    });

    const r = await procesarEventoDePago(txDe(db), {
      proveedor: 'TEST_GATEWAY_ONLY',
      eventoExterno: `evt-${stamp}-tarde-2`,
      tipo: 'payment.authorized',
      estadoInformado: 'AUTORIZADO',
      intentId: intento,
    });
    expect(r.resultado).toBe('ATRASADO');

    const e = await db.query<{ estado: string }>(
      'SELECT estado FROM payment_intents WHERE id = $1',
      [intento],
    );
    expect(e.rows[0]!.estado).toBe('PAGADO');
  });

  it('un evento imposible se registra como CONFLICTO y no se aplica', async () => {
    const intento = await nuevoIntento('conflicto');
    // Reembolsar lo que nunca se cobró.
    const r = await procesarEventoDePago(txDe(db), {
      proveedor: 'TEST_GATEWAY_ONLY',
      eventoExterno: `evt-${stamp}-conflicto`,
      tipo: 'payment.refunded',
      estadoInformado: 'REEMBOLSADO',
      intentId: intento,
    });
    expect(r.resultado).toBe('CONFLICTO');

    const e = await db.query<{ estado: string }>(
      'SELECT estado FROM payment_intents WHERE id = $1',
      [intento],
    );
    expect(e.rows[0]!.estado).toBe('PENDIENTE');
  });

  it('un evento sobre un cobro que este sistema no inició se guarda igual', async () => {
    // Es la evidencia de que la pasarela cree que existe algo que acá no está.
    // Descartarlo en silencio borra esa evidencia.
    const r = await procesarEventoDePago(txDe(db), {
      proveedor: 'TEST_GATEWAY_ONLY',
      eventoExterno: `evt-${stamp}-huerfano`,
      tipo: 'payment.succeeded',
      estadoInformado: 'PAGADO',
      referenciaExterna: 'TEST_REF_QUE_NO_EXISTE',
    });
    expect(r.resultado).toBe('DESCONOCIDO');

    const guardado = await db.query<{ resultado: string }>(
      'SELECT resultado FROM payment_events WHERE evento_externo = $1',
      [`evt-${stamp}-huerfano`],
    );
    expect(guardado.rows[0]!.resultado).toBe('DESCONOCIDO');
  });

  it('anular exige motivo, y anulado no es borrado', async () => {
    const sinMotivo = await anularDocumento(txDe(db), {
      documentId: documento,
      motivo: 'x',
      actorId: 'test:operador',
    });
    expect(sinMotivo.estado).toBe('NO_SE_PUEDE');

    const r = await anularDocumento(txDe(db), {
      documentId: documento,
      motivo: 'Emitido por error: la suscripción arrancaba el mes siguiente',
      actorId: 'test:operador',
    });
    expect(r.estado).toBe('ANULADO');

    const d = await db.query<{ estado: string; motivo_anulacion: string }>(
      'SELECT estado, motivo_anulacion FROM billing_documents WHERE id = $1',
      [documento],
    );
    // El documento sigue, con su número y su motivo. Un documento que
    // desaparece no deja hueco: deja una pregunta sin respuesta.
    expect(d.rows[0]!.estado).toBe('ANULADO');
    expect(d.rows[0]!.motivo_anulacion).toMatch(/por error/u);
  });

  it('un documento pagado no se anula: se acredita', async () => {
    const empresa = await nuevaEmpresa('pagada');
    const s = await suscribir(empresa, '2026-05-01', '500.00');
    await correrCiclo(txDe(db), '2026-05-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const doc = (
      await db.query<{ id: string }>(
        'SELECT id FROM billing_documents WHERE subscription_id = $1',
        [s],
      )
    ).rows[0]!.id;
    await registrarCobro(txDe(db), {
      documentId: doc,
      proveedor: 'TRANSFERENCIA',
      idempotencia: `pagada-${stamp}-${s}`,
      actorId: 'test:operador',
      pagadoEl: '2026-05-02',
    });

    const r = await anularDocumento(txDe(db), {
      documentId: doc,
      motivo: 'Intento de anular algo ya cobrado',
      actorId: 'test:operador',
    });
    expect(r.estado).toBe('NO_SE_PUEDE');
    expect(r.detalle).toMatch(/nota de crédito/u);
  });

  it('el cambio de plan parte el período sin crear ni perder centavos', async () => {
    const empresa = await nuevaEmpresa('cambio');
    const s = await suscribir(empresa, '2026-07-01', '100.00');

    // Julio tiene 31 días. Del 1 al 15 son 15; del 16 al 31, 16.
    const r = await cambiarDePlan(txDe(db), {
      subscriptionId: s,
      nuevoPlanId: planId,
      nuevoImporte: '200.00',
      desde: '2026-07-16',
      actorId: 'test:operador',
    });

    expect(r.estado).toBe('CAMBIADO');
    if (r.estado !== 'CAMBIADO') return;
    // 100 × 15/31 = 48,39 por lo viejo; 200 × 16/31 = 103,23 por lo nuevo.
    expect(r.cobrableDelPeriodo).toBe('48.39');
    expect(r.restante).toBe('103.23');

    const actualizada = await db.query<{ importe_acordado: string }>(
      'SELECT importe_acordado::text FROM company_subscriptions WHERE id = $1',
      [s],
    );
    expect(actualizada.rows[0]!.importe_acordado).toBe('200.00');
  });

  it('el cambio de plan fuera del período en curso se rechaza', async () => {
    const r = await cambiarDePlan(txDe(db), {
      subscriptionId: sub,
      nuevoPlanId: planId,
      nuevoImporte: '1.00',
      desde: '2030-01-15',
      actorId: 'test:operador',
    });
    expect(r.estado).toBe('NO_SE_PUEDE');
  });

  it('el cambio de plan queda en la bitácora con el importe viejo y el nuevo', async () => {
    const log = await db.query<{ old_value: unknown; new_value: unknown }>(
      `SELECT old_value, new_value FROM audit_logs
        WHERE action = 'CAMBIAR_PLAN_DE_SUSCRIPCION' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(log.rows[0]!.old_value).toMatchObject({ importe: '100.00' });
    expect(log.rows[0]!.new_value).toMatchObject({ importe: '200.00' });
  });
});
