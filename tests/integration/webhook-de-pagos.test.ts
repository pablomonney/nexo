/**
 * El camino completo de una notificación de la pasarela, con un doble.
 *
 *     pasarela → POST /webhooks/pagos → payment_webhook_inbox
 *                                       ↓ (otro proceso, otros permisos)
 *                                       le pregunta a la pasarela
 *                                       ↓
 *                                       payment_intents / payment_events
 *
 * ## Lo que este archivo existe para comprobar
 *
 * Que **una notificación no mueve plata por sí sola**. La ruta pública guarda y
 * no aplica; lo que aplica corre aparte y antes de aplicar nada le pregunta a la
 * pasarela. Los dos tramos se ejercitan por separado y contra la base real,
 * porque la mitad de las garantías —la idempotencia, los permisos— son de la
 * base y no del código.
 *
 * ## Por qué el proveedor es un doble y no la API de Mercado Pago
 *
 * No hay cuenta. Y aunque la hubiera: Mercado Pago usa la **misma URL** para
 * prueba y producción, así que una suite que hablara con la API real estaría a
 * un `.env` mal copiado de cobrarle a alguien de verdad.
 *
 * El doble implementa `ProveedorDePagos` entero, incluido `verificarFirma`, así
 * que lo que se ejercita es el contrato del puerto — no el de Mercado Pago. Es
 * la misma decisión que el adaptador: los detalles del vendor se prueban en
 * `tests/unit/pasarela-de-pagos.test.ts`, contra un `fetch` inyectado.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL, hasDatabase, type Client } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

/**
 * El estado que el doble va a contestar, y si contesta.
 *
 * Se declara mutable a propósito: lo que cambia entre casos es **qué dice la
 * pasarela**, y eso es exactamente lo que se está probando.
 */
interface Guion {
  firma: boolean | null;
  pago: { id: string; estado: string; suscripcion: string | null } | null;
  suscripcion: { id: string; estado: string } | null;
  /** Cuántas veces se le preguntó. Un webhook que no pregunta es el defecto. */
  consultas: number;
}

