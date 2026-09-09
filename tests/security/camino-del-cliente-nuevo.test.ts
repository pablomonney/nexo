/**
 * S-33 — El camino del cliente nuevo, caminado entero.
 *
 * NEXO se vende con prueba de 14 días y sin intervención manual. Eso convierte
 * al recorrido «me registro → confirmo → entro → creo mi empresa → opero» en
 * parte del producto, no en una comodidad: si se corta en cualquier punto, no
 * hay negocio, por más que cada endpoint del tramo funcione por separado.
 *
 * ## Lo que la auditoría del 2026-09-09 encontró recorriéndolo con el navegador
 *
 * Estaba cortado en **tres** lugares, y ningún test lo veía porque todos los
 * endpoints andaban:
 *
 *   1. El formulario de crear empresa vivía dentro de la pantalla de ingreso.
 *      `POST /onboarding/empresa` **exige sesión**, así que sin entrar daba 401;
 *      y al entrar, `ir()` esconde `v-login` y el formulario dejaba de existir
 *      para el usuario. Estaba en el único lugar donde no podía funcionar.
 *
 *   2. Quien no tenía ninguna empresa aterrizaba en la lista de empresas
 *      —vacía— con los treinta y cuatro botones del menú puestos. Todos daban
 *      403. El Panel llegaba a mostrar **«Sin pendientes» en verde** con tres
 *      403 atrás: la peor lectura posible de un error, porque tranquiliza.
 *
 *   3. El rol que crea el alta exige segundo factor, y la pantalla para
 *      configurarlo también vivía adentro de `v-login`. El alta terminaba
 *      contra un 403 crudo que decía «configuralo en /auth/mfa/setup»: una ruta
 *      de la API, en la pantalla, como instrucción. Es exactamente el defecto
 *      que S-25 encontró el 2026-09-03, arreglado en el ingreso y recreado acá.
 *
 * Las tres son la misma forma: **la pieza está, la regla está escrita, y nadie
 * recorrió el trayecto entre las dos.** Por eso este archivo no comprueba
 * piezas: camina.
 *
 * ## Las dos mitades
 *
 * Un test HTTP no ve si el botón está en una pantalla escondida, y un test del
 * HTML no ve si el endpoint contesta. Los tres cortes vivían justo en esa
 * juntura, así que acá están las dos:
 *
 *   · el tramo por HTTP, extremo a extremo, con una cuenta nueva de verdad;
 *   · el tramo en el HTML, comprobando que cada parada tenga pantalla propia y
 *     no dependa de que otra esté visible.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import { totp, withCheckDigit } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';
import { sufijoUnico } from '../integration/helpers/identificadores.js';

const CONSOLA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'consola.html',
);

const suite = hasDatabase ? describe : describe.skip;

const CLAVE = 'una-contrasena-suficientemente-larga';

/** La cookie de sesión, tal como la manda el servidor. */
function galleta(respuesta: { headers: Record<string, unknown> }): string {
  const bruto = respuesta.headers['set-cookie'];
  const lista = Array.isArray(bruto) ? bruto : [bruto];
  const sesion = lista.find((c): c is string => typeof c === 'string' && c.includes('='));
  if (sesion === undefined) throw new Error('el servidor no mandó cookie de sesión');
  return sesion.split(';')[0]!;
}

