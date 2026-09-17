/**
 * La prueba de catorce días y la puerta comercial de los planes.
 *
 * Lo que este archivo defiende, en orden de importancia:
 *
 *   1. **Que la prueba termine.** Una prueba que no vence es el producto
 *      gratis, y el sistema no tendría forma de notar la diferencia.
 *   2. **Que vencer no sea cancelar.** Cancelar es una decisión del cliente y
 *      de ahí no se vuelve; a quien se le acabó el tiempo no decidió nada.
 *   3. **Que el cliente no pueda estirarla.** Las fechas las pone el servidor.
 *   4. **Que la puerta de planes falle ABIERTA.** Es una puerta comercial: el
 *      error caro es dejar afuera a alguien que paga.
 *   5. **Que el aislamiento no dependa de ella.** Sin plan contratado se sigue
 *      sin ver los datos de otra empresa, porque eso lo hacen el RLS y los
 *      permisos.
 *
 * El punto 4 es el que más incomoda y el que hay que sostener: una puerta
 * comercial demasiado cerrada produce un cliente furioso el primer día del mes;
 * demasiado abierta produce un mes de un módulo regalado, que se arregla
 * facturándolo.
 */

import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import {
  convertirPrueba,
  iniciarPrueba,
  pruebaDe,
  vencerPruebas,
  DIAS_DE_PRUEBA,
} from '@aai/api/billing/prueba';
import { alcanzaElPlan, olvidarPlanDe, olvidarTodosLosPlanes } from '@aai/api/planes/alcance';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';
import { sufijoUnico } from './helpers/identificadores.js';

const suite = hasDatabase ? describe : describe.skip;
const PASSWORD = 'una-contrasena-suficientemente-larga';

const txDe = (db: Client) => ({
  query: (text: string, values?: readonly unknown[]) => db.query(text, values as unknown[]),
});

