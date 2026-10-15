/**
 * «Recordar en este dispositivo» en el ingreso de la consola.
 *
 * Lo que se pidió: que el ingreso recuerde el correo y la contraseña. Lo que se hizo, y por qué:
 *
 *   · el CORREO se recuerda en `localStorage`;
 *   · la CONTRASEÑA **no** se guarda en la página: se le pide al gestor de contraseñas del navegador
 *     (`PasswordCredential`) y el formulario lleva los `autocomplete` que hacen que el navegador ofrezca guardarla.
 *
 * Guardar la contraseña en `localStorage` la dejaría en texto plano a disposición de cualquier script que llegara a
 * correr en la consola (un XSS), en un sistema que lleva contabilidad de terceros. Esta suite fija esa frontera.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const consola = readFileSync(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');

describe('el ingreso: formulario, casilla y gestor de contraseñas', () => {
  it('es un <form> con usuario y contraseña reconocibles por el navegador', () => {
    expect(consola).toMatch(/<form id="f-login"[^>]*autocomplete="on"/u);
    expect(consola).toMatch(/<input id="email"[^>]*autocomplete="username"/u);
    expect(consola).toMatch(/<input id="pass" type="password"[^>]*autocomplete="current-password"/u);
  });

  it('tiene la casilla «Recordar en este dispositivo», sin marcar de fábrica, dentro del formulario', () => {
    expect(consola).toMatch(/<input type="checkbox" id="recordar">\s*Recordar en este dispositivo/u);
    expect(consola).not.toMatch(/<input type="checkbox" id="recordar"[^>]*checked/u);
    const form = consola.slice(consola.indexOf('<form id="f-login"'), consola.indexOf('</form>', consola.indexOf('<form id="f-login"')));
    expect(form).toContain('id="recordar"');
    expect(form).toContain('id="b-login"');
  });

  it('el envío del formulario no navega (la consola habla con la API)', () => {
    expect(consola).toMatch(/E\('f-login'\)\.onsubmit = \(ev\) => \{ ev\.preventDefault\(\); \};/u);
  });
});

describe('la contraseña nunca se guarda en la página', () => {
  it('ningún localStorage/sessionStorage/cookie recibe la contraseña ni el campo #pass', () => {
    const escrituras = [...consola.matchAll(/(?:localStorage|sessionStorage)\.setItem\(([^)]*)\)/gu)].map((m) => m[1]!);
    expect(escrituras.length).toBeGreaterThan(0);
    for (const argumentos of escrituras) {
      expect(argumentos, `se guarda algo que parece la contraseña: ${argumentos}`).not.toMatch(/pass|contrasena|password/iu);
    }
    expect(consola).not.toMatch(/document\.cookie\s*=[^;]*(pass|contrasena|password)/iu);
  });

  it('la única clave de localStorage del ingreso es la del correo', () => {
    const claves = [...consola.matchAll(/(?:localStorage)\.setItem\(([^,)]*)/gu)].map((m) => m[1]!.trim());
    expect(new Set(claves)).toEqual(new Set(['CLAVE_CORREO_RECORDADO', "'nexo-tema'"]));
    expect(consola).toContain("const CLAVE_CORREO_RECORDADO = 'nexo-correo-recordado';");
  });

  it('la contraseña sólo sale de la página hacia el gestor del navegador (PasswordCredential) y hacia /auth/login', () => {
    const i = consola.indexOf('async function recordarEsteDispositivo');
    expect(i).toBeGreaterThan(0);
    const funcion = consola.slice(i, consola.indexOf('\n}\n', i));
    expect(funcion).toContain('new window.PasswordCredential({ id: correo, password: contrasena, name: correo })');
    // Lo único que va a localStorage dentro de la función es el correo.
    expect(funcion).toMatch(/localStorage\.setItem\(CLAVE_CORREO_RECORDADO, correo\)/u);
    expect(funcion).not.toMatch(/localStorage\.setItem\([^)]*contrasena/u);
  });
});

describe('el comportamiento del ingreso', () => {
  const i = consola.indexOf("E('b-login').onclick");
  const manejador = consola.slice(i, consola.indexOf('\n};\n', i));

  it('con la casilla marcada y un ingreso correcto recuerda; sin marcar, olvida el correo guardado', () => {
    expect(manejador).toContain("if (E('recordar').checked) await recordarEsteDispositivo(correo, E('pass').value);");
    expect(manejador).toContain('else olvidarCorreo();');
  });

  it('sólo recuerda DESPUÉS de un ingreso correcto (un correo o contraseña mal escritos no quedan guardados)', () => {
    const iLogin = manejador.indexOf("api('POST', '/auth/login'");
    const iError = manejador.indexOf("if (!login.ok) return decir('login-msg', login);");
    const iRecordar = manejador.indexOf('recordarEsteDispositivo(');
    expect(iLogin).toBeGreaterThanOrEqual(0);
    expect(iError).toBeGreaterThan(iLogin);
    expect(iRecordar).toBeGreaterThan(iError);
  });

  it('al abrir la consola precarga el correo recordado y marca la casilla', () => {
    const j = consola.indexOf('(function precargarElCorreo()');
    expect(j).toBeGreaterThan(0);
    const bloque = consola.slice(j, consola.indexOf('})();', j));
    expect(bloque).toContain("E('email').value = correo;");
    expect(bloque).toContain("E('recordar').checked = true;");
  });

  it('todo acceso a localStorage va envuelto en try/catch (ventana privada, cookies bloqueadas)', () => {
    for (const nombre of ['function correoRecordado', 'function olvidarCorreo']) {
      const k = consola.indexOf(nombre);
      expect(k).toBeGreaterThan(0);
      expect(consola.slice(k, consola.indexOf('\n}\n', k))).toContain('try {');
    }
  });
});
