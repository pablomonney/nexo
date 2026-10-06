/**
 * S-45 — Toda conexión que decide una fecha de negocio la cuenta en hora argentina.
 *
 * ## El defecto que este control existe para que no vuelva
 *
 * Los arreglos de los defectos de fechas #3, #4 y #5 (2026-10-01) le preguntaban
 * `CURRENT_DATE` a la base y daban por hecho que la base estaba en hora
 * argentina. La de producción está en UTC (confirmado el 2026-10-05), así que
 * entre las 21:00 y las 24:00 ART seguía devolviendo la fecha de mañana. Los
 * tests pasaban porque la base de desarrollo está en `America/Buenos_Aires`.
 *
 * La base **no** se cambia —el hash de la cadena de auditoría depende de la zona
 * de la sesión; ver la migración 0131—. En su lugar cada conexión de la
 * aplicación pide su zona al abrirse (`initPool`). Este control comprueba, mirando
 * el código y no el reloj, que nadie abra una conexión sin hacerlo.
 *
 * ## Por qué mira el código y no el resultado
 *
 * Mismo argumento que S-37: un control que solo falla entre las 21:00 y las 24:00
 * es el que no estaba.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONA_DE_NEGOCIO } from '@aai/shared';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — módulo .mjs sin tipos, a propósito: es JavaScript plano.
import * as zonaDeScripts from '../../scripts/lib/zona.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(RAIZ, 'scripts');

const soloCodigo = (fuente: string): string =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

async function fuentesTs(carpeta: string): Promise<string[]> {
  const salida: string[] = [];
  async function recorrer(directorio: string): Promise<void> {
    for (const entrada of await readdir(directorio, { withFileTypes: true })) {
      const completo = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(completo);
      } else if (entrada.name.endsWith('.ts') && !entrada.name.endsWith('.test.ts')) {
        salida.push(completo);
      }
    }
  }
  await recorrer(join(RAIZ, carpeta));
  return salida;
}

/** Los scripts que deciden o comparan fechas de negocio y por eso piden la zona. */
const CON_ZONA = [
  'facturacion-ciclo.mjs',
  'sembrar-comercial-b1.mjs',
  'declarar-plan-de-pasarela.mjs',
  'ensayo-de-pagos.mjs',
  'metricas-saas.mjs',
  'factura-demo.mjs',
] as const;

/**
 * Scripts que mencionan la fecha de la base y **no** necesitan la zona, con el
 * motivo. Una excepción sin motivo es una puerta abierta.
 */
const SIN_ZONA_CON_MOTIVO: Readonly<Record<string, string>> = {
  'bench-vistas.mjs':
    'Genera datos sintéticos para medir el rendimiento de las vistas: las fechas son relativas a ' +
    '`current_date` y nadie las compara contra una fecha del negocio.',
  'verificar-zona-de-negocio.mjs':
    'Es la comprobación de la zona: abre una conexión con `initPool` (que pide la zona) y, ' +
    'a propósito, otra conexión cruda sin ella, como control. Es de solo lectura.',
};

