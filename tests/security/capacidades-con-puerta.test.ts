/**
 * S-25 — una capacidad sin puerta de entrada no es una capacidad.
 *
 * S-12 ya hace la mitad de esta pregunta: **por dominio**. Que exista alguna
 * pantalla que llame a `/analytics/…` no dice nada de si se puede ver el flujo
 * bancario, y esa distinción no es teórica — la primera corrida de este barrido
 * encontró **47 rutas de 293** escritas, probadas, con permiso y con migración,
 * y sin una sola línea de la consola que las nombrara.
 *
 * S-12 explica por qué se quedó en el dominio: comparar ruta por ruta con el
 * lector de llamadas daba falsos rojos, porque la consola arma URL en tiempo de
 * ejecución —`const url = accion === 'emit' ? … : …`— y ahí no hay literal que
 * leer. Ese sigue siendo el motivo correcto para no hacerlo **así**.
 *
 * Este barrido lo hace al revés y por eso puede: no reconstruye lo que la
 * consola arma, sino que toma cada ruta registrada y busca su forma en el
 * texto, con el parámetro como comodín (`tienePuerta`). Lo que pierde es el
 * método, y se dice: una pantalla que lista sin botón de guardar cuenta como
 * puerta de las dos rutas. Sigue contestando la pregunta que estaba sin
 * contestar —**¿hay por dónde entrarle a esto?**— y no la de S-12.
 *
 * ## Para qué sirve la lista de abajo
 *
 * Para que una ausencia tenga que ser una decisión. Tres de las excepciones son
 * permanentes y se ven a la legua (sondas, la consola misma, el recolector de
 * métricas); el resto **son trabajo**, y cada línea dice cuál.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, initPool } from '@aai/db';
import { buildServer } from '@aai/api/server';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase } from '../integration/helpers/db.js';
import { puertasDe, tienePuerta } from './helpers/consola.js';

/** `'POST /fiscal-years'` → ¿la consola sabe pedirlo, con ese método? */
const tienePuertaDe = (registrada: string, html: string): boolean => {
  const corte = registrada.indexOf(' ');
  return tienePuerta(registrada.slice(0, corte), registrada.slice(corte + 1), html);
};

const CONSOLA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'apps',
  'web',
  'consola.html',
);
const suite = hasDatabase ? describe : describe.skip;

/**
 * Rutas que la consola no nombra, cada una con **por qué**.
 *
 * Las que dicen «falta la pantalla» son deuda, no diseño. Están escritas así a
 * propósito: «se decidió que no» sería mentira en la mayoría de los casos, y una
 * excepción que se disfraza de decisión no vuelve a mirarse nunca.
 */
