/**
 * S-21 — un agente declarado que nadie ejecuta.
 *
 * `AI_ARCHITECTURE.md` §3 tiene una tabla con ocho agentes, y el `CHECK` de
 * `ai_predictions.agent` acepta esos ocho nombres. Uno solo los produce.
 *
 * Es el mismo defecto que S-16 y S-17 un piso más abajo: no es una tabla sin
 * escritor ni una función sin consumidor, es **un valor de un enum que nombra
 * una capacidad que no existe**. Y engaña más que los otros dos, porque el
 * `CHECK` se lee como un inventario: quien mire el esquema va a creer que hay
 * ocho agentes corriendo.
 *
 * ## Por qué el nombre no alcanza como prueba
 *
 * Los ocho nombres están escritos en `packages/ai-engine/src/contracts.ts`, en
 * la unión `AgentName`. Buscar el literal a secas daría **ocho de ocho** y el
 * barrido sería decoración: un miembro de un tipo no ejecuta nada.
 *
 * Por eso el barrido descarta las líneas que solo declaran el nombre —las de la
 * forma `| 'NOTES'`— y pide que quede algo más: una asignación, un `INSERT`,
 * una consulta. Hoy eso lo cumple `CLASSIFICATION` y nadie más, que es la
 * verdad medida.
 *
 * ## Qué no puede ver
 *
 * Un agente cuyo nombre se arme concatenando. No hay ninguno, y si aparece el
 * barrido va a gritar de más — el lado correcto para equivocarse.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const suite = hasDatabase ? describe : describe.skip;

/**
 * Agentes nombrados en el `CHECK` que hoy no produce nadie, cada uno con **qué
 * lo destraba**. Ninguna entrada dice «todavía no»: dicen qué falta.
 *
 * Cinco de los siete tienen su trabajo hecho de forma determinística en otro
 * lado —y ahí es donde tiene que quedarse—. Lo que falta en esos casos no es la
 * capacidad: es la propuesta con confianza y cita que iría a `ai_predictions`.
 */
const SIN_EJECUCION = new Map<string, string>([
  [
    'DOCUMENT',
    'La extracción de campos existe y es determinística (`document-engine`: parsers de XML, ' +
      'tabulares, texto y ZIP, más el OCR). Lo que no existe es el agente que ponga confianza ' +
      'por campo sobre lo ilegible, y eso empieza por el adaptador de un proveedor de modelo: ' +
      'credencial de un tercero (NEXO_ROADMAP.md §P1.2).',
  ],
  [
    'TAX',
    'El tratamiento de IVA lo calcula `tax-engine` desde las alícuotas archivadas, y ahí tiene ' +
      'que seguir: un modelo no puede ser responsable de una alícuota (ADR-017). El agente ' +
      'propondría el tratamiento en los casos que la regla no cubre. Bloqueado por la misma ' +
      'credencial.',
  ],
  [
    'NORMATIVE_RESEARCH',
    'Necesita el corpus, y el corpus no está: `norm_articles`, `norm_candidates` y ' +
      '`norm_references` no tienen escritor (S-17). Investigar sobre un corpus vacío devolvería ' +
      'siempre lo mismo. Lo destraba el relevamiento normativo del §32.',
  ],
  [
    'RECONCILIATION',
    'Las propuestas de conciliación existen y puntúan (`bank-engine/matching.ts`), sin modelo y ' +
      'sin pasar por `ai_predictions`. El motor tampoco desempata cuando dos líneas puntúan ' +
      'igual: dice que no puede. Este valor del CHECK sobra mientras la conciliación siga ' +
      'siendo determinística, y sacarlo es una decisión de esquema, no de código.',
  ],
  [
    'FINANCIAL_ANALYSIS',
    'El análisis es determinístico y está: descomposición de la variación del margen, seis ' +
      'frentes de riesgo, simulación y comparación de escenarios. La **narración** de esas ' +
      'cifras es el camino cerrado y probado contra el proveedor simulado; falta el archivo que ' +
      'implemente `LLMProvider` con una credencial real (NEXO_ROADMAP.md §P1.2).',
  ],
  [
    'NOTES',
    'Las notas se arman en `financial-statements/notes.ts` y una cifra de nota **no se escribe: ' +
      'se referencia** (invariante A-2). Un agente que redactara la cifra rompería justamente ' +
      'eso. Lo que podría proponer es la redacción alrededor de cifras ya referenciadas, y ' +
      'depende de la misma credencial.',
  ],
  [
    'AUDIT',
    'Los hallazgos se derivan de vistas y no se guardan: `audit_findings` no tiene escritor y ' +
      'está anotado como deuda. Priorizar hallazgos que nadie persiste no tendría sobre qué ' +
      'trabajar. Lo destraba decidir si un hallazgo es una fila o una derivación.',
  ],
]);

