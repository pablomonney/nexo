/**
 * S-20 — la bitácora es un vocabulario, no una lista de textos sueltos.
 *
 * Cada escritura productiva deja una fila en `audit_logs` con un `action`. Ese
 * campo es la única forma que tiene el sistema de contestar «qué pasó en esta
 * empresa», y es la materia prima de todo lo que se construya encima: métricas,
 * detección, agentes. Un vocabulario que deriva convierte esa pregunta en una
 * búsqueda de texto.
 *
 * Y derivaba. Al medirlo había **106 acciones** en `VERBO_EN_MAYUSCULAS` y
 * **ocho** en `objeto.verbo` —`bank_account.create`, `vat_book.generate`,
 * `book.emit`…—, todas de un puñado de archivos donde cada uno copió el estilo
 * de su vecino. Ninguna estaba mal escrita; el conjunto sí.
 *
 * ## El caso que este barrido existe para atajar
 *
 * `audit_logs` exige motivo para cinco acciones excepcionales. Hasta la 0091 esa
 * regla era un CHECK que comparaba **por texto**: renombrar cualquiera de las
 * cinco no rompía nada, la aplicación seguía andando, los tests seguían verdes,
 * y el candado dejaba de aplicarse en silencio. Desde ese día se podría anular
 * un asiento sin explicar por qué.
 *
 * La 0091 le dio identidad a la acción: `audit_actions` la registra y
 * `audit_logs.action` la referencia, así que un nombre sin registrar **no se
 * puede escribir**. Este barrido es la primera línea —falla en los tests, antes
 * de que falle una escritura— y comprueba además la forma del vocabulario, que
 * la base no mira.
 *
 * ## El agujero que tenía este barrido, y que se tapó
 *
 * Leía `action: 'LITERAL'` en TypeScript, y hay **tres** caminos por los que una
 * acción llega a la bitácora:
 *
 *   1. `action: 'LITERAL'` en un `recordAudit` — lo único que veía.
 *   2. `accion: 'LITERAL'` en la tabla de acciones de una ruta, que un ayudante
 *      pasa a `recordAudit` una función más adelante.
 *   3. Un **trigger SQL** que inserta en `audit_logs` desde la base.
 *
 * Así que las afirmaciones de este archivo —«todas son VERBO_EN_MAYUSCULAS»—
 * eran ciertas sobre lo que veía y falsas sobre el vocabulario. Dos de las que
 * no veía estaban **en inglés** (`AFFECTATION_DECLARED`, `AFFECTATION_CHANGED`),
 * en un vocabulario castellano en todo lo demás. Las renombró la 0092.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS_REQUIRING_REASON } from '@aai/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = join(RAIZ, 'apps', 'api', 'src');

const suite = hasDatabase ? describe : describe.skip;

/**
 * Las excepcionales que **nadie escribe todavía**, con el motivo.
 *
 * No son un olvido: son nombres reservados para actos que el producto todavía no
 * tiene. Declararlas acá es lo que hace que el barrido pueda distinguir «nunca
 * existió» de «alguien la renombró y el candado dejó de aplicarse», que es lo
 * único que importa de esta lista.
 */
const SIN_ESCRITOR = new Map<string, string>([
  [
    'ACTIVAR_REGLA',
    'Activar una regla no ocurre dentro de una empresa: va a `normative_audit_logs` con la ' +
      'acción `RULE_APPROVED` (0041). El nombre quedó registrado en `audit_actions`, donde no ' +
      'puede dispararse nunca.',
  ],
  [
    'RECLASIFICAR_APROBADO',
    'Reclasificar un asiento ya aprobado no existe como operación: lo que hay es anular y ' +
      'volver a asentar, que deja los dos asientos. El nombre está reservado para el día que ' +
      'exista.',
  ],
]);