const SIN_PUERTA = new Map<string, string>([
  // ── Permanentes: no son pantallas ──────────────────────────────────────
  ['GET /consola', 'Es la consola misma: se sirve, no se consume.'],
  ['GET /health', 'Sonda de infraestructura, para el orquestador.'],
  ['GET /health/db', 'Ídem: la usa el despliegue, no una persona.'],
  ['GET /metrics', 'Exige un token que una página servida sin autenticar no puede tener.'],
  // Quien la llama es un servidor de la pasarela de pagos, que no tiene sesión
  // en NEXO y no podría tenerla: lo que la protege es la firma de la propia
  // notificación. Una pantalla acá sería un botón para fabricarse a mano un
  // aviso de cobro, que es exactamente lo que el diseño impide.
  ['POST /webhooks/pagos', 'La llama la pasarela de pagos, no una persona.'],

  // ── Administración del estudio: antes de elegir empresa ────────────────
  //
  // La consola arranca en «elegí una empresa». Todo lo que pasa antes —crear la
  // organización, darla de alta, invitar usuarios— no tiene dónde vivir en esta
  // pantalla, y meterlo acá sería mezclar dos productos. Lo destraba decidir si
  // el panel del estudio es una vista más o una aplicación aparte.
  ['GET /organizations', 'Panel del estudio, anterior a elegir empresa.'],
  ['POST /organizations', 'Ídem: crear la organización pasa antes de esta pantalla.'],
  ['POST /organizations/:organizationId/companies', 'Ídem: alta de empresa en el estudio.'],
  [
    'POST /auth/register-first-admin',
    'El arranque en frío del sistema: corre una vez, antes de que exista una consola donde ' +
      'apretarlo. Hoy lo hace el script de siembra.',
  ],
  [
    'POST /subscription/:subscriptionId/estado',
    'Cambiar el estado de una suscripción es del lado del proveedor, no del cliente. La ' +
      'consola declara la suscripción y la lee; moverle el estado lo hará la pasarela cuando ' +
      'exista (NEXO_ROADMAP.md §P2).',
  ],

  // ── Lo que el barrido ve desde que mira el método (2026-09-21) ─────────
  //
  // Hasta esa fecha `tienePuerta` recibía la ruta y no el método, así que una
  // escritura figuraba con puerta si la consola **leía** esa misma ruta. Estas
  // cuatro estaban tapadas por su propio `GET`, y cada una dice de qué clase es.
  [
    'GET /',
    'EXCEPCIÓN LEGÍTIMA. Es la página pública, no una capacidad de la consola: se sirve a ' +
      'quien entra al dominio. La consola vive en `/consola` y ya está exceptuada arriba.',
  ],
  [
    'POST /comprobantes/:taxTransactionId/decision',
    'FALTA PANTALLA. Declarar el tratamiento contable de un comprobante exige ' +
      '`journal_entry:create`: es un acto contable, no de carga. La consola muestra la ' +
      'decisión tomada y sus correcciones, y no tiene dónde tomarla — hoy el asiento se ' +
      'carga entero a mano desde Asientos, que es el camino que sí existe.',
  ],
  [
    'GET /documents/:documentId/tax-transaction',
    'INTERNA. Devuelve el comprobante que salió de un documento. La consola llega al ' +
      'comprobante por Operaciones, que es la pantalla donde se lo busca; este atajo por ' +
      'documento lo usa quien integra contra la API.',
  ],
  [
    'POST /integrations/:integrationId/records',
    'INTERNA. Es la ingesta programática de registros de un sistema externo, con ' +
      '`integration:ingest`. Lo que hace una persona desde la consola es subir el CSV ' +
      '—`…/records/csv`, que sí tiene botón—; esta variante la llama otro sistema.',
  ],

  // ── Rutas que sobran ───────────────────────────────────────────────────
  [
    'GET /checks/flujo',
    'SOBRA LA RUTA. Devuelve exactamente lo mismo que el campo `cartera` de `GET /checks`, que ' +
      'la pantalla de cheques ya muestra por tramo de fecha de pago. Es una segunda forma de ' +
      'preguntar lo mismo; sacarla es una decisión de API, no una pantalla que falte.',
  ],

  // ── Falta la pantalla: linaje ──────────────────────────────────────────
  [
    'GET /statements/trace/:lineId',
    'NO ALCANZABLE SIN BACKEND NUEVO. El renglón de un estado recién armado ya trae su ' +
      '`origen` (cuentas y aporte) en la misma respuesta de `GET /statements` — la consola ' +
      'ahora lo muestra ahí, sin necesidad de esta ruta. Esta ruta sirve para un renglón YA ' +
      'EMITIDO, identificado por el `line_id` persistido en `financial_statement_lines` — y ' +
      'ningún endpoint devuelve ese id: ni el paquete de notas, ni ninguna otra lectura de un ' +
      'estado ya emitido. Construir el formulario igual sería pedirle a una persona un UUID ' +
      'que no tiene de dónde sacar. Falta un endpoint que liste los renglones persistidos de ' +
      'un estado emitido con su id antes de que esta pantalla tenga sentido.',
  ],
  // ── Falta el botón: actos que existen y no tienen dónde apretarse ──────
  [
    'POST /documents/:documentId/classify',
    'FALTA BOTÓN. Pedirle al agente que clasifique un documento. La pantalla de propuestas ' +
      'muestra y aprueba lo ya propuesto; **generar** la propuesta no se puede desde acá.',
  ],
  [
    'POST /commercial-documents/:documentId/link-invoice',
    'FALTA BOTÓN. Vincular un remito o un pedido con la factura que lo cubre.',
  ],

  // ── Falta la pantalla: la sesión misma ─────────────────────────────────
]);

