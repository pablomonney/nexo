/**
 * De la prueba al cobro, sin saltearse ningún eslabón.
 *
 *     prueba de 14 días
 *       → POST /subscription/convertir   (fija plan, periodicidad, moneda,
 *                                         importe y próxima facturación)
 *       → POST /subscription/pasarela    (crea el preapproval y devuelve dónde
 *                                         autoriza el cliente)
 *       → el ciclo emite el cargo
 *
 * Hasta B2.5.5 esta cadena tenía dos eslabones que existían y **no los llamaba
 * nadie**: `convertirPrueba` y `crearSuscripcion`. Un archivo de tests que los
 * ejercitara por separado —y lo había— seguía dando verde mientras el producto
 * no se podía contratar. Por eso acá todo entra por HTTP: lo que se defiende no
 * es que las funciones anden, es que **haya puerta**.
 *
 * ## Lo que este archivo existe para impedir
 *
 *   1. **Que el cliente elija cuánto paga.** El importe sale de `plan_prices` y
 *      no del cuerpo del pedido. Es el punto uno porque es el único de esta
 *      lista que se cobra en plata.
 *   2. **Que sin precio declarado se cobre cero.** Un plan sin precio no es un
 *      plan gratis: es un plan cuyo precio nadie declaró.
 *   3. **Que una empresa termine con dos suscripciones en la pasarela.** Serían
 *      dos débitos mensuales al mismo cliente.
 *   4. **Que se escriba una referencia de pasarela sin dueño ni ambiente.**
 *
 * ## El precio que declara este archivo
 *
 * Sobre un plan propio, con código único y `DISCONTINUADO` al terminar. No toca
 * ninguno de los cinco planes comerciales: declarar un precio de prueba sobre
 * `GESTION` lo dejaría vigente en la base de desarrollo, visible en el catálogo,
 * y se vería exactamente igual que uno decidido.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { emitirVencidos } from '@aai/api/billing/ciclo';
import { iniciarPrueba, DIAS_DE_PRUEBA } from '@aai/api/billing/prueba';
import { conectarConLaPasarela } from '@aai/api/pagos/suscripcion';
import { SinPasarela, type EstadoExternoDeSuscripcion } from '@aai/api/pagos/puerto';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

/** El precio del plan de prueba. Un número cualquiera: lo que importa es que sea **el mismo** que termina en la suscripción. */
const PRECIO = '12345.67';
const PRECIO_EN_CENTAVOS = 1_234_567n;

/**
 * Lo que el doble de la pasarela va a contestar, y qué se le preguntó.
 *
 * Mutable a propósito: lo que cambia entre casos es qué dice el proveedor, que
 * es justamente lo que se prueba. `creaciones` es el contador que defiende el
 * punto 3 de la lista de arriba.
 */
interface Guion {
  creaciones: number;
  consultas: number;
  ultimoPedido: {
    referenciaNexo: string;
    planExternoId: string;
    correoDelPagador: string;
    importeCentavos: bigint;
    moneda: string;
    urlDeRetorno: string;
  } | null;
  respuesta: 'OK' | 'RECHAZA';
  /**
   * El estado de la suscripción **del lado de la pasarela**.
   *
   * El doble lo guarda y las transiciones lo mueven, en vez de contestar una
   * constante. Es la única forma de comprobar lo que importa: que después de
   * cancelar en NEXO, la pasarela **quedó** cancelada. Un doble que solo
   * devuelve `ok` diría que sí aunque no hubiera cambiado nada.
   */
  externo: EstadoExternoDeSuscripcion | 'INEXISTENTE';
  /** Qué transiciones se le pidieron, en orden. Un pedido de más se ve acá. */
  pedidos: string[];
  /** La pasarela no contesta. Para el caso en que cancelar tiene que fallar. */
  caida: boolean;
  /**
   * La pasarela contesta la consulta y **rechaza la transición**.
   *
   * Es distinto de `caida` y hace falta que lo sea: con la pasarela caída no se
   * llega a pedir nada, y lo que hay que ejercitar acá es el rechazo del pedido
   * en sí — el momento en que NEXO ya sabe en qué estado está la suscripción y
   * aun así no consigue moverla.
   */
  rechazaTransicion: boolean;
}

function doble(guion: Guion) {
  const fallo = { codigo: 'NO_ENCONTRADO' as const, detalle: 'el doble no lo tiene' };
  const caido = { codigo: 'PROVEEDOR_CAIDO' as const, detalle: 'el doble está caído' };

  const transicion = async (nombre: string, hacia: EstadoExternoDeSuscripcion) => {
    guion.pedidos.push(nombre);
    if (guion.caida) return { ok: false as const, fallo: caido };
    if (guion.rechazaTransicion) {
      return {
        ok: false as const,
        fallo: { codigo: 'CONFLICTO' as const, detalle: 'el doble rechaza la transición' },
      };
    }
    guion.externo = hacia;
    return { ok: true as const, valor: { id: 'preapproval-doble', estado: hacia } };
  };
  return {
    id: 'mercadopago',
    asegurarPlan: async () => ({ ok: false as const, fallo }),
    crearSuscripcion: async (datos: Guion['ultimoPedido'] & object) => {
      guion.creaciones += 1;
      guion.ultimoPedido = datos;
      if (guion.respuesta === 'RECHAZA') {
        return {
          ok: false as const,
          fallo: { codigo: 'PEDIDO_INVALIDO' as const, detalle: 'el doble lo rechaza' },
        };
      }
      guion.externo = 'PENDIENTE';
      return {
        ok: true as const,
        valor: {
          id: `preapproval-${guion.creaciones}`,
          estado: 'PENDIENTE' as const,
          urlDeAutorizacion: 'https://www.mercadopago.com.ar/subscriptions/checkout?pref=abc',
          referenciaNexo: datos.referenciaNexo,
        },
      };
    },
    consultarSuscripcion: async (id: string) => {
      guion.consultas += 1;
      if (guion.caida) return { ok: false as const, fallo: caido };
      if (guion.externo === 'INEXISTENTE') return { ok: false as const, fallo };
      return { ok: true as const, valor: { id, estado: guion.externo } };
    },
    pausarSuscripcion: async () => transicion('pausar', 'PAUSADA'),
    reactivarSuscripcion: async () => transicion('reactivar', 'AUTORIZADA'),
    cancelarSuscripcion: async () => transicion('cancelar', 'CANCELADA'),
    consultarPago: async () => ({ ok: false as const, fallo }),
    verificarFirma: async () => null,
  };
}

