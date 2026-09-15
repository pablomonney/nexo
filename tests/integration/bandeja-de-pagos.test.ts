/**
 * El segundo tramo: de la bandeja a un cobro registrado.
 *
 * El primero —la ruta pública— está en `webhook-de-pagos.test.ts`. Acá se
 * ejercita lo que corre **después** y con otros permisos: leer la notificación,
 * preguntarle a la pasarela qué pasó de verdad, y recién entonces escribir.
 *
 * ## Lo que más importa de este archivo
 *
 * Que **el primer cobro de una suscripción no tiene intento previo**. Es la
 * consecuencia menos obvia de cobrar con `preapproval`: NEXO no inicia el
 * débito, lo ejecuta la pasarela sola cada mes. Así que cuando llega el aviso no
 * existe ningún `payment_intent` con esa referencia, y sin un paso que lo cree,
 * `procesarEventoDePago` contestaría `DESCONOCIDO` para siempre y ningún cobro
 * se registraría nunca.
 *
 * Lo otro que se defiende acá es lo contrario: que **no se invente** cuando no
 * se puede atribuir. Un cobro que entró y que NEXO no sabe a qué imputar queda
 * registrado como tal, no imputado a cualquier documento.
 */

import { drenarBandeja } from '@aai/api/pagos/bandeja';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;

const txDe = (db: Client) => ({
  query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]),
});

interface Guion {
  pago: {
    id: string;
    estado: 'PENDIENTE' | 'AUTORIZADO' | 'PAGADO' | 'FALLIDO' | 'REEMBOLSADO' | 'CONTRACARGO';
    suscripcion: string | null;
    /** El `status_detail` del proveedor. Opcional: no siempre viene. */
    detalle?: string;
  } | null;
  suscripcion: { id: string; estado: string } | null;
  falla: boolean;
}

/**
 * El doble de la pasarela.
 *
 * Implementa el puerto, no la API de Mercado Pago: lo que se prueba acá es que
 * el billing haga lo correcto con lo que el puerto devuelve. Los detalles del
 * vendor se prueban contra un `fetch` inyectado en
 * `tests/unit/pasarela-de-pagos.test.ts`.
 */
function doble(guion: Guion) {
  const fallo = { codigo: 'PROVEEDOR_CAIDO' as const, detalle: 'el doble está caído' };
  const noEsta = { codigo: 'NO_ENCONTRADO' as const, detalle: 'el doble no lo tiene' };
  return {
    id: 'mercadopago',
    asegurarPlan: async () => ({ ok: false as const, fallo: noEsta }),
    crearSuscripcion: async () => ({ ok: false as const, fallo: noEsta }),
    consultarSuscripcion: async () => {
      if (guion.falla) return { ok: false as const, fallo };
      return guion.suscripcion === null
        ? { ok: false as const, fallo: noEsta }
        : {
            ok: true as const,
            valor: {
              id: guion.suscripcion.id,
              estado: guion.suscripcion.estado as 'AUTORIZADA',
              urlDeAutorizacion: null,
              referenciaNexo: null,
            },
          };
    },
    pausarSuscripcion: async () => ({ ok: false as const, fallo: noEsta }),
    reactivarSuscripcion: async () => ({ ok: false as const, fallo: noEsta }),
    cancelarSuscripcion: async () => ({ ok: false as const, fallo: noEsta }),
    consultarPago: async () => {
      if (guion.falla) return { ok: false as const, fallo };
      return guion.pago === null
        ? { ok: false as const, fallo: noEsta }
        : {
            ok: true as const,
            valor: {
              id: guion.pago.id,
              estado: guion.pago.estado,
              suscripcionExternaId: guion.pago.suscripcion,
              importeCentavos: null,
              moneda: 'ARS',
              medio: 'visa',
              ultimos4: '4242',
              // Lo que Mercado Pago pone en `status_detail`. `undefined` en el
              // guion significa «el proveedor no dijo por qué», que es un caso
              // real y el que más apretaba: la base exige un motivo igual.
              detalleDelFallo: guion.pago.detalle ?? null,
            },
          };
    },
    verificarFirma: async () => true,
  };
}