suite('Prueba de 14 días', () => {
  let db: Client;
  let fx: Fixture;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'prueba');
  });

  afterAll(async () => {
    await db.end();
  });

  async function empresaNueva(etiqueta: string): Promise<string> {
    const sufijo = await sufijoUnico(db);
    const r = await db.query<{ id: string }>(
      `INSERT INTO companies (organization_id, legal_name, cuit, entity_type,
                              jurisdiction, regulator, fiscal_year_end)
       VALUES ($1, $2, $3, 'SRL', 'AR-C', 'IGJ', '12-31') RETURNING id`,
      [fx.organizationId, `Prueba ${etiqueta} ${sufijo}`, `30${sufijo}8`],
    );
    return r.rows[0]!.id;
  }

  /**
   * Un día contado desde el «hoy» de la base, no desde el de UTC.
   *
   * Esto restaba días sobre `getUTCDate()`, y `dias_restantes` los cuenta
   * contra `CURRENT_DATE`, que en esta instalación es hora argentina. Después
   * de las nueve de la noche las dos fechas dejan de coincidir y la prueba
   * fallaba por un día — medido el 2026-09-09 a las 22:07. Un control que
   * depende de la hora a la que se corre no está midiendo lo que dice medir.
   */
  const hoyMenos = async (dias: number): Promise<string> => {
    const { rows } = await db.query<{ d: string }>(
      `SELECT (CURRENT_DATE - $1::int)::text AS d`,
      [dias],
    );
    return rows[0]!.d;
  };

  it('la prueba recién creada dura catorce días contando el primero', async () => {
    // Sumar catorce daría quince días: el error clásico de contar un intervalo
    // cerrado como si fuera abierto.
    const empresa = await empresaNueva('nueva');
    const r = await iniciarPrueba(txDe(db), {
      companyId: empresa,
      planCode: 'GESTION',
      desde: (await hoyMenos(0)) as never,
      actorId: 'test:alta',
    });
    expect(r.estado).toBe('INICIADA');
    if (r.estado !== 'INICIADA') return;

    const dias =
      (Date.parse(r.prueba.hasta) - Date.parse(r.prueba.desde)) / 86_400_000 + 1;
    expect(dias).toBe(DIAS_DE_PRUEBA);
  });

  it('una prueba sin fecha de fin es imposible', async () => {
    // El CHECK de la 0106. Sin él la regla viviría en el código que da de alta,
    // y el primer alta por otro camino dejaría una prueba eterna.
    const empresa = await empresaNueva('sin-fin');
    const plan = await db.query<{ id: string }>(
      "SELECT id FROM subscription_plans WHERE code = 'GESTION'",
    );
    let code = '';
    try {
      await db.query(
        `INSERT INTO company_subscriptions
           (company_id, plan_id, estado, vigencia_desde, created_by)
         VALUES ($1, $2, 'PRUEBA', CURRENT_DATE, 'test')`,
        [empresa, plan.rows[0]!.id],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('23514');
  });

  it('una empresa no puede tener dos pruebas', async () => {
    // Cancelar y volver a empezar sería producto gratis indefinido, y el UNIQUE
    // de la 0073 no lo alcanza: una cancelada ya no está vigente.
    const empresa = await empresaNueva('repetida');
    const primera = await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', desde: (await hoyMenos(0)) as never, actorId: 'test:alta',
    });
    expect(primera.estado).toBe('INICIADA');

    const segunda = await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', desde: (await hoyMenos(0)) as never, actorId: 'test:alta',
    });
    expect(segunda.estado).toBe('YA_TUVO_PRUEBA');
  });

  it('una prueba en curso informa cuántos días quedan', async () => {
    const empresa = await empresaNueva('en-curso');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', desde: (await hoyMenos(2)) as never, actorId: 'test:alta',
    });
    const p = await pruebaDe(txDe(db), empresa);
    expect(p?.situacion).toBe('EN_CURSO');
    expect(p?.diasRestantes).toBe(DIAS_DE_PRUEBA - 1 - 2);
  });

  it('a tres días o menos la prueba está POR_VENCER', async () => {
    const empresa = await empresaNueva('por-vencer');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION',
      desde: (await hoyMenos(DIAS_DE_PRUEBA - 3)) as never, actorId: 'test:alta',
    });
    const p = await pruebaDe(txDe(db), empresa);
    expect(p?.situacion).toBe('POR_VENCER');
  });

  it('pasada la fecha la prueba figura VENCIDA aunque el ciclo no haya corrido', async () => {
    // La vista dice el hecho; el ciclo hace el acto. Si el acceso dependiera de
    // cuándo alguien mira, dos clientes con la misma fecha tendrían suertes
    // distintas según quién abrió la pantalla.
    const empresa = await empresaNueva('vencida');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION',
      desde: (await hoyMenos(DIAS_DE_PRUEBA + 5)) as never, actorId: 'test:alta',
    });
    const p = await pruebaDe(txDe(db), empresa);
    expect(p?.situacion).toBe('VENCIDA');
    expect(p!.diasRestantes).toBeLessThan(0);

    const s = await db.query<{ estado: string }>(
      'SELECT estado FROM company_subscriptions WHERE company_id = $1',
      [empresa],
    );
    expect(s.rows[0]!.estado).toBe('PRUEBA');
  });

  it('el ciclo la vence, y la deja SUSPENDIDA y no CANCELADA', async () => {
    const empresa = await empresaNueva('a-vencer');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION',
      desde: (await hoyMenos(DIAS_DE_PRUEBA + 2)) as never, actorId: 'test:alta',
    });

    const informe = await vencerPruebas(txDe(db), (await hoyMenos(0)) as never, 'test:ciclo', { soloOrganizacion: fx.organizationId });
    expect(informe.vencidas.some((v) => v.companyId === empresa)).toBe(true);

    const s = await db.query<{ estado: string; motivo: string }>(
      'SELECT estado, motivo FROM company_subscriptions WHERE company_id = $1',
      [empresa],
    );
    // Cancelar es una decisión del cliente y de ahí no se vuelve. A quien se le
    // acabó el tiempo no decidió nada.
    expect(s.rows[0]!.estado).toBe('SUSPENDIDA');
    expect(s.rows[0]!.motivo).toMatch(/sin contratación/u);
  });

  it('vencer queda en la bitácora con motivo', async () => {
    const log = await db.query<{ motivo: string }>(
      `SELECT motivo FROM audit_logs WHERE action = 'VENCER_PRUEBA'
        ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(log.rows[0]!.motivo).toMatch(/no se contrató/u);
  });

  it('correr el vencimiento dos veces es inocuo', async () => {
    const antes = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'VENCER_PRUEBA'`,
    );
    await vencerPruebas(txDe(db), (await hoyMenos(0)) as never, 'test:ciclo', { soloOrganizacion: fx.organizationId });
    const despues = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'VENCER_PRUEBA'`,
    );
    expect(despues.rows[0]!.n).toBe(antes.rows[0]!.n);
  });

  it('convertir deja la suscripción activa y sin fecha de fin', async () => {
    // La prueba terminaba; la suscripción no. Dejar la fecha vieja la vencería
    // de nuevo al día siguiente.
    const empresa = await empresaNueva('convertida');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'CONTABLE', desde: (await hoyMenos(3)) as never, actorId: 'test:alta',
    });

    const r = await convertirPrueba(txDe(db), {
      companyId: empresa,
      planCode: 'GESTION',
      periodicidad: 'MENSUAL',
      moneda: 'ARS',
      importe: '59900.00',
      desde: (await hoyMenos(0)) as never,
      actorId: 'test:comercial',
    });
    expect(r.estado).toBe('CONVERTIDA');

    const s = await db.query<{
      estado: string;
      vigencia_hasta: string | null;
      importe_acordado: string;
      code: string;
    }>(
      `SELECT s.estado, s.vigencia_hasta::text, s.importe_acordado::text, p.code
         FROM company_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.company_id = $1`,
      [empresa],
    );
    expect(s.rows[0]).toMatchObject({
      estado: 'ACTIVA',
      vigencia_hasta: null,
      importe_acordado: '59900.00',
      code: 'GESTION',
    });
  });

  it('una prueba ya vencida todavía se puede convertir: es el cliente que se decidió tarde', async () => {
    const empresa = await empresaNueva('tardia');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION',
      desde: (await hoyMenos(DIAS_DE_PRUEBA + 4)) as never, actorId: 'test:alta',
    });
    await vencerPruebas(txDe(db), (await hoyMenos(0)) as never, 'test:ciclo', { soloOrganizacion: fx.organizationId });

    const r = await convertirPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', periodicidad: 'MENSUAL', moneda: 'ARS',
      importe: '59900.00', desde: (await hoyMenos(0)) as never, actorId: 'test:comercial',
    });
    expect(r.estado).toBe('CONVERTIDA');
  });

  it('una suscripción cancelada no se convierte', async () => {
    const empresa = await empresaNueva('cancelada');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', desde: (await hoyMenos(1)) as never, actorId: 'test:alta',
    });
    await db.query(
      `UPDATE company_subscriptions SET estado = 'CANCELADA', motivo = 'baja del cliente'
        WHERE company_id = $1`,
      [empresa],
    );

    const r = await convertirPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', periodicidad: 'MENSUAL', moneda: 'ARS',
      importe: '1.00', desde: (await hoyMenos(0)) as never, actorId: 'test:comercial',
    });
    expect(r.estado).toBe('NO_HAY_PRUEBA');
  });

  it('convertir a un plan que no existe se rechaza', async () => {
    const empresa = await empresaNueva('plan-raro');
    await iniciarPrueba(txDe(db), {
      companyId: empresa, planCode: 'GESTION', desde: (await hoyMenos(1)) as never, actorId: 'test:alta',
    });
    const r = await convertirPrueba(txDe(db), {
      companyId: empresa, planCode: 'NO_EXISTE', periodicidad: 'MENSUAL', moneda: 'ARS',
      importe: '1.00', desde: (await hoyMenos(0)) as never, actorId: 'test:comercial',
    });
    expect(r.estado).toBe('NO_SE_PUEDE');
  });
});

suite('La puerta comercial de los planes', () => {
  let app: FastifyInstance;
  let db: Client;
  let fx: Fixture;
  let empresa: string;
  let token: string;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    db = await connect();
    fx = await seed(db, 'puerta');
    const stamp = await sufijoUnico(db);

    const { hash: argonHash } = await import('@node-rs/argon2');
    const clave = await argonHash(PASSWORD, {
      algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1,
    });
    const fundadorId = (
      await db.query<{ id: string }>(
        'INSERT INTO users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
        [`fundador-pue-${stamp}@estudio.test`, 'Fundador', clave],
      )
    ).rows[0]!.id;
    const organizationId = (
      await db.query<{ create_organization: string }>('SELECT create_organization($1,$2,$3)', [
        `Estudio pue ${stamp}`, withCheckDigit(`30${stamp}`), fundadorId,
      ])
    ).rows[0]!.create_organization;
    empresa = (
      await db.query<{ create_company: string }>('SELECT create_company($1,$2,$3,$4,$5,$6,$7,$8)', [
        fundadorId, organizationId, `Empresa pue ${stamp}`, withCheckDigit(`27${stamp}`),
        'SA', 'AR-C', 'IGJ', '12-31',
      ])
    ).rows[0]!.create_company;

    const tokenFundador = (
      await app.inject({
        method: 'POST', url: '/auth/login',
        payload: { email: `fundador-pue-${stamp}@estudio.test`, password: PASSWORD },
      })
    ).json<{ token: string }>().token;

    const email = `admin-pue-${stamp}@estudio.test`;
    const userId = (
      await app.inject({
        method: 'POST', url: `/organizations/${organizationId}/users`,
        headers: { authorization: `Bearer ${tokenFundador}` },
        payload: { email, fullName: 'Administradora', password: PASSWORD, level: 'MEMBER' },
      })
    ).json<{ id: string }>().id;
    await app.inject({
      method: 'POST', url: `/companies/${empresa}/roles`,
      headers: { authorization: `Bearer ${tokenFundador}` },
      payload: { userId, role: 'ADMINISTRADOR' },
    });

    const inicial = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
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
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } })
    ).json<{ token: string }>().token;
    await app.inject({
      method: 'POST', url: '/auth/mfa/verify',
      payload: { code: totp(secret, Date.now()) },
      headers: { authorization: `Bearer ${token}` },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.end();
    await closePool();
  });

  const pedir = (url: string) =>
    app.inject({
      method: 'GET', url,
      headers: { authorization: `Bearer ${token}`, 'x-company-id': empresa },
    });

  const suscribir = async (planCode: string): Promise<void> => {
    await db.query('DELETE FROM company_subscriptions WHERE company_id = $1', [empresa]).catch(
      () => undefined,
    );
    const plan = await db.query<{ id: string }>(
      'SELECT id FROM subscription_plans WHERE code = $1',
      [planCode],
    );
    await db.query(
      `INSERT INTO company_subscriptions
         (company_id, plan_id, estado, vigencia_desde, created_by,
          periodicidad, moneda, importe_acordado, proxima_facturacion)
       VALUES ($1, $2, 'ACTIVA', CURRENT_DATE, 'test', 'MENSUAL', 'ARS', 1.00, CURRENT_DATE)`,
      [empresa, plan.rows[0]!.id],
    );
    olvidarTodosLosPlanes();
  };

  it('sin suscripción se deja pasar todo: la puerta falla ABIERTA', async () => {
    // Es una puerta comercial, no de seguridad. El error caro es dejar afuera a
    // alguien que paga.
    olvidarTodosLosPlanes();
    const r = await pedir('/analysis/signals');
    expect(r.statusCode, r.body).not.toBe(403);
  });

  it('un dominio que ninguna funcionalidad cubre se deja pasar', async () => {
    await suscribir('CONTABLE');
    // `/companies/current` no está en el catálogo de dominios: ningún plan lo
    // puede excluir, y tiene que seguir andando con el plan más chico.
    const r = await pedir('/companies/current');
    expect(r.statusCode, r.body).toBe(200);
  });

  it('el plan Contable no llega a un módulo que no incluye', async () => {
    await suscribir('CONTABLE');
    const r = await pedir('/analysis/signals');
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json<{ error: string }>().error).toBe('FUERA_DEL_PLAN');
    // El mensaje no le dice que perdió sus datos: le dice que le falta el plan.
    expect(r.body).toContain('siguen estando');
  });

  it('el plan Completo llega al mismo módulo', async () => {
    // El control positivo: sin él, el test anterior daría verde también si la
    // ruta estuviera rota por cualquier otro motivo.
    await suscribir('COMPLETO');
    const r = await pedir('/analysis/signals');
    expect(r.statusCode, r.body).toBe(200);
  });

  it('todos los planes llegan a la contabilidad', async () => {
    // Es una funcionalidad esencial: un plan que no la incluyera se podría
    // contratar y no se podría usar.
    for (const plan of ['CONTABLE', 'GESTION', 'ESTUDIO', 'EMPRESA_B1', 'COMPLETO']) {
      await suscribir(plan);
      const r = await pedir('/accounts');
      expect(r.statusCode, `${plan}: ${r.body}`).not.toBe(403);
    }
  });

  it('la puerta no reemplaza al aislamiento: sin plan, tampoco se ven datos ajenos', async () => {
    // Lo importante de todo el archivo. El plan decide qué módulos, el RLS
    // decide de quién son los datos, y son independientes.
    await suscribir('COMPLETO');
    const r = await app.inject({
      method: 'GET', url: '/accounts',
      headers: { authorization: `Bearer ${token}`, 'x-company-id': fx.companyA },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json<{ message: string }>().message).toMatch(/No tenés acceso a esta empresa/u);
  });

  it('el catálogo de planes se ve sin sesión: es la página de precios', async () => {
    const r = await app.inject({ method: 'GET', url: '/planes' });
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = r.json<{
      planes: { code: string; precio: { importe: string; incluyeImpuestos: boolean } | null }[];
      prueba: { dias: number; pideTarjeta: boolean };
      alcance: string;
    }>();

    expect(cuerpo.prueba).toMatchObject({ dias: 14, pideTarjeta: false });
    const contable = cuerpo.planes.find((p) => p.code === 'CONTABLE');
    expect(contable?.precio?.importe).toBe('29900.00');
    // Neto: la lista comercial dice «+ IVA». Guardar el final y llamarlo neto
    // sería equivocarse por un 21 % en cada cargo.
    expect(contable?.precio?.incluyeImpuestos).toBe(false);
    expect(cuerpo.alcance).toContain('NETOS');
  });

  it('alcanzaElPlan resuelve el dominio del primer segmento de la ruta', async () => {
    await suscribir('CONTABLE');
    const v = await db.query('SELECT 1');
    void v;
    const veredicto = await alcanzaElPlan(txDe(db), empresa, '/analysis/signals?soloDesvios=si');
    expect(veredicto).toMatchObject({ permitido: false, feature: 'analisis' });
  });

  /**
   * Suspender corta el acceso — y hasta la auditoría B-2 no lo cortaba.
   *
   * `NEXO_BILLING.md` §9 dice, con estas palabras, «suspender corta el acceso y
   * **conserva todo**». El código hacía lo contrario, y por una razón que no se
   * ve leyendo: `funcionalidadesDe` filtraba por `estado IN ('ACTIVA','PRUEBA')`,
   * así que una suscripción SUSPENDIDA no devolvía filas, y **cero filas se
   * interpretaba como «esta empresa no tiene plan»** —el caso que la puerta
   * deja pasar a propósito—.
   *
   * El resultado era el peor de los posibles: al vencer la prueba de catorce
   * días, la empresa pasaba de ver **solo los módulos de su plan** a verlos
   * **todos**. Dejar de pagar ampliaba el producto.
   *
   * Ninguna prueba lo veía porque cada mitad estaba bien: la prueba vence y
   * queda SUSPENDIDA —eso se comprueba más arriba en este archivo—, y la puerta
   * falla abierta sin suscripción —eso se comprueba en esta misma suite—. El
   * defecto vivía en la junta: **nadie preguntó qué pasaba después de vencer.**
   *
   * La distinción que hay que sostener, y que estas pruebas fijan:
   *
   *     sin suscripción           pasa  ← deliberado, es una puerta comercial
   *     plan sin funcionalidades  pasa  ← deliberado
   *     SUSPENDIDA / CANCELADA    NO    ← esto es lo que faltaba
   */
  const suspender = async (planCode: string, estado: string): Promise<void> => {
    await suscribir(planCode);
    await db.query(
      `UPDATE company_subscriptions
          SET estado = $2, suspendida_el = CURRENT_DATE,
              motivo = 'La prueba terminó sin contratación'
        WHERE company_id = $1`,
      [empresa, estado],
    );
    olvidarTodosLosPlanes();
  };

  it('una suscripción suspendida no llega a un módulo de su propio plan', async () => {
    // Con COMPLETO activa, `/analysis/signals` da 200 —está comprobado arriba—.
    // Suspenderla no puede ampliar lo que se ve.
    await suspender('COMPLETO', 'SUSPENDIDA');
    const r = await pedir('/analysis/signals');
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json<{ error: string }>().error).toBe('SUSCRIPCION_SUSPENDIDA');
  });

  it('vencer la prueba no puede AMPLIAR lo que la empresa ve', async () => {
    // La forma exacta del defecto, medida de los dos lados con el mismo plan.
    // Sin esta prueba, arreglar el 403 de arriba con una excepción por dominio
    // dejaría el agujero abierto en cualquier otro.
    await suscribir('CONTABLE');
    const conPlan = await pedir('/analysis/signals');
    expect(conPlan.statusCode, 'CONTABLE no incluye análisis').toBe(403);

    await suspender('CONTABLE', 'SUSPENDIDA');
    const suspendida = await pedir('/analysis/signals');
    expect(suspendida.statusCode, 'suspendida ve MÁS que contratada').toBe(403);

    // Y tampoco conserva lo que sí incluía.
    const propio = await pedir('/accounts');
    expect(propio.statusCode, propio.body).toBe(403);
  });

  it('una suscripción cancelada tampoco entra', async () => {
    await suspender('COMPLETO', 'CANCELADA');
    const r = await pedir('/accounts');
    expect(r.statusCode, r.body).toBe(403);
  });

  it('suspendida sigue llegando a lo que necesita para regularizar', async () => {
    // «Conserva todo» incluye poder ver qué se debe y volver a contratar. Una
    // puerta que encierra al cliente afuera de la caja no cobra: enoja.
    await suspender('COMPLETO', 'SUSPENDIDA');
    for (const url of ['/suscripciones', '/companies/current']) {
      const r = await pedir(url);
      expect(r.statusCode, `${url}: ${r.body}`).not.toBe(403);
    }
  });

  it('el mensaje dice que los datos están, y no que se perdieron', async () => {
    await suspender('COMPLETO', 'SUSPENDIDA');
    const r = await pedir('/accounts');
    // Es la primera pantalla que ve alguien que dejó de pagar. Decirle «no
    // tenés acceso» a secas se lee como «perdí mi contabilidad».
    expect(r.body).toContain('siguen estando');
    expect(r.body).toMatch(/suspend/iu);
  });

  it('levantar la suspensión devuelve el acceso, sin esperar a que venza el cache', async () => {
    // El control positivo. Sin él, un `permitido: false` constante pasaría
    // todas las pruebas de arriba y dejaría a todo el mundo afuera.
    await suspender('COMPLETO', 'SUSPENDIDA');
    expect((await pedir('/accounts')).statusCode).toBe(403);

    await db.query(
      `UPDATE company_subscriptions SET estado = 'ACTIVA', suspendida_el = NULL, motivo = NULL
        WHERE company_id = $1`,
      [empresa],
    );
    olvidarPlanDe(empresa);

    const r = await pedir('/accounts');
    expect(r.statusCode, r.body).toBe(200);
  });

  it('sin ninguna suscripción se sigue pasando: el arreglo no cerró la puerta', async () => {
    // La regla que NO se toca. Una empresa sin fila de suscripción no es una
    // empresa que dejó de pagar: es una que nunca contrató, y la puerta
    // comercial la deja pasar a propósito.
    await db.query('DELETE FROM company_subscriptions WHERE company_id = $1', [empresa]);
    olvidarTodosLosPlanes();
    const r = await pedir('/accounts');
    expect(r.statusCode, r.body).toBe(200);
  });

  // ── Los topes, después de la 0122 ─────────────────────────────────────────

  /** Declara un tope para el plan de esta empresa, y lo limpia el que sigue. */
  const declararTope = async (
    planCode: string,
    recurso: string,
    tope: number | null,
    ilimitado = false,
  ): Promise<void> => {
    const plan = await db.query<{ id: string }>(
      'SELECT id FROM subscription_plans WHERE code = $1',
      [planCode],
    );
    await db.query(
      `INSERT INTO plan_limits (plan_id, recurso, tope, ilimitado, declarado_por)
       VALUES ($1, $2, $3, $4, 'test:topes')
       ON CONFLICT (plan_id, recurso) DO UPDATE
         SET tope = EXCLUDED.tope, ilimitado = EXCLUDED.ilimitado`,
      [plan.rows[0]!.id, recurso, tope, ilimitado],
    );
  };

  const recursosDe = async (): Promise<
    readonly { recurso: string; uso: number | null; tope: number | null; estado: string }[]
  > => {
    const r = await pedir('/subscription');
    return r.json<{
      recursos: { recurso: string; uso: number | null; tope: number | null; estado: string }[];
    }>().recursos;
  };

  it('EMPRESAS se mide: era un tope que se podía declarar y nadie evaluaba', async () => {
    // El defecto que la 0122 vino a cerrar. Hasta entonces el número estaba en
    // la tabla y ninguna vista lo miraba, así que un plan «de una empresa»
    // admitía las que fueran. Es la diferencia comercial entre cuatro de los
    // cinco planes.
    await suscribir('CONTABLE');
    await declararTope('CONTABLE', 'EMPRESAS', 1);

    const empresas = (await recursosDe()).find((x) => x.recurso === 'EMPRESAS');

    expect(empresas, 'EMPRESAS no aparece en los recursos medidos').toBeDefined();
    expect(empresas!.tope).toBe(1);
    // El fixture de esta suite crea más de una empresa en el mismo estudio, así
    // que el uso real es mayor que uno y el tope tiene que verse excedido. Lo
    // que se afirma no es el número: es que **hay número** y que se compara.
    expect(empresas!.uso).not.toBeNull();
    expect(empresas!.uso!).toBeGreaterThan(0);
    expect(empresas!.estado).toBe(empresas!.uso! > 1 ? 'EXCEDIDO' : 'DENTRO_DEL_TOPE');
  });

  it('un tope excedido se detecta y uno holgado no', async () => {
    await suscribir('CONTABLE');
    await declararTope('CONTABLE', 'USUARIOS', 1);
    const apretado = (await recursosDe()).find((x) => x.recurso === 'USUARIOS');
    expect(apretado!.estado).toBe(apretado!.uso! > 1 ? 'EXCEDIDO' : 'DENTRO_DEL_TOPE');

    await declararTope('CONTABLE', 'USUARIOS', 9999);
    const holgado = (await recursosDe()).find((x) => x.recurso === 'USUARIOS');
    expect(holgado!.estado).toBe('DENTRO_DEL_TOPE');
  });

  it('ilimitado declarado NO es lo mismo que sin declarar', async () => {
    // Los dos se ven como «no hay número» y significan cosas opuestas: uno es
    // una decisión escrita y el otro es un silencio. Confundirlos hace que un
    // plan que se vende ilimitado aparezca como un hueco.
    await suscribir('CONTABLE');

    await db.query(
      `DELETE FROM plan_limits WHERE recurso = 'INTEGRACIONES' AND plan_id =
         (SELECT id FROM subscription_plans WHERE code = 'CONTABLE')`,
    );
    const sinDeclarar = (await recursosDe()).find((x) => x.recurso === 'INTEGRACIONES');
    expect(sinDeclarar!.estado).toBe('SIN_TOPE_DECLARADO');

    await declararTope('CONTABLE', 'INTEGRACIONES', null, true);
    const ilimitado = (await recursosDe()).find((x) => x.recurso === 'INTEGRACIONES');
    expect(ilimitado!.estado).toBe('SIN_TOPE');
    expect(ilimitado!.tope).toBeNull();
  });

  it('un ilimitado no se puede exceder ni cuenta como sin declarar', async () => {
    await suscribir('CONTABLE');
    await declararTope('CONTABLE', 'USUARIOS', null, true);

    const fila = await db.query<{ excedidos: number; sin_declarar: number }>(
      `SELECT topes_excedidos AS excedidos, topes_sin_declarar AS sin_declarar
         FROM subscription_status WHERE company_id = $1`,
      [empresa],
    );
    const estado = (await recursosDe()).find((x) => x.recurso === 'USUARIOS');

    expect(estado!.estado).toBe('SIN_TOPE');
    // Aunque el uso sea alto, un ilimitado nunca entra en el contador de
    // excedidos; y como está declarado, tampoco en el de sin declarar.
    expect(Number(fila.rows[0]!.excedidos)).toBe(0);
    expect(Number(fila.rows[0]!.sin_declarar)).toBeLessThan(5);
  });

  it('la base impide una fila que no diga ni número ni ilimitado', async () => {
    // Sería indistinguible de no haberla escrito, salvo porque ocupa lugar.
    const plan = await db.query<{ id: string }>(
      "SELECT id FROM subscription_plans WHERE code = 'CONTABLE'",
    );
    let code = '';
    try {
      await db.query(
        `INSERT INTO plan_limits (plan_id, recurso, tope, ilimitado, declarado_por)
         VALUES ($1, 'DOCUMENTOS_MES', NULL, false, 'test:topes')
         ON CONFLICT (plan_id, recurso) DO UPDATE SET tope = NULL, ilimitado = false`,
        [plan.rows[0]!.id],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('23514'); // check_violation
  });
});