suite('S-33 — el camino del cliente nuevo llega hasta el final', () => {
  let app: FastifyInstance;
  let raw: Client;
  let correo: string;
  let cuit: string;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    raw = await connect();
    const stamp = await sufijoUnico(raw);
    correo = `cliente-nuevo-${stamp}@estudio.test`;
    cuit = withCheckDigit(`307${stamp.replace(/\D/g, '').padStart(7, '0').slice(-7)}`);
  });

  afterAll(async () => {
    await app?.close();
    await raw?.end();
    await closePool();
  });

  it('de registrarse a operar, sin que nadie toque la base a mano', async () => {
    // ── 1 · Registro ────────────────────────────────────────────────────
    const alta = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: correo, password: CLAVE, fullName: 'Cliente Nuevo' },
    });
    expect(alta.statusCode, alta.body).toBe(200);

    // ── 2 · Confirmación ────────────────────────────────────────────────
    // El código sale de la bandeja de salida, que es donde queda mientras no
    // haya proveedor de correo. Que el test lo lea de ahí no es una trampa: es
    // la única fuente, y contratar el proveedor no cambia el resto del camino.
    const bandeja = await raw.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM email_outbox
        WHERE destinatario = $1 AND tipo = 'VERIFICACION_DE_ALTA'
        ORDER BY creado_el DESC LIMIT 1`,
      [correo],
    );
    const cuerpo = bandeja.rows[0]?.cuerpo;
    expect(cuerpo, 'el alta no dejó mensaje de verificación en la bandeja').toBeDefined();
    const codigo = /\n\n(\S+)\n/.exec(cuerpo ?? '')?.[1];
    expect(codigo, 'el mensaje no trae un código legible').toBeDefined();

    const verificacion = await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token: codigo },
    });
    expect(verificacion.statusCode, verificacion.body).toBe(200);

    // ── 3 · Ingreso ─────────────────────────────────────────────────────
    const ingreso = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: correo, password: CLAVE },
    });
    expect(ingreso.statusCode, ingreso.body).toBe(200);
    const cookie = galleta(ingreso);

    // ── 4 · Crear la empresa ────────────────────────────────────────────
    // El corte número uno vivía acá: este pedido exige sesión, y el formulario
    // que lo dispara estaba dentro de la pantalla de ingreso.
    const empresa = await app.inject({
      method: 'POST',
      url: '/onboarding/empresa',
      headers: { cookie },
      payload: {
        estudio: 'Estudio del cliente nuevo',
        razonSocial: 'Cliente Nuevo SRL',
        cuit,
        tipoEntidad: 'SRL',
        jurisdiccion: 'AR-C',
        cierreEjercicio: '12-31',
        plan: 'GESTION',
      },
    });
    expect(empresa.statusCode, empresa.body).toBe(201);
    const creada = empresa.json() as { prueba?: { hasta?: string } };
    expect(creada.prueba?.hasta, 'el alta no arrancó la prueba de 14 días').toBeDefined();

    // ── 5 · El segundo factor, si el rol lo exige ───────────────────────
    // El corte número tres. La respuesta a este pedido es la que dejaba al
    // recién llegado contra un 403 sin pantalla a la que ir.
    let cartera = await app.inject({ method: 'GET', url: '/companies', headers: { cookie } });

    if (cartera.statusCode === 403) {
      expect(
        (cartera.json() as { error?: string }).error,
        'un 403 en la cartera recién creada tiene que ser el segundo factor y nada más',
      ).toBe('MFA_SETUP_REQUIRED');

      const setup = await app.inject({
        method: 'POST',
        url: '/auth/mfa/setup',
        headers: { cookie },
      });
      expect(setup.statusCode, setup.body).toBe(200);
      const secreto = (setup.json() as { secret: string }).secret;

      const confirmado = await app.inject({
        method: 'POST',
        url: '/auth/mfa/confirm',
        headers: { cookie },
        payload: { code: totp(secreto, Date.now()) },
      });
      expect(confirmado.statusCode, confirmado.body).toBe(200);

      // Y esta es la parte que la consola decía mal: confirmar el segundo
      // factor **habilita la sesión en curso**. El mensaje mandaba a volver a
      // ingresar, que era pedirle a alguien que rehaga lo que acaba de hacer.
      cartera = await app.inject({ method: 'GET', url: '/companies', headers: { cookie } });
    }

    // ── 6 · Operar ──────────────────────────────────────────────────────
    expect(cartera.statusCode, cartera.body).toBe(200);
    const companies = (cartera.json() as { companies: { id: string }[] }).companies;
    expect(companies.length, 'terminó el alta y la cartera quedó vacía').toBe(1);

    const dentro = await app.inject({
      method: 'GET',
      url: '/companies/current',
      headers: { cookie, 'x-company-id': companies[0]!.id },
    });
    expect(dentro.statusCode, dentro.body).toBe(200);

    // La prueba tiene que estar corriendo: es lo que se vende.
    const prueba = await app.inject({
      method: 'GET',
      url: '/onboarding/prueba',
      headers: { cookie, 'x-company-id': companies[0]!.id },
    });
    expect(prueba.statusCode, prueba.body).toBe(200);
    expect((prueba.json() as { enPrueba: boolean }).enPrueba).toBe(true);
  });

  /**
   * El caso que va a pasar seguido: el CUIT ya está.
   *
   * El contador que registró el estudio y no se acuerda, o el socio que se
   * adelantó. `organizations.tax_id` es único —dos estudios con el mismo CUIT
   * serían dos verdades sobre el mismo contribuyente— y la violación de
   * unicidad salía como **500 «Error interno»**, en la primera pantalla que ve
   * un cliente. Lo encontró la auditoría del 2026-09-09 reusando un CUIT.
   *
   * Esa persona necesita saber que la cuenta existe y a quién preguntarle.
   */
  it('un CUIT ya registrado se contesta como conflicto, no como falla del servidor', async () => {
    const otro = `segundo-en-la-fila-${correo}`;
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: otro, password: CLAVE, fullName: 'Segundo En La Fila' },
    });
    const bandeja = await raw.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM email_outbox
        WHERE destinatario = $1 AND tipo = 'VERIFICACION_DE_ALTA'
        ORDER BY creado_el DESC LIMIT 1`,
      [otro],
    );
    await app.inject({
      method: 'POST',
      url: '/auth/verificar-correo',
      payload: { token: /\n\n(\S+)\n/.exec(bandeja.rows[0]?.cuerpo ?? '')?.[1] },
    });
    const ingreso = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: otro, password: CLAVE },
    });
    const cookie = galleta(ingreso);

    // El mismo CUIT que dio de alta el test de arriba.
    const r = await app.inject({
      method: 'POST',
      url: '/onboarding/empresa',
      headers: { cookie },
      payload: {
        estudio: 'Estudio repetido',
        razonSocial: 'Repetida SRL',
        cuit,
        tipoEntidad: 'SRL',
        jurisdiccion: 'AR-C',
        cierreEjercicio: '12-31',
        plan: 'GESTION',
      },
    });

    expect(r.statusCode, r.body).toBe(409);
    const cuerpo = r.json() as { message: string };
    expect(cuerpo.message).toContain(cuit);
    expect(cuerpo.message).toContain('ya está registrado');
    // Y no dice de quién es: sería un oráculo para averiguar en qué estudio
    // está un CUIT cualquiera.
    expect(cuerpo.message).not.toContain(correo);
  });
});

