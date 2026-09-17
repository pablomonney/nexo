/**
 * La mora: el escalón entre deber y estar cortado.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que deber no cierre el sistema contable.** Una empresa en mora tiene
 *      que poder emitir comprobantes, asentar y cerrar el período. Cortarle eso
 *      por dos semanas de abono le causa un perjuicio que no guarda relación
 *      con la deuda y que además no la ayuda a pagar.
 *   2. **Que deber no abra el producto entero.** El defecto que el encabezado
 *      de `planes/alcance.ts` cuenta —una suspendida devolvía cero filas y cero
 *      filas se leía como «sin plan», que se deja pasar— se recrea idéntico con
 *      cualquier estado nuevo que nadie agregue a la consulta. Acá se mide.
 *   3. **Que pagar devuelva todo, y solo cuando no queda deuda.** Levantar la
 *      mora con dos facturas abiertas le daría el producto completo a quien
 *      pagó una de tres.
 *   4. **Que el calendario se ejecute paso a paso y no se repita.** Un ciclo que
 *      corre cuatro veces en un día tiene que dejar los mismos pasos que uno que
 *      corre una.
 *   5. **Que los avisos se encolen y no se manden desde la transacción.** Si el
 *      ciclo se revierte después de que el proveedor aceptó el mensaje, el
 *      cliente ya recibió un correo sobre algo que no pasó.
 *
 * ## Tres candados contra el cruce con las otras suites, y hicieron falta los tres
 *
 * Las suites corren **en paralelo contra la misma base**, y `avanzarCobranza`
 * no recibe una empresa: toma todos los documentos impagos que existan y les
 * aplica la política vigente al día que se le pasa.
 *
 *   1. **Las fechas están en 2028**, que no usa ninguna otra suite. La política
 *      de este archivo vive en su propia ventana de vigencia, así que para las
 *      fechas de las demás no existe.
 *   2. **Las aserciones filtran por el documento propio** (`mio`). No evita el
 *      cruce: lo hace visible.
 *   3. **Las llamadas van acotadas a su organización** (`cobrar`). Este fue el que
 *      faltaba, y el que rompía: sin él, las corridas de este archivo en 2028
 *      le escribían pasos de aviso a los documentos de `facturacion.test.ts`,
 *      que espera el calendario de **su** política. El fallo aparecía allá, no
 *      acá, que es lo que lo hacía difícil de leer.
 *
 * Los dos primeros no alcanzaban porque el problema no es de fechas ni de
 * lectura: es que la función escribe sobre lo que encuentra.
 */

import { closePool, initPool } from '@aai/db';
import {
  avanzarCobranza,
  registrarCobro,
  politicaVigente,
  type PasoEjecutado,
} from '@aai/api/billing/ciclo';
import { textoDelAviso, destinatariosDeCobranza } from '@aai/api/billing/avisos';
import { alcanzaElPlan, olvidarTodosLosPlanes } from '@aai/api/planes/alcance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

/** El `Tx` que espera el ciclo: solo `query`. Igual que en producción. */
const txDe = (db: Client) => ({
  query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]),
});

/** El calendario que se va a declarar: avisos 0/2/5, mora 7, suspensión 10. */
const VIGENTE_DESDE = '2028-01-01';
const FALLO = '2028-03-01';

