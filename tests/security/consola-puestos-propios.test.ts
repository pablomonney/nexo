/**
 * La consola ofrece los puestos propios y los ajustes por persona sólo al dueño del estudio (migración 0145).
 *
 * El control está en la base (`exigir_dueno_del_estudio`, probado en `tests/integration/puestos-propios.test.ts`). Lo que se afirma acá es
 * lo de la pantalla: que no ofrece lo que el servidor va a rechazar, que lo que dice de cada función sale del servidor y no de una copia, y
 * que no pide un motivo con `prompt()` (un cuadro del navegador que no se puede probar ni explicar).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('la consola: puestos propios y permisos por persona', () => {
  let html = '';
  let ruta = '';
  beforeAll(async () => {
    html = await readFile(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');
    ruta = await readFile(join(RAIZ, 'apps', 'api', 'src', 'routes', 'puestos-propios.ts'), 'utf8');
  });

  it('la sección sólo se arma si el servidor dice que la persona es dueña del estudio', () => {
    expect(html).toMatch(/if \(u\.datos\.esDuenoDelEstudio\) \{\s*await cargarPuestosPropios\(personas\);\s*caja\.innerHTML \+= seccionDePuestosPropios\(\);/u);
  });

  it('cada acto pide su motivo (10 caracteres o más) antes de llamar al servidor', () => {
    const f = html.slice(html.indexOf('async function manejarPuestosPropios'), html.indexOf('/** Al elegir un puesto predeterminado como punto de partida'));
    expect(f.match(/length < 10/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(f).not.toMatch(/\bprompt\(/u);
    expect(f).not.toMatch(/\bconfirm\(/u);
  });

  it('las funciones reservadas no se pueden marcar, y se explica por qué', () => {
    const f = html.slice(html.indexOf('function matrizDeFunciones'), html.indexOf('const marcadasEn'));
    expect(f).toContain("p.reservado !== null && !deSuPuesto");
    expect(f).toContain('(reservada: ');
  });

  it('el aviso del segundo factor sale de lo que dice el servidor (`sensible`), no de una lista copiada en la pantalla', () => {
    expect(html).toContain('funcionDe(c).sensible');
    expect(ruta).toContain('sensible: permisoSensible(f.code)');
    expect(html).not.toMatch(/:approve\$\|\^stock:adjust/u);
  });

  it('todo lo que viene del servidor se escapa antes de dibujarse', () => {
    const f = html.slice(html.indexOf('function opcionesDePersonas'), html.indexOf('/** Al elegir un puesto predeterminado como punto de partida'));
    for (const campo of ['p.nombre', 'p.descripcion', 'x.nombre', 'p.fullName', 'p.reservado', 'p.funcion', 'm.modulo']) {
      expect(f, campo).toContain('escapar(' + campo);
    }
  });

  it('las escrituras de la API piden `user:manage` y las lecturas `user:read`', () => {
    const escrituras = ruta.match(/app\.(post|put)\(/gu)?.length ?? 0;
    expect(escrituras).toBe(6);
    expect(ruta.match(/requirePermission\(tenant, 'user:manage'\)/gu)?.length ?? 0).toBe(escrituras);
    expect(ruta.match(/requirePermission\(tenant, 'user:read'\)/gu)?.length ?? 0).toBe(3);
  });
});
