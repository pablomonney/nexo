/**
 * Los tickets del WSAA son una credencial: viven en un solo lugar y no se loguean.
 *
 * `arca_access_tickets` guarda `token` y `sign`, que autorizan a operar ante ARCA en nombre del contribuyente mientras duran
 * (horas). La caché compartida (`TicketCacheDb`, E2) es el único código que toca esa tabla; nada más puede leerla, y
 * ninguna línea de ese archivo puede mandar un `token` o un `sign` a un log, a una respuesta o a la bitácora.
 *
 * Es la misma lógica que la regla del repositorio para claves y certificados (§27 del pliego): una credencial se confina,
 * porque una vez que anda suelta por el código, el próximo `console.log` de depuración la publica.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = 'apps/api/src/arca/ticket-cache-db.ts';

async function fuentes(dir: string): Promise<string[]> {
  const salida: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const ruta = join(dir, e.name);
    if (e.isDirectory()) salida.push(...(await fuentes(ruta)));
    else if (/\.(ts|mjs|js)$/u.test(e.name)) salida.push(ruta);
  }
  return salida;
}

describe('tickets del WSAA — confinados', () => {
  it('sólo la caché compartida nombra la tabla (fuera de las migraciones y los tests)', async () => {
    const nombran: string[] = [];
    for (const base of ['apps', 'packages', 'scripts']) {
      for (const ruta of await fuentes(join(RAIZ, base))) {
        const texto = await readFile(ruta, 'utf8');
        if (/arca_access_tickets/u.test(texto)) nombran.push(relative(RAIZ, ruta).split(sep).join('/'));
      }
    }
    // `credentials.ts` la nombra sólo en un comentario («en producción se usa la tabla…»).
    const permitidos = new Set([CACHE, 'packages/arca/src/credentials.ts', 'packages/arca/dist/credentials.js', 'packages/arca/dist/credentials.d.ts']);
    expect(
      nombran.filter((r) => !permitidos.has(r)),
      'otro código lee o escribe los tickets del WSAA: tienen que pasar por TicketCacheDb',
    ).toEqual([]);
    expect(nombran).toContain(CACHE);
  });

  it('el archivo de la caché no loguea ni devuelve token ni sign', async () => {
    const texto = await readFile(join(RAIZ, CACHE), 'utf8');
    // Sin comentarios: la documentación puede nombrar las palabras.
    const codigo = texto.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    expect(codigo).not.toMatch(/console\.|logger|log\.(info|warn|error|debug)|recordAudit|reply\.|JSON\.stringify/u);
  });

  it('la tabla no tiene company_id, así que la exportación de una empresa no la alcanza', async () => {
    const mig = await readFile(join(RAIZ, 'infrastructure/db/migrations/0015_arca_integration.sql'), 'utf8');
    const i = mig.indexOf('CREATE TABLE arca_access_tickets');
    const cuerpo = mig.slice(i, mig.indexOf(');', i));
    expect(cuerpo).not.toMatch(/company_id/u);
  });
});
