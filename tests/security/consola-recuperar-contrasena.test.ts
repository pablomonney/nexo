/**
 * «Olvidé mi contraseña» en la consola.
 *
 * Qué se fija acá: que la pantalla use las dos rutas nuevas, que no cuente más de lo que cuenta el servidor (que contesta lo
 * mismo exista o no la cuenta) y que la contraseña nueva no se quede ni en el campo ni en ningún almacenamiento.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const consola = readFileSync(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');

const manejador = (id: string): string => {
  const i = consola.indexOf(`E('${id}').onclick`);
  expect(i, `no encuentro el handler de ${id}`).toBeGreaterThan(0);
  return consola.slice(i, consola.indexOf('\n};\n', i));
};

describe('la pantalla', () => {
  it('está dentro del ingreso (se necesita SIN sesión) y trae los dos pasos', () => {
    const login = consola.slice(consola.indexOf('<section id="v-login">'), consola.indexOf('<!-- ══ Segundo factor'));
    for (const id of ['recuperar', 'rec-email', 'b-rec-pedir', 'rec-token', 'rec-pass', 'b-rec-cambiar', 'rec-pedir-msg', 'rec-cambiar-msg']) {
      expect(login, `falta #${id} dentro del ingreso`).toContain(`id="${id}"`);
    }
    expect(login).toContain('Olvidé mi contraseña');
  });

  it('la contraseña nueva es un campo de contraseña que el navegador sabe que es NUEVA', () => {
    expect(consola).toMatch(/<input id="rec-pass" type="password" autocomplete="new-password">/u);
  });

  it('avisa que se cierran las sesiones y que el segundo factor sigue siendo necesario', () => {
    expect(consola).toMatch(/cierran todas tus sesiones abiertas/u);
    expect(consola).toMatch(/recuperar la contraseña no lo saltea/u);
  });
});

describe('los pasos', () => {
  it('pedir el código llama a /auth/recuperar y muestra SOLO la respuesta del servidor', () => {
    const cuerpo = manejador('b-rec-pedir');
    expect(cuerpo).toContain("api('POST', '/auth/recuperar'");
    expect(cuerpo).toContain("decir('rec-pedir-msg', r)");
    // Ninguna frase propia que diga si el correo existe: eso sólo lo puede saber (y callar) el servidor.
    expect(cuerpo).not.toMatch(/no existe|no está registrad|no tiene cuenta|ya está registrad/iu);
  });

  it('cambiar la contraseña llama a /auth/restablecer con el código y la contraseña', () => {
    const cuerpo = manejador('b-rec-cambiar');
    expect(cuerpo).toContain("api('POST', '/auth/restablecer'");
    expect(cuerpo).toContain("token: E('rec-token').value.trim()");
    expect(cuerpo).toContain("password: E('rec-pass').value");
  });

  it('tras cambiarla vacía la contraseña y el código, y deja el correo en el ingreso', () => {
    const cuerpo = manejador('b-rec-cambiar');
    expect(cuerpo).toContain("E('rec-pass').value = '';");
    expect(cuerpo).toContain("E('rec-token').value = '';");
    expect(cuerpo).toContain("E('email').value = E('rec-email').value.trim();");
  });
});

describe('la contraseña no se guarda en ningún lado', () => {
  it('ni el código ni la contraseña de recuperación van a localStorage/sessionStorage/cookie', () => {
    for (const bloque of [manejador('b-rec-pedir'), manejador('b-rec-cambiar')]) {
      expect(bloque).not.toMatch(/localStorage|sessionStorage|document\.cookie|PasswordCredential/u);
    }
  });
});
