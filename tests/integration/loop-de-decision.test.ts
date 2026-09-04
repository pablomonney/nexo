/**
 * El loop de decisión, de punta a punta y por HTTP.
 *
 * Los barridos anteriores fueron cerrando el defecto de «construido y
 * desconectado» capa por capa: funciones sin consumidor (S-16), tablas sin
 * escritor (S-17), rutas sin permiso (S-18), capacidades sin pantalla (S-25).
 * Éste pregunta otra cosa, y es la que importa para que NEXO sea una plataforma
 * y no un conjunto de módulos:
 *
 *     ¿Una misma operación atraviesa las capas hasta volver al ERP?
 *
 *     ERP          se factura una venta
 *      ↓
 *     DATA         la métrica del mes la refleja
 *      ↓
 *     INTELLIGENCE la pregunta del catálogo la contesta con esa cifra
 *      ↓
 *     DECISION     un escenario proyecta qué pasaría si el precio subiera
 *      ↓
 *     ERP          alguien hace algo, y queda en la bitácora
 *      ↓
 *     PUENTE       se declara que ese acto aplicó ese escenario
 *      ↓
 *     MEDICIÓN     qué se esperaba, qué pasó, cuánto se separaron
 *
 * Cada paso usa la cifra que dejó el anterior. No hay fixtures intermedias: si
 * una capa dejara de leer lo que la de abajo escribe, el paso siguiente se cae.
 *
 * ## Lo que este test NO afirma
 *
 * Que el escenario haya causado el resultado. La respuesta de la medición lo
 * dice con todas las letras, y acá se comprueba que lo diga: un sistema que
 * presenta una correlación como una causa es peor que uno que no mide nada.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const PASSWORD = 'una-contrasena-suficientemente-larga';
const suite = hasDatabase ? describe : describe.skip;

suite('El loop de decisión: ERP → datos → inteligencia → decisión → ERP', () => {
  let app: FastifyInstance;
  let db: Client;
  let token = '';
  let empresa = '';
  let stamp = '';
  let hoy = '';
  let mes = '';

  /** Lo que la venta deja: se usa como referencia en cada capa siguiente. */
  const NETO = '100000.00';

  let escenarioId = '';
  let actoId = '';

  const pedir = async (metodo: 'GET' | 'POST', url: string, cuerpo?: unknown) =>
    app.inject({
      method: metodo,
      url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
      ...(cuerpo === undefined ? {} : { payload: cuerpo }),
    });

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    stamp = await sufijoUnico(db);
    hoy = new Date().toISOString().slice(0, 10);
    mes = hoy.slice(0, 7);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [
          `fundador-loop-${stamp}@estudio.test`,
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
        `Estudio loop ${stamp}`,
        withCheckDigit(`30${stamp}`),
        fundadorId,
      ])
    ).rows[0]!.create_organization;

    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId,
        organizationId,
        `Empresa loop ${stamp}`,
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
        payload: { email: `fundador-loop-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `contadora-loop-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST',
        url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Contadora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;

    for (const role of ['CONTADOR', 'ADMINISTRADOR']) {
      await app.inject({
        method: 'POST',
        url: `/companies/${empresa}/roles`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { userId, role },
      });
    }

    // CONTADOR exige segundo factor.
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

    // Una operación fiscal vive en un período: sin ejercicio abierto no se
    // registra, y todo el loop empieza por una venta.
    const anio = Number(hoy.slice(0, 4));
    const fy = await pedir('POST', '/fiscal-years', {
      code: `EJ${anio}-${stamp}`,
      startDate: `${anio}-01-01`,
      endDate: `${anio}-12-31`,
    });
    expect(fy.statusCode, fy.body).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await app?.close();
    await closePool();
  });

  it('1 · ERP — se factura una venta', async () => {
    const forma =
      `--X\r\nContent-Disposition: form-data; name="file"; filename="loop-${stamp}.xml"\r\n` +
      `Content-Type: application/xml\r\n\r\n<c><n>1</n></c>\r\n--X--\r\n`;
    const subida = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: {
        authorization: `Bearer ${token}`,
        'x-company-id': empresa,
        'content-type': 'multipart/form-data; boundary=X',
      },
      payload: forma,
    });
    expect(subida.statusCode, subida.body).toBe(201);

    const op = await pedir(
      'POST',
      `/documents/${subida.json<{ id: string }>().id}/tax-transaction`,
      {
        direction: 'VENTAS',
        cbteTipo: 1,
        puntoVenta: 1,
        numero: 9101,
        fecha: hoy,
        cuitContraparte: withCheckDigit(`30${stamp}`),
        razonSocial: `Cliente loop ${stamp}`,
        condicionIva: 'RESPONSABLE_INSCRIPTO',
        neto: NETO,
        iva: '21000.00',
        noGravado: '0',
        exento: '0',
        percepciones: '0',
        total: '121000.00',
      },
    );
    expect(op.statusCode, op.body).toBe(201);
  });

  it('2 · DATA — la métrica del mes refleja esa venta, y no otra cosa', async () => {
    const r = await pedir('GET', '/analytics/operaciones?direccion=VENTAS');
    expect(r.statusCode, r.body).toBe(200);

    const meses = r.json<{ meses: { desde: string; neto: string; comprobantes: number }[] }>()
      .meses;
    const delMes = meses.find((m) => m.desde.startsWith(mes));
    expect(delMes, 'el mes de la venta tiene que estar en la métrica').toBeDefined();
    // La empresa es nueva y esta es su única venta: la cifra tiene que ser
    // exactamente la facturada. Si la métrica dijera otra cosa, todo lo que
    // sigue estaría razonando sobre un número inventado.
    expect(delMes!.neto).toBe(NETO);
    expect(delMes!.comprobantes).toBe(1);
  });

  it('3 · INTELLIGENCE — la pregunta del catálogo contesta con esa misma cifra', async () => {
    const r = await pedir('POST', '/intelligence/preguntar', {
      pregunta: '¿cuánto vendí este mes?',
    });
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<{
      entendida: boolean;
      respuesta: { valor: string; origen: string[]; metodologia: string };
    }>();
    expect(v.entendida, 'la pregunta tiene que resolver').toBe(true);
    // El valor sale formateado; lo que importa es que la cifra sea la del ERP.
    expect(v.respuesta.valor).toContain('100.000');
    // Y que diga de dónde la sacó: una respuesta sin origen no se puede rehacer.
    expect(v.respuesta.origen.length).toBeGreaterThan(0);
    expect(v.respuesta.metodologia.length).toBeGreaterThan(20);
  });

  it('4 · DECISION — un escenario proyecta sobre esa base, y no sobre otra', async () => {
    const alta = await pedir('POST', '/analysis/scenarios', {
      nombre: `Suba de precios loop ${stamp}`,
      pregunta: '¿Qué pasa con el neto si subo diez por ciento?',
      meses: 12,
      variacionDePrecio: 10,
    });
    expect(alta.statusCode, alta.body).toBe(201);
    escenarioId = alta.json<{ id: string }>().id;

    const lista = await pedir('GET', '/analysis/scenarios');
    const e = lista
      .json<{
        escenarios: {
          id: string;
          resultadoDeHoy: {
            base: { netoFacturado: string };
            resultado: { netoProyectado: string };
          };
        }[];
      }>()
      .escenarios.find((x) => x.id === escenarioId)!;

    // La base del escenario es la venta del paso 1: la capa de decisión está
    // proyectando sobre lo que el ERP registró, no sobre una fixture propia.
    expect(e.resultadoDeHoy.base.netoFacturado).toBe(NETO);
    // Y proyecta más que la base, porque el precio sube.
    expect(Number(e.resultadoDeHoy.resultado.netoProyectado)).toBeGreaterThan(Number(NETO));
  });

  it('5 · sin declarar la aplicación, la medición se niega a comparar', async () => {
    const r = await pedir('GET', `/analysis/scenarios/${escenarioId}/result`);
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json<{ estado: string; motivo: string }>();
    expect(v.estado).toBe('SIN_APLICAR');
    expect(v.motivo).toContain('cualquier otra cosa');
  });

  it('6 · ERP — se ejecuta un acto, y queda en la bitácora', async () => {
    // El acto es una lista de precios: es lo que ejecuta «subir el precio». Lo
    // firma una persona, como todo lo que toca el ERP.
    const lista = await pedir('POST', '/price-lists', {
      codigo: `SUBA-${stamp}`,
      nombre: `Lista subida ${stamp}`,
      moneda: 'ARS',
      vigenteDesde: hoy,
    });
    expect(lista.statusCode, lista.body).toBe(201);

    const bitacora = await pedir('GET', '/audit?action=CREAR_LISTA_DE_PRECIOS&limite=5');
    expect(bitacora.statusCode, bitacora.body).toBe(200);
    const eventos = bitacora.json<{ eventos: { id: string; accion: string }[] }>().eventos;
    expect(eventos.length, 'el acto tiene que haber dejado su fila').toBeGreaterThan(0);
    actoId = eventos[0]!.id;
  });

  it('7 · PUENTE — se declara que ese acto aplicó ese escenario, citándolo', async () => {
    const r = await pedir('POST', `/analysis/scenarios/${escenarioId}/applied`, {
      auditLogId: actoId,
      aplicadoDesde: hoy,
      motivo: 'La lista nueva sube los precios de la línea que el escenario proyectaba.',
    });
    expect(r.statusCode, r.body).toBe(201);

    const v = r.json<{
      actoCitado: { id: string; accion: string };
      esperado: { base: string; neto: string };
      alcance: string;
    }>();
    expect(v.actoCitado.id).toBe(actoId);
    expect(v.actoCitado.accion).toBe('CREAR_LISTA_DE_PRECIOS');
    // La predicción congelada es la que el escenario proyectaba en el paso 4.
    expect(v.esperado.base).toBe(NETO);
    expect(Number(v.esperado.neto)).toBeGreaterThan(Number(NETO));
    expect(v.alcance).toContain('no afirma');
  });

  it('8 · el acto citado tiene que existir en la bitácora de esta empresa', async () => {
    // Sin esto la cita sería una descripción, y una descripción se escribe
    // después para que encaje con el resultado.
    const inventado = '00000000-0000-7000-8000-000000000000';
    const r = await pedir('POST', `/analysis/scenarios/${escenarioId}/applied`, {
      auditLogId: inventado,
      aplicadoDesde: hoy,
      motivo: 'Un acto que no existe no puede haber aplicado nada.',
    });
    expect(r.statusCode).toBe(404);
    expect(r.json<{ message: string }>().message).toContain('bitácora');
  });

  it('9 · MEDICIÓN — qué se esperaba, qué pasó, y cuánto se separaron', async () => {
    const r = await pedir('GET', `/analysis/scenarios/${escenarioId}/result`);
    expect(r.statusCode, r.body).toBe(200);

    const v = r.json<{
      estado: string;
      esperado: { neto: string; porMes: string; ventanaEnMeses: number };
      real: { neto: string; mesesTranscurridos: number; porMes: string };
      diferencia: { porMes: string; desvioPct: string | null };
      aplicacion: { actoCitado: { accion: string } };
      alcance: string;
      metodologia: string;
    }>();

    expect(v.estado).toBe('MEDIDO');
    // Lo real es la venta del paso 1: el único mes transcurrido es este.
    expect(v.real.neto).toBe(NETO);
    expect(v.real.mesesTranscurridos).toBe(1);
    // Se esperaba más por mes de lo que hubo: el escenario proyectaba una suba
    // sobre doce meses y solo pasó uno con la facturación de siempre.
    // Se esperaba 110.000 por mes --la base de un mes, con el precio 10% arriba--
    // y hubo 100.000: la decision no alcanzo el pronostico.
    expect(v.esperado.porMes).toBe('110000.00');
    expect(v.real.porMes).toBe('100000.00');
    expect(Number(v.diferencia.porMes)).toBeLessThan(0);
    expect(v.aplicacion.actoCitado.accion).toBe('CREAR_LISTA_DE_PRECIOS');

    // Y la afirmación que el sistema NO hace.
    expect(v.alcance).toContain('no dice que la diferencia');
    expect(v.metodologia).toContain('ritmos mensuales');
  });

  it('10 · un escenario se aplica una vez: dos predicciones no compiten', async () => {
    const r = await pedir('POST', `/analysis/scenarios/${escenarioId}/applied`, {
      auditLogId: actoId,
      aplicadoDesde: hoy,
      motivo: 'Un segundo intento sobre el mismo escenario tiene que rebotar.',
    });
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
  });

  it('11 · la declaración no se edita ni se borra', async () => {
    // Una predicción que se puede retocar después no mide nada.
    for (const sql of [
      `UPDATE scenario_applications SET esperado_neto = 1 WHERE company_id = $1`,
      `DELETE FROM scenario_applications WHERE company_id = $1`,
    ]) {
      let fallo = '';
      try {
        await db.query(`SELECT set_config('app.company_id', $1, true)`, [empresa]);
        await db.query(sql, [empresa]);
      } catch (error) {
        fallo = (error as Error).message;
      }
      expect(fallo, `esto tendría que haber fallado: ${sql}`).not.toBe('');
    }
  });
});
