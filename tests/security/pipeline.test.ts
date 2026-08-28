/**
 * El workflow de CI ejecuta el pipeline, y no otra cosa.
 *
 * ## Qué defecto existe este archivo para no repetir
 *
 * La auditoría maestra del 2026-08-28 encontró que `.github/workflows/ci.yml`
 * **no podía funcionar**: levantaba Postgres con la base `aai`, `setup-env.ts`
 * redirigía las suites a `aai_test` y ningún paso creaba esa segunda base. Cada
 * suite de integración habría fallado al conectar.
 *
 * Nadie lo notó por dos razones que se suman: el repositorio no tiene remoto
 * —CI nunca corrió— y el pipeline estaba escrito dos veces, en el YAML y en el
 * script `verify`, sin nada que las comparara. Un paso agregado a una y no a la
 * otra no produce ningún síntoma hasta que alguien mira.
 *
 * Así que la secuencia pasó a vivir en `scripts/pipeline.mjs` y este test
 * comprueba que el YAML la ejecute **entera y en orden**. Es el mismo criterio
 * que `adr-001.test.ts`: la regla arquitectónica se hace ejecutable en vez de
 * quedar escrita en un documento que alguien tiene que acordarse de leer.
 *
 * ## Lo que este test NO puede afirmar
 *
 * Que el workflow **pase**. Sin remoto no hay runner, y no hay forma de saberlo
 * desde acá. Lo que sí se puede afirmar —y se afirma— es que la secuencia es la
 * misma que corre localmente, y que esa secuencia local termina en verde.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PASOS } from '../../scripts/pipeline.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');

/** Los pasos del job `verify`, en el orden en que el YAML los declara. */
function pasosDelWorkflow(): { nombre: string; comando: string }[] {
  const pasos: { nombre: string; comando: string }[] = [];
  const lineas = workflow.split('\n');

  for (let i = 0; i < lineas.length; i += 1) {
    const nombre = /^\s*- name:\s*(.+?)\s*$/.exec(lineas[i]!);
    if (nombre === null) continue;

    // El `run:` del paso puede venir después de un comentario, así que se busca
    // hacia adelante hasta el próximo `- name:` en vez de mirar la línea de al lado.
    for (let j = i + 1; j < lineas.length; j += 1) {
      if (/^\s*- name:/.test(lineas[j]!) || /^\s{2}\w[\w-]*:/.test(lineas[j]!)) break;
      const run = /^\s*run:\s*(.+?)\s*$/.exec(lineas[j]!);
      if (run !== null) {
        pasos.push({ nombre: nombre[1]!, comando: run[1]! });
        break;
      }
    }
  }
  return pasos;
}

describe('el workflow de CI ejecuta el pipeline', () => {
  const delWorkflow = pasosDelWorkflow();

  it('el parseo encontró pasos: no está pasando por vacío', () => {
    // Sin esto, un cambio de formato del YAML dejaría el test verde sin haber
    // comparado nada — que es exactamente el defecto que vino a evitar.
    expect(delWorkflow.length).toBeGreaterThanOrEqual(PASOS.length);
  });

  it('todos los pasos del pipeline están en el workflow, con su comando', () => {
    const faltantes = PASOS.filter(
      (paso) =>
        !delWorkflow.some(
          (w) => w.nombre === paso.nombre && w.comando === paso.comando.join(' '),
        ),
    );

    expect(
      faltantes.map((p) => `${p.nombre} → ${p.comando.join(' ')}`),
      'pasos del pipeline que el workflow no ejecuta (o ejecuta con otro comando)',
    ).toEqual([]);
  });

  it('y están en el mismo orden', () => {
    // El orden importa: las bases se crean antes de lo que las usa, y las
    // puertas baratas van antes que los tests para no esperar quince minutos
    // por un error de tipos.
    const posiciones = PASOS.map((paso) =>
      delWorkflow.findIndex((w) => w.nombre === paso.nombre),
    );
    const ordenado = [...posiciones].sort((a, b) => a - b);
    expect(posiciones).toEqual(ordenado);
  });

  it('el workflow crea la base de tests antes de correr los tests', () => {
    // El defecto exacto que se encontró, fijado como test. Si alguien vuelve a
    // sacar este paso, la suite lo dice en vez de que lo descubra CI meses
    // después — o nunca, si CI sigue sin correr.
    const crea = delWorkflow.findIndex((p) => p.comando === 'npm run test:db');
    const corre = delWorkflow.findIndex((p) => p.comando === 'npm run test:coverage');

    expect(crea, 'el workflow no crea la base de tests').toBeGreaterThanOrEqual(0);
    expect(corre, 'el workflow no corre los tests con cobertura').toBeGreaterThanOrEqual(0);
    expect(crea).toBeLessThan(corre);
  });

  it('los tests corren con cobertura, no con `npm test` a secas', () => {
    // `npm test` no hace cumplir los umbrales por paquete. Correrlo en CI dejaba
    // que un paquete cayera por debajo del suyo sin que el pipeline se enterara.
    expect(delWorkflow.some((p) => p.comando === 'npm test')).toBe(false);
    expect(delWorkflow.some((p) => p.comando === 'npm run test:coverage')).toBe(true);
  });

  it('CI declara una sola DATABASE_URL, y no apunta a una base de tests', () => {
    // Las otras dos bases se derivan y las crean sus propios pasos. Declarar
    // `aai_test` acá haría que `setup-env.ts` derivara `aai_test_test`, y que
    // los gates conductuales escribieran donde no corresponde.
    const urls = [...workflow.matchAll(/DATABASE_URL:\s*(\S+)/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toMatch(/_test|_verify/);
  });
});