suite('La bandeja de pagos', () => {
  let db: Client;
  let fx: Fixture;
  let planId: string;
  let stamp: string;
  let guion: Guion;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'bandeja-de-pagos');
    stamp = await sufijoUnico(db);
    planId = (
      await db.query<{ id: string }>("SELECT id FROM subscription_plans WHERE code = 'PYME'")
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    guion = { pago: null, suscripcion: null, falla: false };
    await db.query('DELETE FROM payment_webhook_inbox');
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

  /** Una suscripción conectada a la pasarela, con su referencia y su ambiente. */
  async function suscribir(
    companyId: string,
    referencia: string,
    estado = 'ACTIVA',
  ): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion,
          referencia_externa, proveedor_pago, ambiente_pago, motivo)
       VALUES ($1, $2, $3, '2026-01-01'::date, 'test', 'MENSUAL', 'ARS', 3000.00,
               '2026-01-01'::date, $4, 'mercadopago', 'sandbox', $5)
       RETURNING id`,
      [
        companyId,
        planId,
        estado,
        referencia,
        estado === 'ACTIVA' ? null : 'estado inicial de la prueba',
      ],
    );
    return r.rows[0]!.id;
  }

  /** Un documento emitido esperando cobro. */
  async function emitir(companyId: string, subId: string): Promise<string> {
    const periodo = await db.query<{ id: string }>(
      `INSERT INTO billing_periods
         (company_id, subscription_id, desde, hasta, estado, moneda, importe, created_by)
       VALUES ($1, $2, '2026-01-01'::date, '2026-01-31'::date, 'FACTURADO', 'ARS', 3000.00, 'test')
       RETURNING id`,
      [companyId, subId],
    );
    const doc = await db.query<{ id: string }>(
      `INSERT INTO billing_documents
         (company_id, subscription_id, period_id, tipo, estado, moneda, importe_total,
          emitido_el, vence_el, created_by)
       VALUES ($1, $2, $3, 'CARGO', 'EMITIDO', 'ARS', 3000.00,
               '2026-01-01'::date, '2026-01-11'::date, 'test')
       RETURNING id`,
      [companyId, subId, periodo.rows[0]!.id],
    );
    return doc.rows[0]!.id;
  }

  async function encolar(
    evento: string,
    tipo: string,
    recurso: string,
    ambiente = 'sandbox',
  ): Promise<void> {
    await db.query(
      `INSERT INTO payment_webhook_inbox
         (proveedor, ambiente, evento_externo, tipo, accion, recurso_id)
       VALUES ('mercadopago', $1, $2, $3, $3 || '.updated', $4)`,
      [ambiente, evento, tipo, recurso],
    );
  }

  const drenar = () => drenarBandeja(txDe(db), doble(guion) as never, 'sandbox');

  it('un cobro de una suscripción crea el intento que nadie inició y lo registra', async () => {
    // El caso central. Sin el paso que crea el intento, esto sería DESCONOCIDO.
    const empresa = await nuevaEmpresa('cobro');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-1`);
    const doc = await emitir(empresa, sub);

    guion.pago = {
      id: `mp-pago-${stamp}-1`,
      estado: 'PAGADO',
      suscripcion: `mp-sub-${stamp}-1`,
    };
    await encolar(`evt-${stamp}-1`, 'payment', `mp-pago-${stamp}-1`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('APLICADO');

    const intento = await db.query<{ estado: string; document_id: string; importe: string }>(
      `SELECT estado, document_id, importe::text AS importe FROM payment_intents
        WHERE proveedor = 'mercadopago' AND referencia_externa = $1`,
      [`mp-pago-${stamp}-1`],
    );
    expect(intento.rows).toHaveLength(1);
    expect(intento.rows[0]!.estado).toBe('PAGADO');
    expect(intento.rows[0]!.document_id).toBe(doc);
    // El importe es el del documento —que salió de `plan_prices` en centavos—
    // y no el de la pasarela: leer el de la pasarela obligaría a multiplicar un
    // `double` por cien.
    expect(intento.rows[0]!.importe).toBe('3000.00');

    // Y quedó el rastro del evento, que es lo único que hay el día que un
    // cliente diga que pagó.
    const evento = await db.query<{ resultado: string }>(
      'SELECT resultado FROM payment_events WHERE proveedor = $1 AND evento_externo = $2',
      ['mercadopago', `evt-${stamp}-1`],
    );
    expect(evento.rows[0]!.resultado).toBe('APLICADO');
  });

  it('un pago rechazado deja el intento FALLIDO, que es lo que arranca la cobranza', async () => {
    // La costura entre el webhook y la política de cobranza, y la única que no
    // estaba ejercitada. `avanzarCobranza` busca documentos con un intento en
    // FALLIDO:
    //
    //     JOIN payment_intents i ON i.document_id = d.id AND i.estado = 'FALLIDO'
    //
    // Si un rechazo entrara como PENDIENTE —o no creara intento— el documento
    // no entraría en ninguna política y vencería sin que nada lo mencione. No
    // habría error visible en ninguna parte: simplemente no se cobraría.
    const empresa = await nuevaEmpresa('rechazo');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-rech`);
    const doc = await emitir(empresa, sub);

    guion.pago = {
      id: `mp-pago-${stamp}-rech`,
      estado: 'FALLIDO',
      suscripcion: `mp-sub-${stamp}-rech`,
      detalle: 'cc_rejected_insufficient_amount',
    };
    await encolar(`evt-${stamp}-rech`, 'payment', `mp-pago-${stamp}-rech`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('APLICADO');

    const intento = await db.query<{
      estado: string;
      document_id: string;
      detalle_error: string | null;
    }>(
      `SELECT estado, document_id, detalle_error FROM payment_intents
        WHERE proveedor = 'mercadopago' AND referencia_externa = $1`,
      [`mp-pago-${stamp}-rech`],
    );
    expect(intento.rows[0]!.estado).toBe('FALLIDO');
    expect(intento.rows[0]!.document_id).toBe(doc);
    // El motivo del proveedor, sin traducir. Es lo único que hay el día que el
    // cliente pregunte por qué no le pasó la tarjeta — y sin esto la base ni
    // siquiera deja guardar el fallo.
    expect(intento.rows[0]!.detalle_error).toBe('cc_rejected_insufficient_amount');

    // El documento **no** pasa a nada: un cobro rechazado no lo anula ni lo da
    // por incobrable. Sigue emitido, que es lo que permite volver a intentarlo.
    const documento = await db.query<{ estado: string }>(
      'SELECT estado FROM billing_documents WHERE id = $1',
      [doc],
    );
    expect(documento.rows[0]!.estado).toBe('EMITIDO');

    // Y la suscripción sigue ACTIVA: suspender es un paso de la política de
    // cobranza, con sus días de gracia, no una consecuencia inmediata de un
    // rechazo. Sin política declarada no pasa nada, que no es «cero
    // reintentos» sino que nadie dijo cuántos.
    const s = await db.query<{ estado: string }>(
      'SELECT estado FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(s.rows[0]!.estado).toBe('ACTIVA');
  });

  it('un rechazo sin motivo del proveedor igual se guarda, diciendo eso', async () => {
    // El caso que rompía. La base exige un motivo para todo `FALLIDO`, y el
    // proveedor no siempre manda `status_detail`. Se escribe que no lo dio:
    // inventar un motivo concreto sería peor, porque después alguien se lo
    // repite al cliente.
    const empresa = await nuevaEmpresa('rechazo-mudo');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-mudo`);
    await emitir(empresa, sub);

    guion.pago = {
      id: `mp-pago-${stamp}-mudo`,
      estado: 'FALLIDO',
      suscripcion: `mp-sub-${stamp}-mudo`,
    };
    await encolar(`evt-${stamp}-mudo`, 'payment', `mp-pago-${stamp}-mudo`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('APLICADO');

    const intento = await db.query<{ detalle_error: string | null }>(
      `SELECT detalle_error FROM payment_intents
        WHERE proveedor = 'mercadopago' AND referencia_externa = $1`,
      [`mp-pago-${stamp}-mudo`],
    );
    expect(intento.rows[0]!.detalle_error).toMatch(/no dio un motivo/u);
  });

  it('un cobro que no se puede atribuir no se imputa a cualquier documento', async () => {
    // Se registra el evento y no se inventa la deuda que cancela.
    guion.pago = { id: `mp-pago-${stamp}-huerfano`, estado: 'PAGADO', suscripcion: 'no-existe' };
    await encolar(`evt-${stamp}-huerfano`, 'payment', `mp-pago-${stamp}-huerfano`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
    expect(hecho!.detalle).toContain('no tiene ningún documento emitido');

    const intento = await db.query(
      'SELECT 1 FROM payment_intents WHERE referencia_externa = $1',
      [`mp-pago-${stamp}-huerfano`],
    );
    expect(intento.rowCount).toBe(0);
  });

  it('un cobro sin suscripción declarada tampoco se atribuye', async () => {
    guion.pago = { id: `mp-pago-${stamp}-suelto`, estado: 'PAGADO', suscripcion: null };
    await encolar(`evt-${stamp}-suelto`, 'payment', `mp-pago-${stamp}-suelto`);
    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
    expect(hecho!.detalle).toContain('no dice de qué suscripción salió');
  });

  it('una suscripción cancelada en la pasarela SUSPENDE y no cancela', async () => {
    // La decisión comercial, comprobada de punta a punta: una tarjeta vencida no
    // da de baja a un cliente que no decidió irse. De CANCELADA no se vuelve.
    const empresa = await nuevaEmpresa('cancelada');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-2`);

    guion.suscripcion = { id: `mp-sub-${stamp}-2`, estado: 'CANCELADA' };
    await encolar(`evt-${stamp}-2`, 'subscription_preapproval', `mp-sub-${stamp}-2`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('APLICADO');

    const fila = await db.query<{ estado: string; motivo: string | null }>(
      'SELECT estado, motivo FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(fila.rows[0]!.estado).toBe('SUSPENDIDA');
    // El motivo no es burocracia: es lo que el cliente ve cuando su servicio se
    // corta.
    expect(fila.rows[0]!.motivo).toContain('no se cancela');
  });

  it('una pausa en la pasarela suspende, y avisarlo dos veces no la aplica dos veces', async () => {
    // La otra mitad de la sincronización: NEXO → pasarela la resuelve
    // `sincronizarEstadoConLaPasarela`; pasarela → NEXO entra por acá, y tiene
    // que ser idempotente porque una pasarela reenvía sus avisos.
    const empresa = await nuevaEmpresa('pausada');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-pausa`);

    guion.suscripcion = { id: `mp-sub-${stamp}-pausa`, estado: 'PAUSADA' };
    await encolar(`evt-${stamp}-pausa-1`, 'subscription_preapproval', `mp-sub-${stamp}-pausa`);

    const [primero] = await drenar();
    expect(primero!.desenlace).toBe('APLICADO');
    expect(
      (
        await db.query<{ estado: string }>(
          'SELECT estado FROM company_subscriptions WHERE id = $1',
          [sub],
        )
      ).rows[0]!.estado,
    ).toBe('SUSPENDIDA');

    // Segundo aviso, distinto evento, mismo hecho. No vuelve a aplicar: el
    // estado ya es el que corresponde.
    await encolar(`evt-${stamp}-pausa-2`, 'subscription_preapproval', `mp-sub-${stamp}-pausa`);
    const [segundo] = await drenar();

    expect(segundo!.desenlace).toBe('SIN_EFECTO');
    expect(segundo!.detalle).toMatch(/ya estaba SUSPENDIDA/u);
  });

  it('una suscripción PENDIENTE no mueve el estado comercial', async () => {
    const empresa = await nuevaEmpresa('pendiente');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-3`);

    guion.suscripcion = { id: `mp-sub-${stamp}-3`, estado: 'PENDIENTE' };
    await encolar(`evt-${stamp}-3`, 'subscription_preapproval', `mp-sub-${stamp}-3`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
    const fila = await db.query<{ estado: string }>(
      'SELECT estado FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(fila.rows[0]!.estado).toBe('ACTIVA');
  });

  it('una suscripción ya CANCELADA en NEXO no la reactiva ningún webhook', async () => {
    // La máquina de estados manda sobre la pasarela: cancelar fue una decisión
    // del cliente, y devolverle el servicio a quien se dio de baja sería lo
    // contrario de lo que pidió.
    const empresa = await nuevaEmpresa('irreversible');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-4`, 'CANCELADA');

    guion.suscripcion = { id: `mp-sub-${stamp}-4`, estado: 'AUTORIZADA' };
    await encolar(`evt-${stamp}-4`, 'subscription_preapproval', `mp-sub-${stamp}-4`);

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
    expect(hecho!.detalle).toContain('de CANCELADA no se pasa');

    const fila = await db.query<{ estado: string }>(
      'SELECT estado FROM company_subscriptions WHERE id = $1',
      [sub],
    );
    expect(fila.rows[0]!.estado).toBe('CANCELADA');
  });

  it('una suscripción que no es de esta instalación se registra y no se aplica', async () => {
    guion.suscripcion = { id: `mp-sub-${stamp}-ajena`, estado: 'CANCELADA' };
    await encolar(`evt-${stamp}-ajena`, 'subscription_preapproval', `mp-sub-${stamp}-ajena`);
    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
    expect(hecho!.detalle).toContain('no está vinculada a ninguna empresa');
  });

  it('una notificación de otro ambiente NO se consulta', async () => {
    // Preguntar por un recurso de la otra cuenta da 404, y ese 404 se leería
    // como «ese cobro no existe» — lo contrario de lo que pasa.
    guion.pago = { id: 'x', estado: 'PAGADO', suscripcion: null };
    await encolar(`evt-${stamp}-prod`, 'payment', 'x', 'production');

    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('FALLIDO');
    expect(hecho!.detalle).toContain('otra cuenta');
  });

  it('un tipo desconocido no se interpreta como el más parecido', async () => {
    await encolar(`evt-${stamp}-raro`, 'subscription_something_new', 'x');
    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
    expect(hecho!.detalle).toContain('no reconocido');
  });

  it('un aviso sobre el catálogo de planes no toca a ninguna empresa', async () => {
    await encolar(`evt-${stamp}-plan`, 'subscription_preapproval_plan', 'plan-1');
    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('SIN_EFECTO');
  });

  it('si la pasarela no contesta, la fila queda FALLIDA y no se inventa nada', async () => {
    guion.falla = true;
    await encolar(`evt-${stamp}-caido`, 'payment', 'x');
    const [hecho] = await drenar();
    expect(hecho!.desenlace).toBe('FALLIDO');
    expect(hecho!.detalle).toContain('PROVEEDOR_CAIDO');
  });

  it('drenar dos veces no reprocesa: la fila queda marcada con lo que le pasó', async () => {
    await encolar(`evt-${stamp}-doble`, 'subscription_preapproval_plan', 'plan-1');
    expect(await drenar()).toHaveLength(1);
    expect(await drenar(), 'la segunda corrida volvió a tomar la fila').toHaveLength(0);

    const fila = await db.query<{ estado: string; intentos: number; procesado_el: Date | null }>(
      'SELECT estado, intentos, procesado_el FROM payment_webhook_inbox WHERE evento_externo = $1',
      [`evt-${stamp}-doble`],
    );
    expect(fila.rows[0]!.estado).toBe('SIN_EFECTO');
    expect(fila.rows[0]!.intentos).toBe(1);
    expect(fila.rows[0]!.procesado_el).not.toBeNull();
  });

  it('el mismo pago informado dos veces no cobra dos veces', async () => {
    // Las pasarelas reenvían. El segundo aviso tiene que ser inofensivo, y el
    // `UNIQUE (proveedor, evento_externo)` de la 0096 lo garantiza aunque dos
    // corridas se pisen.
    const empresa = await nuevaEmpresa('repetido');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-5`);
    await emitir(empresa, sub);

    guion.pago = {
      id: `mp-pago-${stamp}-5`,
      estado: 'PAGADO',
      suscripcion: `mp-sub-${stamp}-5`,
    };

    await encolar(`evt-${stamp}-5a`, 'payment', `mp-pago-${stamp}-5`);
    expect((await drenar())[0]!.desenlace).toBe('APLICADO');

    // Otro aviso, mismo pago: el intento ya existe y ya está PAGADO.
    await encolar(`evt-${stamp}-5b`, 'payment', `mp-pago-${stamp}-5`);
    const [segundo] = await drenar();
    expect(segundo!.desenlace).toBe('SIN_EFECTO');
    expect(segundo!.detalle).toContain('REPETIDO');

    const intentos = await db.query(
      'SELECT 1 FROM payment_intents WHERE referencia_externa = $1',
      [`mp-pago-${stamp}-5`],
    );
    expect(intentos.rowCount, 'se creó un segundo intento para el mismo pago').toBe(1);
  });

  it('un evento que llega tarde se registra y no hace retroceder el cobro', async () => {
    const empresa = await nuevaEmpresa('atrasado');
    const sub = await suscribir(empresa, `mp-sub-${stamp}-6`);
    await emitir(empresa, sub);

    guion.pago = {
      id: `mp-pago-${stamp}-6`,
      estado: 'PAGADO',
      suscripcion: `mp-sub-${stamp}-6`,
    };
    await encolar(`evt-${stamp}-6a`, 'payment', `mp-pago-${stamp}-6`);
    await drenar();

    // Ahora la pasarela informa un estado anterior. Aplicarlo haría retroceder
    // un cobro que ya entró.
    guion.pago = {
      id: `mp-pago-${stamp}-6`,
      estado: 'AUTORIZADO',
      suscripcion: `mp-sub-${stamp}-6`,
    };
    await encolar(`evt-${stamp}-6b`, 'payment', `mp-pago-${stamp}-6`);
    const [segundo] = await drenar();
    expect(segundo!.desenlace).toBe('SIN_EFECTO');
    expect(segundo!.detalle).toContain('ATRASADO');

    const estado = await db.query<{ estado: string }>(
      'SELECT estado FROM payment_intents WHERE referencia_externa = $1',
      [`mp-pago-${stamp}-6`],
    );
    expect(estado.rows[0]!.estado).toBe('PAGADO');
  });
});