/** Dónde se busca a quien produzca cada agente. Los tests no cuentan. */
const FUENTES = [['apps'], ['packages'], ['scripts']];

suite('S-21 — cada agente declarado tiene quién lo ejecute', () => {
  let db: Client;
  let declarados: string[] = [];
  let lineas: string[] = [];

  beforeAll(async () => {
    db = await connect();
    const r = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'ai_predictions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%agent%'`,
    );
    const def = r.rows.map((fila) => fila.def).join(' ');
    declarados = [...new Set(def.match(/'[A-Z_]{3,}'/gu) ?? [])].map((x) => x.slice(1, -1)).sort();

    const partes: string[] = [];
    for (const carpeta of FUENTES) {
      for (const archivo of await archivosDe(join(RAIZ, ...carpeta))) {
        partes.push(await readFile(archivo, 'utf8'));
      }
    }
    lineas = partes.join('\n').split(/\r?\n/u);
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  it('el barrido está leyendo el CHECK de verdad', () => {
    // Si la lectura fallara, cero agentes huérfanos no probaría nada.
    expect(declarados, 'el CHECK de `agent` tiene que nombrar los ocho').toHaveLength(8);
    expect(declarados).toContain('CLASSIFICATION');
    expect(lineas.length).toBeGreaterThan(10_000);
  });

  it('ningún agente existe solamente como nombre en un tipo', () => {
    const huerfanos = declarados.filter(
      (agente) => !SIN_EJECUCION.has(agente) && !seEjecuta(agente, lineas),
    );

    expect(
      huerfanos,
      'Estos agentes están en el CHECK y nadie los produce fuera de la unión de tipos. O les ' +
        'falta el ejecutor, o sobran en el esquema:\n  ' +
        huerfanos.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula agentes que ya se ejecutan', () => {
    // Una excepción que sobrevive a su motivo convierte la lista en decoración.
    const resueltos = [...SIN_EJECUCION.keys()].filter((agente) => seEjecuta(agente, lineas));

    expect(
      resueltos,
      'Estos agentes ya se ejecutan y siguen declarados como si no:\n  ' + resueltos.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no nombra agentes que el CHECK no acepta', () => {
    const fantasmas = [...SIN_EJECUCION.keys()].filter((agente) => !declarados.includes(agente));

    expect(
      fantasmas,
      'Estas excepciones ya no corresponden a ningún agente del CHECK:\n  ' +
        fantasmas.join('\n  '),
    ).toEqual([]);
  });

  it('el agente que sí corre deja rastro en las dos puntas', () => {
    // No alcanza con que el nombre aparezca: el que funciona se escribe y se
    // vuelve a leer. Es la diferencia entre la capacidad y el nombre.
    const texto = lineas.join('\n');
    expect(texto).toMatch(/INSERT\s+INTO\s+ai_predictions/iu);
    expect(texto).toMatch(/agent\s*=\s*'CLASSIFICATION'/u);
  });
});

/**
 * Un agente se ejecuta si su nombre aparece en algún lado **que no sea** la
 * declaración del tipo. Una línea de la forma `| 'NOTES'` no ejecuta nada.
 */
function seEjecuta(agente: string, lineas: string[]): boolean {
  const soloDeclara = new RegExp(`^\\s*\\|?\\s*'${agente}'[,;]?\\s*$`, 'u');
  const literal = new RegExp(`'${agente}'`, 'u');
  return lineas.some((linea) => literal.test(linea) && !soloDeclara.test(linea));
}

/** Todo el código fuente, sin tests, sin compilados y sin dependencias. */
async function archivosDe(directorio: string, salida: string[] = []): Promise<string[]> {
  for (const entrada of await readdir(directorio, { withFileTypes: true })) {
    const completo = join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entrada.name)) continue;
      await archivosDe(completo, salida);
      continue;
    }
    if (/\.(ts|mjs|js)$/u.test(entrada.name) && !entrada.name.includes('.test.')) {
      salida.push(completo);
    }
  }
  return salida;
}