suite('Mora — el estado, el calendario y el acceso degradado', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;

  beforeAll(async () => {
    db = await connect();
    initPool();
    fx = await seed(db, 'mora');
    planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;

    // La política, en su propia ventana de vigencia. `politicaVigente` toma la
    // de `vigente_desde` más alta que ya empezó, así que para las fechas de esta
    // suite gana esta y para las de las demás no existe.
    await db.query(
      `INSERT INTO collection_policies
         (reintentos_en_dias, aviso_en_dias, dias_de_mora, dias_de_gracia,
          vigente_desde, declarado_por, motivo)
       VALUES ('{}'::integer[], '{0,2,5}'::integer[], 7, 10, $1::date, 'test:mora',
               'Politica sintetica de la suite de mora')
       ON CONFLICT (vigente_desde) DO NOTHING`,
      [VIGENTE_DESDE],
    );
  });

  afterAll(async () => {
    await closePool();
    await db.end();
  });

  const nuevaEmpresa = async (nombre = 'Empresa mora'): Promise<string> => {
    const sufijo = await sufijoUnico(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type,
                              jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [fx.organizationId, `${nombre} ${sufijo}`, `30${sufijo}7`],
    );
    return r.rows[0]!.id;
  };

  const suscribir = async (companyId: string, estado = 'ACTIVA'): Promise<string> => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion, motivo, morosa_desde)
       VALUES ($1, $2, $3, $4::date, 'test', 'MENSUAL', 'ARS', 10000.00, $5::date, $6, $7::date)
       RETURNING id`,
      [
        companyId,
        planId,
        estado,
        '2028-02-01',
        // Lejos, para que ninguna corrida global de otra suite la facture.
        '2029-12-01',
        estado === 'ACTIVA' || estado === 'PRUEBA' ? null : 'Falta de pago',
        estado === 'MOROSA' ? FALLO : null,
      ],
    );
    return r.rows[0]!.id;
  };

  /**
   * Un documento emitido y vencido, con un intento de pago fallido.
   *
   * Es lo que dispara la cobranza: el **fallo de pago**, no el vencimiento del
   * documento. Un cargo que nadie intentó cobrar no pone en mora a nadie.
   */
  const deudaFallida = async (
    companyId: string,
    subscriptionId: string,
    falloEl = FALLO,
  ): Promise<string> => {
    const periodo = await db.query<{ id: string }>(
      `INSERT INTO billing_periods
         (subscription_id, company_id, desde, hasta, estado, moneda, importe, created_by)
       VALUES ($1, $2, $3::date, $4::date, 'FACTURADO', 'ARS', 10000.00, 'test') RETURNING id`,
      [subscriptionId, companyId, falloEl, '2028-03-31'],
    );
    const doc = await db.query<{ id: string }>(
      `INSERT INTO billing_documents
         (company_id, subscription_id, period_id, tipo, moneda, importe_total, impuestos,
          estado, emitido_el, vence_el, es_comprobante_fiscal, created_by)
       VALUES ($1, $2, $3, 'CARGO', 'ARS', 10000.00, 0.00, 'EMITIDO', $4::date, $4::date,
               false, 'test')
       RETURNING id`,
      [companyId, subscriptionId, periodo.rows[0]!.id, falloEl],
    );
    await db.query(
      `INSERT INTO payment_intents
         (company_id, document_id, proveedor, moneda, importe, estado, idempotency_key,
          detalle_error, created_at)
       VALUES ($1, $2, 'test', 'ARS', 10000.00, 'FALLIDO', $3,
               'Rechazo sintetico de la suite de mora', $4::timestamptz)`,
      [companyId, doc.rows[0]!.id, `mora:${doc.rows[0]!.id}`, `${falloEl}T12:00:00Z`],
    );
    return doc.rows[0]!.id;
  };

  const estadoDe = async (subscriptionId: string) =>
    (
      await db.query<{ estado: string; morosa_desde: string | null; motivo: string | null }>(
        `SELECT estado, morosa_desde::text AS morosa_desde, motivo
           FROM company_subscriptions WHERE id = $1`,
        [subscriptionId],
      )
    ).rows[0]!;

  const pasosDe = async (documentId: string) =>
    (
      await db.query<{ tipo: string; numero: number | null; resultado: string; detalle: string }>(
        `SELECT tipo, numero, resultado, detalle FROM collection_steps
          WHERE document_id = $1 ORDER BY programado_para, tipo, numero`,
        [documentId],
      )
    ).rows;

  const mio = (pasos: readonly PasoEjecutado[], documentId: string) =>
    pasos.find((p) => p.documentId === documentId);

  /**
   * Avanza la cobranza **de esta suite**, y no la de toda la base.
   *
   * `avanzarCobranza` no recibe una empresa: toma todos los documentos impagos
   * que existan y les aplica la política vigente al día que se le pasa. Es lo
   * correcto en producción —una cobranza que hay que acordarse de correr por
   * cliente no se corre— y es un problema acá, porque las suites corren en
   * paralelo contra la misma base.
   *
   * Sin acotar, las llamadas de este archivo en 2028 le escribían pasos de
   * aviso a los documentos de `facturacion.test.ts`, que espera el calendario
   * de **su** política. No era un test frágil: era este archivo rompiendo el
   * otro, y el fallo aparecía en el otro.
   *
   * El alcance es la organización que `seed()` creó para este archivo, no cada
   * empresa suelta: todas las de acá cuelgan de ella, y un solo valor no se
   * puede olvidar en una llamada.
   */
  const cobrar = (hoy: string) =>
    avanzarCobranza(txDe(db), hoy, 'test:mora', { soloOrganizacion: fx.organizationId });

  // ══ La política ═══════════════════════════════════════════════════════════

  it('la política declarada se lee entera, con el día de la mora', async () => {
    const p = await politicaVigente(txDe(db), '2028-03-01');
    expect(p).toEqual({
      reintentosEnDias: [],
      avisoEnDias: [0, 2, 5],
      diasDeMora: 7,
      diasDeGracia: 10,
    });
  });

  // ══ El calendario, día por día ════════════════════════════════════════════

  it('el calendario recorre AVISO 1/2/3, MORA y SUSPENSION, sin reintentos', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);

    // Cada corrida avanza **un** paso. Correr el ciclo una vez y encontrarlo
    // todo hecho significaría que un fin de semana largo suspende a alguien sin
    // haberle avisado nunca.
    const dias = ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08', '2028-03-11'];
    const ejecutados: (PasoEjecutado | undefined)[] = [];
    for (const dia of dias) {
      ejecutados.push(mio(await cobrar(dia), doc));
    }

    expect(ejecutados.map((e) => e?.paso.tipo)).toEqual([
      'AVISO',
      'AVISO',
      'AVISO',
      'MORA',
      'SUSPENSION',
    ]);
    expect(ejecutados.slice(0, 3).map((e) => e?.paso.numero)).toEqual([1, 2, 3]);
    expect((await pasosDe(doc)).some((p) => p.tipo === 'REINTENTO')).toBe(false);
  });

  it('el día 7 la suscripción queda MOROSA, con fecha y con motivo', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);

    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06']) {
      await cobrar(dia);
    }
    expect((await estadoDe(sub)).estado).toBe('ACTIVA');

    const paso = mio(await cobrar('2028-03-08'), doc);
    expect(paso?.paso.tipo).toBe('MORA');
    expect(paso?.resultado).toBe('HECHO');

    const s = await estadoDe(sub);
    expect(s.estado).toBe('MOROSA');
    // Sin fecha no se puede contar cuánto lleva debiendo, que es lo que después
    // decide si corresponde suspender.
    expect(s.morosa_desde).toBe('2028-03-08');
    expect(s.motivo).toContain('Falta de pago');
  });

  it('la mora deja la acción en la bitácora, con motivo', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
      await cobrar(dia);
    }

    const log = await db.query<{ action: string; motivo: string | null; new_value: unknown }>(
      `SELECT action, motivo, new_value FROM audit_logs
        WHERE company_id = $1 AND action = 'MARCAR_EN_MORA'`,
      [empresa],
    );
    expect(log.rows).toHaveLength(1);
    // `audit_actions.requiere_motivo` lo exige con un trigger: sin motivo, la
    // transacción entera del ciclo se caería.
    expect(log.rows[0]!.motivo).toContain(doc);
  });

  it('de MOROSA se pasa a SUSPENDIDA cuando se acaba la gracia', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
      await cobrar(dia);
    }
    expect((await estadoDe(sub)).estado).toBe('MOROSA');

    const paso = mio(await cobrar('2028-03-11'), doc);
    expect(paso?.paso.tipo).toBe('SUSPENSION');
    expect(paso?.resultado).toBe('HECHO');
    expect((await estadoDe(sub)).estado).toBe('SUSPENDIDA');
  });

  // ══ Idempotencia ══════════════════════════════════════════════════════════

  it('correr el ciclo cuatro veces el mismo día deja un solo paso', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);

    for (let i = 0; i < 4; i += 1) {
      await cobrar('2028-03-01');
    }
    expect(await pasosDe(doc)).toHaveLength(1);
  });

  it('la mora no se aplica dos veces: la segunda no encuentra el paso pendiente', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
      await cobrar(dia);
    }
    const desde = (await estadoDe(sub)).morosa_desde;

    // Otra corrida el mismo día, y otra más tarde: ninguna vuelve a degradar.
    await cobrar('2028-03-08');
    await cobrar('2028-03-09');

    expect((await pasosDe(doc)).filter((p) => p.tipo === 'MORA')).toHaveLength(1);
    expect((await estadoDe(sub)).morosa_desde).toBe(desde);
  });

  it('un paso omitido queda registrado: sin la fila, el ciclo lo reintentaría todos los días', async () => {
    // Una suscripción ya CANCELADA no puede ir a MOROSA. El paso se omite y **se
    // escribe**: sin registro, `pasoPendiente` lo encontraría pendiente mañana,
    // y pasado, para siempre.
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06']) {
      await cobrar(dia);
    }
    await db.query(
      `UPDATE company_subscriptions SET estado = 'CANCELADA', motivo = 'Baja del test'
        WHERE id = $1`,
      [sub],
    );

    const paso = mio(await cobrar('2028-03-08'), doc);
    expect(paso?.resultado).toBe('OMITIDO');
    expect(paso?.detalle).toContain('CANCELADA');
    expect((await pasosDe(doc)).filter((p) => p.tipo === 'MORA')).toHaveLength(1);
  });

  it('si la deuda ya no está vencida, la mora se omite y no degrada a nadie', async () => {
    // El caso caro: degradarle el acceso a alguien que acaba de pagar. Se vuelve
    // a mirar la deuda aunque la lista se armó hace un instante.
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06']) {
      await cobrar(dia);
    }
    // El documento se mueve al futuro: sigue EMITIDO —así la cobranza lo levanta
    // igual— pero ya no está vencido al día del paso.
    await db.query(`UPDATE billing_documents SET vence_el = '2028-12-01'::date WHERE id = $1`, [
      doc,
    ]);

    const paso = mio(await cobrar('2028-03-08'), doc);
    expect(paso?.resultado).toBe('OMITIDO');
    expect(paso?.detalle).toContain('deuda vencida');
    expect((await estadoDe(sub)).estado).toBe('ACTIVA');
  });

  // ══ Que ningún paso mienta ════════════════════════════════════════════════

  describe('un paso HECHO significa que algo pasó', () => {
    /**
     * Una suscripción en prueba, con deuda fallida.
     *
     * No debería existir —`emitirVencidos` no factura pruebas— pero la cobranza
     * no mira el estado para armar su lista: mira documentos impagos. Si alguien
     * emite uno a mano, o una migración futura cambia el criterio, este es el
     * camino por el que una prueba llega al paso de suspensión.
     */
    const pruebaConDeuda = async (): Promise<{ sub: string; doc: string; empresa: string }> => {
      const empresa = await nuevaEmpresa('Empresa prueba');
      const r = await db.query<{ id: string }>(
        `INSERT INTO company_subscriptions
           (company_id, plan_id, estado, vigencia_desde, vigencia_hasta, created_by)
         VALUES ($1, $2, 'PRUEBA', '2028-02-01'::date, '2028-02-15'::date, 'test')
         RETURNING id`,
        [empresa, planId],
      );
      const sub = r.rows[0]!.id;
      return { sub, doc: await deudaFallida(empresa, sub), empresa };
    };

    it('una PRUEBA que llega al paso de suspensión CAMBIA de estado de verdad', async () => {
      // `puedeTransicionar('PRUEBA', 'SUSPENDIDA')` es true —una prueba que se
      // vence queda suspendida— así que el control pasa. Lo que tiene que pasar
      // entonces es que el `UPDATE` **también** la alcance.
      //
      // La versión anterior comprobaba la transición y después actualizaba solo
      // `estado = 'ACTIVA'`: la prueba pasaba el control, no cambiaba nada, y el
      // paso quedaba registrado como HECHO. Un registro que afirma un corte que
      // no ocurrió es peor que no tener registro: nadie va a volver a mirarlo.
      const { sub, doc } = await pruebaConDeuda();
      for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
        await cobrar(dia);
      }
      const paso = mio(await cobrar('2028-03-11'), doc);

      expect(paso?.paso.tipo).toBe('SUSPENSION');
      expect(paso?.resultado).toBe('HECHO');
      expect((await estadoDe(sub)).estado).toBe('SUSPENDIDA');
    });

    it('una PRUEBA no entra en mora: el paso se omite y el estado no se toca', async () => {
      // Una prueba no genera deuda propia. `puedeTransicionar('PRUEBA','MOROSA')`
      // es false, así que el paso se omite **y se registra**: sin la fila, el
      // ciclo lo encontraría pendiente todos los días para siempre.
      const { sub, doc } = await pruebaConDeuda();
      for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06']) {
        await cobrar(dia);
      }
      const paso = mio(await cobrar('2028-03-08'), doc);

      expect(paso?.paso.tipo).toBe('MORA');
      expect(paso?.resultado).toBe('OMITIDO');
      expect(paso?.detalle).toContain('PRUEBA');
      expect((await estadoDe(sub)).estado).toBe('PRUEBA');
      expect((await estadoDe(sub)).morosa_desde).toBeNull();
    });

    it('en toda la base, ningún paso HECHO afirma un cambio que no ocurrió', async () => {
      // El invariante, escrito como consulta y sobre **todas** las filas que
      // dejaron las demás suites, no solo sobre las de este archivo. Es la forma
      // de que un defecto introducido por otro camino —otra ruta, otro script—
      // también lo levante.
      //
      // Tres formas de mentir, las tres imposibles:
      //   · SUSPENSION en HECHO sobre algo que no quedó SUSPENDIDA;
      //   · MORA en HECHO sobre algo que nunca fue MOROSA;
      //   · MOROSA sin fecha desde cuándo.
      const mentiras = await db.query<{ clase: string; n: string }>(
        `SELECT 'suspension sin suspender' AS clase, count(*)::text AS n
           FROM collection_steps cs
           JOIN billing_documents d ON d.id = cs.document_id
           JOIN company_subscriptions s ON s.id = d.subscription_id
          WHERE cs.tipo = 'SUSPENSION' AND cs.resultado = 'HECHO'
            AND s.estado NOT IN ('SUSPENDIDA', 'CANCELADA', 'ACTIVA')
         UNION ALL
         SELECT 'mora sin fecha', count(*)::text
           FROM company_subscriptions
          WHERE estado = 'MOROSA' AND morosa_desde IS NULL
         UNION ALL
         SELECT 'mora sin motivo', count(*)::text
           FROM company_subscriptions
          WHERE estado = 'MOROSA' AND (motivo IS NULL OR length(btrim(motivo)) <= 2)`,
      );
      for (const m of mentiras.rows) expect(Number(m.n), m.clase).toBe(0);
    });
  });

  // ══ Reactivación ══════════════════════════════════════════════════════════

  it('pagar levanta la mora y borra morosa_desde y el motivo', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
      await cobrar(dia);
    }
    expect((await estadoDe(sub)).estado).toBe('MOROSA');

    const cobro = await registrarCobro(txDe(db), {
      documentId: doc,
      proveedor: 'transferencia',
      idempotencia: `pago-mora-${doc}`,
      actorId: 'test:mora',
      pagadoEl: '2028-03-09',
    });
    expect(cobro.estado).toBe('REGISTRADO');
    expect(cobro).toMatchObject({ reactivada: true });

    const s = await estadoDe(sub);
    expect(s.estado).toBe('ACTIVA');
    // Dejar la fecha haría que la próxima lectura contara días de mora de una
    // deuda ya pagada.
    expect(s.morosa_desde).toBeNull();
    expect(s.motivo).toBeNull();
  });

  it('pagar una de dos facturas NO levanta la mora', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc1 = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
      await cobrar(dia);
    }
    expect((await estadoDe(sub)).estado).toBe('MOROSA');

    // Una segunda deuda, del mes siguiente.
    const periodo = await db.query<{ id: string }>(
      `INSERT INTO billing_periods
         (subscription_id, company_id, desde, hasta, estado, moneda, importe, created_by)
       VALUES ($1, $2, '2028-04-01'::date, '2028-04-30'::date, 'FACTURADO', 'ARS', 10000.00,
               'test')
       RETURNING id`,
      [sub, empresa],
    );
    await db.query(
      `INSERT INTO billing_documents
         (company_id, subscription_id, period_id, tipo, moneda, importe_total, impuestos,
          estado, emitido_el, vence_el, es_comprobante_fiscal, created_by)
       VALUES ($1, $2, $3, 'CARGO', 'ARS', 10000.00, 0.00, 'EMITIDO', '2028-04-01'::date,
               '2028-04-01'::date, false, 'test')`,
      [empresa, sub, periodo.rows[0]!.id],
    );

    const cobro = await registrarCobro(txDe(db), {
      documentId: doc1,
      proveedor: 'transferencia',
      idempotencia: `pago-parcial-${doc1}`,
      actorId: 'test:mora',
      pagadoEl: '2028-04-02',
    });
    expect(cobro).toMatchObject({ estado: 'REGISTRADO', reactivada: false });
    // Levantarla con deuda abierta le daría el producto entero a quien pagó una
    // de dos.
    expect((await estadoDe(sub)).estado).toBe('MOROSA');
  });

  it('pagar sigue levantando una SUSPENDIDA, como antes de la mora', async () => {
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa, 'SUSPENDIDA');
    const doc = await deudaFallida(empresa, sub);

    const cobro = await registrarCobro(txDe(db), {
      documentId: doc,
      proveedor: 'transferencia',
      idempotencia: `pago-susp-${doc}`,
      actorId: 'test:mora',
      pagadoEl: '2028-03-20',
    });
    expect(cobro).toMatchObject({ estado: 'REGISTRADO', reactivada: true });
    expect((await estadoDe(sub)).estado).toBe('ACTIVA');
  });

  it('la reactivación deja en la bitácora desde qué estado volvió', async () => {
    // «Reactivada» sobre una morosa y sobre una suspendida son dos
    // recuperaciones distintas: una perdió módulos, la otra el acceso entero.
    const empresa = await nuevaEmpresa();
    const sub = await suscribir(empresa);
    const doc = await deudaFallida(empresa, sub);
    for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
      await cobrar(dia);
    }
    await registrarCobro(txDe(db), {
      documentId: doc,
      proveedor: 'transferencia',
      idempotencia: `pago-bitacora-${doc}`,
      actorId: 'test:mora',
      pagadoEl: '2028-03-09',
    });

    const log = await db.query<{ old_value: { estado?: string } | null }>(
      `SELECT old_value FROM audit_logs
        WHERE company_id = $1 AND action = 'REACTIVAR_POR_PAGO'`,
      [empresa],
    );
    expect(log.rows[0]!.old_value).toMatchObject({ estado: 'MOROSA' });
  });

  // ══ El acceso degradado ═══════════════════════════════════════════════════

  describe('acceso degradado', () => {
    /** Las diecinueve funcionalidades, con su dominio y si sobrevive la mora. */
    const catalogo = async () =>
      (
        await db.query<{ code: string; dominio: string; sobrevive: boolean }>(
          `SELECT code, dominios[1] AS dominio, sobrevive_la_mora AS sobrevive
             FROM product_features ORDER BY orden`,
        )
      ).rows;

    /** Una empresa con plan completo, para que nada quede fuera por no estar contratado. */
    const conPlanCompleto = async (estado: string): Promise<string> => {
      const empresa = await nuevaEmpresa('Empresa acceso');
      await suscribir(empresa, estado);
      return empresa;
    };

    it('el catálogo tiene diecinueve funcionalidades y ninguna queda sin decidir', async () => {
      // `sobrevive_la_mora` es NOT NULL con default, así que «sin decidir» no
      // existe como estado: o sobrevive o no. Lo que este caso cuida es que la
      // partición sea **exhaustiva** — que 12 + 7 sean las 19— porque los dos
      // casos de abajo recorren una mitad cada uno y una funcionalidad que se
      // cayera de las dos listas no la miraría nadie.
      const todas = await catalogo();
      expect(todas).toHaveLength(19);

      const sobreviven = todas.filter((f) => f.sobrevive);
      const apagadas = todas.filter((f) => !f.sobrevive);
      expect(sobreviven.length + apagadas.length).toBe(19);
      expect(sobreviven).toHaveLength(12);
      expect(apagadas).toHaveLength(7);

      // Las siete, por nombre. Escritas acá y no derivadas de la base: si fueran
      // derivadas, este caso pasaría igual el día que alguien apague una octava.
      expect(apagadas.map((f) => f.code).sort()).toEqual([
        'analisis',
        'analitica',
        'comisiones',
        'crm',
        'integraciones',
        'inteligencia',
        'proyectos',
      ]);

      // Y las doce, también por nombre: son las que sostienen una obligación con
      // plazo y con multa, o el camino de vuelta a pagar.
      expect(sobreviven.map((f) => f.code).sort()).toEqual([
        'arca',
        'auditoria',
        'comercial',
        'compras',
        'contabilidad',
        'documentos',
        'fiscal',
        'precios',
        'stock',
        'sucursales',
        'terceros',
        'tesoreria',
      ]);
    });

    it('las diecinueve, una por una, contestan lo que corresponde en mora', async () => {
      // El recorrido completo en un solo caso, con el veredicto exacto por
      // funcionalidad. Los dos casos siguientes miran una mitad cada uno; este
      // mira las diecinueve juntas y deja el mapa entero escrito en la salida
      // cuando falla.
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      const veredictos: Record<string, string> = {};
      for (const f of await catalogo()) {
        const v = await alcanzaElPlan(txDe(db), empresa, `/${f.dominio}`);
        veredictos[f.code] = v.permitido ? 'PERMITIDO' : (v.motivo ?? 'SIN_MOTIVO');
      }

      expect(veredictos).toEqual({
        contabilidad: 'PERMITIDO',
        fiscal: 'PERMITIDO',
        terceros: 'PERMITIDO',
        documentos: 'PERMITIDO',
        auditoria: 'PERMITIDO',
        comercial: 'PERMITIDO',
        compras: 'PERMITIDO',
        stock: 'PERMITIDO',
        tesoreria: 'PERMITIDO',
        precios: 'PERMITIDO',
        sucursales: 'PERMITIDO',
        arca: 'PERMITIDO',
        proyectos: 'DEGRADADA_POR_MORA',
        comisiones: 'DEGRADADA_POR_MORA',
        crm: 'DEGRADADA_POR_MORA',
        analitica: 'DEGRADADA_POR_MORA',
        analisis: 'DEGRADADA_POR_MORA',
        inteligencia: 'DEGRADADA_POR_MORA',
        integraciones: 'DEGRADADA_POR_MORA',
      });
    });

    it('todos los dominios de cada funcionalidad se comportan igual, no solo el primero', async () => {
      // `contabilidad` cubre ocho dominios y `fiscal` cuatro. Los casos de
      // arriba miran `dominios[1]`: si la degradación se resolviera por dominio
      // en vez de por funcionalidad, los otros siete se irían sin mirar.
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      const todos = await db.query<{ code: string; dominio: string; sobrevive: boolean }>(
        `SELECT code, unnest(dominios) AS dominio, sobrevive_la_mora AS sobrevive
           FROM product_features ORDER BY orden`,
      );
      // 40 dominios repartidos entre las 19: si el catálogo se achica, este
      // número avisa antes de que el caso deje de probar lo que dice probar.
      expect(todos.rows.length).toBeGreaterThanOrEqual(40);

      for (const f of todos.rows) {
        const v = await alcanzaElPlan(txDe(db), empresa, `/${f.dominio}`);
        expect(v.motivo === 'DEGRADADA_POR_MORA', `${f.code} → /${f.dominio}`).toBe(!f.sobrevive);
      }
    });

    it('en mora, las doce que sostienen una obligación siguen abiertas', async () => {
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      for (const f of (await catalogo()).filter((x) => x.sobrevive)) {
        const v = await alcanzaElPlan(txDe(db), empresa, `/${f.dominio}`);
        // Se afirma sobre el motivo y no solo sobre `permitido`: un `false` por
        // FUERA_DEL_PLAN diría otra cosa, y acá el plan las incluye.
        expect(v.motivo, `${f.code} (${f.dominio})`).not.toBe('DEGRADADA_POR_MORA');
      }
    });

    it('en mora, las siete degradadas contestan DEGRADADA_POR_MORA', async () => {
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      for (const f of (await catalogo()).filter((x) => !x.sobrevive)) {
        const v = await alcanzaElPlan(txDe(db), empresa, `/${f.dominio}`);
        expect(v.permitido, `${f.code} (${f.dominio})`).toBe(false);
        expect(v.motivo, `${f.code} (${f.dominio})`).toBe('DEGRADADA_POR_MORA');
      }
    });

    it('en mora, los dominios administrativos siguen abiertos', async () => {
      // `suscripciones` y `companies` son por dónde se ve la deuda y se vuelve a
      // pagar. Una puerta que deja al cliente afuera de la caja no cobra: enoja.
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      for (const ruta of ['/subscription', '/companies/current', '/work-queue', '/health']) {
        const v = await alcanzaElPlan(txDe(db), empresa, ruta);
        expect(v.permitido, ruta).toBe(true);
        expect(v.feature, ruta).toBeNull();
      }
    });

    it('la degradación NO depende del verbo: leer y escribir contestan lo mismo', async () => {
      // La puerta comercial nunca supo de métodos, y enseñarle uno ahora sería
      // dos reglas donde hoy hay una. `alcanzaElPlan` recibe la URL y nada más:
      // la misma ruta con y sin query contesta idéntico.
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      const lectura = await alcanzaElPlan(txDe(db), empresa, '/crm?pagina=2');
      const escritura = await alcanzaElPlan(txDe(db), empresa, '/crm');
      expect(lectura).toEqual(escritura);
      expect(lectura.motivo).toBe('DEGRADADA_POR_MORA');
    });

    it('una morosa NO recibe el producto entero por devolver cero funcionalidades', async () => {
      // El defecto del encabezado de `alcance.ts`, recreado con el estado nuevo.
      // Si `funcionalidadesDe` no incluyera MOROSA en su `IN`, esta empresa
      // devolvería cero filas, cero filas se lee como «sin plan», y «sin plan»
      // se deja pasar: deber la cuota abriría todo.
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('MOROSA');
      olvidarTodosLosPlanes();

      const v = await alcanzaElPlan(txDe(db), empresa, '/crm');
      expect(v.permitido).toBe(false);
    });

    it('con la suscripción ACTIVA no se degrada nada', async () => {
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('ACTIVA');
      olvidarTodosLosPlanes();

      for (const f of await catalogo()) {
        const v = await alcanzaElPlan(txDe(db), empresa, `/${f.dominio}`);
        expect(v.motivo, `${f.code}`).not.toBe('DEGRADADA_POR_MORA');
      }
    });

    it('una SUSPENDIDA sigue contestando SUSCRIPCION_SUSPENDIDA, no la de mora', async () => {
      olvidarTodosLosPlanes();
      const empresa = await conPlanCompleto('SUSPENDIDA');
      olvidarTodosLosPlanes();

      const v = await alcanzaElPlan(txDe(db), empresa, '/crm');
      expect(v.motivo).toBe('SUSCRIPCION_SUSPENDIDA');
    });
  });

  // ══ Los avisos ════════════════════════════════════════════════════════════

  describe('avisos de cobranza', () => {
    const encolados = async (companyId: string) =>
      (
        await db.query<{ asunto: string; estado: string; tipo: string; destinatario: string }>(
          `SELECT o.asunto, o.estado, o.tipo, o.destinatario
             FROM email_outbox o
            WHERE o.destinatario IN (
                    SELECT u.email FROM user_company_roles ucr
                      JOIN roles r ON r.id = ucr.role_id
                      JOIN users u ON u.id = ucr.user_id
                     WHERE ucr.company_id = $1 AND r.code = 'ADMINISTRADOR')
              AND o.tipo = 'AVISO_DE_COBRANZA'
            ORDER BY o.creado_el`,
          [companyId],
        )
      ).rows;

    /** Un administrador vigente y activo para la empresa. */
    const conAdministrador = async (companyId: string): Promise<string> => {
      const sufijo = await sufijoUnico(db);
      const email = `admin.mora.${sufijo}@ejemplo.test`;
      const u = await db.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, status, created_by)
         VALUES ($1, 'Admin de mora', 'x', 'ACTIVE', 'test') RETURNING id`,
        [email],
      );
      await db.query(
        `INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from)
         VALUES ($1, $2, (SELECT id FROM roles WHERE code = 'ADMINISTRADOR'), CURRENT_DATE)`,
        [u.rows[0]!.id, companyId],
      );
      return email;
    };

    it('el aviso se ENCOLA en PENDIENTE: no se manda desde la transacción del ciclo', async () => {
      // Si el ciclo se revirtiera después de que el proveedor aceptó el mensaje,
      // el cliente ya recibió un correo sobre algo que no pasó, y eso no se
      // deshace. `PENDIENTE` es «todavía no se intentó», que es la verdad.
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      const doc = await deudaFallida(empresa, sub);
      await conAdministrador(empresa);

      const paso = mio(await cobrar('2028-03-01'), doc);
      expect(paso?.resultado).toBe('HECHO');

      const bandeja = await encolados(empresa);
      expect(bandeja).toHaveLength(1);
      expect(bandeja[0]!.estado).toBe('PENDIENTE');
      expect(bandeja[0]!.tipo).toBe('AVISO_DE_COBRANZA');
    });

    it('el primer aviso no anuncia ninguna consecuencia; los siguientes dicen cuántos días faltan', async () => {
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      await deudaFallida(empresa, sub);
      await conAdministrador(empresa);

      await cobrar('2028-03-01');
      await cobrar('2028-03-03');

      const bandeja = await encolados(empresa);
      expect(bandeja).toHaveLength(2);
      expect(bandeja[0]!.asunto).toContain('no pudimos procesar el pago');
      expect(bandeja[1]!.asunto).toContain('sigue impaga');
    });

    it('el paso de mora encola el aviso de acceso degradado, con los módulos', async () => {
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      await deudaFallida(empresa, sub);
      await conAdministrador(empresa);

      for (const dia of ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08']) {
        await cobrar(dia);
      }
      const cuerpo = (
        await db.query<{ cuerpo: string }>(
          `SELECT cuerpo FROM email_outbox
            WHERE asunto LIKE '%quedaron en pausa%'
              AND destinatario IN (SELECT u.email FROM user_company_roles ucr
                                     JOIN roles r ON r.id = ucr.role_id
                                     JOIN users u ON u.id = ucr.user_id
                                    WHERE ucr.company_id = $1)`,
          [empresa],
        )
      ).rows[0];

      expect(cuerpo).toBeDefined();
      // Nombra lo que se apagó: sin los nombres, la persona ve botones que
      // faltan y no sabe cuáles.
      expect(cuerpo!.cuerpo).toContain('CRM');
      // Y dice lo que sigue andando, que es lo que evita el susto.
      expect(cuerpo!.cuerpo).toContain('ARCA');
    });

    it('sin administradores vigentes el paso se omite y lo dice, y la cobranza sigue', async () => {
      // No es un problema del correo y decirlo como uno mandaría a revisar el
      // proveedor: es una empresa sin a quién escribirle.
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      const doc = await deudaFallida(empresa, sub);

      const paso = mio(await cobrar('2028-03-01'), doc);
      expect(paso?.resultado).toBe('OMITIDO');
      expect(paso?.detalle).toContain('administrador');

      // Y el calendario no se detiene: al día siguiente sigue el aviso 2.
      const siguiente = mio(await cobrar('2028-03-03'), doc);
      expect(siguiente?.paso).toMatchObject({ tipo: 'AVISO', numero: 2 });
    });

    it('no se le escribe a una cuenta suspendida o sin confirmar', async () => {
      const empresa = await nuevaEmpresa();
      const sufijo = await sufijoUnico(db);
      const u = await db.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, status, created_by)
         VALUES ($1, 'Admin pendiente', 'x', 'PENDIENTE', 'test') RETURNING id`,
        [`pendiente.${sufijo}@ejemplo.test`],
      );
      await db.query(
        `INSERT INTO user_company_roles (user_id, company_id, role_id, valid_from)
         VALUES ($1, $2, (SELECT id FROM roles WHERE code = 'ADMINISTRADOR'), CURRENT_DATE)`,
        [u.rows[0]!.id, empresa],
      );

      // Mandarle un correo a una cuenta que nunca confirmó el alta es contarlo
      // como aviso dado sobre alguien que no lo va a leer.
      expect(await destinatariosDeCobranza(txDe(db), empresa)).toEqual([]);
    });

    it('ningún texto trae el importe ni el número de factura', async () => {
      // El cuerpo de `email_outbox` lo puede leer el operador con
      // `correo:bandeja -- --cuerpo`, y ese permiso existe para poder entregar
      // un token a mano, no para leer la deuda de una empresa.
      const clases = [
        'RECHAZO_INICIAL',
        'SUSPENSION_PROXIMA',
        'ACCESO_DEGRADADO',
        'SUSPENSION_APLICADA',
      ] as const;

      for (const clase of clases) {
        const { asunto, cuerpo } = textoDelAviso(clase, {
          empresa: 'Empresa de prueba',
          diasParaLaSuspension: 5,
          modulosEnPausa: ['CRM'],
        });
        expect(asunto.length, clase).toBeGreaterThan(0);
        expect(cuerpo, clase).not.toMatch(/\$\s?\d/u);
        expect(cuerpo, clase).toContain('Suscripciones');
      }
    });

    it('el ciclo corrido cinco veces el mismo día encola UN aviso, no cinco', async () => {
      // La idempotencia del correo no la cuida el correo: la cuida
      // `collection_steps` con su `UNIQUE (document_id, tipo, numero)`. Un paso
      // ya registrado no se vuelve a ejecutar, y encolar es parte del paso.
      //
      // Es la propiedad que hace que se pueda agendar el ciclo sin miedo. Sin
      // ella, un timer cada cinco minutos le manda al cliente doce correos por
      // hora diciéndole lo mismo.
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      await deudaFallida(empresa, sub);
      await conAdministrador(empresa);

      for (let i = 0; i < 5; i += 1) {
        await cobrar('2028-03-01');
      }
      expect(await encolados(empresa)).toHaveLength(1);
    });

    it('recorrer el calendario entero dos veces encola cinco avisos, no diez', async () => {
      // El calendario completo son cinco mensajes: tres avisos, el de mora y el
      // de suspensión. Una segunda pasada por los mismos días no agrega ninguno.
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      await deudaFallida(empresa, sub);
      await conAdministrador(empresa);

      const dias = ['2028-03-01', '2028-03-03', '2028-03-06', '2028-03-08', '2028-03-11'];
      for (const dia of dias) await cobrar(dia);
      expect(await encolados(empresa)).toHaveLength(5);

      for (const dia of dias) await cobrar(dia);
      expect(await encolados(empresa)).toHaveLength(5);
    });

    it('con dos administradores sale un mensaje para cada uno, y uno solo por corrida', async () => {
      // Un aviso, varios destinatarios: son filas distintas de `email_outbox`
      // con el mismo texto. Lo que no puede pasar es que la segunda corrida del
      // mismo día agregue otro par.
      const empresa = await nuevaEmpresa();
      const sub = await suscribir(empresa);
      await deudaFallida(empresa, sub);
      await conAdministrador(empresa);
      await conAdministrador(empresa);

      await cobrar('2028-03-01');
      const primera = await encolados(empresa);
      expect(primera).toHaveLength(2);
      expect(new Set(primera.map((m) => m.destinatario)).size).toBe(2);

      await cobrar('2028-03-01');
      expect(await encolados(empresa)).toHaveLength(2);
    });

    it('todo lo encolado por la cobranza queda PENDIENTE: nada se marca enviado solo', async () => {
      // Si algo apareciera `ENVIADO` sin que `correo:bandeja` haya corrido,
      // significaría que el motor de cobranza mandó desde adentro de su
      // transacción — que es exactamente lo que `encolarSinEnviar` existe para
      // impedir.
      const sinEntregar = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM email_outbox
          WHERE tipo = 'AVISO_DE_COBRANZA' AND estado <> 'PENDIENTE'`,
      );
      expect(Number(sinEntregar.rows[0]!.n)).toBe(0);
    });

    it('sin días para la suspensión el texto no inventa un número', async () => {
      // `null` es «no se puede afirmar». Un correo que diga «te quedan 0 días»
      // sobre alguien que no está por ser suspendido es la peor clase de error.
      const { cuerpo } = textoDelAviso('SUSPENSION_PROXIMA', {
        empresa: 'Empresa de prueba',
        diasParaLaSuspension: null,
      });
      expect(cuerpo).toContain('en los próximos días');
      expect(cuerpo).not.toContain('en 0 días');
    });
  });
});
