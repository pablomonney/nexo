/**
 * La documentación no nombra cosas que no existen.
 *
 * `PROJECT_STATUS.md` abre diciendo que este archivo dice **dónde está el
 * proyecto de verdad**. Esa promesa vale para todo el repositorio, y era falsa
 * en dos lugares:
 *
 *   · `scripts/README.md` decía «vacío en FASE 0» y listaba cuatro utilidades,
 *     de las que tres nunca existieron. Había treinta y siete scripts.
 *   · `apps/web/README.md` decía «Next.js + TypeScript + Tailwind» y «vacío en
 *     FASE 0». Es un archivo HTML sin build y sin dependencias.
 *
 * Los dos mandaban a buscar algo que no está, que es la forma más cara de
 * documentación equivocada: cuesta el tiempo de alguien y no falla nunca.
 *
 * ## Qué se puede verificar y qué no
 *
 * Que un documento diga la verdad **no es comprobable en general**. Lo que sí:
 * que cada archivo y cada comando que nombra existan. Es una porción chica del
 * problema y es la que se pudre sola —los archivos se mueven, los scripts se
 * renombran— mientras la prosa alrededor sigue pareciendo correcta.
 *
 * No reemplaza leer. Impide que la parte mecánica se degrade sin aviso.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Carpetas que no son documentación del proyecto. */
const IGNORADAS = new Set(['node_modules', '.git', 'dist', 'coverage', 'var', '.vitest']);

/**
 * Referencias que se dejan pasar, con su motivo.
 *
 * La lista es lo único que separa «esto no es una ruta» de «a esta ruta se le
 * escapó el control», así que cada línea explica por qué.
 */
const TOLERADAS = [
  // Rutas de ejemplo dentro de bloques de código o de prosa explicativa.
  /^\.\/(var|tmp)\b/,
  // Plantillas con marcadores: `docs/adr/ADR-XXX-...`.
  /[<{]|XXX|NNN|\.\.\./,
  // Rutas absolutas del sistema operativo, que dependen de la máquina.
  /^[A-Za-z]:\\|^\//,
];

async function markdownsDe(carpeta: string): Promise<string[]> {
  const salida: string[] = [];
  for (const entrada of await readdir(carpeta, { withFileTypes: true })) {
    if (IGNORADAS.has(entrada.name)) continue;
    const completo = join(carpeta, entrada.name);
    if (entrada.isDirectory()) salida.push(...(await markdownsDe(completo)));
    else if (entrada.name.endsWith('.md')) salida.push(completo);
  }
  return salida;
}

async function existe(ruta: string): Promise<boolean> {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}

describe('La documentación no nombra cosas que no existen', () => {
  it('cada enlace relativo de un .md apunta a un archivo que está', async () => {
    const docs = await markdownsDe(RAIZ);
    expect(docs.length, 'el barrido tiene que encontrar documentos').toBeGreaterThan(20);

    const rotos: string[] = [];
    for (const doc of docs) {
      const texto = await readFile(doc, 'utf8');
      // Enlaces markdown `[texto](ruta)`, sin URLs ni anclas.
      for (const m of texto.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const destino = m[1]!;
        if (/^(https?:|mailto:|#)/.test(destino)) continue;
        if (TOLERADAS.some((patron) => patron.test(destino))) continue;

        const sinAncla = destino.split('#')[0]!;
        if (sinAncla === '') continue;

        if (!(await existe(resolve(dirname(doc), sinAncla)))) {
          rotos.push(`${doc.slice(RAIZ.length + 1)} → ${destino}`);
        }
      }
    }

    expect(rotos, 'estos enlaces apuntan a archivos que no existen:\n  ' + rotos.join('\n  '))
      .toEqual([]);
  });

  it('cada `npm run X` que menciona un README existe como script', async () => {
    // Un README que ofrece un comando inexistente cuesta el tiempo de quien lo
    // copia y no falla nunca por su cuenta.
    const paquete = JSON.parse(await readFile(join(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    const docs = await markdownsDe(RAIZ);
    const inexistentes: string[] = [];

    for (const doc of docs) {
      const texto = await readFile(doc, 'utf8');
      for (const m of texto.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
        const comando = m[1]!;
        if (paquete.scripts[comando] === undefined) {
          inexistentes.push(`${doc.slice(RAIZ.length + 1)} → npm run ${comando}`);
        }
      }
    }

    expect(
      inexistentes,
      'estos comandos no existen en package.json:\n  ' + inexistentes.join('\n  '),
    ).toEqual([]);
  });

  it('ningún documento sigue anunciando que su carpeta está vacía', async () => {
    // La frase exacta que sobrevivió en dos README durante toda la evolución del
    // producto. Es específica a propósito: un barrido de «palabras que suenan a
    // desactualizado» daría falsos rojos y terminaría apagado.
    const docs = await markdownsDe(RAIZ);
    const mienten: string[] = [];

    for (const doc of docs) {
      const texto = await readFile(doc, 'utf8');
      if (/vac[ií]o en FASE 0/i.test(texto)) mienten.push(doc.slice(RAIZ.length + 1));
    }

    expect(mienten, 'estos documentos dicen estar vacíos y no lo están').toEqual([]);
  });
});
