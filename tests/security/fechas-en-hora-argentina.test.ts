/**
 * S-37 — Ningún «hoy» se calcula en UTC.
 *
 * ## El defecto que este control existe para que no vuelva
 *
 * `sembrar-comercial-b1.mjs` calculaba la fecha de vigencia de los precios con
 * `getUTCDate()`. Argentina es UTC menos tres, así que **después de las nueve
 * de la noche «hoy» ya es mañana**: los cinco precios quedaban con
 * `vigente_desde` en el día siguiente, la consulta del catálogo —que compara
 * contra `CURRENT_DATE`— no encontraba ninguno, y los planes se quedaban sin
 * precio hasta la medianoche.
 *
 * Medido el 2026-09-09 a las 22:07, reconstruyendo la base: tres pruebas en
 * rojo por un huso horario. No lo encontró nadie leyendo el código; lo encontró
 * correr el pipeline a una hora a la que nunca se había corrido.
 *
 * ## Por qué el control mira el código y no el resultado
 *
 * Un control que corriera la siembra y comprobara la fecha **pasaría todo el
 * día menos tres horas**. Un control que solo falla entre las 21 y las 24 es
 * exactamente el que no estaba. Así que se mira lo que no depende de la hora:
 * que ningún script derive una fecha del calendario en UTC.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(RAIZ, 'scripts');

/**
 * Las formas de sacar «el día de hoy» del reloj de UTC.
 *
 * `toISOString()` recortado a diez caracteres y los `getUTC*` de calendario.
 * `getUTCFullYear` solo no alcanza —también aparece en fechas ya conocidas—:
 * lo que se busca es el trío que arma una fecha de calendario.
 */
const EN_UTC = [
  /new Date\(\)\s*\.\s*toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/,
  /getUTCDate\(\)/,
  /getUTCMonth\(\)/,
];

/**
 * El código sin sus comentarios.
 *
 * Sin esto, el propio comentario que explica el arreglo —«esto decía
 * `getUTCDate()`»— hacía saltar el control sobre el archivo ya corregido. Un
 * control que se dispara con la explicación de su propio hallazgo enseña a
 * borrar la explicación.
 */
const soloCodigo = (fuente: string): string =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Los archivos donde una fecha en UTC **es** lo correcto.
 *
 * Un sello de tiempo para una fuente citada o para el nombre de un artefacto no
 * es una fecha de calendario contra la que la base vaya a comparar: es una
 * marca, y en UTC está bien puesta.
 */
const CON_MOTIVO: Readonly<Record<string, string>> = {
  'construir-landing.mjs':
    'Sella la fecha de construcción de la landing publicada. Es una marca del artefacto, no una ' +
    'fecha de vigencia: nadie la compara contra CURRENT_DATE.',
  'sincronizar-tipos-comprobante.mjs':
    'Arma el texto de la fuente citada —«FEParamGetTiposCbte (homologacion) — 2026-09-09»— que ' +
    'queda como procedencia del dato. Es documentación, no una comparación.',
};

describe('S-37 — ningún «hoy» se calcula en UTC', () => {
  it('ningún script deriva una fecha de calendario del reloj de UTC', async () => {
    const archivos = (await readdir(SCRIPTS)).filter((f) => f.endsWith('.mjs'));
    expect(archivos.length).toBeGreaterThan(10);

    const sospechosos: string[] = [];
    for (const archivo of archivos) {
      if (archivo in CON_MOTIVO) continue;
      const fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
      for (const patron of EN_UTC) {
        if (patron.test(fuente)) sospechosos.push(`${archivo}: ${patron.source}`);
      }
    }

    expect(
      sospechosos,
      'Estos scripts arman una fecha de calendario con el reloj de UTC. En Argentina eso es el ' +
        'día siguiente después de las nueve de la noche. Si la fecha se compara contra la base, ' +
        'pedísela a la base con `SELECT CURRENT_DATE`; si es solo una marca, agregá el archivo a ' +
        'CON_MOTIVO con el motivo:\n  ' +
        sospechosos.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones no acumula archivos que ya no la necesitan', async () => {
    // El otro lado del control: una excepción que sobra es una puerta abierta
    // que nadie recuerda haber dejado.
    const archivos = new Set(await readdir(SCRIPTS));
    const sobran: string[] = [];

    for (const archivo of Object.keys(CON_MOTIVO)) {
      if (!archivos.has(archivo)) {
        sobran.push(`${archivo}: ya no existe`);
        continue;
      }
      const fuente = soloCodigo(await readFile(join(SCRIPTS, archivo), 'utf8'));
      if (!EN_UTC.some((p) => p.test(fuente))) sobran.push(`${archivo}: ya no usa UTC`);
    }

    expect(sobran, `Sacá estos archivos de CON_MOTIVO:\n  ${sobran.join('\n  ')}`).toEqual([]);
  });

  it('la siembra comercial le pregunta la fecha a la base', async () => {
    // El arreglo concreto, comprobado donde vive: la fecha por omisión sale de
    // `CURRENT_DATE` y no de ningún reloj del proceso.
    const fuente = soloCodigo(await readFile(join(SCRIPTS, 'sembrar-comercial-b1.mjs'), 'utf8'));
    expect(fuente).toContain('CURRENT_DATE');
    expect(fuente).not.toMatch(/getUTC(Date|Month|FullYear)\(\)/);
  });
});
