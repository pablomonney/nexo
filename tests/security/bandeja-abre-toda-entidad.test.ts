/**
 * Toda entidad que la bandeja puede emitir tiene por dónde abrirla.
 *
 * `PERMISO_POR_ENTIDAD` (`work-queue.ts`) es la lista blanca de entidades que
 * la bandeja de Pendientes puede mostrar. `abrirPendiente()` (`consola.html`)
 * es lo que corre al hacer clic en «abrir». Hasta la auditoría integral de
 * 2026-09-21 estaban desincronizadas: 18 de las 33 entidades de la lista
 * blanca no tenían `case`, y el clic en «abrir» no hacía nada — el mismo
 * síntoma que ya se había visto y corregido una vez para
 * `company_account_map`, sin que nada impidiera que volviera a pasar con la
 * próxima entidad nueva.
 *
 * Este barrido lee las dos fuentes y compara mecánicamente, igual que hace
 * S-25 con capacidades y rutas: una ausencia tiene que ser una decisión que
 * se vea en el diff, no un olvido silencioso.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORK_QUEUE = join(RAIZ, 'apps', 'api', 'src', 'routes', 'work-queue.ts');
const CONSOLA = join(RAIZ, 'apps', 'web', 'consola.html');
const MIGRACION_ARRANQUE = join(
  RAIZ, 'infrastructure', 'db', 'migrations', '0075_puesta_en_marcha.sql',
);
const MIGRACION_VALUACION = join(
  RAIZ, 'infrastructure', 'db', 'migrations', '0077_valuacion_de_existencias.sql',
);

/** Las claves de `PERMISO_POR_ENTIDAD`, en el orden en que aparecen. */
function entidadesDeLaBandeja(): string[] {
  const fuente = readFileSync(WORK_QUEUE, 'utf-8');
  const inicio = fuente.indexOf('const PERMISO_POR_ENTIDAD');
  const fin = fuente.indexOf('\n};', inicio);
  const cuerpo = fuente.slice(inicio, fin);
  return [...cuerpo.matchAll(/^\s*([a-z_]+):\s*'[a-z_:]+',/gm)].map((m) => m[1]!);
}

/** El cuerpo completo de `abrirPendiente(item) { ... }`, por conteo de llaves. */
function cuerpoDeAbrirPendiente(): string {
  const fuente = readFileSync(CONSOLA, 'utf-8');
  const inicio = fuente.indexOf('async function abrirPendiente(item)');
  expect(inicio, 'abrirPendiente tiene que existir en la consola').toBeGreaterThan(-1);
  const aperturaLlave = fuente.indexOf('{', inicio);
  let profundidad = 0;
  let i = aperturaLlave;
  for (; i < fuente.length; i += 1) {
    if (fuente[i] === '{') profundidad += 1;
    else if (fuente[i] === '}') {
      profundidad -= 1;
      if (profundidad === 0) break;
    }
  }
  return fuente.slice(aperturaLlave, i + 1);
}

/** Los `case '...'` de un cuerpo de switch, sin bajar a switches anidados. */
function casosDe(cuerpo: string): Set<string> {
  return new Set([...cuerpo.matchAll(/case '([A-Za-z_]+)':/g)].map((m) => m[1]!));
}

/** Las ramas declaradas con `entidad='companies'` en una migración de puesta en marcha. */
function ramasDeCompanies(rutaMigracion: string): string[] {
  const sql = readFileSync(rutaMigracion, 'utf-8');
  const ramas: string[] = [];
  const bloques = sql.split(/UNION ALL/);
  for (const bloque of bloques) {
    if (!bloque.includes("'companies'::text")) continue;
    const m = bloque.match(/'([A-Z_]+)'::text\s+AS rama/);
    if (m) ramas.push(m[1]!);
  }
  return ramas;
}

describe('Pendientes: cada entidad de la bandeja tiene case en abrirPendiente', () => {
  const entidades = entidadesDeLaBandeja();
  const cuerpo = cuerpoDeAbrirPendiente();
  const casos = casosDe(cuerpo);

  it('PERMISO_POR_ENTIDAD no está vacío (si esto falla, el extractor se rompió)', () => {
    expect(entidades.length).toBeGreaterThanOrEqual(33);
  });

  it.each(entidades)('%s tiene un case en abrirPendiente', (entidad) => {
    expect(casos.has(entidad)).toBe(true);
  });

  it('no queda ninguna entidad de la lista blanca sin case', () => {
    const faltantes = entidades.filter((e) => !casos.has(e));
    expect(faltantes).toEqual([]);
  });

  // `companies` no tiene una sola pantalla: agrupa las ramas de puesta en
  // marcha (0075) y de valuación (0077), cada una con su propio destino. Un
  // `case 'companies'` que solo cubriera una rama pasaría el barrido de
  // arriba —la entidad está— y aun así dejaría el resto sin abrir.
  describe('companies: cada rama de arranque/valuación abre su pantalla', () => {
    const ramas = [
      ...ramasDeCompanies(MIGRACION_ARRANQUE),
      ...ramasDeCompanies(MIGRACION_VALUACION),
    ];
    const inicioCompanies = cuerpo.indexOf("case 'companies':");
    const cuerpoCompanies = inicioCompanies === -1 ? '' : cuerpo.slice(inicioCompanies);
    const casosDeRama = casosDe(cuerpoCompanies);

    it('las migraciones declaran al menos las 4 ramas conocidas', () => {
      expect(ramas).toEqual(
        expect.arrayContaining([
          'SIN_PLAN_DE_CUENTAS', 'SIN_EJERCICIO', 'SIN_PERIODO_ABIERTO', 'SIN_METODO_DE_VALUACION',
        ]),
      );
    });

    it.each(ramas)('rama %s tiene case dentro de companies', (rama) => {
      expect(casosDeRama.has(rama)).toBe(true);
    });
  });

  // Guarda contra el typo silencioso: un `ir('cheque', ...)` en vez de
  // `ir('cheques', ...)` no rompe nada en tiempo de ejecución —la sección
  // simplemente no aparece— y sin este chequeo pasaría sin que nadie se
  // entere hasta que alguien lo clickeara en producción.
  it('cada ir(vista, …) dentro de abrirPendiente apunta a una sección real', () => {
    const html = readFileSync(CONSOLA, 'utf-8');
    const seccionesReales = new Set(
      [...html.matchAll(/<section id="v-([a-z-]+)"/g)].map((m) => m[1]!),
    );
    const vistasUsadas = new Set([...cuerpo.matchAll(/ir\('([a-z-]+)', migas\)/g)].map((m) => m[1]!));
    expect(vistasUsadas.size).toBeGreaterThan(0);
    for (const vista of vistasUsadas) {
      expect(seccionesReales.has(vista), `no existe <section id="v-${vista}">`).toBe(true);
    }
  });
});
