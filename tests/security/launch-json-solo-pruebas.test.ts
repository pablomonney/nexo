/**
 * S-48 — `.claude/launch.json` sólo sabe levantar el servidor AISLADO.
 *
 * El 2026-10-14 y el 2026-10-15, un pedido de vista previa para el servidor de pruebas arrancó, por error, la
 * configuración `nexo`: `npm start`, puerto 3001, el `.env` normal y la base de DESARROLLO. Las dos veces la API se negó a
 * arrancar por migraciones faltantes —por suerte—, pero la herramienta no respetó el nombre pedido, así que el control no
 * puede depender de que alguien escriba bien el nombre: **no tiene que existir ninguna configuración que apunte a otra
 * cosa**. Todo lo que se pueda arrancar desde acá pasa por `scripts/servir-contra-pruebas.mjs`, que se niega a conectarse
 * a una base que no sea local y de pruebas (S-47) y fuerza pagos, correo e IA a «ninguno».
 *
 * Para levantar la aplicación «de verdad» (desarrollo contra `aai`) se usa una terminal: `npm start`. No hay vista previa.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
interface Launch {
  configurations: Array<{ name: string; runtimeExecutable: string; runtimeArgs?: string[]; port: number; url?: string }>;
}
const leer = (ruta: string): Launch => JSON.parse(readFileSync(ruta, 'utf8')) as Launch;

/**
 * Los DOS archivos que la vista previa puede leer: el del repositorio y el de la carpeta que lo contiene (que es donde
 * se abre la sesión). El segundo estaba fuera de Git, tenía la configuración `nexo` (`npm --prefix … start`) y era el
 * que de verdad se usaba: por eso el primer arreglo no alcanzó. Si el de la carpeta padre existe, se controla también.
 */
const archivos: Array<[string, string, string]> = [
  ['del repositorio', join(RAIZ, '.claude', 'launch.json'), 'scripts/servir-contra-pruebas.mjs'],
  ['de la carpeta que contiene al repositorio', join(RAIZ, '..', '.claude', 'launch.json'), 'accounting-ai-argentina/scripts/servir-contra-pruebas.mjs'],
];
const presentes = archivos.filter(([, ruta]) => existsSync(ruta));
const launch = leer(archivos[0]![1]);

describe('S-48 — launch.json no puede arrancar la aplicación con el .env normal', () => {
  it.each(presentes)('el launch.json %s tiene al menos una configuración y TODAS son el servidor aislado', (_donde, ruta, guion) => {
    const l = leer(ruta);
    expect(l.configurations.length).toBeGreaterThan(0);
    for (const c of l.configurations) {
      expect(c.runtimeExecutable, c.name).toBe('node');
      expect(c.runtimeArgs, c.name).toEqual([guion]);
      expect(c.port, c.name).not.toBe(3001);
      expect(c.name, c.name).not.toBe('nexo');
    }
  });

  it('ninguna configuración llama a `npm`, a `dist/index.js` ni usa el puerto de la aplicación (3001)', () => {
    for (const c of launch.configurations) {
      const linea = [c.runtimeExecutable, ...(c.runtimeArgs ?? [])].join(' ');
      expect(linea, c.name).not.toMatch(/\bnpm\b|\bnpx\b|dist[\\/]index|\bstart\b/u);
      expect(c.port, c.name).not.toBe(3001);
    }
  });

  it('no hay dos configuraciones con el mismo nombre ni una llamada `nexo` a secas', () => {
    const nombres = launch.configurations.map((c) => c.name);
    expect(new Set(nombres).size).toBe(nombres.length);
    expect(nombres).not.toContain('nexo');
  });

  it('el guion que arranca se NIEGA con una base que no es de pruebas (prueba negativa ejecutada de verdad)', () => {
    // (Con la base de desarrollo local el guion NO se niega: la reemplaza por `<nombre>_test`, que es su función; eso lo
    // cubre S-47. Acá van los destinos que no pueden ser de pruebas bajo ningún nombre.)
    const intentos: Array<[string, string]> = [
      ['una remota', 'postgres://u:p@db.ejemplo.com:5432/aai_test'],
      ['la de producción', 'postgres://u:p@2.24.94.71:5432/aai'],
    ];
    for (const [que, url] of intentos) {
      const r = spawnSync(process.execPath, [join(RAIZ, 'scripts', 'servir-contra-pruebas.mjs')], {
        cwd: RAIZ,
        env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: url },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(r.status, `${que}: ${r.stdout}${r.stderr}`).toBe(2);
    }
  });
});
