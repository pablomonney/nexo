/**
 * Las tres separaciones del circuito contable, comprobadas sobre el código.
 *
 * Los tests de integración prueban que el circuito **hace** lo correcto. Éste
 * prueba que sigue **armado** de la forma que lo hace correcto, que es una
 * propiedad distinta: un refactor bienintencionado puede conservar todos los
 * comportamientos observables y borrar la razón por la que eran ciertos.
 *
 * Las tres:
 *
 *   1. **Sugerir no es registrar.** Nada del aprendizaje ni de la IA escribe en
 *      el Diario. Hay tres escritores de `journal_entry_lines` y son los mismos
 *      desde que existe el Mayor.
 *
 *   2. **La importación es un camino aparte.** Trae la contabilidad de otro
 *      sistema y la escribe como venía. Si empezara a consultar el mapeo, las
 *      cuentas de producto o el aprendizaje, estaría reinterpretando lo que
 *      importa, y una migración que cambia los datos al pasarlos no es una
 *      migración.
 *
 *   3. **La dirección del asiento sale de un solo lugar.** `signoDe`, en
 *      `@aai/tax-engine`, alimentado por la clase que ARCA versiona. Una segunda
 *      tabla de códigos en cualquier otro archivo sería la misma clase de
 *      defecto que este repositorio ya tuvo tres veces.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function fuentes(base: string): Promise<string[]> {
  const encontrados: string[] = [];
  const recorrer = async (directorio: string): Promise<void> => {
    for (const entrada of await readdir(directorio, { withFileTypes: true })) {
      const ruta = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(ruta);
      } else if (entrada.name.endsWith('.ts') && !entrada.name.endsWith('.test.ts')) {
        encontrados.push(ruta);
      }
    }
  };
  await recorrer(join(RAIZ, base));
  return encontrados;
}

const leer = async (...partes: string[]): Promise<string> =>
  readFile(join(RAIZ, ...partes), 'utf8');

describe('Sugerir no es registrar', () => {
  it('los escritores del Diario siguen siendo tres, y ninguno es de IA', async () => {
    const escritores: string[] = [];
    for (const ruta of [...(await fuentes('apps')), ...(await fuentes('packages'))]) {
      const texto = await readFile(ruta, 'utf8');
      if (/INSERT\s+INTO\s+journal_entry_lines/iu.test(texto)) {
        escritores.push(relative(RAIZ, ruta).replaceAll('\\', '/'));
      }
    }

    expect(escritores.sort()).toEqual([
      // La importación, que trae lo que otro sistema ya había asentado.
      'apps/api/src/migracion/escritores.ts',
      // El cierre de ejercicio, único hecho que produce asientos por sí solo.
      'apps/api/src/routes/closures.ts',
      // La persona, por `POST /journal-entries`.
      'apps/api/src/routes/journal-entries.ts',
    ]);
  });

  it('el aprendizaje y la IA no escriben en el Diario', async () => {
    for (const ruta of await fuentes(join('packages', 'ai-engine'))) {
      const texto = await readFile(ruta, 'utf8');
      expect(
        /INSERT\s+INTO\s+journal/iu.test(texto),
        `${relative(RAIZ, ruta)} escribe en el Diario`,
      ).toBe(false);
    }

    // `predictions.ts` escribe el aprendizaje y las predicciones, y nada más.
    const predictions = await leer('apps', 'api', 'src', 'routes', 'predictions.ts');
    expect(/INSERT\s+INTO\s+journal/iu.test(predictions)).toBe(false);
  });

  it('el armador de la propuesta no consulta el aprendizaje', async () => {
    // Una propuesta que mezclara el mapeo declarado con lo que la empresa hizo
    // antes ya no sería una propuesta a partir de lo declarado, y nadie podría
    // decir cuál de las dos cosas produjo cada renglón.
    for (const archivo of [
      join('apps', 'api', 'src', 'contabilidad', 'armar-renglones.ts'),
      join('apps', 'api', 'src', 'routes', 'mapeo-contable.ts'),
    ]) {
      const texto = await readFile(join(RAIZ, archivo), 'utf8');
      expect(
        /classification_preferences|sugerirPorPreferencia|ClassificationAgent/u.test(texto),
        `${archivo} consulta el aprendizaje`,
      ).toBe(false);
    }
  });
});

describe('La importación es un camino aparte', () => {
  it('no consulta el mapeo, ni las cuentas de producto, ni el aprendizaje, ni la IA', async () => {
    const prohibido = [
      ['company_account_map', 'el mapeo contable de la empresa'],
      ['leerMapeo', 'el mapeo contable de la empresa'],
      ['armarRenglones', 'el armador de propuestas'],
      ['sales_account_id', 'las cuentas del maestro de productos'],
      ['purchase_account_id', 'las cuentas del maestro de productos'],
      ['classification_preferences', 'el aprendizaje'],
      ['@aai/ai-engine', 'la IA'],
    ] as const;

    for (const ruta of await fuentes(join('apps', 'api', 'src', 'migracion'))) {
      const texto = await readFile(ruta, 'utf8');
      for (const [aguja, que] of prohibido) {
        expect(
          texto.includes(aguja),
          `${relative(RAIZ, ruta)} empezó a consultar ${que}: la importación escribe lo que el ` +
            'otro sistema ya había asentado, no lo reinterpreta',
        ).toBe(false);
      }
    }
  });
});

describe('La dirección del asiento sale de un solo lugar', () => {
  it('el armador usa `signoDe` y no una lista propia de códigos', async () => {
    const texto = await leer('apps', 'api', 'src', 'contabilidad', 'armar-renglones.ts');
    expect(texto).toMatch(/import\s*\{[^}]*signoDe[^}]*\}\s*from\s*'@aai\/tax-engine'/u);
  });

  it('`signoDe` tiene una sola implementación en todo el repositorio', async () => {
    // Una segunda —«acá me conviene otro criterio»— es exactamente cómo se
    // desincronizaron antes el organismo de contralor, el tipo de entidad y los
    // siete tipos de cuenta.
    const definiciones: string[] = [];
    for (const ruta of [...(await fuentes('apps')), ...(await fuentes('packages'))]) {
      const texto = await readFile(ruta, 'utf8');
      if (/export function signoDe\b/u.test(texto)) {
        definiciones.push(relative(RAIZ, ruta).replaceAll('\\', '/'));
      }
    }
    expect(definiciones).toEqual(['packages/tax-engine/src/subdiario.ts']);
  });

  it('el armador no decide nada mirando el número del tipo de comprobante', async () => {
    // Los tipos de comprobante son una tabla que ARCA versiona por fecha. Que el
    // armador comparara `cbte_tipo` contra un número sería cablear una vigencia,
    // y dejaría afuera todos los códigos que el manual archivado no describe.
    // Lo que el armador recibe es la clase, ya resuelta.
    const texto = await leer('apps', 'api', 'src', 'contabilidad', 'armar-renglones.ts');
    expect(texto).not.toMatch(/cbte_?[Tt]ipo/u);
    expect(texto).not.toMatch(/tipoComprobante/u);
  });

  it('el catálogo de ARCA se consulta por la fecha del comprobante, no por hoy', async () => {
    // Contra `now()` diría qué es hoy ese código y no qué era cuando se emitió.
    for (const archivo of [
      join('apps', 'api', 'src', 'routes', 'mapeo-contable.ts'),
      join('apps', 'api', 'src', 'tax', 'subdiario.ts'),
    ]) {
      const texto = await readFile(join(RAIZ, archivo), 'utf8');
      expect(texto, archivo).toContain('arca_comprobante_types');
      expect(texto, archivo).toMatch(/valid_from\s+IS NULL OR ct\.valid_from\s*<=\s*t\.cbte_fecha/u);
      expect(texto, archivo).not.toMatch(/valid_from\s*<=\s*now\(\)/u);
    }
  });
});