describe('S-33 — cada parada del camino tiene pantalla propia', () => {
  let html: string;

  beforeAll(async () => {
    html = await readFile(CONSOLA, 'utf8');
  });

  /**
   * Las paradas que **no** pueden vivir dentro de otra pantalla.
   *
   * Las tres estuvieron adentro de `v-login` y las tres se rompieron por eso:
   * `ir()` esconde la sección entera, y con ella el formulario que hacía falta.
   * El motivo va escrito porque el día que alguien quiera moverlas de nuevo,
   * esto es lo que tiene que leer antes.
   */
  const PANTALLAS_PROPIAS: Readonly<Record<string, string>> = {
    'v-alta-empresa':
      'Crear la empresa exige sesión: dentro de v-login estaba en el único lugar donde no podía funcionar',
    'v-mfa':
      'El segundo factor hace falta en dos caminos —ingresar y terminar el alta—, así que no puede vivir dentro de uno',
  };

  for (const [id, motivo] of Object.entries(PANTALLAS_PROPIAS)) {
    it(`${id} es una sección de primer nivel — ${motivo}`, () => {
      expect(html).toContain(`<section id="${id}"`);

      // Y no está anidada adentro de otra sección: si lo estuviera, esconder la
      // de afuera la escondería con ella, que es exactamente lo que pasaba.
      const desde = html.indexOf(`<section id="${id}"`);
      const anterior = html.lastIndexOf('<section id="', desde - 1);
      const cierre = html.lastIndexOf('</section>', desde);
      expect(
        cierre > anterior,
        `${id} está dentro de otra sección: se va a esconder cuando se esconda esa`,
      ).toBe(true);
    });
  }

  it('las pantallas del camino están declaradas en VISTAS', () => {
    // Una sección que no está en VISTAS no la esconde ni la muestra nadie:
    // queda visible sobre las demás o no aparece nunca.
    const lista = /const VISTAS = \[([\s\S]*?)\];/.exec(html)?.[1] ?? '';
    for (const id of Object.keys(PANTALLAS_PROPIAS)) {
      expect(lista, `${id} no figura en VISTAS`).toContain(`'${id.slice(2)}'`);
    }
  });

  it('una consulta que falla no se dibuja como cero', () => {
    // El Panel decía «Sin pendientes» en verde cuando /work-queue contestaba
    // 403: `datos` venía indefinido, el resumen quedaba en {} y el total daba
    // cero. La regla del proyecto sobre `null` —«no se puede afirmar» nunca es
    // cero— tiene que valer también donde se ve.
    const inicio = html.slice(html.indexOf('async function cargarInicio()'));
    const hastaElResumen = inicio.slice(0, inicio.indexOf('inicio-arranque'));
    expect(
      hastaElResumen,
      'cargarInicio pinta el resumen sin mirar si la consulta salió bien',
    ).toMatch(/!wq\.ok/);
  });
});

