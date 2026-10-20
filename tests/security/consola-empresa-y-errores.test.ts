/**
 * La consola explica los errores y obliga a elegir empresa al entrar.
 *
 * Dos defectos que vio el titular el 2026-10-20:
 *
 *   1. Con dos empresas la consola mostraba la lista y dejaba tocar cualquier botón del menú **sin haber elegido una**. Cada pedido salía sin
 *      la cabecera `X-Company-Id` y el servidor contestaba «Falta la cabecera X-Company-Id…»: un error técnico, sin una palabra de qué hacer.
 *   2. Los errores se mostraban con la frase del servidor y un JSON plegado, pero **sin explicar qué pasó ni qué hacer**.
 *
 * Qué se afirma: (a) sin empresa elegida no se entra a ninguna pantalla de trabajo ni se dispara un pedido; (b) cada error —por código o por
 * familia de estado— sale con «Qué pasó» y «Qué hacer», y el de la empresa sin elegir manda a «Cambiar de empresa».
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const CONSOLA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'consola.html');

type Explicar = (r: { ok: boolean; status: number; datos: unknown }) => { paso: string; hacer: string };

describe('la consola: elegir empresa al entrar y errores explicados', () => {
  let html = '';
  let explicarError: Explicar;

  beforeAll(async () => {
    html = await readFile(CONSOLA, 'utf8');
    const ini = html.indexOf('function explicarError(r) {');
    const fin = html.indexOf('function decir(destino, resultado, exito) {');
    expect(ini, 'falta explicarError').toBeGreaterThan(0);
    expect(fin, 'falta decir').toBeGreaterThan(ini);
    explicarError = new Function(`${html.slice(ini, fin)}; return explicarError;`)() as Explicar;
  });

  describe('elegir la empresa a penas se entra', () => {
    it('ir() manda a la lista de empresas si hay empresas y todavía no se eligió ninguna', () => {
      const ir = html.slice(html.indexOf('function ir(vista, migas) {'), html.indexOf('function ir(vista, migas) {') + 400);
      expect(ir).toContain('faltaElegirEmpresa(vista)');
      expect(ir).toContain("vista = 'empresa'");
      expect(html).toMatch(/function faltaElegirEmpresa\(vista\) \{\s*return !estado\.empresa && estado\.empresas\.length > 0 && PANTALLAS_SIN_EMPRESA\.indexOf\(vista\) === -1;/u);
      expect(html).toContain("const PANTALLAS_SIN_EMPRESA = ['login', 'mfa', 'alta-empresa', 'empresa'];");
    });

    it('un botón del menú sin empresa elegida explica y NO dispara ningún pedido', () => {
      const ini = html.indexOf("for (const b of document.querySelectorAll('nav button')) {\n  b.onclick = () => {");
      const manejador = html.slice(ini, ini + 2500);
      const guarda = manejador.indexOf('if (faltaElegirEmpresa(v))');
      const primerCargador = manejador.indexOf("if (v === 'inicio')");
      expect(guarda, 'falta la guarda').toBeGreaterThan(0);
      expect(primerCargador, 'el primer cargador no está donde se esperaba').toBeGreaterThan(0);
      expect(guarda, 'la guarda tiene que ir ANTES de cualquier cargador').toBeLessThan(primerCargador);
      expect(manejador.slice(guarda, primerCargador)).toContain('return;');
      expect(manejador.slice(guarda, primerCargador)).toContain('Primero elegí con qué empresa querés trabajar');
    });

    it('al entrar con varias empresas, el menú queda apagado y la pantalla dice que hay que elegir', () => {
      expect(html).toContain('nav[data-sin-empresa="si"] button:not([data-vista="empresa"])');
      expect(html).toContain('id="empresa-elegir"');
      expect(html).toContain('Elegí con qué empresa querés trabajar.');
      const cartera = html.slice(html.indexOf('async function continuarSegunCartera'), html.indexOf('async function continuarSegunCartera') + 3500);
      expect(cartera).toContain("E('nav').dataset.sinEmpresa = 'si'");
      expect(cartera).toContain("E('empresa-elegir').hidden = false");
    });

    it('al elegir una empresa el menú se enciende, y si no se pudo entrar a ella se vuelve a «sin elegir»', () => {
      const usar = html.slice(html.indexOf('async function usarEmpresa(id) {'), html.indexOf('async function usarEmpresa(id) {') + 1500);
      expect(usar).toContain("E('nav').dataset.sinEmpresa = 'no'");
      expect(usar).toContain('estado.empresa = null');
    });

    it('cada empresa de la lista tiene un botón claro, no una palabra suelta', () => {
      expect(html).toContain('Trabajar con esta empresa</button>');
    });
  });

  describe('los errores se explican', () => {
    it('decir() agrega «Qué pasó» y «Qué hacer» a todo error', () => {
      const decir = html.slice(html.indexOf('function decir(destino, resultado, exito) {'), html.indexOf('function decir(destino, resultado, exito) {') + 3500);
      expect(decir).toContain('explicarError(resultado)');
      expect(decir).toContain('Qué pasó:');
      expect(decir).toContain('Qué hacer:');
    });

    it('el error de la empresa sin elegir manda a «Cambiar de empresa»', () => {
      const r = explicarError({
        ok: false,
        status: 403,
        datos: { error: 'FORBIDDEN', message: 'Falta la cabecera X-Company-Id o no es un identificador válido' },
      });
      expect(r.paso).toMatch(/empresa/u);
      expect(r.hacer).toContain('Cambiar de empresa');
    });

    it('los errores conocidos tienen su explicación propia', () => {
      const casos: Array<[string, number, string, RegExp]> = [
        ['MFA_SETUP_REQUIRED', 403, 'x', /segundo factor/u],
        ['MFA_REQUIRED', 401, 'x', /código/u],
        ['INVALID_CREDENTIALS', 401, 'x', /contraseña/u],
        ['SUSCRIPCION_SUSPENDIDA', 403, 'x', /suspendida/u],
        ['DEGRADADA_POR_MORA', 403, 'x', /sin pagar/u],
        ['FUERA_DEL_PLAN', 403, 'x', /plan/u],
        ['SIN_CONEXION', 0, 'x', /internet/u],
      ];
      for (const [codigo, status, message, patron] of casos) {
        const r = explicarError({ ok: false, status, datos: { error: codigo, message } });
        expect(`${r.paso} ${r.hacer}`, codigo).toMatch(patron);
      }
    });

    it('un error sin código conocido se explica igual por su familia de estado: nunca sale sin «qué hacer»', () => {
      for (const status of [0, 400, 401, 403, 404, 409, 418, 422, 429, 500, 502, 503]) {
        const r = explicarError({ ok: false, status, datos: { error: 'ALGO_NUEVO', message: 'm' } });
        expect(r.paso.length, `${status} sin «qué pasó»`).toBeGreaterThan(20);
        expect(r.hacer.length, `${status} sin «qué hacer»`).toBeGreaterThan(20);
      }
      // Y sin cuerpo (por ejemplo, un 502 del proxy con HTML).
      const r = explicarError({ ok: false, status: 502, datos: null });
      expect(r.hacer).toMatch(/soporte/u);
    });

    it('api() convierte una caída de red en una respuesta explicable, no en una excepción suelta', () => {
      const api = html.slice(html.indexOf('async function api(method, url, cuerpo, esForma, claveDeIdempotencia) {'));
      expect(api.slice(0, 2200)).toContain("error: 'SIN_CONEXION'");
      expect(api.slice(0, 2200)).toContain('e instanceof TypeError');
    });
  });
});
