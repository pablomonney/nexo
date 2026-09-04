/**
 * S-26 — Intelligence pregunta por significado, no por tablas.
 *
 * El límite entre el ERP y la capa que lo interpreta es una frontera real, y
 * hasta ahora no la defendía nadie: estaba respetada por costumbre.
 *
 * De un lado, el ERP escribe hechos en tablas cuya forma responde a cómo se
 * registra una operación. Del otro, Intelligence contesta preguntas de negocio.
 * Entre los dos van las **vistas**, que es donde vive el significado: qué es una
 * venta, qué es una cobranza, qué mes le corresponde a cada hecho, qué se puede
 * afirmar y qué no.
 *
 * Cuando una respuesta salta las vistas y consulta la tabla directo, pasan dos
 * cosas, y la segunda es la grave:
 *
 *   1. La métrica queda encerrada adentro de esa respuesta. Cualquier otra capa
 *      que la necesite va a escribir su propia versión, y a partir de ahí hay
 *      dos definiciones de lo mismo que nadie puede comparar.
 *
 *   2. El significado se decide ahí, sin que se note. La respuesta «¿cuánto
 *      cobré?» agrupaba por `party_allocations.created_at` —cuándo alguien
 *      registró la imputación— mientras el resto del sistema fecha por el
 *      hecho. Un cobro de marzo imputado en abril figuraba en abril, y las
 *      cobranzas de un mes cerrado cambiaban al cargar una imputación
 *      atrasada. Nadie lo había elegido: se fue con la tabla que había a mano.
 *
 * Lo arregló la 0090 con `collections_by_month`. Esto impide que vuelva.
 *
 * ## Qué mide
 *
 * Cada `FROM <relación>` del catálogo de preguntas tiene que resolver contra una
 * **vista** en la base. Se comprueba contra `information_schema`, no contra una
 * lista escrita a mano: una vista que alguien convierta en tabla lo rompe, que
 * es lo correcto.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = hasDatabase ? describe : describe.skip;

/**
 * Los archivos que forman la capa de Intelligence: el catálogo de preguntas y
 * el armado del contexto que se le manda al modelo.
 */
const CAPA = [
  ['apps', 'api', 'src', 'intelligence', 'catalogo.ts'],
  ['apps', 'api', 'src', 'routes', 'intelligence.ts'],
];

/**
 * Tablas que Intelligence sí puede consultar, con **por qué**.
 *
 * **Está vacía, y esa es la afirmación.** Al medirlo, las diecinueve preguntas
 * del catálogo salían de dieciocho vistas y una sola tabla —`party_allocations`,
 * la que estaba mal fechada—, y la 0090 la reemplazó. Hoy la frontera está
 * completa: ninguna respuesta interpreta una tabla del ERP.
 *
 * Si alguna vez hace falta una excepción, tiene que costar una explicación: cada
 * una es un lugar donde el significado puede volver a decidirse a escondidas.
 * Las tablas de la capa misma —`ai_predictions`, `ai_rejections`— y la
 * comprobación de citas contra `norm_versions` viven en `routes/predictions.ts`
 * y en el motor, no acá, y por eso este barrido no las ve.
 */
const PERMITIDAS = new Map<string, string>();

suite('S-26 — Intelligence lee significado, no tablas del ERP', () => {
  let db: Client;
  const vistas = new Set<string>();
  const tablas = new Set<string>();
  const relaciones: { archivo: string; nombre: string }[] = [];

  beforeAll(async () => {
    db = await connect();
    const r = await db.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables
        WHERE table_schema = 'public'`,
    );
    for (const fila of r.rows) {
      if (fila.table_type === 'VIEW') vistas.add(fila.table_name);
      else tablas.add(fila.table_name);
    }

    for (const partes of CAPA) {
      const archivo = partes[partes.length - 1]!;
      const texto = await readFile(join(RAIZ, ...partes), 'utf8');
      // `FROM x` y `JOIN x`: las dos formas de traer una relación.
      for (const m of texto.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gu)) {
        relaciones.push({ archivo, nombre: m[1]! });
      }
    }
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  it('el barrido está leyendo las dos puntas', () => {
    // Si el catálogo no tuviera consultas, cero infracciones no probaría nada.
    expect(vistas.size, 'la base tiene vistas').toBeGreaterThan(20);
    expect(relaciones.length, 'el catálogo consulta algo').toBeGreaterThan(15);
    expect(
      relaciones.some((r) => r.nombre === 'collections_by_month'),
      'la cobranza del mes sale de su vista',
    ).toBe(true);
  });

  it('ninguna respuesta consulta una tabla del ERP', () => {
    const infracciones = [
      ...new Set(
        relaciones
          .filter((r) => tablas.has(r.nombre) && !PERMITIDAS.has(r.nombre))
          .map((r) => `${r.archivo}: ${r.nombre}`),
      ),
    ];

    expect(
      infracciones,
      'Estas consultas de Intelligence van contra una tabla en vez de una vista. La métrica ' +
        'queda encerrada en la respuesta, y el significado se decide ahí sin que se note:\n  ' +
        infracciones.join('\n  '),
    ).toEqual([]);
  });

  it('cada relación consultada existe en la base', () => {
    // Una respuesta que cita una vista renombrada dice de dónde sale un número y
    // manda a un lugar que no está: peor que no decirlo.
    const fantasmas = [
      ...new Set(
        relaciones
          .filter((r) => !vistas.has(r.nombre) && !tablas.has(r.nombre))
          .map((r) => `${r.archivo}: ${r.nombre}`),
      ),
    ];

    expect(
      fantasmas,
      'Estas relaciones no existen en la base:\n  ' + fantasmas.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula tablas que ya no se consultan', () => {
    const consultadas = new Set(relaciones.map((r) => r.nombre));
    const sobrantes = [...PERMITIDAS.keys()].filter((t) => !consultadas.has(t));

    expect(
      sobrantes,
      'Estas tablas están permitidas y nadie las consulta:\n  ' + sobrantes.join('\n  '),
    ).toEqual([]);
  });
});
