/**
 * S-43 — La imagen lleva lo que el arranque necesita.
 *
 * ## El defecto que este control existe para que no vuelva
 *
 * El 2026-09-10, el primer despliegue real de NEXO **no arrancó**:
 *
 *     NEXO no arranca:
 *       ✘ no se encontró infrastructure/db/migrations, así que no se pudo
 *         comprobar el esquema
 *
 * El Dockerfile copiaba `packages`, `apps`, `node_modules` y `package.json`, y
 * no `infrastructure`. El preflight de `arranque.ts` compara los `.sql` del
 * disco contra `schema_migrations` y **se niega a arrancar** si no puede
 * hacerlo — que es lo correcto: un servidor contra un esquema viejo anda a
 * medias, y ese es el estado más caro de diagnosticar.
 *
 * Nadie lo vio antes porque los dos lados eran correctos por separado. El
 * preflight leía un directorio que existe en el repositorio; el Dockerfile
 * copiaba lo que hace falta para **ejecutar**. Lo que faltaba era la pregunta
 * que cruza los dos: *¿qué lee el proceso al arrancar, y está en la imagen?*
 *
 * ## Por qué el control mira el Dockerfile y no la imagen construida
 *
 * Porque construir una imagen en la suite exigiría Docker en cada máquina que
 * corra los tests y en CI, y tardaría minutos. Lo que sí se puede comprobar sin
 * Docker es la correspondencia: **todo directorio del repositorio que el código
 * lea en tiempo de ejecución tiene que estar copiado a la etapa de runtime.**
 *
 * Es un control de correspondencia, como S-38 con `.env.example`: dos listas que
 * tienen que decir lo mismo y que nadie compara hasta que algo se rompe.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Directorios del repositorio que el proceso lee **al ejecutarse**, y por qué.
 *
 * No es la lista de lo que hace falta para compilar: es la de lo que el
 * contenedor abre cuando ya está corriendo. Un directorio que solo se usa en
 * los tests no va acá.
 */
const LEIDOS_EN_EJECUCION: Readonly<Record<string, string>> = {
  infrastructure:
    'El preflight de `arranque.ts` lee `infrastructure/db/migrations` para comparar contra ' +
    '`schema_migrations`. Sin esto el servidor **no arranca**.',
  apps:
    'El código compilado (`apps/api/dist`) y las páginas que sirve la API: `apps/web/landing.html` ' +
    'y `apps/web/consola.html` se leen con `readFile` en cada pedido.',
  packages: 'Los dieciséis paquetes compilados que importa la API.',
};

async function dockerfile(): Promise<string> {
  return readFile(join(RAIZ, 'Dockerfile'), 'utf8');
}

/** Las dos etapas, partidas por el `FROM ... AS runtime`. */
function etapas(texto: string): { build: string; runtime: string } {
  const corte = texto.search(/^FROM\s+\S+\s+AS\s+runtime/mu);
  expect(corte, 'el Dockerfile no tiene una etapa `runtime`').toBeGreaterThan(0);
  return { build: texto.slice(0, corte), runtime: texto.slice(corte) };
}