function doble(guion: Guion) {
  const fallo = { codigo: 'NO_ENCONTRADO' as const, detalle: 'el doble no lo tiene' };
  return {
    id: 'mercadopago',
    asegurarPlan: async () => ({ ok: false as const, fallo }),
    crearSuscripcion: async () => ({ ok: false as const, fallo }),
    consultarSuscripcion: async () => {
      guion.consultas += 1;
      return guion.suscripcion === null
        ? { ok: false as const, fallo }
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
    pausarSuscripcion: async () => ({ ok: false as const, fallo }),
    reactivarSuscripcion: async () => ({ ok: false as const, fallo }),
    cancelarSuscripcion: async () => ({ ok: false as const, fallo }),
    consultarPago: async () => {
      guion.consultas += 1;
      return guion.pago === null
        ? { ok: false as const, fallo }
        : {
            ok: true as const,
            valor: {
              id: guion.pago.id,
              estado: guion.pago.estado as 'PAGADO',
              suscripcionExternaId: guion.pago.suscripcion,
              importeCentavos: null,
              moneda: 'ARS',
              medio: 'visa',
              ultimos4: '4242',
            },
          };
    },
    verificarFirma: async () => guion.firma,
  };
}

suite('El webhook de pagos', () => {
  let app: FastifyInstance;
  let db: Client;
  let guion: Guion;

  beforeAll(async () => {
    initPool(DATABASE_URL);
    db = await connect();
    guion = { firma: true, pago: null, suscripcion: null, consultas: 0 };
    app = await buildServer({ pagos: { proveedor: doble(guion) as never, ambiente: 'sandbox' } });
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  beforeEach(async () => {
    guion.firma = true;
    guion.consultas = 0;
    // La bandeja se vacía entre casos: es una tabla de integración del
    // operador, no un hecho económico, así que borrarla no rompe ninguna
    // trazabilidad. Las tablas de cobros no se tocan.
    await db.query('DELETE FROM payment_webhook_inbox');
  });

  const enviar = async (cuerpo: unknown, cabeceras: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/pagos',
      payload: cuerpo,
      headers: { 'x-signature': 'ts=1,v1=loquesea', 'x-request-id': 'req-1', ...cabeceras },
    });

  const NOTIFICACION = {
    id: 'notif-1',
    type: 'payment',
    action: 'payment.updated',
    data: { id: '9001' },
  };

  const enBandeja = async (): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM payment_webhook_inbox',
    );
    return Number(rows[0]!.n);
  };

  it('con firma válida, guarda y contesta 200', async () => {
    const r = await enviar(NOTIFICACION);
    expect(r.statusCode).toBe(200);
    expect(await enBandeja()).toBe(1);
  });

  it('con firma inválida contesta 401 y NO deja fila', async () => {
    // No guardar los rechazos es lo que impide que la ruta pública —que
    // cualquiera puede llamar— sea un buzón que se llena desde internet.
    guion.firma = false;
    const r = await enviar(NOTIFICACION);
    expect(r.statusCode).toBe(401);
    expect(await enBandeja()).toBe(0);
  });

  it('sin con qué verificar contesta 503 y no 401', async () => {
    // La distinción que más importa de la ruta. Un 401 diría «tu firma está
    // mal» y haría que alguien buscara un ataque; lo que falta es
    // configuración de este lado. Además un 5xx hace que la pasarela
    // reintente, así que las notificaciones de esas horas no se pierden.
    guion.firma = null;
    const r = await enviar(NOTIFICACION);
    expect(r.statusCode).toBe(503);
    expect(r.json<{ error: string }>().error).toBe('SIN_VERIFICACION');
    expect(await enBandeja()).toBe(0);
  });

  it('la misma notificación dos veces deja una sola fila y contesta 200 las dos', async () => {
    // Contestar un error a un reenvío —que es comportamiento normal de una
    // pasarela— la haría reintentar para siempre algo ya resuelto.
    expect((await enviar(NOTIFICACION)).statusCode).toBe(200);
    expect((await enviar(NOTIFICACION)).statusCode).toBe(200);
    expect(await enBandeja()).toBe(1);
  });

  it('dos notificaciones distintas sobre el mismo recurso son dos filas', async () => {
    // El caso que una clave sintetizada como `tipo:recurso` colapsaría: el
    // segundo aviso sobre el mismo pago se perdería en silencio.
    await enviar({ ...NOTIFICACION, id: 'notif-1' });
    await enviar({ ...NOTIFICACION, id: 'notif-2' });
    expect(await enBandeja()).toBe(2);
  });

  it('sin id de notificación, el sello de la firma separa una de otra', async () => {
    const sinId = { type: 'payment', action: 'payment.updated', data: { id: '9001' } };
    await enviar(sinId, { 'x-signature': 'ts=1700000000,v1=x' });
    await enviar(sinId, { 'x-signature': 'ts=1700000099,v1=x' });
    expect(await enBandeja()).toBe(2);
  });

  it('una notificación que no dice de qué habla es 400 y no deja fila', async () => {
    for (const cuerpo of [{}, { type: 'payment' }, { data: { id: '1' } }, { id: 'x' }]) {
      const r = await enviar(cuerpo);
      expect(r.statusCode, JSON.stringify(cuerpo)).toBe(400);
    }
    expect(await enBandeja()).toBe(0);
  });

  it('acepta el tipo y el recurso por query, que es la otra forma documentada', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/pagos?type=payment&data.id=9001',
      payload: { id: 'notif-q' },
      headers: { 'x-signature': 'ts=1,v1=x' },
    });
    expect(r.statusCode).toBe(200);
    expect(await enBandeja()).toBe(1);
  });

  it('el cuerpo gana sobre la query', async () => {
    await app.inject({
      method: 'POST',
      url: '/webhooks/pagos?type=payment&data.id=OTRO',
      payload: NOTIFICACION,
      headers: { 'x-signature': 'ts=1,v1=x' },
    });
    const { rows } = await db.query<{ recurso_id: string }>(
      'SELECT recurso_id FROM payment_webhook_inbox',
    );
    expect(rows[0]!.recurso_id).toBe('9001');
  });

  it('la ruta NO le pregunta nada a la pasarela', async () => {
    // El corte que sostiene todo el diseño: la ruta guarda y no interpreta.
    // Consultar acá la haría depender de una llamada externa para poder
    // contestar, y un proveedor lento haría que la pasarela reintentara.
    await enviar(NOTIFICACION);
    expect(guion.consultas, 'la ruta consultó a la pasarela').toBe(0);
  });

  it('la aplicación no puede leer la bandeja que escribe', async () => {
    // El permiso que hace que esto sea seguro, comprobado desde el rol real y
    // no desde la declaración. S-29 lo mira en el catálogo; esto lo ejercita.
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE aai_app');
      await expect(db.query('SELECT * FROM payment_webhook_inbox')).rejects.toThrow(
        /permission denied|permiso denegado/iu,
      );
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('no responde a GET: una notificación no es una lectura', async () => {
    const r = await app.inject({ method: 'GET', url: '/webhooks/pagos' });
    expect(r.statusCode).toBe(404);
  });
});
