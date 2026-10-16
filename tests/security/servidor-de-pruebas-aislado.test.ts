/**
 * S-47 — El servidor que abre la consola contra la base de pruebas no puede hablar con el exterior.
 *
 * `scripts/servir-contra-pruebas.mjs` existe para MIRAR pantallas con datos adentro. Heredaba el `.env` de
 * desarrollo, que puede traer un proveedor de pagos con su token: con eso cargado, un botón de cobro llamaría
 * de verdad a la pasarela, y uno de correo mandaría un mail real. Se descubrió el 2026-10-15, antes de usarlo
 * para verificar las 16 pantallas, leyendo qué variables tenía el `.env` local (sin imprimir ningún valor).
 *
 * Qué se comprueba:
 *   · se niega a arrancar si la base de destino no es local o su nombre no termina en `_test`;
 *   · fuerza a «ninguno» los proveedores de pagos, correo e IA, y vacía sus credenciales, pase lo que pase con el `.env`.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUION = join(RAIZ, 'scripts', 'servir-contra-pruebas.mjs');
const fuente = readFileSync(GUION, 'utf8');

function correr(databaseUrl: string) {
  const r = spawnSync(process.execPath, [GUION], {
    cwd: RAIZ,
    // Sin PORT ni nada más: el guion tiene que decidir por sí mismo y, si arrancara, no debería llegar acá.
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { codigo: r.status, salida: `${r.stdout}\n${r.stderr}` };
}

describe('S-47 — el servidor de pruebas está aislado', () => {
  it.each([
    ['un host remoto', 'postgres://u:p@prod.example.com:5432/aai'],
    ['la IP de un servidor', 'postgres://u:p@64.190.63.111:5432/aai'],
    ['el nombre del contenedor de producción', 'postgres://u:p@nexo-postgres:5432/aai'],
  ])('se niega ante %s', (_nombre, url) => {
    const r = correr(url);
    expect(r.codigo, r.salida).toBe(2);
    expect(r.salida).toContain('Me niego');
    expect(r.salida).toContain('solo abre una base local cuyo nombre termina en _test');
  });

  it('no deja pasar una URL que no se puede convertir en una base de pruebas', () => {
    const r = correr('postgres://u:p@localhost:5432');
    expect(r.codigo, r.salida).toBe(2);
  });

  it('fuerza pagos, correo e IA a «ninguno» y vacía sus credenciales', () => {
    // Se lee el objeto que se le pasa al hijo, no el comportamiento: arrancar el servidor de verdad es lo que se evita.
    const bloque = /const SIN_EXTERIOR = \{([\s\S]*?)\};/u.exec(fuente)?.[1] ?? '';
    for (const clave of ['PAYMENTS_PROVIDER', 'EMAIL_PROVIDER', 'AI_PROVIDER', 'ASSISTANT_PROVIDER']) {
      expect(bloque, clave).toMatch(new RegExp(`${clave}: 'none'`, 'u'));
    }
    for (const clave of ['PAYMENTS_ACCESS_TOKEN', 'PAYMENTS_WEBHOOK_SECRET', 'EMAIL_API_KEY', 'AI_API_KEY', 'ASSISTANT_API_KEY', 'ASSISTANT_API_KEY_REF']) {
      expect(bloque, clave).toMatch(new RegExp(`${clave}: ''`, 'u'));
    }
  });

  it('esas variables se aplican DESPUÉS del entorno heredado, así que le ganan al `.env`', () => {
    // `...process.env, ...SIN_EXTERIOR`: el orden es lo que da la garantía.
    expect(fuente).toMatch(/env: \{ \.\.\.process\.env, \.\.\.SIN_EXTERIOR, DATABASE_URL: pruebas/u);
  });
});
