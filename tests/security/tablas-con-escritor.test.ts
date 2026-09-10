/**
 * S-17 — una tabla que nadie escribe es un hueco, no una tabla.
 *
 * Es el mismo defecto que persigue S-16, un piso más abajo. S-16 mira las
 * funciones exportadas; este mira el esquema: **cada tabla tiene que tener al
 * menos un `INSERT` fuera de los tests**.
 *
 * El repositorio ya lo encontró a mano tres veces, y las tres tenían la misma
 * forma —estructura correcta, regla escrita, nadie recorriendo el camino—:
 *
 *   - `bank_reconciliations` sin ningún INSERT: se podían proponer coincidencias
 *     y confirmarlas, y no había forma de crear la conciliación que las sostiene.
 *   - `vat_books.compras_sha256` / `ventas_sha256`, con el motivo escrito desde
 *     la migración 0021 —«es lo que hace verificable la referencia que el art.
 *     327 exige»— y ningún escritor. El Diario resumido no tenía contra qué
 *     verificar.
 *   - `bank_accounts` y `bank_statement_layouts`: el módulo de bancos entero
 *     empezaba en dos filas que solo se podían crear por SQL. La consola pedía
 *     el `layoutId` escrito a mano y no había de dónde sacarlo.
 *
 * Las tres las encontró una persona leyendo. Este es el control.
 *
 * ## Qué cuenta como escritor
 *
 * Un `INSERT INTO <tabla>` en `apps/`, `scripts/`, `packages/` o en una
 * migración —los triggers y las funciones SQL viven ahí, y una fila escrita por
 * un trigger está tan escrita como una escrita por un handler—. Los tests **no**
 * cuentan: una tabla que solo llenan los tests es exactamente el defecto.
 *
 * ## Qué no puede ver
 *
 * Un `INSERT` armado con el nombre de la tabla en una variable. No hay ninguno
 * hoy, y si aparece, el barrido va a gritar de más — que es el lado correcto
 * para equivocarse.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = hasDatabase ? describe : describe.skip;

/**
 * Tablas sin escritor productivo, cada una con **qué la destraba**.
 *
 * Una excepción que se queda es un permiso permanente para no terminar el
 * trabajo. Ninguna dice "todavía no": dicen qué falta y de quién depende.
 */
const SIN_ESCRITOR = new Map<string, string>([
  // `alerts` salió de esta lista el 2026-09-08: la escribe el detector (0102).
  // Lo que faltaba no era la tabla — era la distinción entre una señal, que dice
  // qué es cierto ahora, y una alerta, que dice desde cuándo y quién la miró.
  [
    'audit_findings',
    'Los hallazgos se derivan de vistas y no se guardan. Deuda registrada. Cerrarla es la ' +
      'misma distinción que cerró `alerts`: un hallazgo derivado no tiene dónde anotar que ' +
      'alguien lo revisó y decidió que no importaba.',
  ],
  [
    'fiscal_emissions',
    'La emisión fiscal está construida y **cerrada a propósito** (B2.5.4.1): `EMISION_HABILITADA` ' +
      'es `false` y `@aai/arca-emision` sigue fuera del grafo de la aplicación. La tabla es el ' +
      'candado que impide la doble emisión, y existe antes que el camino que la produciría — que ' +
      'es la única forma de que no la escriba el apuro. Lo destraba implementar `FECompConsultar` ' +
      'contra el manual archivado, para que una emisión en duda se pueda cerrar sola; hasta ' +
      'entonces la reconciliación sabe si el comprobante existe y no puede recuperar su CAE.',
  ],
  [
    'arca_access_tickets',
    'El ticket del WSAA se cachea en disco (`TicketCacheFs`, que usa el CLI) y la API no cachea: ' +
      'pide uno por consulta. Esta tabla es la caché **compartida** que haría falta con más de ' +
      'una instancia corriendo. Lo destraba decidir el despliegue, no escribir código.',
  ],
  [
    'bank_reconciliation_differences',
    'Las partidas conciliatorias se derivan del acta cada vez que se pide, desde los movimientos ' +
      'y las líneas del Mayor. Guardarlas sería un derivado que puede envejecer sin que nadie se ' +
      'entere, que es lo que ADR-022 evita. La tabla sobra: sacarla es una migración pendiente.',
  ],
  [
    'confidence_policies',
    'Los umbrales de confianza por empresa: hoy rige `POLITICA_POR_DEFECTO` y no hay endpoint ' +
      'para fijarlos. Mientras `accounting_rules` esté vacía toda propuesta cae en 🔴 igual, así ' +
      'que fijar un umbral no cambiaría nada. Lo destraba tener clasificación real (proveedor de ' +
      'modelo y reglas activas).',
  ],
  [
    'document_versions',
    'Un archivo distinto es un documento distinto: la identidad es el `sha256`, y volver a subir ' +
      'el mismo archivo devuelve el documento existente. No hay versionado del archivo, y lo que ' +
      'sí se versiona —la lectura de un campo— vive en `document_extraction_fields`, donde la ' +
      'corrección se agrega al lado de la original.',
  ],
  [
    'journals',
    'Catálogo de libros por empresa que **duplica** la unión `JournalCode` y el CHECK de ' +
      '`journal_entries.journal_code`. Nada lo referencia: no hay FK contra él. Son dos ' +
      'representaciones del mismo catálogo y la que manda es la otra. Lo destraba decidir si los ' +
      'libros pasan a ser filas (nombre por empresa, FK real) o si la tabla se va. El importador ' +
      'de migraciones llegó a escribirla y se le sacó: le habría agregado a la empresa libros ' +
      'con el nombre que trajera el archivo, que ninguna otra pantalla conoce.',
  ],
  [
    'lineage_edges',
    'El grafo de linaje explícito. La trazabilidad que el producto usa sale de las claves ' +
      'foráneas y de vistas como `bank_trace`: un grafo paralelo mantenido a mano se ' +
      'desincroniza del que ya existe. Lo destraba un caso que las FK no puedan contestar.',
  ],
  [
    'norm_articles',
    'El articulado de cada norma, que carga el Normative Update Service (§32). El servicio no ' +
      'está construido: hoy las normas se archivan con su documento y su hash, y el texto por ' +
      'artículo no se separa.',
  ],
  [
    'norm_candidates',
    'Candidatas detectadas por el crawler del §32, que no existe. Nada se activa solo: detectar ' +
      'es automático y activar es humano, pero primero hay que detectar.',
  ],
  [
    'norm_modifications',
    'Qué norma deroga o sustituye a cuál. El motor **lee** esta tabla para descartar reglas ' +
      'derogadas; escribirla es parte del relevamiento normativo del §32.',
  ],
  ['norm_references', 'Referencias cruzadas entre normas, del mismo relevamiento pendiente.'],
  [
    'norm_watch_sources',
    'Las fuentes que el servicio de vigilancia consultaría. `OFFICIAL_SOURCES.md` §7 tiene el ' +
      'relevamiento: el único acceso programático oficial es la API CKAN de datos.gob.ar.',
  ],
  [
    'normative_conflicts',
    'Conflictos entre normas detectados por el servicio del §32. El motor sí resuelve conflictos ' +
      'en memoria y los informa como CONFLICTO_NORMATIVO; persistirlos es del servicio.',
  ],
  [
    'normative_updates',
    'La máquina de estados de una actualización normativa (DETECTADA → … → APROBADA). Es el ' +
      'servicio del §32 completo.',
  ],
  [
    'profit_centers',
    'Centros de beneficio: existen en el esquema desde la 0003 y no tienen ABM, igual que los ' +
      'centros de costo, que se eligen dentro de cada asiento. Lo destraba decidir si el producto ' +
      'los ofrece como dimensión aparte.',
  ],
  [
    'system_settings',
    'Almacén genérico de configuración por empresa. Todo lo que hoy se configura tiene su tabla ' +
      'con sus CHECK —`analysis_thresholds`, `company_account_map`, `confidence_policies`—, que ' +
      'es más verificable que un `jsonb` sin forma. Lo destraba una configuración que no merezca ' +
      'tabla propia.',
  ],
  [
    'vat_book_lines',
    'Los renglones del Libro de IVA. Desde 2026-09-03 el libro archiva el `sha256` del subdiario ' +
      'emitido y el archivo se puede volver a bajar y comparar: el contenido presentado queda ' +
      'fijado por el hash sin duplicar cada renglón en una tabla que puede envejecer. Lo ' +
      'destraba una obligación de conservar el detalle fila por fila.',
  ],
]);

