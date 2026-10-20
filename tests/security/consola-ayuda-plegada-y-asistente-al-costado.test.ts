/**
 * Cada pantalla abre directo en lo que se hace; la explicación está detrás de un «?»; el asistente vive al costado; el menú habla en sustantivos.
 *
 * Lo pidió el titular el 2026-10-20: «cuando entres a cada lugar, no te diga cómo funciona por dentro (…) un cuadradito a la derecha arriba
 * que diga que vos puedas desplegar la explicación» y «no pongas comprar, vender: poné compras, ventas, y que quede bien profesional».
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const CONSOLA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'consola.html');

describe('la consola: ayuda plegada, asistente al costado, menú profesional', () => {
  let html = '';
  beforeAll(async () => {
    html = await readFile(CONSOLA, 'utf8');
  });

  it('el panel de ayuda de cada pantalla nace cerrado y se abre con un «?» arriba a la derecha del título', () => {
    const f = html.slice(html.indexOf('function construirTarjeta(vista, g) {'), html.indexOf('/** Los atajos dependen de lo que el menú le deja ver'));
    expect(f).toContain('t.hidden = true;');
    expect(f).toContain("nodo('button', 'h2-ayuda', '?')");
    expect(f).toContain("q.setAttribute('aria-expanded', 'false')");
    expect(f).toContain('h2.appendChild(q);');
    expect(html).toMatch(/\.h2-ayuda\{margin:0 0 0 auto;/u);
    // Se arma para TODAS las pantallas, no sólo las que tienen guía.
    expect(html).toContain('for (const vista of VISTAS) construirTarjeta(vista, GUIAS[vista]);');
  });

  it('cada pantalla se abre con la ayuda cerrada, y la explicación técnica va dentro del panel', () => {
    const r = html.slice(html.indexOf('function refrescar(vista) {'), html.indexOf('function refrescar(vista) {') + 900);
    expect(r).toContain('panel.hidden = true;');
    expect(html).toContain("d.appendChild(nodo('summary', '', g !== undefined ? 'Detalle del funcionamiento' : 'Leer la explicación'));");
  });

  it('la ayuda ya no se recuerda abierta ni cerrada: no hay clave de localStorage de las guías', () => {
    expect(html).not.toContain('CLAVE_GUIAS');
    expect(html).not.toContain("'nexo-guias'");
  });

  it('el asistente es un panel fijo al costado: no reemplaza la pantalla en la que estás', () => {
    expect(html).toMatch(/#v-asistente\{position:fixed;top:0;right:0;bottom:0;/u);
    const ir = html.slice(html.indexOf('function ir(vista, migas) {'), html.indexOf('function ir(vista, migas) {') + 900);
    expect(ir).toContain("if (vista === 'asistente') { ASISTENTE_LADO.abrir(true); return; }");
    expect(ir).toContain("if (s && v !== 'asistente') s.hidden = v !== vista;");
    expect(html).toContain('id="b-as-lado"');
    expect(html).toContain('id="b-as-cerrar"');
    // Sin empresa elegida no se abre (la guarda del menú corre antes), y al salir a ingresar se cierra.
    expect(ir).toContain('if (PANTALLAS_SIN_EMPRESA.indexOf(vista) !== -1) ASISTENTE_LADO.abrir(false);');
  });

  it('el menú nombra los grupos con sustantivos, no con verbos', () => {
    const grupos = [...html.matchAll(/class="gnav-t"[^>]*>([^<]+)</gu)].map((m) => m[1]!.trim());
    expect(grupos).toEqual(['General', 'Ventas', 'Compras', 'Tesorería', 'Inventario y operaciones', 'Contabilidad', 'Análisis', 'Administración']);
    const botones = [...html.matchAll(/<button data-vista="(?!empresa)[a-z-]+"[^>]*data-nombre="([^"]+)"/gu)].map((m) => m[1]!);
    expect(botones.length).toBeGreaterThan(30);
    expect(botones.filter((n) => /^(Preguntar|Vender|Comprar|Cobrar|Pagar)\b/u.test(n))).toEqual([]);
  });

  it('recargar la pantalla no cierra la sesión: se pregunta al servidor y se vuelve a la empresa y a la pantalla de la pestaña', () => {
    const f = html.slice(html.indexOf('(async function restaurarLaSesion() {'));
    expect(f).toContain("api('GET', '/auth/me')");
    expect(f).toContain('continuarSegunCartera');
    expect(f).toContain('usarEmpresa(empresaGuardada)');
    // Sólo identificadores, por pestaña: nunca una credencial ni localStorage.
    expect(html).toContain("sessionStorage.setItem(clave, valor)");
    expect(html).toContain('recordarEnLaPestana(CLAVE_EMPRESA_DE_LA_PESTANA, id);');
    expect(html).toContain('olvidarLaPestana();\n  location.reload();');
  });
});