describe('S-43 — la imagen de producción lleva lo que el arranque lee', () => {
  it('todo directorio que el proceso lee está copiado a la etapa de runtime', async () => {
    const { runtime } = etapas(await dockerfile());
    const faltan: string[] = [];

    for (const [directorio, motivo] of Object.entries(LEIDOS_EN_EJECUCION)) {
      const copiado = new RegExp(
        `COPY\\s+--from=build[^\\n]*\\s/app/${directorio}\\s+\\./${directorio}`,
        'u',
      ).test(runtime);
      if (!copiado) faltan.push(`${directorio} — ${motivo}`);
    }

    expect(
      faltan,
      'La imagen de producción no lleva estos directorios, y el proceso los lee al correr. ' +
        'El contenedor va a construirse bien y fallar al arrancar:\n  ' +
        faltan.join('\n  '),
    ).toEqual([]);
  });

  it('lo que la etapa de runtime copia, la de build lo trajo antes', async () => {
    // La dependencia circular que se cometió el 2026-09-10: `COPY --from=build
    // /app/infrastructure` en runtime **sin** haber hecho `COPY infrastructure`
    // en build. La etapa de build no tiene el directorio, así que la copia
    // falla y el error no menciona la causa.
    const { build, runtime } = etapas(await dockerfile());
    const huerfanos: string[] = [];

    for (const m of runtime.matchAll(/COPY\s+--from=build[^\n]*\s\/app\/([A-Za-z0-9_.-]+)\s/gu)) {
      const recurso = m[1]!;
      // `node_modules` lo produce `npm ci` y no se copia del contexto.
      if (recurso === 'node_modules') continue;
      const enBuild =
        new RegExp(`^COPY\\s+(?!--from)[^\\n]*\\b${recurso}\\b`, 'mu').test(build) ||
        // Un archivo suelto puede venir en un COPY múltiple hacia `./`.
        new RegExp(`^COPY\\s+(?!--from)[^\\n]*\\s${recurso}[^\\n]*\\s\\./`, 'mu').test(build);
      if (!enBuild) huerfanos.push(recurso);
    }

    expect(
      huerfanos,
      'La etapa de runtime copia esto desde `build`, y `build` nunca lo trajo del contexto. ' +
        'La copia va a fallar:\n  ' + huerfanos.join('\n  '),
    ).toEqual([]);
  });

  it('el directorio que el preflight lee existe en el repositorio', async () => {
    // El control positivo. Sin él, renombrar `infrastructure/db/migrations`
    // dejaría los dos casos de arriba en verde sobre un directorio inexistente.
    const { readdir } = await import('node:fs/promises');
    const migraciones = await readdir(join(RAIZ, 'infrastructure', 'db', 'migrations'));
    expect(migraciones.filter((n) => n.endsWith('.sql')).length).toBeGreaterThan(100);
  });

  it('la imagen no lleva secretos ni el archivo de entorno', async () => {
    const ignorados = await readFile(join(RAIZ, '.dockerignore'), 'utf8');
    // `.env` es lo primero de la lista a propósito: es el archivo que más
    // rápido convierte una imagen en una filtración, y una imagen se comparte.
    expect(ignorados).toMatch(/^\.env$/mu);
    expect(ignorados).toMatch(/^\.env\.\*$/mu);

    const texto = await dockerfile();
    expect(texto, 'el Dockerfile copia el archivo de entorno a la imagen').not.toMatch(
      /^COPY\s+[^\n]*\.env(?!\.example)/mu,
    );
  });

  /**
   * El contenedor corre con el sistema de archivos de solo lectura.
   *
   * `docker-compose.prod.yml` declara `read_only: true`, y eso es una promesa
   * sobre el código: **la API no escribe en ningún lado salvo el volumen de
   * documentos**. Si alguien agrega una escritura a otra ruta, el contenedor
   * deja de funcionar en producción con un `EROFS` que no menciona la causa.
   *
   * Verificado el 2026-09-10: el único escritor de la API es
   * `FilesystemDocumentStore`, que apunta a `DOCUMENT_STORAGE_PATH`. El otro
   * escritor del repositorio, `TicketCacheFs`, lo usan **solo los scripts** —el
   * cliente SOAP de la API cae en `InMemoryTicketCache`— y esos corren fuera
   * del contenedor.
   */
  it('la API no escribe fuera del volumen de documentos', async () => {
    const { readdir } = await import('node:fs/promises');
    const escritores = /\b(writeFile|writeFileSync|createWriteStream|appendFile|mkdir|mkdirSync)\b/u;
    const culpables: string[] = [];

    const recorrer = async (carpeta: string): Promise<void> => {
      for (const e of await readdir(carpeta, { withFileTypes: true })) {
        const ruta = join(carpeta, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === 'dist') continue;
          await recorrer(ruta);
          continue;
        }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
        const fuente = await readFile(ruta, 'utf8');
        if (escritores.test(fuente.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, ''))) {
          culpables.push(ruta.slice(RAIZ.length + 1).replace(/\\/gu, '/'));
        }
      }
    };

    await recorrer(join(RAIZ, 'apps', 'api', 'src'));

    expect(
      culpables,
      'Estos archivos de la API escriben en disco. El contenedor de producción corre con ' +
        '`read_only: true` y lo único montado como escribible es `/app/var/documents`: una ' +
        'escritura a otra ruta falla con EROFS en producción y anda perfecto en desarrollo. ' +
        'Si la escritura es legítima, hay que montar su ruta en el compose:\n  ' +
        culpables.join('\n  '),
    ).toEqual([]);
  });

  it('el contenedor no corre como root y no migra al arrancar', async () => {
    const texto = await dockerfile();
    expect(texto).toMatch(/^USER\s+node/mu);

    // Un contenedor que migra al levantarse convierte cada réplica nueva en una
    // carrera contra las otras. El orden está en docs/DESPLIEGUE.md §7.2.
    const cmd = /^CMD\s+(.+)$/mu.exec(texto);
    expect(cmd?.[1]).toContain('apps/api/dist/index.js');
    expect(cmd?.[1] ?? '', 'el CMD migra al arrancar').not.toMatch(/migrate|db:setup/u);
  });
});
