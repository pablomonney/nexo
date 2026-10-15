/**
 * `scripts/recuperar-cuenta.sh`: el envoltorio que corre la herramienta del operador dentro de la imagen, en el servidor.
 *
 * Es el acto que deja entrar a alguien a una empresa con datos de terceros: lo que se fija acá es que corra con el mismo
 * aislamiento que las tareas diarias y que no filtre la contraseña de la base ni monte nada del servidor.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sh = readFileSync(join(RAIZ, 'scripts', 'recuperar-cuenta.sh'), 'utf8');
const codigo = sh.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

describe('scripts/recuperar-cuenta.sh', () => {
  it('corre dentro de la imagen, con el sistema de archivos de sólo lectura y sin privilegios nuevos', () => {
    expect(codigo).toContain('--read-only');
    expect(codigo).toContain('--security-opt no-new-privileges:true');
    expect(codigo).toContain('--network nexo');
    expect(codigo).toContain('--env-file "$RAIZ/.env"');
  });

  it('no carga el .env con `.`/source, no pone la contraseña en los argumentos y la arma dentro del contenedor', () => {
    expect(codigo).not.toMatch(/^\s*(\.|source)\s+.*\.env/mu);
    expect(codigo).not.toMatch(/POSTGRES_PASSWORD=/u);
    expect(codigo).toContain('process.env.POSTGRES_PASSWORD'); // se lee DENTRO del contenedor
  });

  it('no monta ningún archivo ni directorio del servidor', () => {
    expect(codigo.split('\n').filter((l) => /(^|[\s(])-v\s|--mount/u.test(l))).toHaveLength(0);
  });

  it('ejecuta exactamente la herramienta del repositorio y le pasa los argumentos tal cual', () => {
    expect(codigo).toContain('exec node scripts/recuperar-cuenta.mjs "$@"');
    expect(codigo).toMatch(/sh "\$@"\s*$/u);
  });
});