suite('De la prueba al cobro', () => {
  let app: FastifyInstance;
  let db: Client;
  let empresa: string;
  let token: string;
  let planId: string;
  let planCode: string;
  let correo: string;

  const guion: Guion = {
    creaciones: 0,
    consultas: 0,
    ultimoPedido: null,
    respuesta: 'OK',
    externo: 'INEXISTENTE',
    pedidos: [],
    caida: false,
    rechazaTransicion: false,
  };

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer({

      pagos: {
        proveedor: doble(guion) as never,
        ambiente: 'sandbox',
        urlDeRetorno: 'https://nexo.test/suscripcion/volver',
      },
    });
    await app.ready();
    db = await connect();
    const stamp = await sufijoUnico(db);

    // ── El plan de prueba, con su precio ──────────────────────────────────
    planCode = `PRUEBA_${stamp}`.slice(0, 40);
    planId = (
      await db.query<{ id: string }>(
        `INSERT INTO subscription_plans (code, name, descripcion, orden, status)
         VALUES ($1, $2, 'Plan de prueba de la suite de conversión', 9000, 'DISPONIBLE')
         RETURNING id`,
        [planCode, `Plan ${stamp}`],
      )
    ).rows[0]!.id;

    /**
     * El plan de prueba lleva **todas** las funcionalidades del catálogo.
     *
     * No es decoración: mientras exista, es un plan `DISPONIBLE` como cualquier
     * otro, y S-33 —que comprueba que el menú no ofrezca lo que un plan a la
     * venta excluye— lo ve y lo cuenta. Sin features, este plan excluía **todos
     * los dominios**, así que S-33 fallaba cada vez que los dos archivos se
     * cruzaban en paralelo. Pasaba solo, fallaba acompañado.
     *
     * Con el catálogo completo el plan no excluye nada y deja de existir para
     * S-33, sin desactivar nada ni depender de en qué orden corran los
     * archivos. El mismo remedio que las fechas aparcadas en 2027: no estorbar,
     * en vez de pedir que no te miren.
     */
    await db.query(
      `INSERT INTO plan_features (plan_id, feature_code, declarado_por, motivo)
       SELECT $1, f.code, 'test:conversion',
              'El plan de la suite de conversión incluye todo el catálogo para no ' ||
              'aparecer ante S-33 como un plan a la venta que excluye dominios'
         FROM product_features f
       ON CONFLICT DO NOTHING`,
      [planId],
    );

    // ── La empresa y quien la administra ──────────────────────────────────
    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [`fundador-conv-${stamp}@estudio.test`, 'Fundador', clave],
      )
    ).rows[0]!.id;
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio conv ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;
    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa conv ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST', url: '/auth/login',
        payload: { email: `fundador-conv-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    correo = `admin-conv-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST', url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email: correo, fullName: 'Administradora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { userId, role: 'ADMINISTRADOR' },
    });

    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correo, password: PASSWORD } })
    ).json<{ token: string }>().token;
    const secret = (
      await app.inject({
        method: 'POST', url: '/auth/mfa/setup',
        headers: { authorization: `Bearer ${inicial}` },
      })
    ).json<{ secret: string }>().secret;
    await app.inject({
      method: 'POST', url: '/auth/mfa/confirm',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${inicial}` },
    });
    token = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email: correo, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
  });

  afterAll(async () => {
    // El plan de prueba sale del catálogo. No se borra la fila: una suscripción
    // que lo cite tiene que seguir encontrando su plan, que es el mismo motivo
    // por el que la 0105 discontinuó los de ejemplo en vez de borrarlos.
    await db.query(`UPDATE subscription_plans SET status = 'DISCONTINUADO' WHERE id = $1`, [planId]);
    await borrarSuscripciones();
    await db.query('DELETE FROM payment_plan_map WHERE plan_id = $1', [planId]);
    await db.query('DELETE FROM plan_prices WHERE plan_id = $1', [planId]);
    // Las features del plan de prueba también se van: la fila del plan queda
    // (una suscripción histórica tiene que encontrarlo) pero no hace falta que
    // arrastre diecinueve filas de catálogo.
    await db.query('DELETE FROM plan_features WHERE plan_id = $1', [planId]);
    await db.query('DELETE FROM plan_limits WHERE plan_id = $1', [planId]);
    await app.close();
    await db.end();
    await closePool();
  });

  const cabeceras = () => ({
    authorization: `Bearer ${token}`,
    'x-company-id': empresa,
  });

  /** El ciclo corre como operador, sin empresa en contexto: recorre todas. */
  const txDe = (cliente: Client) => ({
    query: (text: string, values?: readonly unknown[]) => cliente.query(text, values as unknown[]),
  });

  const declararPrecio = async (): Promise<void> => {
    await db.query(
      `INSERT INTO plan_prices
         (plan_id, periodicidad, moneda, importe, incluye_impuestos, vigente_desde,
          declarado_por, motivo)
       VALUES ($1, 'MENSUAL', 'ARS', $2::numeric, false, CURRENT_DATE,
               'test:conversion', 'Precio de la suite de conversión')
       ON CONFLICT DO NOTHING`,
      [planId, PRECIO],
    );
  };

  /**
   * Borra la suscripción de esta empresa y todo lo que cuelga de ella.
   *
   * En orden de dependencia y sin `CASCADE`. Desde que el último caso hace
   * emitir el cargo, la suscripción tiene un período y un documento apuntándole,
   * y un `DELETE` directo choca contra la clave foránea — que está para eso: un
   * documento de cobro no se queda sin la suscripción que lo explica.
   *
   * Se borra en los tests y **solo en los tests**: en producción estas filas no
   * se borran nunca, que es el motivo por el que `billing_documents` tiene
   * estados `ANULADO` e `INCOBRABLE` en vez de un `DELETE`.
   */
  /**
   * La ventana de fechas de este archivo, y por qué existe.
   *
   * `emitirVencidos` recorre **todas** las suscripciones de la base, y la base
   * de pruebas la comparten los archivos que corren en paralelo. Mientras una
   * suscripción de acá tenga `proxima_facturacion` dentro del rango que usan
   * las otras suites —2026-01 a 2026-10— el ciclo de ellas la levanta, y si
   * justo la borro entre su `SELECT` y su `INSERT`, el que falla es su test con
   * una violación de clave foránea. Pasó dos veces.
   *
   * La solución es no estar en su rango: apenas una suscripción de este archivo
   * tiene fecha, se la manda a 2027. Nadie más mira ahí.
   */
  const FECHA_APARCADA = '2027-03-05';

  const aparcarFechas = async (): Promise<void> => {
    await db.query(
      `UPDATE company_subscriptions SET proxima_facturacion = $2::date
        WHERE company_id = $1 AND proxima_facturacion IS NOT NULL`,
      [empresa, FECHA_APARCADA],
    );
  };

  /**
   * Al terminar cada caso, las fechas se van a 2027.
   *
   * Convertir deja `proxima_facturacion` en la fecha de hoy, que cae dentro del
   * rango de las otras suites. Aparcarla en `afterEach` —que corre también
   * cuando el caso falla— reduce la exposición a la duración de un solo test,
   * en vez de dejarla viva entre casos.
   *
   * Es una limitación de compartir la base entre archivos que corren en
   * paralelo, no un defecto del producto: en producción nada borra
   * suscripciones, y por eso el ciclo no se defiende de que desaparezcan.
   */
  afterEach(async () => {
    if (db !== undefined) await aparcarFechas();
  });

  const borrarSuscripciones = async (): Promise<void> => {
    // Primero se le sacan las condiciones: sin `proxima_facturacion` la fila
    // deja de ser elegible para cualquier ciclo, y recién entonces se borra.
    //
    // Las cuatro juntas y no solo la fecha: `condiciones_completas` (0096) exige
    // que estén las cuatro o ninguna, así que vaciar una sola viola el CHECK.
    // Es el mismo candado que impide un importe sin moneda, funcionando.
    await db.query(
      `UPDATE company_subscriptions
          SET periodicidad = NULL, moneda = NULL, importe_acordado = NULL,
              proxima_facturacion = NULL
        WHERE company_id = $1`,
      [empresa],
    );
    await db.query('DELETE FROM payment_intents WHERE company_id = $1', [empresa]);
    await db.query('DELETE FROM billing_documents WHERE company_id = $1', [empresa]);
    await db.query('DELETE FROM billing_periods WHERE company_id = $1', [empresa]);
    await db.query('DELETE FROM company_subscriptions WHERE company_id = $1', [empresa]);
  };

  /**
   * La prueba de este archivo termina dentro de diez años, y no es un descuido.
   *
   * `correrCiclo` vence **todas** las pruebas cuya `vigencia_hasta` quedó atrás,
   * y `facturacion.test.ts` lo corre con fechas de hasta `2026-10-01` sobre la
   * misma base, en paralelo. Una prueba que terminara a los catorce días reales
   * quedaba SUSPENDIDA en mitad de un caso de este archivo, y el que fallaba era
   * este —el inocente—, que ni siquiera habla de vencimientos.
   *
   * Que la prueba dure catorce días lo defiende `prueba-y-planes.test.ts`, que
   * es su archivo. Acá lo que se prueba es la conversión, y para eso la fecha de
   * fin solo tiene que estar lejos.
   */
  const FIN_LEJANO = "CURRENT_DATE + 3650";

  const empezarPrueba = async (): Promise<void> => {
    await borrarSuscripciones();
    await db.query(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, vigencia_hasta, created_by)
       VALUES ($1, $2, 'PRUEBA', CURRENT_DATE, ${FIN_LEJANO}, 'test:conversion')`,
      [empresa, planId],
    );
  };

  const suscripcion = async () =>
    (
      await db.query<{
        estado: string;
        periodicidad: string | null;
        moneda: string | null;
        importe_acordado: string | null;
        proxima_facturacion: string | null;
        vigencia_hasta: string | null;
        referencia_externa: string | null;
        proveedor_pago: string | null;
        ambiente_pago: string | null;
      }>(
        `SELECT estado, periodicidad, moneda, importe_acordado::text AS importe_acordado,
                proxima_facturacion::text AS proxima_facturacion,
                vigencia_hasta::text AS vigencia_hasta,
                referencia_externa, proveedor_pago, ambiente_pago
           FROM company_subscriptions WHERE company_id = $1`,
        [empresa],
      )
    ).rows[0]!;

  // ── 1 · Convertir ────────────────────────────────────────────────────────

  it('sin precio declarado no convierte, y lo dice con ese nombre', async () => {
    // El control que durante meses figuró en el tipo `Omision` del ciclo de
    // facturación y **no lo emitía nadie**. Vive acá, que es donde se decide el
    // importe, y no allá, que es donde se factura lo ya acordado.
    await db.query('DELETE FROM plan_prices WHERE plan_id = $1', [planId]);
    await empezarPrueba();

    const r = await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('SIN_PRECIO_VIGENTE');

    // Y no convirtió a medias: sigue siendo una prueba, sin condiciones.
    const s = await suscripcion();
    expect(s.estado).toBe('PRUEBA');
    expect(s.importe_acordado).toBeNull();
  });

  it('convertir fija las cuatro condiciones que el ciclo necesita', async () => {
    // Las cuatro van juntas o no va ninguna (`condiciones_completas`, 0096), y
    // `emitirVencidos` solo levanta suscripciones que las tengan. Sin esta ruta
    // una empresa podía contratar y no ser facturada nunca.
    await declararPrecio();
    await empezarPrueba();

    const r = await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });
    expect(r.statusCode, r.payload).toBe(200);

    const s = await suscripcion();
    expect(s.estado).toBe('ACTIVA');
    expect(s.periodicidad).toBe('MENSUAL');
    expect(s.moneda).toBe('ARS');
    expect(s.importe_acordado).toBe(PRECIO);
    expect(s.proxima_facturacion).not.toBeNull();
    // La vigencia deja de tener fin: la prueba terminaba, la suscripción no.
    expect(s.vigencia_hasta).toBeNull();
  });

  it('el importe sale de la lista aunque el cliente mande otro', async () => {
    // El punto uno. Un cuerpo con `importe` no tiene efecto: el esquema no lo
    // declara, así que zod lo descarta y el precio se resuelve contra
    // `plan_prices`. Si algún día alguien agrega el campo «por comodidad», este
    // test se pone en rojo.
    await declararPrecio();
    await empezarPrueba();

    const r = await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS', importe: '1.00' },
    });
    expect(r.statusCode, r.payload).toBe(200);
    expect((await suscripcion()).importe_acordado).toBe(PRECIO);
  });

  it('una moneda que el sistema no conoce se rechaza antes de mirar el precio', async () => {
    // No se sabe cuántos decimales tiene, así que no se la puede pasar a
    // centavos. Se dice eso y no «no hay precio», que mandaría a cargar una
    // lista que no es el problema.
    await declararPrecio();
    await empezarPrueba();

    const r = await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'XYZ' },
    });

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('MONEDA_DESCONOCIDA');
    expect((await suscripcion()).estado).toBe('PRUEBA');
  });

  it('un plan discontinuado no se vuelve a vender', async () => {
    // 404 y no 409: lo que se pidió no existe como oferta. Un plan
    // discontinuado sigue en la tabla para que las suscripciones históricas lo
    // encuentren, y eso **no** lo vuelve contratable.
    await empezarPrueba();

    const r = await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: 'GRATUITO', periodicidad: 'MENSUAL', moneda: 'ARS' },
    });

    expect(r.statusCode).toBe(404);
    expect((await suscripcion()).estado).toBe('PRUEBA');
  });

  it('una prueba ya convertida no se vuelve a convertir', async () => {
    await declararPrecio();
    await empezarPrueba();
    const cabs = cabeceras();
    const cuerpo = { plan: planCode, periodicidad: 'MENSUAL' as const, moneda: 'ARS' };

    expect(
      (await app.inject({ method: 'POST', url: '/subscription/convertir', headers: cabs, payload: cuerpo }))
        .statusCode,
    ).toBe(200);

    const segunda = await app.inject({
      method: 'POST', url: '/subscription/convertir', headers: cabs, payload: cuerpo,
    });
    expect(segunda.statusCode).toBe(409);
  });

  // ── 2 · Conectar la pasarela ─────────────────────────────────────────────

  it('en PRUEBA no se conecta la pasarela: no hay importe con qué suscribir', async () => {
    await declararPrecio();
    await empezarPrueba();
    const antes = guion.creaciones;

    const r = await app.inject({
      method: 'POST', url: '/subscription/pasarela', headers: cabeceras(),
    });

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('ESTADO_NO_CONTRATABLE');
    // Y no se llamó al proveedor: el control es de este lado.
    expect(guion.creaciones).toBe(antes);
  });

  it('sin plan declarado en la pasarela no se inventa uno', async () => {
    // Crear un plan del lado del proveedor define lo que se le cobra a todo el
    // mundo: lo declara el operador con un comando, no una petición HTTP.
    await declararPrecio();
    await empezarPrueba();
    await db.query('DELETE FROM payment_plan_map WHERE plan_id = $1', [planId]);
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });
    const antes = guion.creaciones;

    const r = await app.inject({
      method: 'POST', url: '/subscription/pasarela', headers: cabeceras(),
    });

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('SIN_PLAN_EN_LA_PASARELA');
    expect(guion.creaciones).toBe(antes);
  });

  it('con plan declarado devuelve dónde autoriza el cliente y guarda las tres columnas', async () => {
    await declararPrecio();
    await empezarPrueba();
    await mapearPlan();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });

    const r = await app.inject({
      method: 'POST', url: '/subscription/pasarela', headers: cabeceras(),
    });
    expect(r.statusCode, r.payload).toBe(200);

    const cuerpo = r.json<{ estado: string; urlDeAutorizacion: string; referenciaExterna: string }>();
    expect(cuerpo.estado).toBe('CONECTADA');
    expect(cuerpo.urlDeAutorizacion).toContain('mercadopago.com');

    // Las tres juntas: `cs_pasarela_completa` no admite otra cosa, y una
    // referencia sin proveedor ni ambiente apunta a un recurso que nadie puede
    // consultar.
    const s = await suscripcion();
    expect(s.referencia_externa).toBe(cuerpo.referenciaExterna);
    expect(s.proveedor_pago).toBe('mercadopago');
    expect(s.ambiente_pago).toBe('sandbox');
  });

  it('el importe que viaja a la pasarela es el acordado, en centavos', async () => {
    // Nunca se multiplica un flotante por cien. El importe sale de
    // `numeric(18,2)` como texto y se convierte con aritmética de enteros.
    expect(guion.ultimoPedido?.importeCentavos).toBe(PRECIO_EN_CENTAVOS);
    expect(guion.ultimoPedido?.moneda).toBe('ARS');
    // La clave del vínculo es el id de la suscripción, no el correo.
    expect(guion.ultimoPedido?.correoDelPagador).toBe(correo);
    expect(guion.ultimoPedido?.referenciaNexo).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('pedirla dos veces no crea dos suscripciones en la pasarela', async () => {
    // El punto tres. Dos `preapproval` para la misma empresa son dos débitos
    // mensuales al mismo cliente, y de eso no se vuelve con un `UPDATE`.
    const antes = guion.creaciones;

    const r = await app.inject({
      method: 'POST', url: '/subscription/pasarela', headers: cabeceras(),
    });

    expect(r.statusCode, r.payload).toBe(200);
    expect(r.json<{ estado: string }>().estado).toBe('YA_ESTABA');
    expect(guion.creaciones).toBe(antes);
  });

  it('si la pasarela rechaza, no queda ninguna referencia escrita', async () => {
    // Guardar la referencia de una suscripción que no se creó dejaría a la
    // empresa marcada como conectada contra un recurso inexistente, y el
    // próximo intento no volvería a crearla porque creería que ya está.
    await declararPrecio();
    await empezarPrueba();
    await mapearPlan();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });

    guion.respuesta = 'RECHAZA';
    const r = await app.inject({
      method: 'POST', url: '/subscription/pasarela', headers: cabeceras(),
    });
    guion.respuesta = 'OK';

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('LA_PASARELA_RECHAZO');
    expect((await suscripcion()).referencia_externa).toBeNull();
  });

  // ── 3 · Lo que la 0118 dejó imposible de escribir a mano ─────────────────

  it('declarar un plan por la ruta manual no escribe ninguna referencia', async () => {
    // `POST /subscription` aceptaba `referenciaExterna` y la escribía sola.
    // Desde la 0118 eso viola `cs_pasarela_completa`. El campo se sacó del
    // cuerpo, así que mandarlo no rompe nada y tampoco hace nada.
    await borrarSuscripciones();

    const r = await app.inject({
      method: 'POST', url: '/subscription',
      headers: cabeceras(),
      payload: {
        plan: planCode,
        estado: 'ACTIVA',
        vigenciaDesde: new Date().toISOString().slice(0, 10),
        referenciaExterna: 'preapproval-inventado',
      },
    });

    expect(r.statusCode).toBe(201);
    const s = await suscripcion();
    expect(s.referencia_externa).toBeNull();
    expect(s.proveedor_pago).toBeNull();
  });

  it('la base impide que dos suscripciones compartan una referencia', async () => {
    // El índice de la 0120. Sin él, `pagos/bandeja.ts` atribuiría un cobro
    // entrante por orden de lectura, que es azar disfrazado de regla.
    const stamp = await sufijoUnico(db);
    // La referencia lleva el sufijo del run. Con un literal fijo, un run que
    // falla a mitad deja dos filas que colisionan con las del siguiente — y la
    // primera versión de este test lo hizo: dejó seis, y la migración que crea
    // el índice no pudo aplicarse sobre la base de pruebas.
    const referencia = `compartida-${stamp}`;
    const otra = (
      await db.query<{ id: string }>(
        `INSERT INTO companies (organization_id, legal_name, cuit, entity_type,
                                jurisdiction, regulator, fiscal_year_end)
         SELECT organization_id, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31'
           FROM companies WHERE id = $1 RETURNING id`,
        [empresa, `Otra conv ${stamp}`, withCheckDigit(`33${stamp}`)],
      )
    ).rows[0]!.id;

    let code = '';
    try {
      await db.query(
        `UPDATE company_subscriptions
            SET referencia_externa = $2, proveedor_pago = 'mercadopago',
                ambiente_pago = 'sandbox'
          WHERE company_id = $1`,
        [empresa, referencia],
      );

      try {
        await db.query(
          `INSERT INTO company_subscriptions
             (company_id, plan_id, estado, vigencia_desde, referencia_externa,
              proveedor_pago, ambiente_pago, created_by)
           VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, $3, 'mercadopago', 'sandbox', 'test')`,
          [otra, planId, referencia],
        );
      } catch (error) {
        code = (error as { code?: string }).code ?? '';
      }
    } finally {
      // En `finally` y no después de la afirmación: si el índice no estuviera
      // —o sea, justo cuando este test tiene que fallar— la limpieza no correría
      // y el residuo impediría crear el índice la próxima vez. Un test que al
      // fallar rompe el arreglo que reclama no sirve para reclamarlo.
      await db.query(
        `UPDATE company_subscriptions
            SET referencia_externa = NULL, proveedor_pago = NULL, ambiente_pago = NULL
          WHERE company_id = $1`,
        [empresa],
      );
      await db.query('DELETE FROM company_subscriptions WHERE company_id = $1', [otra]);
      await db.query('DELETE FROM companies WHERE id = $1', [otra]);
    }

    // 23505 — unique_violation. El SQLSTATE y no el mensaje: los textos de
    // PostgreSQL están traducidos y un test que los compare pasa en inglés y
    // falla en español.
    expect(code).toBe('23505');
  });

  it('una suscripción ACTIVA sin condiciones acordadas no se puede suscribir', async () => {
    // Es alcanzable y no es hipotético: `POST /subscription` declara el plan y
    // **no escribe** periodicidad, moneda ni importe. Quien la declare a mano y
    // después toque «conectar el medio de pago» cae acá. Sin este control, el
    // importe que viajaría a la pasarela saldría de un `null`.
    await borrarSuscripciones();
    await app.inject({
      method: 'POST', url: '/subscription',
      headers: cabeceras(),
      payload: {
        plan: planCode,
        estado: 'ACTIVA',
        vigenciaDesde: (await db.query<{ hoy: string }>('SELECT CURRENT_DATE::text AS hoy'))
          .rows[0]!.hoy,
      },
    });
    const antes = guion.creaciones;

    const r = await app.inject({
      method: 'POST', url: '/subscription/pasarela', headers: cabeceras(),
    });

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('SIN_CONDICIONES_ACORDADAS');
    expect(guion.creaciones).toBe(antes);
  });

  it('si ya estaba conectada y la pasarela no contesta, se dice eso y no «sin medio»', async () => {
    // La diferencia importa: «no se pudo consultar» es la pasarela caída,
    // «sin medio de pago» es el cliente que no autorizó. Confundirlos mandaría a
    // pedirle al cliente que rehaga un trámite que ya hizo.
    await declararPrecio();
    await empezarPrueba();
    await mapearPlan();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });
    await app.inject({ method: 'POST', url: '/subscription/pasarela', headers: cabeceras() });

    const mudo = { ...doble(guion), consultarSuscripcion: async () => ({
      ok: false as const,
      fallo: { codigo: 'PROVEEDOR_CAIDO' as const, detalle: 'la pasarela no contesta' },
    }) };

    const salida = await conectarConLaPasarela(
      txDe(db),
      { companyId: empresa, correoDelPagador: correo, actorId: 'test:conversion' },
      { proveedor: mudo as never, ambienteConfigurado: 'sandbox', urlDeRetorno: 'https://x.test' },
    );

    expect(salida.estado).toBe('YA_ESTABA');
    if (salida.estado !== 'YA_ESTABA') return;
    expect(salida.estadoEnLaPasarela).toBeNull();
    expect(salida.detalle).toMatch(/ya estaba conectada/u);
    expect(salida.detalle).toMatch(/PROVEEDOR_CAIDO/u);
  });

  it('sin pasarela contratada no falla: dice que se cobra por transferencia', async () => {
    // El modo en el que NEXO está hoy, y **es un modo de operación**, no una
    // degradación. Se ejercita contra la función y no contra la ruta porque lo
    // que cambia es el proveedor del despliegue entero, no algo de un pedido.
    await declararPrecio();
    await empezarPrueba();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });

    const salida = await conectarConLaPasarela(
      txDe(db),
      { companyId: empresa, correoDelPagador: correo, actorId: 'test:conversion' },
      { proveedor: new SinPasarela(), ambienteConfigurado: 'sandbox', urlDeRetorno: 'https://x.test' },
    );

    expect(salida.estado).toBe('NO_SE_PUDO');
    if (salida.estado !== 'NO_SE_PUDO') return;
    expect(salida.motivo).toBe('SIN_PASARELA');
    expect(salida.detalle).toMatch(/transferencia/u);
  });

  it('sin URL de retorno no se llama al proveedor: falta una variable de acá', async () => {
    // El proveedor la exige, así que llamar sin ella volvería con un 4xx que se
    // leería como «la pasarela rechazó la suscripción» — y mandaría a revisar
    // la cuenta en vez del `.env`.
    const antes = guion.creaciones;

    const salida = await conectarConLaPasarela(
      txDe(db),
      { companyId: empresa, correoDelPagador: correo, actorId: 'test:conversion' },
      { proveedor: doble(guion) as never, ambienteConfigurado: 'sandbox', urlDeRetorno: null },
    );

    expect(salida.estado).toBe('NO_SE_PUDO');
    if (salida.estado !== 'NO_SE_PUDO') return;
    expect(salida.motivo).toBe('SIN_URL_DE_RETORNO');
    expect(salida.detalle).toMatch(/PAYMENTS_BACK_URL/u);
    expect(guion.creaciones).toBe(antes);
  });

  it('la suscripción convertida la levanta el ciclo y le emite el cargo', async () => {
    // El último eslabón, y el que justifica todo lo anterior. `emitirVencidos`
    // filtra por `proxima_facturacion IS NOT NULL`: mientras nadie escribiera
    // esa columna, una empresa podía contratar, pagar y **no recibir ningún
    // cargo**. La deuda no existía porque nadie la emitía.
    await declararPrecio();
    await empezarPrueba();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });

    /**
     * El ciclo recorre **todas** las suscripciones de la base, y la base de
     * pruebas la comparten los archivos que corren en paralelo. Llamarlo con la
     * fecha de hoy le hacía emitir cargos sobre los fixtures de
     * `facturacion.test.ts` mientras ese archivo los estaba usando: dos
     * corridas se pisaron y una terminó insertando un período de una suscripción
     * que la otra ya había borrado.
     *
     * Se resuelve moviendo esta suscripción a una fecha que **ningún otro
     * archivo usa** —los demás trabajan en 2026— y pidiéndole al ciclo esa
     * fecha. El filtro `proxima_facturacion <= $1` deja afuera todo lo ajeno.
     * No es una manía de aislamiento: es que un test que ensucia a otro hace
     * fallar al inocente, y ahí se busca el defecto en el lugar equivocado.
     */
    await aparcarFechas();

    /**
     * El ciclo corre **dentro de una transacción que se deshace**.
     *
     * Dos motivos, y los dos son de convivencia:
     *
     *   · `emitirVencidos` emite para todo lo que encuentre vencido, no solo
     *     para esta empresa. Sin el `ROLLBACK`, este archivo le crearía
     *     documentos a los fixtures de las otras suites mientras las están
     *     usando.
     *   · La fecha está aparcada en 2027, fuera del rango de las demás, así que
     *     lo de este lado tampoco es visible para sus ciclos.
     *
     * Lo que se prueba no se pierde: el informe y las filas se leen **antes**
     * de deshacer.
     */
    await db.query('BEGIN');
    let informe: Awaited<ReturnType<typeof emitirVencidos>>;
    let docEstado: string | undefined;
    let docImporte: string | undefined;
    try {
      informe = await emitirVencidos(txDe(db), FECHA_APARCADA as never, 'test:ciclo');
      const doc = await db.query<{ estado: string; importe_total: string }>(
        `SELECT estado, importe_total::text AS importe_total
           FROM billing_documents WHERE company_id = $1`,
        [empresa],
      );
      docEstado = doc.rows[0]?.estado;
      docImporte = doc.rows[0]?.importe_total;
    } finally {
      await db.query('ROLLBACK');
    }

    const mio = informe!.emitidos.find((d) => d.companyId === empresa);
    expect(mio, JSON.stringify(informe!.omitidos)).toBeDefined();
    expect(mio!.importe).toBe(PRECIO);
    expect(mio!.moneda).toBe('ARS');

    // El documento existió dentro de la transacción, con el importe de la
    // lista. Que después se haya deshecho no le quita nada a lo que prueba:
    // el ciclo levantó la suscripción convertida y emitió el cargo.
    expect(docEstado).toBe('EMITIDO');
    expect(docImporte).toBe(PRECIO);
  });

  // ── 4 · Cancelar, pausar y reactivar: NEXO y la pasarela, o ninguno ──────
  //
  // El invariante de esta sección, en una línea: **ninguna suscripción puede
  // quedar cancelada o suspendida en NEXO mientras la pasarela le sigue
  // debitando al cliente**. Un cliente que se da de baja, ve «CANCELADA» y
  // sigue viendo el débito en su resumen no tiene un problema de software:
  // tiene un cargo indebido.

  /** Deja la empresa ACTIVA y conectada a la pasarela, con la pasarela autorizada. */
  const conectadaYAutorizada = async (): Promise<void> => {
    await declararPrecio();
    await empezarPrueba();
    await mapearPlan();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });
    await app.inject({ method: 'POST', url: '/subscription/pasarela', headers: cabeceras() });
    await aparcarFechas();
    // El cliente autorizó el medio de pago: es el estado desde el que la
    // pasarela debita todos los meses, o sea donde cancelar importa de verdad.
    guion.externo = 'AUTORIZADA';
    guion.pedidos = [];
    guion.caida = false;
    guion.rechazaTransicion = false;
  };

  const suscripcionId = async (): Promise<string> =>
    (
      await db.query<{ id: string }>(
        'SELECT id FROM company_subscriptions WHERE company_id = $1',
        [empresa],
      )
    ).rows[0]!.id;

  const cambiarEstado = async (estado: string, motivo: string) =>
    app.inject({
      method: 'POST', url: `/subscription/${await suscripcionId()}/estado`,
      headers: cabeceras(),
      payload: { estado, motivo },
    });

  it('cancelar en NEXO cancela en la pasarela', async () => {
    await conectadaYAutorizada();

    const r = await cambiarEstado('CANCELADA', 'El cliente pidió la baja');

    expect(r.statusCode, r.payload).toBe(200);
    // Lo que importa no es que la ruta conteste 200: es que del otro lado haya
    // quedado cancelada. Por eso el doble guarda estado.
    expect(guion.pedidos).toContain('cancelar');
    expect(guion.externo).toBe('CANCELADA');
    expect((await suscripcion()).estado).toBe('CANCELADA');
  });

  it('si la pasarela no confirma, NEXO no se cancela', async () => {
    // El caso que justifica todo el orden de la operación. Cancelar en NEXO
    // sobre una pasarela que no contestó dejaría al cliente dado de baja y
    // debitado: entre «probá de nuevo» y «te seguimos cobrando», se elige el
    // inconveniente.
    await conectadaYAutorizada();
    guion.caida = true;

    const r = await cambiarEstado('CANCELADA', 'El cliente pidió la baja');

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('NO_SE_PUDO_CONSULTAR');
    // Y no quedó a medias: sigue ACTIVA y la pasarela sigue como estaba.
    expect((await suscripcion()).estado).toBe('ACTIVA');
    expect(guion.externo).toBe('AUTORIZADA');
    guion.caida = false;
  });

  it('si la pasarela rechaza la cancelación, NEXO tampoco se cancela', async () => {
    // La pasarela contesta —no está caída— y dice que no. Es distinto de no
    // poder preguntarle, y el desenlace tiene que ser el mismo: la suscripción
    // sigue debitando, así que NEXO no puede decir que está dada de baja.
    await conectadaYAutorizada();
    guion.rechazaTransicion = true;

    const r = await cambiarEstado('CANCELADA', 'El cliente pidió la baja');

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('LA_PASARELA_RECHAZO');
    expect(guion.pedidos).toContain('cancelar');
    // Se pidió, se rechazó, y no se movió nada de los dos lados.
    expect(guion.externo).toBe('AUTORIZADA');
    expect((await suscripcion()).estado).toBe('ACTIVA');
    guion.rechazaTransicion = false;
  });

  it('cancelar dos veces no le pide dos veces a la pasarela', async () => {
    // Idempotencia. Reintentar sobre algo ya cancelado devolvería un 4xx del
    // proveedor que se leería como «no se pudo cancelar»; preguntando primero,
    // ese caso es un éxito sin llamada.
    await conectadaYAutorizada();
    await cambiarEstado('CANCELADA', 'El cliente pidió la baja');
    const pedidosTrasLaPrimera = guion.pedidos.filter((p) => p === 'cancelar').length;

    // La segunda la frena NEXO —de CANCELADA no se vuelve— antes de la
    // pasarela. Lo que se comprueba es que no se le pidió nada más.
    const segunda = await cambiarEstado('CANCELADA', 'Otra vez');

    expect(segunda.statusCode).toBe(409);
    expect(guion.pedidos.filter((p) => p === 'cancelar').length).toBe(pedidosTrasLaPrimera);
  });

  it('pausar en NEXO pausa en la pasarela, y reactivar la vuelve a autorizar', async () => {
    await conectadaYAutorizada();

    const suspendida = await cambiarEstado('SUSPENDIDA', 'El cliente pidió pausar el servicio');
    expect(suspendida.statusCode, suspendida.payload).toBe(200);
    expect(guion.externo).toBe('PAUSADA');
    expect((await suscripcion()).estado).toBe('SUSPENDIDA');

    const reactivada = await cambiarEstado('ACTIVA', 'El cliente retoma el servicio');
    expect(reactivada.statusCode, reactivada.payload).toBe(200);
    expect(guion.externo).toBe('AUTORIZADA');
    expect((await suscripcion()).estado).toBe('ACTIVA');
    expect(guion.pedidos).toEqual(['pausar', 'reactivar']);
  });

  it('reactivar no se puede si la pasarela ya la canceló', async () => {
    // Mercado Pago no reactiva un preapproval cancelado. Reactivar en NEXO
    // dejaría a la empresa con el servicio y sin forma de cobrarle: es el mismo
    // error del otro signo.
    await conectadaYAutorizada();
    await cambiarEstado('SUSPENDIDA', 'Pausa a pedido del cliente');
    guion.externo = 'CANCELADA';
    guion.pedidos = [];

    const r = await cambiarEstado('ACTIVA', 'Intento de reactivación');

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('NO_SE_PUEDE_REACTIVAR');
    expect((await suscripcion()).estado).toBe('SUSPENDIDA');
    expect(guion.pedidos).toEqual([]);
  });

  it('una referencia de otra cuenta no se toca, y tampoco se cambia el estado', async () => {
    // Desde esta instalación no se puede detener ese débito. Escribir el estado
    // igual sería afirmar una baja que no ocurrió.
    await conectadaYAutorizada();
    await db.query(
      `UPDATE company_subscriptions SET ambiente_pago = 'production' WHERE company_id = $1`,
      [empresa],
    );
    guion.pedidos = [];

    const r = await cambiarEstado('CANCELADA', 'El cliente pidió la baja');

    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: string }>().error).toBe('OTRA_CUENTA');
    expect((await suscripcion()).estado).toBe('ACTIVA');
    expect(guion.pedidos).toEqual([]);
  });

  it('sin pasarela conectada, cambiar el estado sigue funcionando igual', async () => {
    // Es el caso de producción hoy, y no puede depender de que haya pasarela:
    // una instalación que cobra por transferencia tiene que poder dar de baja.
    await declararPrecio();
    await empezarPrueba();
    await app.inject({
      method: 'POST', url: '/subscription/convertir',
      headers: cabeceras(),
      payload: { plan: planCode, periodicidad: 'MENSUAL', moneda: 'ARS' },
    });
    guion.pedidos = [];

    const r = await cambiarEstado('CANCELADA', 'Baja de una empresa que pagaba por transferencia');

    expect(r.statusCode, r.payload).toBe(200);
    expect(r.json<{ pasarela: { resultado: string } }>().pasarela.resultado).toBe('SIN_PASARELA');
    expect((await suscripcion()).estado).toBe('CANCELADA');
    expect(guion.pedidos).toEqual([]);
  });

  it('la suspensión por falta de pago NO pausa la pasarela', async () => {
    // La decisión menos obvia del módulo, y por eso se ejercita. Pausar del otro
    // lado cortaría los reintentos de la propia pasarela —lo único que puede
    // cobrar la deuda— así que se suspendería el acceso y se cerraría la vía de
    // recuperarlo.
    await conectadaYAutorizada();
    const sub = await suscripcionId();

    await db.query(
      `UPDATE company_subscriptions SET estado = 'SUSPENDIDA', suspendida_el = CURRENT_DATE,
              motivo = 'Falta de pago' WHERE id = $1`,
      [sub],
    );

    // El camino del ciclo no toca la pasarela: no hay ninguna llamada que hacer
    // porque `avanzarCobranza` no la invoca. Lo que se afirma es el hecho
    // observable — la pasarela sigue autorizada y puede seguir intentando.
    expect(guion.externo).toBe('AUTORIZADA');
    expect(guion.pedidos).toEqual([]);
  });

  // ── 5 · La prueba es del plan, y las fechas se comparan (0121) ───────────

  it('un plan sin dias_de_prueba declarados da los catorce por defecto', async () => {
    // `NULL` es «nadie lo declaró», no «cero días». Confundirlos le sacaría la
    // prueba a todo el que contrate ese plan.
    await borrarSuscripciones();
    await db.query('UPDATE subscription_plans SET dias_de_prueba = NULL WHERE id = $1', [planId]);

    const r = await iniciarPrueba(txDe(db), {
      companyId: empresa,
      planCode: planCode,
      desde: (await db.query<{ hoy: string }>('SELECT CURRENT_DATE::text AS hoy')).rows[0]!
        .hoy as never,
      actorId: 'test:conversion',
    });

    expect(r.estado).toBe('INICIADA');
    if (r.estado !== 'INICIADA') return;
    const dias = (Date.parse(r.prueba.hasta) - Date.parse(r.prueba.desde)) / 86_400_000 + 1;
    expect(dias).toBe(DIAS_DE_PRUEBA);
  });

  it('un plan que declara otra duración manda sobre la constante', async () => {
    // El punto de la 0121: cambiar la prueba de un plan es declarar un dato, no
    // desplegar código.
    await borrarSuscripciones();
    await db.query('UPDATE subscription_plans SET dias_de_prueba = 30 WHERE id = $1', [planId]);

    const r = await iniciarPrueba(txDe(db), {
      companyId: empresa,
      planCode: planCode,
      desde: (await db.query<{ hoy: string }>('SELECT CURRENT_DATE::text AS hoy')).rows[0]!
        .hoy as never,
      actorId: 'test:conversion',
    });

    expect(r.estado).toBe('INICIADA');
    if (r.estado !== 'INICIADA') return;
    const dias = (Date.parse(r.prueba.hasta) - Date.parse(r.prueba.desde)) / 86_400_000 + 1;
    expect(dias).toBe(30);

    await db.query('UPDATE subscription_plans SET dias_de_prueba = NULL WHERE id = $1', [planId]);
  });

  it('cuando NEXO factura un día y la pasarela cobra otro, aparece en la bandeja', async () => {
    // El precio de haber dejado la prueba en NEXO: el ciclo cuenta desde la
    // conversión y el proveedor desde la autorización, así que los dos
    // calendarios pueden separarse sin que falle nada. Lo que no puede pasar es
    // que nadie lo note.
    await conectadaYAutorizada();
    const sub = await suscripcionId();

    await db.query(
      `UPDATE company_subscriptions
          SET proxima_facturacion = DATE '2026-11-01',
              proxima_facturacion_pasarela = DATE '2026-11-05'
        WHERE id = $1`,
      [sub],
    );

    const bandeja = await db.query<{ rama: string; motivo: string; bloquea: boolean }>(
      `SELECT rama, motivo, bloquea FROM work_queue_calendario WHERE entity_id = $1`,
      [sub],
    );

    expect(bandeja.rows).toHaveLength(1);
    expect(bandeja.rows[0]!.rama).toBe('PASARELA_FECHA_DIVERGENTE');
    expect(bandeja.rows[0]!.motivo).toMatch(/4 día\(s\) de diferencia/u);
    // No bloquea: cobrar un día distinto no impide operar.
    expect(bandeja.rows[0]!.bloquea).toBe(false);

    // Y con las dos fechas iguales, la rama desaparece. Un aviso que no se va
    // cuando el problema se arregla entrena a la gente a ignorar la bandeja.
    await db.query(
      `UPDATE company_subscriptions SET proxima_facturacion_pasarela = proxima_facturacion
        WHERE id = $1`,
      [sub],
    );
    const despues = await db.query(
      'SELECT 1 FROM work_queue_calendario WHERE entity_id = $1',
      [sub],
    );
    expect(despues.rowCount).toBe(0);
  });

  it('sin fecha informada por la pasarela no se inventa una divergencia', async () => {
    // `NULL` es «el proveedor no lo dijo», no «no hay próximo cobro». Tratarlo
    // como una diferencia llenaría la bandeja de trabajo que no existe.
    await conectadaYAutorizada();
    const sub = await suscripcionId();
    await db.query(
      `UPDATE company_subscriptions
          SET proxima_facturacion = DATE '2026-11-01', proxima_facturacion_pasarela = NULL
        WHERE id = $1`,
      [sub],
    );
    const r = await db.query('SELECT 1 FROM work_queue_calendario WHERE entity_id = $1', [sub]);
    expect(r.rowCount).toBe(0);
  });

  async function mapearPlan(): Promise<void> {
    await db.query(
      `INSERT INTO payment_plan_map
         (plan_id, proveedor, ambiente, periodicidad, moneda, referencia_externa,
          importe_declarado, declarado_por, motivo)
       VALUES ($1, 'mercadopago', 'sandbox', 'MENSUAL', 'ARS', $2, $3::numeric,
               'test:conversion', 'Mapeo de la suite de conversión')
       ON CONFLICT DO NOTHING`,
      [planId, `plan-externo-${planCode}`, PRECIO],
    );
  }
});