suite('S-20 — el vocabulario de la bitácora', () => {
  let db: Client;
  /** Todo lo que el sistema sabe emitir, por los tres caminos. */
  let acciones: string[] = [];
  const porCamino = { typescript: 0, tablaDeAcciones: 0, trigger: 0 };
  let porAccionConMotivo = new Map<string, boolean>();
  const registradas = new Map<string, { dominio: string; requiereMotivo: boolean }>();

  beforeAll(async () => {
    db = await connect();
    const r = await db.query<{ id: string; dominio: string; requiere_motivo: boolean }>(
      'SELECT id, dominio, requiere_motivo FROM audit_actions',
    );
    for (const fila of r.rows) {
      registradas.set(fila.id, {
        dominio: fila.dominio,
        requiereMotivo: fila.requiere_motivo,
      });
    }

    const encontradas = new Set<string>();
    const conMotivo = new Map<string, boolean>();

    // Caminos 1 y 2: TypeScript.
    for (const archivo of await archivosDe(API)) {
      const lineas = (await readFile(archivo, 'utf8')).split('\n');
      for (const [i, linea] of lineas.entries()) {
        // Se lee **todo lo que sigue a `action:`**, no el primer literal.
        //
        // La versión anterior buscaba `action: 'LITERAL'` y se perdía la forma
        // que elige entre dos:
        //
        //     action: version === 1 ? 'DECLARAR_…' : 'ROTAR_…',
        //
        // Ahí hay dos acciones del vocabulario y el barrido no veía ninguna. Es
        // el mismo agujero que ya tuvo con `accion:` y con los triggers SQL:
        // el instrumento ciego a una forma de escritura, no el código sin ella.
        const m = /\b(action|accion):\s*(.+)$/u.exec(linea);
        if (m === null) continue;

        // De un ternario interesan los **resultados**, no la condición. La
        // primera versión de esta ampliación se llevó puesto `AJUSTE`:
        //
        //     action: datos.origenTipo === 'AJUSTE' ? 'AJUSTAR_STOCK' : '…'
        //                                 ↑ eso no es una acción
        //
        // Todo lo que está antes del `?` es la pregunta; lo que sigue son las
        // respuestas, y las respuestas son las acciones.
        const tail = m[2]!;
        const corte = tail.indexOf('?');
        const donde = corte === -1 ? tail : tail.slice(corte + 1);

        const literales = [...donde.matchAll(/'([A-Z][A-Z0-9_]*[A-Z0-9])'/gu)].map((x) => x[1]!);
        if (literales.length === 0) continue;

        for (const accion of literales) {
          encontradas.add(accion);
          if (m[1] === 'action') porCamino.typescript += 1;
          else porCamino.tablaDeAcciones += 1;
        }
        // El `motivo` viaja en el mismo objeto que la acción. Se mira una
        // ventana en vez de parsear TypeScript: alcanza para lo que se defiende
        // y no trae un parser al barrido.
        //
        // Cuando una línea nombra dos acciones —el ternario—, las dos comparten
        // la misma ventana, que es correcto: es el mismo `recordAudit`.
        const ventana = lineas.slice(Math.max(0, i - 12), i + 14).join('\n');
        for (const accion of literales) {
          conMotivo.set(accion, (conMotivo.get(accion) ?? false) || /motivo:/u.test(ventana));
        }
      }
    }

    // Camino 3: triggers SQL. Se leen del catálogo de PostgreSQL, **no de los
    // archivos de migración**. Una migración es historia: la 0031 define el
    // trigger de afectaciones y la 0092 lo reemplaza, así que leer los archivos
    // encuentra las dos versiones y el barrido acusa de un nombre que ya nadie
    // emite. `pg_proc` dice qué se va a ejecutar, que es la pregunta.
    //
    // Se leen solo los `CASE` que miran `TG_OP`, que es donde un trigger elige
    // el nombre de la acción. Buscar cualquier literal en mayúsculas traería los
    // valores de cada enum, y un barrido con falsos rojos dura hasta que alguien
    // lo apaga.
    // `prosrc` y no `pg_get_functiondef`: la segunda falla con 42809 sobre los
    // agregados del esquema, y el error dentro de un `beforeAll` sale como
    // suite salteada —verde de lejos—. El cuerpo alcanza para leer los `CASE`.
    const funciones = await db.query<{ cuerpo: string }>(
      `SELECT p.prosrc AS cuerpo
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
          AND p.prosrc ILIKE '%INSERT INTO audit_logs%'`,
    );
    for (const fila of funciones.rows) {
      for (const bloque of fila.cuerpo.matchAll(/CASE[\s\S]{0,600}?END/gu)) {
        if (!/TG_OP/u.test(bloque[0])) continue;
        for (const m of bloque[0].matchAll(/'([A-Z][A-Z_]{3,}[A-Z])'/gu)) {
          const accion = m[1]!;
          if (['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].includes(accion)) continue;
          if (!encontradas.has(accion)) porCamino.trigger += 1;
          encontradas.add(accion);
          // Un trigger no puede llevar motivo: nadie se lo escribe. Si alguna
          // vez una acción excepcional se emitiera desde uno, la base la
          // rechazaría — y este mapa lo hace visible antes.
          conMotivo.set(accion, conMotivo.get(accion) ?? false);
        }
      }
    }

    acciones = [...encontradas].sort();
    porAccionConMotivo = conMotivo;
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  it('el barrido encuentra el vocabulario por los tres caminos', () => {
    expect(acciones.length, 'la API tiene que registrar muchas acciones').toBeGreaterThan(100);
    expect(acciones).toContain('APROBAR_ASIENTO');
    // Cada camino tiene que aportar algo: si uno dejara de verse, el barrido
    // volvería a decir la verdad sobre una parte y a callarse sobre el resto.
    expect(porCamino.typescript, 'recordAudit con literal').toBeGreaterThan(100);
    expect(porCamino.tablaDeAcciones, 'tablas de acciones de una ruta').toBeGreaterThan(5);
    expect(porCamino.trigger, 'triggers SQL').toBeGreaterThan(5);
    expect(registradas.size, 'el registro de la base tiene filas').toBeGreaterThan(100);
  });

  it('todas las acciones son un verbo en mayúsculas', () => {
    // Un vocabulario con dos formas obliga a cada consulta a conocer las dos, y
    // la tercera que aparezca no la va a conocer nadie.
    const fuera = acciones.filter((accion) => !/^[A-Z][A-Z_]*[A-Z]$/u.test(accion));

    expect(
      fuera,
      'Estas acciones no siguen la forma del resto del vocabulario (VERBO_EN_MAYUSCULAS):\n  ' +
        fuera.join('\n  '),
    ).toEqual([]);
  });

  it('todas las acciones del vocabulario en castellano', () => {
    // El vocabulario es castellano. Dos acciones estaban en inglés y este
    // barrido no las veía porque las emitía un trigger; ahora las ve.
    const enIngles = acciones.filter((a) => /^(AFFECTATION|RULE|ACCOUNT|ENTRY)_/u.test(a));

    expect(
      enIngles,
      'Estas acciones están en inglés, en un vocabulario que es castellano en todo lo demás. ' +
        'Buscar por ellas exige saber que se escriben distinto que las otras ciento treinta:\n  ' +
        enIngles.join('\n  '),
    ).toEqual([]);
  });

  it('cada acción que el código emite está registrada en la base', () => {
    // Es la primera línea de la garantía que dio la 0091. La clave foránea la
    // impone de todos modos, pero fallar acá cambia el momento en que se
    // descubre: al correr los tests, no cuando alguien intenta operar.
    const sinRegistrar = acciones.filter((a) => !registradas.has(a));

    expect(
      sinRegistrar,
      'Estas acciones se emiten y no están en `audit_actions`. La escritura va a fallar, y si ' +
        'alguna era excepcional su candado dejó de aplicarse:\n  ' +
        sinRegistrar.join('\n  '),
    ).toEqual([]);
  });

  it('el registro de la base y la lista del código exigen motivo por lo mismo', () => {
    const enLaBase = [...registradas.entries()]
      .filter(([, v]) => v.requiereMotivo)
      .map(([id]) => id)
      .sort();

    expect(enLaBase.length, 'el registro tiene que marcar acciones').toBeGreaterThan(0);
    expect(
      enLaBase,
      '`audit_actions.requiere_motivo` y `ACTIONS_REQUIRING_REASON` tienen que decir lo mismo',
    ).toEqual([...ACTIONS_REQUIRING_REASON].sort());
  });

  it('cada acción excepcional que alguien escribe viaja con su motivo', () => {
    // La base lo exige y rechaza la fila. Comprobarlo acá cambia el momento en
    // que se descubre: al correr los tests, no cuando alguien intenta anular un
    // asiento en producción.
    const sinMotivo = ACTIONS_REQUIRING_REASON.filter(
      (accion) => porAccionConMotivo.get(accion) === false,
    );

    expect(
      sinMotivo,
      'Estas acciones exigen motivo y el código las escribe sin uno cerca. La base va a ' +
        'rechazar la fila:\n  ' +
        sinMotivo.join('\n  '),
    ).toEqual([]);
  });

  it('las excepcionales que nadie escribe son exactamente las declaradas', () => {
    // Si una de las escritas desaparece del código, aparece acá: o la
    // renombraron —y el candado dejó de aplicarse— o se fue la funcionalidad.
    const fantasmas = ACTIONS_REQUIRING_REASON.filter((accion) => !acciones.includes(accion));
    expect(
      [...fantasmas].sort(),
      'Cambió qué acciones excepcionales escribe el código. Si es un renombre, el registro de ' +
        'la 0091 quedó apuntando a un nombre que ya no existe.',
    ).toEqual([...SIN_ESCRITOR.keys()].sort());
  });

  it('el registro no promete un trigger que no existe', () => {
    // `dominio` dice de dónde sale cada acción, y una fila que dice
    // `trigger:0043` sobre una migración que ya no la emite es una explicación
    // que envejeció: manda a buscar a un lugar donde no está.
    const prometidos = [...registradas.entries()].filter(([, v]) =>
      v.dominio.startsWith('trigger:'),
    );

    expect(prometidos.length, 'hay acciones declaradas como de trigger').toBeGreaterThan(5);
    const rotos = prometidos.filter(([id]) => !acciones.includes(id)).map(([id]) => id);

    expect(
      rotos,
      'Estas acciones están registradas como emitidas por un trigger y ningún trigger las ' +
        'emite:\n  ' +
        rotos.join('\n  '),
    ).toEqual([]);
  });
});

/** Todos los `.ts` de la API, sin tests. */
async function archivosDe(directorio: string, salida: string[] = []): Promise<string[]> {
  for (const entrada of await readdir(directorio, { withFileTypes: true })) {
    const completo = join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
      await archivosDe(completo, salida);
      continue;
    }
    if (entrada.name.endsWith('.ts') && !entrada.name.includes('.test.')) salida.push(completo);
  }
  return salida;
}
