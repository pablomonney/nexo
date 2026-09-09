/**
 * S-34 — La landing se puede publicar sin API detrás.
 *
 * `apps/web/landing.html` **no es una página estática**, aunque lo parezca:
 * pide los precios a `GET /planes` y sus botones llevan a `/consola`. Medido el
 * 2026-09-09 sirviéndola como archivos y nada más:
 *
 *     /              200
 *     /planes        404   → la tabla de precios queda en «No se pudieron
 *                            cargar los planes», para siempre, no un rato
 *     /consola       404   → los tres botones, incluido «Probar 14 días»
 *
 * Publicar eso sería publicar una página cuyo núcleo comercial es un mensaje de
 * error y cuyos botones enseñan, en el primer minuto, que el sistema no anda.
 *
 * `scripts/construir-landing.mjs` produce la versión que sí se puede publicar:
 * congela los precios desde la base y hace que los botones no prometan una
 * prueba que hoy no se puede empezar. Este control cuida las dos costuras por
 * donde eso se rompe en silencio.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LANDING = join(RAIZ, 'apps', 'web', 'landing.html');

describe('S-34 — la landing se puede publicar sin API detrás', () => {
  let html = '';

  beforeAll(async () => {
    html = await readFile(LANDING, 'utf8');
  });

  /**
   * La costura que importa: un enlace a la consola que el modo no puede tocar.
   *
   * El interruptor de modo recorre `[data-cta]`. Un enlace a `/consola` sin ese
   * atributo sobrevive intacto a la construcción y **da 404 en la página
   * publicada** — y nadie lo va a notar hasta que alguien lo apriete, porque
   * todo lo demás funciona.
   */
  it('todo enlace a la consola está marcado para que el modo lo alcance', () => {
    const enlaces = [...html.matchAll(/<a\b[^>]*href="\/consola"[^>]*>/g)].map((m) => m[0]);

    expect(enlaces.length, 'la landing dejó de enlazar a la consola: ¿se movió el enlace?')
      .toBeGreaterThan(0);

    const sinMarcar = enlaces.filter((a) => !a.includes('data-cta='));
    expect(
      sinMarcar,
      'estos enlaces van a la consola y no llevan `data-cta`, así que el modo presentación ' +
        'no los puede cambiar: en la página publicada van a dar 404',
    ).toEqual([]);
  });

  /**
   * Los cuatro ajustes existen y están en el valor de desarrollo.
   *
   * Si alguien commitea la landing con `nexo-modo` en `presentacion` —copiando
   * de vuelta el archivo construido, por ejemplo— el sitio que sirve la API
   * empezaría a esconder sus propios botones y a leer precios congelados, sin
   * un solo error.
   */
  it('en el repositorio la landing queda siempre en modo aplicación', () => {
    const esperado = {
      'nexo-modo': 'app',
      'nexo-planes': '/planes',
      'nexo-contacto': '',
      'nexo-precios-al': '',
    };

    for (const [nombre, valor] of Object.entries(esperado)) {
      const m = new RegExp(`<meta name="${nombre}" content="([^"]*)">`).exec(html);
      expect(m, `falta el <meta name="${nombre}"> que usa el script de construcción`).not.toBeNull();
      expect(m?.[1], `el <meta name="${nombre}"> quedó con el valor de un despliegue`).toBe(valor);
    }
  });

  it('el precio no está escrito en el HTML, ni en la versión publicable', () => {
    // La regla más vieja de esta página. Un precio en el marcado es una segunda
    // verdad sobre el precio, y el día que difiera de la base el cliente ve un
    // número en la página y otro en la factura.
    const cuerpo = html.slice(html.indexOf('<body'));
    const importes = cuerpo.match(/\b\d{2}\.?\d{3}\b/g) ?? [];
    expect(
      importes,
      'hay algo con forma de precio escrito en el HTML de la landing',
    ).toEqual([]);
  });
});
