/**
 * El ciclo de facturación de NEXO, de punta a punta.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que nadie pueda cobrarse a sí mismo.** `aai_app` tiene solo `SELECT`
 *      sobre las tablas de facturación: aunque alguien escribiera el `INSERT` en
 *      una ruta, la base lo rechaza.
 *   2. **Que una empresa no vea lo que se le cobra a otra.** Con el rol de la
 *      aplicación puesto, que es la única forma de ejercer RLS `FORCE`.
 *   3. **Que correr el ciclo dos veces no cobre dos veces.** Ni el mismo día ni
 *      con la misma clave de idempotencia.
 *   4. **Que sin precio no se emita un cargo de cero.** Cero se ve igual que un
 *      cliente que no debe nada.
 *   5. **Que sin política de cobranza no se suspenda a nadie.** Ausencia de
 *      política no es política de tolerancia cero.
 *   6. **Que no haya dónde guardar datos de tarjeta.** Comprobado contra el
 *      esquema, no contra una lista escrita a mano.
 *
 * ## Por qué el ciclo se llama con un `Tx` armado acá
 *
 * Porque así se lo llama en producción: el ciclo no abre conexiones. El script
 * del operador le pasa la suya, y este test le pasa la del test. Si el ciclo
 * abriera la suya, este archivo estaría probando otra cosa que la que corre.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { correrCiclo, registrarCobro, politicaVigente } from '@aai/api/billing/ciclo';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asCompany,
  connect,
  hasDatabase,
  organizacionDe,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

/** El `Tx` que espera el ciclo: solo `query`. */
const txDe = (db: Client) => ({
  query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]),
});

