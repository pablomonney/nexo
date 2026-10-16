/**
 * La landing lleva a contratar: «Elegir este plan» y «Cómo pagás y cómo entrás».
 *
 * Tres costuras que se rompen sin ruido:
 *
 *   1. El botón de cada tarjeta de precios **se crea después** de que carga la página (cuando llega `GET /planes`), así que el
 *      interruptor de modo que reescribe los `[data-cta]` al cargar no lo ve. Si no se lo vuelve a llamar sobre las tarjetas,
 *      en la versión publicable sin consola ese botón da 404.
 *   2. El plan viaja en la dirección (`/consola?plan=CODIGO`). La consola no confía en él: lo valida con una forma fija y sólo lo
 *      usa si coincide con un plan del catálogo.
 *   3. La sección de pago no promete lo que no está: hoy se paga por transferencia, y el pago con tarjeta figura como «lo que viene».
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('la landing lleva a contratar', () => {
  let landing = '';
  let consola = '';

  beforeAll(async () => {
    landing = await readFile(join(RAIZ, 'apps', 'web', 'landing.html'), 'utf8');
    consola = await readFile(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');
  });

  it('cada tarjeta de plan lleva a la consola con su código, y el modo presentación puede reescribirla', () => {
    expect(landing).toMatch(/href="\/consola\?plan=' \+ encodeURIComponent\([^)]*\) \+ '" data-cta="plan"/u);
    // Las tarjetas nacen después de la carga: el interruptor tiene que volver a pasar sobre ellas.
    expect(landing).toContain('ajustarBotones(cuerpo)');
    expect(landing).toMatch(/function ajustarBotones\(raiz\)/u);
    expect(landing).toMatch(/\bajustarBotones\(document\);/u);
  });

  it('la sección de pago existe, está en el menú y lleva a entrar y a probar', () => {
    expect(landing).toContain('<section id="pagar">');
    expect(landing).toContain('href="#pagar"');
    const seccion = landing.slice(landing.indexOf('<section id="pagar">'), landing.indexOf('</section>', landing.indexOf('<section id="pagar">')));
    expect(seccion).toContain('data-cta="entrar"');
    expect(seccion).toContain('data-cta="prueba"');
  });

  it('no promete el pago con tarjeta: hoy es transferencia, y la tarjeta está entre lo que viene', () => {
    const seccion = landing.slice(landing.indexOf('<section id="pagar">'), landing.indexOf('</section>', landing.indexOf('<section id="pagar">')));
    expect(seccion).toMatch(/por transferencia/u);
    expect(seccion).toMatch(/pago con tarjeta todavía no está disponible/u);
    expect(landing).toMatch(/Pago con tarjeta\.<\/strong> Por ahora la suscripción se abona por\s+transferencia/u);
  });

  it('la consola valida el plan de la dirección con una forma fija y sólo lo usa si el catálogo lo conoce', () => {
    expect(consola).toMatch(/get\('plan'\)/u);
    expect(consola).toMatch(/\/\^\[A-Za-z0-9_-\]\{1,40\}\$\/u\.test\(p\)/u);
    // Preselecciona sólo entre las opciones que el catálogo cargó.
    expect(consola).toMatch(/\[\.\.\.sel\.options\]\.some\(\(o\) => o\.value === PLAN_DE_LA_LANDING\)/u);
    // El aviso se arma con textContent, nunca con el valor de la dirección pegado en HTML.
    const aviso = consola.slice(consola.indexOf('async function anunciarPlanDeLaLanding'), consola.indexOf('async function cargarPlanes'));
    expect(aviso).toContain('.textContent =');
    expect(aviso).not.toContain('innerHTML');
    expect(consola).toContain('id="plan-elegido"');
  });
});