/**
 * S-33 (segunda mitad) — el menú no ofrece lo que el plan no incluye.
 *
 * La consola tiene escrita la regla desde antes: «un botón que termina en 403 le
 * enseña a la persona que el sistema falla al azar. Si el backend va a decir que
 * no, la consola no pregunta». Estaba aplicada al permiso y no al plan, que es
 * el otro motivo por el que el backend dice que no.
 *
 * Medido el 2026-09-09 sobre los planes cargados:
 *
 *     CONTABLE     23 de 40 dominios fuera del plan
 *     ESTUDIO      22
 *     GESTION      10
 *     EMPRESA_B1    5
 *     COMPLETO      0
 *
 * Es decir: el cliente del plan de entrada veía los treinta y cuatro botones y
 * más de la mitad del producto le contestaba 403 con el JSON en pantalla.
 *
 * Lo que este control cuida es la **deriva**: el mapa `dominioDe` de la consola
 * y los `dominios` de `product_features` son dos listas que tienen que decir lo
 * mismo, y las listas paralelas se separan solas.
 */
suite('S-33 — el menú no ofrece lo que el plan no incluye', () => {
  let html: string;
  let raw: Client;
  let conFuncionalidad: Set<string>;

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    html = await readFile(CONSOLA, 'utf8');
    raw = await connect();
    const { rows } = await raw.query<{ dominios: string[] }>(
      'SELECT dominios FROM product_features',
    );
    conFuncionalidad = new Set(rows.flatMap((r) => r.dominios));
  });

  afterAll(async () => {
    await raw?.end();
    await closePool();
  });

  /** El mapa pantalla → dominio que la consola usa para esconder el botón. */
  const mapaDeLaConsola = (fuente: string): Map<string, string> => {
    const bloque = /const dominioDe = \{([\s\S]*?)\};/.exec(fuente)?.[1] ?? '';
    return new Map(
      [...bloque.matchAll(/([a-z]+):\s*'([a-z0-9-]+)'/g)].map((m) => [m[1]!, m[2]!]),
    );
  };

  it('el mapa de la consola no nombra dominios que no existen', () => {
    const mapa = mapaDeLaConsola(html);
    expect(mapa.size, 'no se pudo leer el mapa dominioDe de la consola').toBeGreaterThan(10);

    const inventados = [...mapa.entries()]
      .filter(([, d]) => !conFuncionalidad.has(d))
      .map(([v, d]) => `${v} → ${d}`);

    expect(
      inventados,
      'estas pantallas dicen pertenecer a un dominio que ninguna funcionalidad cubre. ' +
        'Un dominio así no lo excluye ningún plan, así que el botón nunca se va a esconder ' +
        'y el mapa está mintiendo sobre por qué',
    ).toEqual([]);
  });

  /**
   * Dominios que alguno de los planes **a la venta** deja afuera.
   *
   * No alcanza con «lo cubre una funcionalidad»: media docena de dominios están
   * cubiertos por funcionalidades que todos los planes incluyen, así que hoy
   * ningún cliente los puede ver fallar. El conjunto que importa es el que
   * produce un 403 de verdad, y sale de la base — si mañana un plan nuevo deja
   * afuera el IVA, este control lo va a exigir sin que nadie lo edite.
   */
  const excluiblesPorAlgunPlan = async (): Promise<Set<string>> => {
    const { rows } = await raw.query<{ dominio: string }>(
      `SELECT DISTINCT unnest(f.dominios) AS dominio
         FROM product_features f
         JOIN subscription_plans p ON p.status = 'DISPONIBLE'
        WHERE NOT EXISTS (
          SELECT 1 FROM plan_features pf
           WHERE pf.plan_id = p.id AND pf.feature_code = f.code)`,
    );
    return new Set(rows.map((r) => r.dominio));
  };

  /**
   * Lo que se llega a llamar sin tener botón propio, con el motivo.
   *
   * La regla que sostiene cada línea: el dominio se pide desde una pantalla que
   * el mismo plan ya esconde, así que no hay forma de llegar a la llamada.
   */
  const LLAMADOS_DESDE_OTRA_PANTALLA: Readonly<Record<string, string>> = {
    'decision-records':
      'Se carga dentro de Señales, y los planes que excluyen decision-records excluyen analysis con él',
  };

  it('todo dominio que un plan excluye se puede esconder del menú', async () => {
    // Solo se leen las urls literales: `api('GET', '/stock/...')`. Las armadas
    // por concatenación quedan afuera, y se dice acá en vez de fingir que el
    // barrido es completo — la primera llamada de cada pantalla es literal, y
    // es la que decide si el botón sirve para algo.
    const llamados = new Set(
      [...html.matchAll(/api\(\s*'(?:GET|POST|PATCH|PUT|DELETE)'\s*,\s*'\/([a-z0-9-]+)/g)].map(
        (m) => m[1]!,
      ),
    );
    const excluibles = await excluiblesPorAlgunPlan();
    expect(excluibles.size, 'ningún plan excluye nada: la medición no está mirando').toBeGreaterThan(
      0,
    );

    const cubiertos = new Set(mapaDeLaConsola(html).values());
    const sinPuerta = [...llamados].filter(
      (d) =>
        excluibles.has(d) &&
        !cubiertos.has(d) &&
        LLAMADOS_DESDE_OTRA_PANTALLA[d] === undefined,
    );

    expect(
      sinPuerta.sort(),
      'la consola llama a estos dominios, algún plan a la venta los excluye, y ninguna ' +
        'pantalla los declara en `dominioDe`: el botón se va a ofrecer igual y va a ' +
        'terminar en 403 con el JSON en pantalla',
    ).toEqual([]);
  });

  it('la excepción sigue siendo cierta: lo declarado aparte también lo excluye un plan', async () => {
    // Una excepción que sobrevive a su motivo convierte la lista en decoración.
    const excluibles = await excluiblesPorAlgunPlan();
    const obsoletas = Object.keys(LLAMADOS_DESDE_OTRA_PANTALLA).filter((d) => !excluibles.has(d));
    expect(obsoletas, 'ningún plan excluye ya estos dominios: sacalos de la lista').toEqual([]);
  });
});