suite('Facturación — el ciclo', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'facturacion');
    // Se reusa un plan ya sembrado en vez de crear uno: `subscription_plans` es
    // del despliegue, no de una empresa, y sembrarla desde un test le cambia el
    // catálogo a todas las demás suites. Lo detectó el test de suscripciones,
    // que compara la lista de planes.
    planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
  });

  /**
   * Una empresa nueva del mismo estudio.
   *
   * Hace falta una por test porque la 0073 impide que una empresa tenga dos
   * suscripciones vigentes superpuestas —E_SUB_SUPERPUESTA—, y cada caso de acá
   * necesita su propia suscripción con sus propias fechas.
   */
  const nuevaEmpresa = async (): Promise<string> => {
    const sufijo = await sufijoUnico(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type,
                              jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [fx.organizationId, `Empresa ciclo ${sufijo}`, `30${sufijo}7`],
    );
    return r.rows[0]!.id;
  };

  /** Una suscripción con condiciones acordadas, lista para facturar. */
  const suscribir = async (
    companyId: string,
    opciones: {
      desde: string;
      proxima: string;
      importe?: string;
      estado?: string;
      periodicidad?: string;
    },
  ): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion, motivo)
       VALUES ($1, $2, $3, $4::date, 'test', $5, 'ARS', $6::numeric, $7::date, $8)
       RETURNING id`,
      [
        companyId,
        planId,
        opciones.estado ?? 'ACTIVA',
        opciones.desde,
        opciones.periodicidad ?? 'MENSUAL',
        opciones.importe ?? '10000.00',
        opciones.proxima,
        // La 0073 exige motivo para SUSPENDIDA y CANCELADA, y lo exige en el
        // INSERT: no alcanza con ponerlo después.
        opciones.estado === 'SUSPENDIDA' || opciones.estado === 'CANCELADA'
          ? 'Falta de pago'
          : null,
      ],
    );
    return r.rows[0]!.id;
  };

  const documentosDe = async (subscriptionId: string) =>
    (
      await db.query<{ id: string; numero: string; estado: string; importe_total: string }>(
        `SELECT id, numero::text AS numero, estado, importe_total::text AS importe_total
           FROM billing_documents WHERE subscription_id = $1 ORDER BY numero`,
        [subscriptionId],
      )
    ).rows;

  it('emite un cargo por el período que vence', async () => {
    const sub = await suscribir(fx.companyA, { desde: '2026-01-01', proxima: '2026-01-01' });
    const informe = await correrCiclo(txDe(db), '2026-01-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    const mios = informe.emitidos.filter((d) => d.companyId === fx.companyA);
    expect(mios).toHaveLength(1);
    expect(mios[0]!.importe).toBe('10000.00');
    expect(mios[0]!.desde).toBe('2026-01-01');
    expect(mios[0]!.hasta).toBe('2026-01-31');

    const docs = await documentosDe(sub);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.estado).toBe('EMITIDO');
  });

  it('correrlo dos veces el mismo día no cobra dos veces', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa, { desde: '2026-02-01', proxima: '2026-02-01' });
    await correrCiclo(txDe(db), '2026-02-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const segunda = await correrCiclo(txDe(db), '2026-02-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    expect(segunda.emitidos.filter((d) => d.companyId === empresa)).toHaveLength(0);
    expect(await documentosDe(sub)).toHaveLength(1);
  });

  it('el ciclo atrasado emite el período que quedó sin facturar, no lo saltea', async () => {
    // Si el ciclo no corrió el lunes, el martes emite el del lunes. Emitir solo
    // el de hoy dejaría un mes de servicio sin cobrar.
    const sub = await suscribir(await nuevaEmpresa(), { desde: '2026-03-01', proxima: '2026-03-01' });
    await correrCiclo(txDe(db), '2026-03-20', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    expect(await documentosDe(sub)).toHaveLength(1);

    const periodo = await db.query<{ desde: string; hasta: string }>(
      'SELECT desde::text, hasta::text FROM billing_periods WHERE subscription_id = $1',
      [sub],
    );
    expect(periodo.rows[0]).toEqual({ desde: '2026-03-01', hasta: '2026-03-31' });
  });

  it('el alta a mitad de mes se prorratea', async () => {
    const sub = await suscribir(await nuevaEmpresa(), {
      desde: '2026-04-16',
      proxima: '2026-04-01',
      importe: '100.00',
    });
    await correrCiclo(txDe(db), '2026-04-16', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    const docs = await documentosDe(sub);
    // Abril tiene 30 días; del 16 al 30 son 15. La mitad exacta.
    expect(docs[0]!.importe_total).toBe('50.00');
  });

  it('sin condiciones acordadas no se emite, y se dice por qué', async () => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions (company_id, plan_id, estado, vigencia_desde, created_by)
       VALUES ($1, $2, 'ACTIVA', '2026-05-01'::date, 'test') RETURNING id`,
      [fx.companyB, planId],
    );
    const sub = r.rows[0]!.id;

    const informe = await correrCiclo(txDe(db), '2026-05-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    // No aparece ni como emitida ni como omitida: sin `proxima_facturacion` la
    // consulta no la levanta. Lo que importa es que no se emitió un cargo de
    // cero, que se vería igual que un cliente que no debe nada.
    expect(informe.emitidos.some((d) => d.companyId === fx.companyB)).toBe(false);
    expect(await documentosDe(sub)).toHaveLength(0);
  });

  it('la próxima facturación avanza al día siguiente del período cerrado', async () => {
    const sub = await suscribir(await nuevaEmpresa(), { desde: '2026-06-01', proxima: '2026-06-01' });
    await correrCiclo(txDe(db), '2026-06-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    const s = await db.query<{ proxima_facturacion: string }>(
      'SELECT proxima_facturacion::text FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(s.rows[0]!.proxima_facturacion).toBe('2026-07-01');
  });

  it('dos períodos consecutivos no dejan hueco', async () => {
    const sub = await suscribir(await nuevaEmpresa(), { desde: '2026-08-31', proxima: '2026-08-31' });
    await correrCiclo(txDe(db), '2026-08-31', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    // El 30, no el 28: el período que arranca un 31 de agosto termina el 29 de
    // septiembre, así que el siguiente recién vence el 30. Correrlo el 28 no
    // emitía nada, y el test lo dijo.
    await correrCiclo(txDe(db), '2026-09-30', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    const periodos = await db.query<{ desde: string; hasta: string }>(
      'SELECT desde::text, hasta::text FROM billing_periods WHERE subscription_id = $1 ORDER BY desde',
      [sub],
    );
    expect(periodos.rows).toHaveLength(2);
    // El 31 de agosto mensual termina el 29 de septiembre porque el siguiente
    // arranca el 30: el recorte de fin de mes se propaga y no deja hueco.
    expect(periodos.rows[0]).toEqual({ desde: '2026-08-31', hasta: '2026-09-29' });
    expect(periodos.rows[1]!.desde).toBe('2026-09-30');
  });

  it('una suscripción suspendida se sigue facturando: la deuda corre', async () => {
    const sub = await suscribir(await nuevaEmpresa(), {
      desde: '2026-10-01',
      proxima: '2026-10-01',
      estado: 'SUSPENDIDA',
    });
    await correrCiclo(txDe(db), '2026-10-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    expect(await documentosDe(sub)).toHaveLength(1);
  });
});

suite('Facturación — cobros', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;
  let sub: string;
  let documento: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'cobros');

    planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    sub = (
      await db.query<{ id: string }>(
        `INSERT INTO company_subscriptions
           (company_id, plan_id, estado, vigencia_desde, created_by,
            periodicidad, moneda, importe_acordado, proxima_facturacion)
         VALUES ($1, $2, 'ACTIVA', '2026-01-01'::date, 'test', 'MENSUAL', 'ARS', 5000.00, '2026-01-01'::date)
         RETURNING id`,
        [fx.companyA, planId],
      )
    ).rows[0]!.id;

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

  it('registra un cobro por transferencia y deja el documento pagado', async () => {
    const r = await registrarCobro(txDe(db), {
      documentId: documento,
      proveedor: 'TRANSFERENCIA',
      idempotencia: `test-cobro-${documento}`,
      actorId: 'test:operador',
      pagadoEl: '2026-01-05',
    });

    expect(r.estado).toBe('REGISTRADO');
    const d = await db.query<{ estado: string; pagado_el: string }>(
      'SELECT estado, pagado_el::text FROM billing_documents WHERE id = $1',
      [documento],
    );
    expect(d.rows[0]).toEqual({ estado: 'PAGADO', pagado_el: '2026-01-05' });
  });

  it('la misma clave de idempotencia no cobra dos veces', async () => {
    // Reintentar el registro de un cobro es normal —una red que se cortó—, así
    // que devuelve YA_REGISTRADO en vez de tirar.
    const r = await registrarCobro(txDe(db), {
      documentId: documento,
      proveedor: 'TRANSFERENCIA',
      idempotencia: `test-cobro-${documento}`,
      actorId: 'test:operador',
      pagadoEl: '2026-01-05',
    });
    expect(r.estado).toBe('YA_REGISTRADO');

    const n = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM payment_intents WHERE document_id = $1',
      [documento],
    );
    expect(n.rows[0]!.n).toBe('1');
  });

  it('un documento ya pagado no se vuelve a cobrar', async () => {
    const r = await registrarCobro(txDe(db), {
      documentId: documento,
      proveedor: 'TRANSFERENCIA',
      idempotencia: `test-cobro-otro-${documento}`,
      actorId: 'test:operador',
      pagadoEl: '2026-01-06',
    });
    expect(r.estado).toBe('DOCUMENTO_NO_COBRABLE');
  });

  it('el cobro queda en la bitácora sin el medio de pago', async () => {
    const log = await db.query<{ action: string; new_value: Record<string, unknown> }>(
      `SELECT action, new_value FROM audit_logs
        WHERE company_id = $1 AND action = 'REGISTRAR_COBRO' ORDER BY occurred_at DESC LIMIT 1`,
      [fx.companyA],
    );
    expect(log.rows[0]!.new_value).toMatchObject({ proveedor: 'TRANSFERENCIA', importe: '5000.00' });
    expect(JSON.stringify(log.rows[0]!.new_value)).not.toMatch(/tarjeta|card|cvv/iu);
  });

  it('pagar levanta la suspensión solo si no queda otra deuda', async () => {
    // Dos meses impagos y una suspensión. Pagar uno no alcanza: levantar con
    // deuda abierta dejaría entrar a quien pagó una de tres facturas.
    await db.query(
      `UPDATE company_subscriptions SET estado = 'SUSPENDIDA', motivo = 'Falta de pago',
              suspendida_el = '2026-02-20'::date, proxima_facturacion = '2026-02-01'::date
        WHERE id = $1`,
      [sub],
    );
    await correrCiclo(txDe(db), '2026-02-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    await db.query(
      `UPDATE company_subscriptions SET proxima_facturacion = '2026-03-01'::date WHERE id = $1`,
      [sub],
    );
    await correrCiclo(txDe(db), '2026-03-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });

    const impagos = (
      await db.query<{ id: string }>(
        `SELECT id FROM billing_documents WHERE subscription_id = $1 AND estado = 'EMITIDO'
          ORDER BY numero`,
        [sub],
      )
    ).rows;
    expect(impagos.length).toBe(2);

    const primero = await registrarCobro(txDe(db), {
      documentId: impagos[0]!.id,
      proveedor: 'TRANSFERENCIA',
      idempotencia: `test-parcial-${impagos[0]!.id}`,
      actorId: 'test:operador',
      pagadoEl: '2026-03-05',
    });
    expect(primero).toMatchObject({ estado: 'REGISTRADO', reactivada: false });

    const segundo = await registrarCobro(txDe(db), {
      documentId: impagos[1]!.id,
      proveedor: 'TRANSFERENCIA',
      idempotencia: `test-parcial-${impagos[1]!.id}`,
      actorId: 'test:operador',
      pagadoEl: '2026-03-06',
    });
    expect(segundo).toMatchObject({ estado: 'REGISTRADO', reactivada: true });

    const s = await db.query<{ estado: string; suspendida_el: string | null }>(
      'SELECT estado, suspendida_el::text FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(s.rows[0]).toEqual({ estado: 'ACTIVA', suspendida_el: null });
  });
});

suite('Facturación — cobranza sin política y con política', () => {
  let db: Client;
  let fx: Fixture;
  let sub: string;
  let documento: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'cobranza');

    const planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    sub = (
      await db.query<{ id: string }>(
        `INSERT INTO company_subscriptions
           (company_id, plan_id, estado, vigencia_desde, created_by,
            periodicidad, moneda, importe_acordado, proxima_facturacion)
         VALUES ($1, $2, 'ACTIVA', '2026-01-01'::date, 'test', 'MENSUAL', 'ARS', 1000.00, '2026-01-01'::date)
         RETURNING id`,
        [fx.companyA, planId],
      )
    ).rows[0]!.id;

    await correrCiclo(txDe(db), '2026-01-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    documento = (
      await db.query<{ id: string }>(
        'SELECT id FROM billing_documents WHERE subscription_id = $1',
        [sub],
      )
    ).rows[0]!.id;

    // Un intento fallido: es lo que dispara la cobranza. El vencimiento del
    // documento no alcanza — un documento que nunca se intentó cobrar no pone al
    // cliente en mora.
    await db.query(
      `INSERT INTO payment_intents
         (company_id, document_id, proveedor, moneda, importe, estado, idempotency_key,
          detalle_error, created_at)
       VALUES ($1, $2, 'TEST_GATEWAY_ONLY', 'ARS', 1000.00, 'FALLIDO', $3,
               'fondos insuficientes (sintetico)', '2026-01-10'::timestamptz)`,
      [fx.companyA, documento, `test-fallo-${documento}`],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM collection_policies WHERE declarado_por = $1', ['test:cobranza']);
    await db.end();
  });

  it('sin política declarada no se suspende a nadie, y se dice por qué', async () => {
    expect(await politicaVigente(txDe(db), '2026-01-15')).toBeNull();

    const informe = await correrCiclo(txDe(db), '2026-01-15', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const mio = informe.cobranza.find((p) => p.documentId === documento);

    expect(mio?.resultado).toBe('OMITIDO');
    expect(mio?.detalle).toMatch(/no es cero reintentos/u);

    const s = await db.query<{ estado: string }>(
      'SELECT estado FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(s.rows[0]!.estado).toBe('ACTIVA');
  });

  it('con política declarada, el ciclo atrasado ejecuta el paso más viejo primero', async () => {
    await db.query(
      `INSERT INTO collection_policies
         (reintentos_en_dias, aviso_en_dias, dias_de_gracia, vigente_desde, declarado_por, motivo)
       VALUES ('{3,7}'::integer[], '{9}'::integer[], 12, '2026-01-01'::date, 'test:cobranza',
               'Política sintética para el test de cobranza')`,
    );

    // El fallo fue el 10 y estamos a 30: hay cuatro pasos vencidos. Ejecuta el
    // primer reintento, no la suspensión.
    const informe = await correrCiclo(txDe(db), '2026-01-30', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const mio = informe.cobranza.find((p) => p.documentId === documento);

    expect(mio?.paso).toMatchObject({ tipo: 'REINTENTO', numero: 1 });
    // Y como esta suscripción no está conectada a ninguna pasarela, el reintento
    // no se pudo ejecutar. Se registra igual: sin registro, el ciclo lo volvería
    // a intentar todos los días y el paso siguiente nunca llegaría.
    expect(mio?.resultado).toBe('OMITIDO');
    // El motivo mira la **suscripción** y no la configuración del despliegue.
    // En B2.5.5 esa distinción pasó a importar: una instalación puede tener
    // pasarela conectada y esta suscripción en particular no estar suscripta,
    // que es lo que pasa con toda empresa que paga por transferencia.
    expect(mio?.detalle).toMatch(/no está conectada a ninguna pasarela/u);
    expect(mio?.detalle).toMatch(/transferencia/u);
  });

  it('avanza un paso por corrida hasta suspender, y la suspensión conserva todo', async () => {
    // Tres corridas más: el ciclo avanza **un** paso por vez aunque haya cuatro
    // vencidos, para que ninguno se saltee.
    for (let corrida = 0; corrida < 3; corrida += 1) {
      await correrCiclo(txDe(db), '2026-01-30', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    }

    const pasos = await db.query<{ tipo: string; numero: number | null; resultado: string }>(
      'SELECT tipo, numero, resultado FROM collection_steps WHERE document_id = $1 ORDER BY programado_para, tipo',
      [documento],
    );
    expect(pasos.rows.map((p) => p.tipo)).toEqual(['REINTENTO', 'REINTENTO', 'AVISO', 'SUSPENSION']);

    const s = await db.query<{ estado: string; suspendida_el: string }>(
      'SELECT estado, suspendida_el::text FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(s.rows[0]!.estado).toBe('SUSPENDIDA');
    expect(s.rows[0]!.suspendida_el).toBe('2026-01-22');

    // Suspender corta el acceso y conserva todo: el documento sigue, el período
    // sigue y la suscripción sigue existiendo.
    const doc = await db.query<{ estado: string }>(
      'SELECT estado FROM billing_documents WHERE id = $1',
      [documento],
    );
    expect(doc.rows[0]!.estado).toBe('EMITIDO');
  });

  it('la suspensión queda en la bitácora con motivo', async () => {
    const log = await db.query<{ motivo: string }>(
      `SELECT motivo FROM audit_logs
        WHERE company_id = $1 AND action = 'SUSPENDER_POR_FALTA_DE_PAGO'
        ORDER BY occurred_at DESC LIMIT 1`,
      [fx.companyA],
    );
    expect(log.rows[0]!.motivo).toMatch(/impago/u);
  });

  it('no repite un paso ya ejecutado aunque el ciclo corra de nuevo', async () => {
    const antes = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection_steps WHERE document_id = $1',
      [documento],
    );
    await correrCiclo(txDe(db), '2026-02-15', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const despues = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM collection_steps WHERE document_id = $1',
      [documento],
    );
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  });
});

suite('Facturación — aislamiento y esquema', () => {
  let db: Client;
  let fx: Fixture;
  let documentoDeA: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'aislamiento-facturacion');

    const planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    await db.query(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion)
       VALUES ($1, $2, 'ACTIVA', '2026-01-01'::date, 'test', 'MENSUAL', 'ARS', 777.00, '2026-01-01'::date)`,
      [fx.companyA, planId],
    );
    await correrCiclo(txDe(db), '2026-01-01', 'test:ciclo', { soloOrganizacion: fx.organizationId });
    documentoDeA = (
      await db.query<{ id: string }>(
        'SELECT id FROM billing_documents WHERE company_id = $1',
        [fx.companyA],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
  });

  it('la empresa B no ve los cargos de la empresa A', async () => {
    // Con `SET LOCAL ROLE aai_app`. Sin eso la conexión es la dueña de la tabla,
    // el FORCE no se ejerce y este test pasaría sin haber probado nada.
    const vistos = await asCompany(db, fx.companyB, async () =>
      (await db.query('SELECT id FROM billing_documents WHERE id = $1', [documentoDeA])).rows,
    );
    expect(vistos).toHaveLength(0);
  });

  it('con su empresa en contexto, A sí los ve', async () => {
    // El control positivo: sin él, este test daría verde también si la consulta
    // no devolviera nada por un motivo equivocado.
    const vistos = await asCompany(db, fx.companyA, async () =>
      (await db.query('SELECT id FROM billing_documents WHERE id = $1', [documentoDeA])).rows,
    );
    expect(vistos).toHaveLength(1);
  });

  it('la aplicación no puede emitirse un cargo: solo tiene SELECT', async () => {
    // Es la defensa que importa. Aunque alguien escribiera el INSERT en una
    // ruta, la base lo rechaza.
    const fallo = await asCompany(db, fx.companyA, async () => {
      try {
        await db.query(
          `INSERT INTO billing_documents
             (company_id, subscription_id, tipo, moneda, importe_total, estado, created_by)
           SELECT $1, id, 'CARGO', 'ARS', 1, 'BORRADOR', 'intruso'
             FROM company_subscriptions WHERE company_id = $1 LIMIT 1`,
          [fx.companyA],
        );
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? '';
      }
    }).catch((error: { code?: string }) => error.code ?? '');

    expect(fallo).toBe('42501');
  });

  it('la aplicación tampoco puede marcar un cargo como pagado', async () => {
    const fallo = await asCompany(db, fx.companyA, async () => {
      try {
        await db.query(`UPDATE billing_documents SET estado = 'PAGADO' WHERE id = $1`, [
          documentoDeA,
        ]);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? '';
      }
    }).catch((error: { code?: string }) => error.code ?? '');

    expect(fallo).toBe('42501');
  });

  it('no hay ninguna columna donde guardar datos de tarjeta', async () => {
    // Contra el esquema y no contra una lista escrita a mano: una columna nueva
    // llamada de cualquier manera lo activa igual.
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('payment_intents', 'payment_events', 'billing_documents',
                             'billing_document_lines', 'company_subscriptions')
          AND (column_name ~* '(^|_)(card|tarjeta|pan|cvv|cvc|titular|holder|expiry)($|_)')`,
    );
    expect(rows).toEqual([]);
  });

  it('un comprobante fiscal sin CAE es imposible, no improbable', async () => {
    let code = '';
    try {
      await db.query('UPDATE billing_documents SET es_comprobante_fiscal = true WHERE id = $1', [
        documentoDeA,
      ]);
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    // 23514 — check_violation.
    expect(code).toBe('23514');
  });

  it('la política de cobranza no puede suspender antes del último reintento', async () => {
    let code = '';
    try {
      await db.query(
        `INSERT INTO collection_policies
           (reintentos_en_dias, aviso_en_dias, dias_de_gracia, vigente_desde, declarado_por, motivo)
         VALUES ('{3,30}'::integer[], '{5}'::integer[], 10, '2027-01-01'::date, 'test', 'imposible a proposito')`,
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('23514');
  });

  it('un plan no puede tener dos precios vigentes desde el mismo día', async () => {
    const plan = (
      await db.query<{ id: string }>(
        'SELECT id FROM subscription_plans ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0]!.id;

    await db.query(
      `INSERT INTO plan_prices (plan_id, periodicidad, moneda, importe, incluye_impuestos,
                                vigente_desde, declarado_por, motivo)
       VALUES ($1, 'MENSUAL', 'ARS', 1.00, true, '2030-01-01'::date, 'test', 'precio sintetico')`,
      [plan],
    );

    let code = '';
    try {
      await db.query(
        `INSERT INTO plan_prices (plan_id, periodicidad, moneda, importe, incluye_impuestos,
                                  vigente_desde, declarado_por, motivo)
         VALUES ($1, 'MENSUAL', 'ARS', 2.00, true, '2030-01-01'::date, 'test', 'precio duplicado')`,
        [plan],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    // 23505 — unique_violation. Dos vigentes a la vez dejarían al motor
    // eligiendo por orden de inserción, es decir por azar.
    expect(code).toBe('23505');

    await db.query(`DELETE FROM plan_prices WHERE declarado_por = 'test'`);
  });
});

suite('Facturación — lo que ve la empresa', () => {
  let app: FastifyInstance;
  let db: Client;
  let token: string;
  let empresa: string;
  let documento: string;
  let stamp: string;

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
          `fundador-fact-${stamp}@estudio.test`,
          'Fundador',
          await argonHash(PASSWORD, {
            algorithm: 2,
            memoryCost: 19_456,
            timeCost: 2,
            parallelism: 1,
          }),
        ],
      )
    ).rows[0]!.id;

    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio fact ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa fact ${stamp}`,
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
        payload: { email: `fundador-fact-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `admin-fact-${stamp}@estudio.test`;
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
    token = (
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

    const planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    await db.query(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion)
       VALUES ($1, $2, 'ACTIVA', '2026-01-01'::date, 'test', 'MENSUAL', 'ARS', 12345.67, '2026-01-01'::date)`,
      [empresa, planId],
    );
    // El ciclo es global: se lo acota a la organización de esta empresa para
    // que no emita sobre las filas de las otras suites, que corren a la par.
    // Esta suite arma su empresa a mano y no tiene fixture, así que la
    // organización se pide por el identificador que sí tiene.
    const organizacion = await organizacionDe(db, empresa);
    await correrCiclo(txDe(db), '2026-01-01', 'test:ciclo', { soloOrganizacion: organizacion });
    documento = (
      await db.query<{ id: string }>('SELECT id FROM billing_documents WHERE company_id = $1', [
        empresa,
      ])
    ).rows[0]!.id;

    // Un intento con últimos cuatro dígitos, para comprobar qué se devuelve y
    // qué no. El valor es sintético.
    await db.query(
      `INSERT INTO payment_intents
         (company_id, document_id, proveedor, referencia_externa, moneda, importe,
          estado, idempotency_key, medio_referencia, medio_ultimos4, detalle_error)
       VALUES ($1, $2, 'TEST_GATEWAY_ONLY', $4, 'ARS', 12345.67,
               'FALLIDO', $3, 'TEST_MEDIO_REF_ONLY', '4242', 'rechazo sintetico')`,
      // La referencia lleva el sufijo del test: la base de pruebas no se borra
      // entre corridas y (proveedor, referencia_externa) es UNIQUE, así que un
      // literal fijo hacía fallar la segunda ejecución del archivo.
      [empresa, documento, `test-visible-${documento}`, `TEST_EXTERNAL_REF_ONLY-${stamp}`],
    );
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  const pedir = (url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });

  it('el estado de cuenta trae lo adeudado por moneda', async () => {
    const r = await pedir('/companies/current/billing');
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      documentos: { id: string; importe: string; impuestos: string | null; esComprobanteFiscal: boolean; diasDeAtraso: number | null }[];
      adeudado: { moneda: string; importe: string }[];
      alcance: string;
    }>();

    expect(cuerpo.documentos).toHaveLength(1);
    expect(cuerpo.documentos[0]!.importe).toBe('12345.67');
    expect(cuerpo.adeudado).toEqual([{ moneda: 'ARS', importe: '12345.67' }]);
  });

  it('los impuestos vienen en null, que no es cero', async () => {
    const cuerpo = (await pedir('/companies/current/billing')).json<{
      documentos: { impuestos: string | null }[];
      alcance: string;
    }>();
    expect(cuerpo.documentos[0]!.impuestos).toBeNull();
    expect(cuerpo.alcance).toMatch(/no que sean cero/u);
  });

  it('el documento no se declara comprobante fiscal', async () => {
    const cuerpo = (await pedir('/companies/current/billing')).json<{
      documentos: { esComprobanteFiscal: boolean }[];
    }>();
    expect(cuerpo.documentos[0]!.esComprobanteFiscal).toBe(false);
  });

  it('sin vencimiento declarado, los días de atraso son null y no cero', async () => {
    const cuerpo = (await pedir('/companies/current/billing')).json<{
      documentos: { diasDeAtraso: number | null }[];
    }>();
    expect(cuerpo.documentos[0]!.diasDeAtraso).toBeNull();
  });

  it('el detalle no devuelve la referencia externa del proveedor de pagos', async () => {
    const r = await pedir(`/companies/current/billing/${documento}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain('TEST_EXTERNAL_REF_ONLY');
    expect(r.body).not.toContain('TEST_MEDIO_REF_ONLY');
    // Los últimos cuatro sí: es lo que le sirve al cliente para reconocer con
    // qué pagó, y lo informa el propio proveedor.
    expect(r.body).toContain('4242');
  });

  it('un documento de otra empresa da 404, no 403', async () => {
    // Contestar «existe pero no es tuyo» confirmaría su existencia a quien no
    // debería poder averiguarla.
    const otra = await db.query<{ id: string }>(
      'SELECT id FROM billing_documents WHERE company_id <> $1 LIMIT 1',
      [empresa],
    );
    if (otra.rows[0] === undefined) return;
    const r = await pedir(`/companies/current/billing/${otra.rows[0].id}`);
    expect(r.statusCode).toBe(404);
  });

  it('no existe ninguna ruta que escriba en facturación', async () => {
    const escrituras = (
      app as unknown as { routeTable: { method: string; url: string }[] }
    ).routeTable.filter(
      (r) => r.method !== 'GET' && r.method !== 'HEAD' && /billing/u.test(r.url),
    );
    expect(escrituras).toEqual([]);
  });
});