describe('S-45 — la zona de negocio en las conexiones', () => {
  it('la constante de los scripts es la misma que la de la aplicación', () => {
    // Está repetida a propósito (los scripts son JavaScript plano); esto es lo
    // que impide que las dos copias se separen.
    expect(zonaDeScripts.ZONA_DE_NEGOCIO).toBe(ZONA_DE_NEGOCIO);
    expect(zonaDeScripts.opcionesDeConexion()).toEqual({
      options: `-c timezone=${ZONA_DE_NEGOCIO}`,
    });
  });

  it('todo `new pg.Pool/Client` del código de la aplicación fija la zona de negocio', async () => {
    const archivos = [
      ...(await fuentesTs('apps/api/src')),
      ...(await fuentesTs('packages')).filter((f) => f.includes(`${sep}src${sep}`)),
    ];
    expect(archivos.length).toBeGreaterThan(50);

    const sinZona: string[] = [];
    let conConexion = 0;
    for (const archivo of archivos) {
      const fuente = soloCodigo(await readFile(archivo, 'utf8'));
      if (!/new\s+(pg\.)?(Pool|Client)\s*\(/.test(fuente)) continue;
      conConexion += 1;
      if (!fuente.includes('ZONA_DE_NEGOCIO')) {
        sinZona.push(relative(RAIZ, archivo).split(sep).join('/'));
      }
    }

    // Que el barrido vea al menos el pool de `@aai/db`: si no lo ve, no prueba nada.
    expect(conConexion).toBeGreaterThanOrEqual(1);
    expect(
      sinZona,
      'Estos archivos abren una conexión a PostgreSQL sin la zona de negocio, así que ' +
        '`CURRENT_DATE` vuelve la fecha de UTC. Pasá `options: `-c timezone=${ZONA_DE_NEGOCIO}``:\n  ' +
        sinZona.join('\n  '),
    ).toEqual([]);
  });

  it('`initPool` pasa la zona como parámetro de arranque de la conexión', async () => {
    const fuente = soloCodigo(await readFile(join(RAIZ, 'packages/db/src/tenancy.ts'), 'utf8'));
    expect(fuente).toMatch(/options:\s*`-c timezone=\$\{ZONA_DE_NEGOCIO\}`/);
  });

  it.each(CON_ZONA)('%s abre su conexión con la zona de negocio', async (archivo) => {
    const fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
    expect(fuente, `${archivo} no importa lib/zona.mjs`).toMatch(/lib\/zona\.mjs/);
    expect(fuente, `${archivo} no usa opcionesDeConexion()`).toMatch(
      /new pg\.Client\(\{[^}]*\.\.\.opcionesDeConexion\(\)/,
    );
  });

  it('todo script que usa la fecha de la base pide la zona o está justificado', async () => {
    const archivos = (await readdir(SCRIPTS)).filter((f) => f.endsWith('.mjs'));
    const sinResolver: string[] = [];

    for (const archivo of archivos) {
      const fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
      if (!/current_date/i.test(fuente)) continue;
      if ((CON_ZONA as readonly string[]).includes(archivo)) continue;
      if (archivo in SIN_ZONA_CON_MOTIVO) continue;
      sinResolver.push(archivo);
    }

    expect(
      sinResolver,
      'Estos scripts usan `CURRENT_DATE` y no piden la zona de negocio: en producción (UTC) ' +
        'devolvería la fecha de mañana entre las 21:00 y las 24:00 ART. Agregalos a CON_ZONA ' +
        '(y usá `opcionesDeConexion()`) o a SIN_ZONA_CON_MOTIVO con el motivo:\n  ' +
        sinResolver.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula scripts que ya no la necesitan', async () => {
    const sobran: string[] = [];
    for (const archivo of Object.keys(SIN_ZONA_CON_MOTIVO)) {
      let fuente: string;
      try {
        fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
      } catch {
        sobran.push(`${archivo}: ya no existe`);
        continue;
      }
      if (!/current_date/i.test(fuente)) sobran.push(`${archivo}: ya no usa la fecha de la base`);
    }
    expect(sobran, `Sacalos de SIN_ZONA_CON_MOTIVO:\n  ${sobran.join('\n  ')}`).toEqual([]);
  });

  it('`backup-db.mjs` sigue en UTC a propósito', async () => {
    // Sus archivos se nombran con el sello UTC (`…T023159Z`), igual que los del
    // servidor. Si alguien le pone la zona de negocio "por consistencia", los
    // nombres dejan de ordenarse junto a los automáticos.
    const fuente = soloCodigo(await readFile(join(SCRIPTS, 'backup-db.mjs'), 'utf8'));
    expect(fuente).not.toContain('opcionesDeConexion');
  });
});
