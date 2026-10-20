/**
 * Lo que el asistente explica de NEXO tiene que existir en NEXO.
 *
 * `AYUDA` (herramientas.ts) nombra las pantallas como «Grupo › Pantalla» y los botones entre comillas angulares. Si el menú de la consola cambia
 * y la ayuda no, el asistente manda a la persona a una pantalla que ya no existe. Este test lee el menú de `consola.html` y comprueba que cada
 * camino y cada botón nombrado en la ayuda sigue estando.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AYUDA } from '@aai/api/asistente/herramientas';
import { beforeAll, describe, expect, it } from 'vitest';

const RAIZ = join(import.meta.dirname, '..', '..');

describe('la ayuda del asistente coincide con la consola', () => {
  let html = '';
  const menu = new Map<string, string[]>();

  beforeAll(async () => {
    html = await readFile(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');
    let grupo = '';
    for (const m of html.matchAll(/class="gnav-t"[^>]*>([^<]+)<|<button data-vista="[a-z-]+"[^>]*?data-nombre="([^"]+)"/gu)) {
      if (m[1] !== undefined) {
        grupo = m[1].trim();
        menu.set(grupo, []);
      } else if (grupo !== '') {
        menu.get(grupo)!.push(m[2]!);
      }
    }
  });

  it('el menú de la consola se leyó entero', () => {
    expect([...menu.keys()]).toContain('Compras');
    expect(menu.get('Compras')).toContain('Documentos');
  });

  it('cada «Grupo › Pantalla» que nombra la ayuda existe en el menú', () => {
    const rotos: string[] = [];
    for (const [tema, texto] of Object.entries(AYUDA)) {
      for (const m of texto.matchAll(/([\p{L} ]+?) › ([\p{L} ]+)/gu)) {
        const grupo = [...menu.keys()].find((g) => m[1]!.trim().endsWith(g));
        if (grupo === undefined) { rotos.push(`${tema}: el grupo de «${m[0]}» no existe`); continue; }
        const resto = m[2]!.trim();
        if (!menu.get(grupo)!.some((n) => resto.startsWith(n))) rotos.push(`${tema}: «${grupo} › ${resto}» no es una pantalla de ese grupo`);
      }
    }
    expect(rotos).toEqual([]);
  });

  it('cada botón entre «comillas angulares» está en la consola', () => {
    const faltan: string[] = [];
    // Los textos de los botones y de los pasos de las guías viven en consola.html.
    for (const [tema, texto] of Object.entries(AYUDA)) {
      for (const m of texto.matchAll(/«([^»]+)»/gu)) {
        const boton = m[1]!.replace(/\.$/u, '');
        if (['aceptar todas'].includes(boton)) continue;
        if (!html.includes(boton)) faltan.push(`${tema}: «${boton}»`);
      }
    }
    expect(faltan).toEqual([]);
  });
});