/** Dónde se busca a los escritores. */
const FUENTES = [['apps'], ['scripts'], ['packages'], ['infrastructure', 'db', 'migrations']];

suite('S-17 — cada tabla tiene quién la escriba', () => {
  let db: Client;
  let tablas: string[] = [];
  let codigo = '';

  beforeAll(async () => {
    db = await connect();
    const r = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    tablas = r.rows.map((fila) => fila.table_name);

    const partes: string[] = [];
    for (const carpeta of FUENTES) {
      for (const archivo of await archivosDe(join(RAIZ, ...carpeta))) {
        partes.push(await readFile(archivo, 'utf8'));
      }
    }
    codigo = partes.join('\n');
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  it('el barrido está mirando el esquema de verdad', () => {
    // Si la lectura fallara, cero huérfanas no probaría nada.
    expect(tablas.length, 'la base tiene que tener tablas').toBeGreaterThan(100);
    expect(tablas).toContain('journal_entries');
    expect(codigo.length).toBeGreaterThan(100_000);
  });

  it('ninguna tabla se llena solo desde los tests', () => {
    const huerfanas = tablas.filter(
      (tabla) =>
        !SIN_ESCRITOR.has(tabla) && !new RegExp(`INSERT\\s+INTO\\s+${tabla}\\b`, 'iu').test(codigo),
    );

    expect(
      huerfanas,
      'Estas tablas no tienen ningún INSERT fuera de los tests. O les falta el escritor, o ' +
        'sobran en el esquema:\n  ' +
        huerfanas.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula tablas que ya tienen escritor', () => {
    // Una excepción que sobrevive a su motivo convierte la lista en decoración.
    const resueltas = [...SIN_ESCRITOR.keys()].filter((tabla) =>
      new RegExp(`INSERT\\s+INTO\\s+${tabla}\\b`, 'iu').test(codigo),
    );

    expect(
      resueltas,
      'Estas tablas ya tienen escritor y siguen declaradas como si no:\n  ' +
        resueltas.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no nombra tablas que ya no existen', () => {
    const fantasmas = [...SIN_ESCRITOR.keys()].filter((tabla) => !tablas.includes(tabla));

    expect(
      fantasmas,
      'Estas excepciones ya no corresponden a ninguna tabla:\n  ' + fantasmas.join('\n  '),
    ).toEqual([]);
  });
});

/** Todo el código fuente y las migraciones, sin tests ni dependencias. */
async function archivosDe(directorio: string, salida: string[] = []): Promise<string[]> {
  for (const entrada of await readdir(directorio, { withFileTypes: true })) {
    const completo = join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entrada.name)) continue;
      await archivosDe(completo, salida);
      continue;
    }
    if (/\.(ts|mjs|js|sql)$/u.test(entrada.name) && !entrada.name.includes('.test.')) {
      salida.push(completo);
    }
  }
  return salida;
}
