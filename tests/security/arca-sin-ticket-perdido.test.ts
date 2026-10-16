/**
 * S-49 — ningún script le pide un ticket al WSAA sin guardarlo.
 *
 * El WSAA da **un** ticket por CUIT y servicio y niega el segundo mientras el primero viva (horas). Un script que lo pide
 * con `authenticator.login(...)` directo y lo descarta deja ese servicio «ocupado»: el comando siguiente —el que de verdad
 * emite o consulta— se queda sin ticket hasta que venza el anterior. Pasó el 2026-10-16: `arca:capabilities` consumió el de
 * `wsfe` y la emisión de homologación quedó bloqueada ~12 horas.
 *
 * Todo script que hable con el WSAA tiene que pasar por `loginConCache` (que reusa el ticket vivo y guarda el nuevo).
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

describe('S-49 — los scripts que hablan con ARCA no pierden el ticket', () => {
  it('ningún script llama a `.login(` del autenticador sin pasar por `loginConCache`', async () => {
    const archivos = (await readdir(SCRIPTS)).filter((n) => n.endsWith('.mjs'));
    const infractores: string[] = [];
    for (const nombre of archivos) {
      const texto = await readFile(join(SCRIPTS, nombre), 'utf8');
      const sinComentarios = texto.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
      if (/\b(?:authenticator|autenticador)\.login\(/u.test(sinComentarios)) infractores.push(nombre);
    }
    expect(infractores, 'Estos scripts piden un ticket al WSAA y lo descartan: usá loginConCache con TicketCacheFs.').toEqual([]);
  });

  it('el relevamiento de servicios usa la caché compartida', async () => {
    const texto = await readFile(join(SCRIPTS, 'arca-capabilities.mjs'), 'utf8');
    expect(texto).toContain('loginConCache(');
    expect(texto).toContain('TicketCacheFs');
  });
});