suite('S-25 — cada capacidad tiene puerta de entrada', () => {
  let app: FastifyInstance;
  let html = '';
  let rutas: string[] = [];

  beforeAll(async () => {
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    html = await readFile(CONSOLA, 'utf8');
    rutas = [
      ...new Set(
        app.routeTable
          .filter((ruta) => !['HEAD', 'OPTIONS'].includes(ruta.method))
          .map((ruta) => `${ruta.method} ${ruta.url}`),
      ),
    ].sort();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await closePool();
  });

  it('el instrumento sabe leer todas las formas de llamada de la consola', () => {
    // Si aparece una forma indirecta nueva, lo que falla dice «no sé leer esto»
    // en vez de acusar a una pantalla de no existir. Es la lección de `bajarCsv`.
    const { sinResolver } = puertasDe(html);
    expect(
      sinResolver,
      'La consola llama a `api()` de una forma que este ayudante no sabe atribuir. Hasta ' +
        'resolverla, el barrido produciría falsos rojos:\n  ' + sinResolver.join('\n  '),
    ).toEqual([]);
  });

  it('leer una ruta no cuenta como puerta para escribirla', () => {
    // El defecto que originó este cambio: la consola listaba los ejercicios con
    // `GET /fiscal-years` y no tenía ningún botón que abriera uno. Con la
    // versión anterior —que recibía la ruta y no el método— el POST figuraba
    // con puerta, y una empresa nueva no podía abrir su ejercicio.
    //
    // Se comprueba sobre un caso armado a mano y no sobre la consola: así la
    // propiedad se sigue probando el día que la pantalla exista, que es
    // justamente cuando nadie se acordaría de volver a mirarla.
    const soloLee = `<script>
      async function listar() { const r = await api('GET', '/fiscal-years'); }
      async function ver(id) { const r = await api('GET', '/accounts/' + id); }
    </script>`;

    expect(tienePuerta('GET', '/fiscal-years', soloLee)).toBe(true);
    expect(tienePuerta('POST', '/fiscal-years', soloLee)).toBe(false);
    expect(tienePuerta('GET', '/accounts/:accountId', soloLee)).toBe(true);
    expect(tienePuerta('PATCH', '/accounts/:accountId', soloLee)).toBe(false);
  });

  it('el barrido está mirando la consola y el inventario de verdad', () => {
    // Si cualquiera de los dos lados fallara, cero inalcanzables no probaría nada.
    expect(rutas.length, 'la API tiene que tener rutas').toBeGreaterThan(200);
    expect(html.length, 'la consola tiene que tener contenido').toBeGreaterThan(100_000);
    expect(tienePuerta('GET', '/journal-entries', html), 'el Mayor tiene pantalla').toBe(true);
    expect(
      tienePuerta('POST', '/commercial-documents/:documentId/emit', html),
      'una URL armada con un ternario también cuenta: si esto diera falso, el barrido tendría ' +
        'falsos rojos y no serviría',
    ).toBe(true);
  });

  it('ninguna ruta queda sin forma de entrarle', () => {
    const inalcanzables = rutas.filter(
      (ruta) => !SIN_PUERTA.has(ruta) && !tienePuertaDe(ruta, html),
    );

    expect(
      inalcanzables,
      'Estas rutas existen y la consola no las nombra en ningún lado. O les falta pantalla, o ' +
        'sobran en la API:\n  ' +
        inalcanzables.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula rutas que ya tienen puerta', () => {
    // Es lo que impide que la lista se vuelva decoración: cuando alguien hace
    // la pantalla, este test lo obliga a borrar la línea.
    const resueltas = [...SIN_PUERTA.keys()].filter((ruta) =>
      tienePuertaDe(ruta, html),
    );

    expect(
      resueltas,
      'Estas rutas ya tienen puerta y siguen declaradas como si no:\n  ' + resueltas.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no nombra rutas que ya no existen', () => {
    const fantasmas = [...SIN_PUERTA.keys()].filter((ruta) => !rutas.includes(ruta));

    expect(
      fantasmas,
      'Estas excepciones no corresponden a ninguna ruta registrada:\n  ' + fantasmas.join('\n  '),
    ).toEqual([]);
  });
});
