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
 * que nadie derive una fecha de calendario del reloj de UTC (ni de la zona del
 * proceso).
 *
 * ## El mismo defecto, en cada superficie donde apareció
 *
 * - `scripts/` (2026-09-09): la siembra de precios.
 * - `apps/api/src` (2026-10-01): la fecha de inicio de la prueba gratuita
 *   (`onboarding.ts`) y el año inferido por `intelligence/catalogo.ts`.
 * - `apps/web/consola.html` (2026-10-07): la fecha por defecto de un asiento, el
 *   período «actual» del inicio, la «normativa vigente hoy» y la propuesta del
 *   ejercicio. **El barrido no miraba los HTML.**
 *
 * ## Lo que se endureció el 2026-10-07
 *
 * La versión anterior detectaba solo la cadena literal
 * `new Date().toISOString().slice(0, 10)` (y `getUTCDate/Month`): medida contra
 * once casos conocidos, dejaba pasar **7 de 9** variantes peligrosas —una
 * variable intermedia, `substring`, `split('T')`, getters locales, un
 * `toLocaleDateString` sin zona—. Ahora:
 *
 * - el detector (`helpers/fechas-en-utc.ts`) es más ancho y **se prueba a sí
 *   mismo** con casos que debe y que no debe marcar;
 * - mira también los HTML de `apps/web`;
 * - un uso legítimo de UTC se declara en su propia línea con
 *   `// s37-permite: <motivo>` (un motivo vacío es un hallazgo), en vez de una
 *   lista de archivos aparte.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hallazgosDeUtc } from './helpers/fechas-en-utc.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(RAIZ, 'scripts');

const formatear = (archivo: string, hallazgos: ReturnType<typeof hallazgosDeUtc>): string[] =>
  hallazgos.map((h) => `${archivo}:${h.linea}  [${h.patron}]  ${h.texto.slice(0, 90)}`);

/**
 * Archivos de `scripts/` donde una fecha en UTC **es** lo correcto, completos.
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
  'comprobantes-sinteticos.mjs':
    'Herramienta de homologación que corre a mano en la máquina de quien desarrolla y arma las ' +
    'fechas de los comprobantes de prueba con getters locales (zona del proceso). Con el proceso ' +
    'en UTC el día se corre entre las 21:00 y las 24:00 ART; ARCA acepta ±5 días para productos y ' +
    '±10 para servicios, así que no rechaza. Conocido, de baja gravedad, sin corregir (P3).',
};

async function archivosDe(carpeta: string, extension: (n: string) => boolean): Promise<string[]> {
  const salida: string[] = [];
  async function recorrer(directorio: string): Promise<void> {
    for (const entrada of await readdir(directorio, { withFileTypes: true })) {
      const completo = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === 'node_modules' || entrada.name === 'dist') continue;
        await recorrer(completo);
      } else if (extension(entrada.name)) {
        salida.push(completo);
      }
    }
  }
  await recorrer(join(RAIZ, carpeta));
  return salida;
}

describe('S-37 — el detector se prueba a sí mismo', () => {
  // Cada caso es una forma real de escribir lo mismo. Si el detector las deja
  // pasar, el control no sirve aunque el repositorio esté limpio.
  it.each([
    ['directo', 'const h = new Date().toISOString().slice(0, 10);'],
    ['en varias líneas', 'const h = new Date()\n  .toISOString()\n  .slice(0, 10);'],
    ['con una variable intermedia', 'const ahora = new Date();\nconst h = ahora.toISOString().slice(0, 10);'],
    ['el ISO guardado en una variable y recortado después', 'const iso = ahora.toISOString();\nconst h = iso.slice(0, 10);'],
    ['el ISO guardado y cortado en la T', "const iso = ahora.toISOString();\nconst h = iso.split('T')[0];"],
    ['substring en vez de slice', 'const h = new Date().toISOString().substring(0, 10);'],
    ['split por T', "const h = new Date().toISOString().split('T')[0];"],
    ['Date.now() envuelto', 'const h = new Date(Date.now()).toISOString().slice(0, 10);'],
    ['el mes', 'const m = new Date().toISOString().slice(0, 7);'],
    ['el mes con substring', 'const m = new Date().toISOString().substring(0, 7);'],
    ['getUTCFullYear', 'const a = hoy.getUTCFullYear();'],
    ['getUTCMonth', 'const m = hoy.getUTCMonth() + 1;'],
    ['getUTCDate', 'const d = hoy.getUTCDate();'],
    ['toJSON en vez de toISOString', 'const h = new Date().toJSON().slice(0, 10);'],
    ['replace de la T para mostrar un instante en UTC', "const s = new Date().toISOString().replace('T', ' ');"],
    ['replace de la T y recorte de un texto', "const s = String(e.ocurridoEn).replace('T', ' ').slice(0, 19);"],
    ['desfase a mano', 'const ms = ahora.getTime() - ahora.getTimezoneOffset() * 60000;'],
    ['getters locales', 'const a = f.getFullYear(); const m = f.getMonth(); const d = f.getDate();'],
    ['toLocaleDateString sin zona', "const h = new Date().toLocaleDateString('en-CA');"],
    ['Intl.DateTimeFormat sin zona', "const f = new Intl.DateTimeFormat('en-CA');"],
    ['anotación sin motivo', 'const h = x.toISOString().slice(0, 10); // s37-permite'],
  ])('detecta: %s', (_nombre, fuente) => {
    expect(hallazgosDeUtc(fuente).length).toBeGreaterThan(0);
  });

  it.each([
    ['un instante a ISO, sin recortar', 'const t = new Date().toISOString();'],
    ['aritmética con Date.UTC', 'const ms = Date.UTC(2026, 0, 1);'],
    ['getTime() de un instante', 'const ms = new Date(x).getTime();'],
    ['Intl con zona', "const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires' });"],
    ['toLocaleString de un número', "const s = n.toLocaleString('es-AR', { minimumFractionDigits: 2 });"],
    ['el patrón dentro de un comentario', '// no usar new Date().toISOString().slice(0, 10)\nconst x = 1;'],
    ['el patrón dentro de un bloque de comentario', '/* new Date().toISOString().slice(0, 10) */\nconst x = 1;'],
    [
      'una línea anotada con motivo',
      'const h = x.toISOString().slice(0, 10); // s37-permite: columna date de pg, no el reloj',
    ],
    ['una URL con //', "const u = 'https://example.com/x';"],
  ])('NO marca: %s', (_nombre, fuente) => {
    expect(hallazgosDeUtc(fuente)).toEqual([]);
  });

  it('informa el número de línea correcto aunque haya comentarios antes', () => {
    const fuente = '// uno\n/* dos\n   tres */\nconst h = new Date().toISOString().slice(0, 10);';
    expect(hallazgosDeUtc(fuente).map((h) => h.linea)).toEqual([4]);
  });
});

describe('S-37 — ningún «hoy» se calcula en UTC', () => {
  it('ningún script deriva una fecha de calendario del reloj de UTC', async () => {
    const archivos = (await readdir(SCRIPTS)).filter((f) => f.endsWith('.mjs'));
    expect(archivos.length).toBeGreaterThan(10);

    const sospechosos: string[] = [];
    for (const archivo of archivos) {
      if (archivo in CON_MOTIVO) continue;
      sospechosos.push(
        ...formatear(`scripts/${archivo}`, hallazgosDeUtc(await readFile(join(SCRIPTS, archivo), 'utf8'))),
      );
    }

    expect(
      sospechosos,
      'Estos scripts arman una fecha de calendario con el reloj de UTC (o de la zona del proceso). ' +
        'En Argentina eso es el día siguiente después de las nueve de la noche. Si la fecha se ' +
        'compara contra la base, pedísela con `SELECT CURRENT_DATE`; si es un instante, no lo ' +
        'recortes; si de verdad es aritmética sobre una fecha ya conocida, anotá la línea con ' +
        '`// s37-permite: <motivo>`:\n  ' +
        sospechosos.join('\n  '),
    ).toEqual([]);
  });

  it('la lista de excepciones de scripts no acumula archivos que ya no la necesitan', async () => {
    // El otro lado del control: una excepción que sobra es una puerta abierta
    // que nadie recuerda haber dejado.
    const archivos = new Set(await readdir(SCRIPTS));
    const sobran: string[] = [];

    for (const archivo of Object.keys(CON_MOTIVO)) {
      if (!archivos.has(archivo)) {
        sobran.push(`${archivo}: ya no existe`);
        continue;
      }
      if (hallazgosDeUtc(await readFile(join(SCRIPTS, archivo), 'utf8')).length === 0) {
        sobran.push(`${archivo}: ya no usa UTC`);
      }
    }

    expect(sobran, `Sacá estos archivos de CON_MOTIVO:\n  ${sobran.join('\n  ')}`).toEqual([]);
  });

  it('ningún archivo de apps/api/src o de un paquete deriva una fecha de calendario del reloj de UTC', async () => {
    const archivos = [
      ...(await archivosDe('apps/api/src', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))),
      ...(await archivosDe('packages', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))).filter((f) =>
        f.includes(`${sep}src${sep}`),
      ),
    ];
    expect(archivos.length).toBeGreaterThan(50);

    const sospechosos: string[] = [];
    for (const archivo of archivos) {
      const relativo = relative(RAIZ, archivo).split(sep).join('/');
      sospechosos.push(...formatear(relativo, hallazgosDeUtc(await readFile(archivo, 'utf8'))));
    }

    expect(
      sospechosos,
      'Estos archivos arman una fecha de calendario con el reloj de UTC. En Argentina eso es el ' +
        'día siguiente después de las nueve de la noche. Si la fecha se compara contra la base, ' +
        'pedísela con `SELECT CURRENT_DATE` (ver `suscripciones.ts` o `intelligence.ts`, ' +
        '`hoyDeLaBase`); si es un instante que se muestra como día, usá `hoyEnZonaDeNegocio(instante)`; ' +
        'si es una columna `date` de pg o aritmética sobre una fecha ya conocida, anotá la línea con ' +
        '`// s37-permite: <motivo>`:\n  ' +
        sospechosos.join('\n  '),
    ).toEqual([]);
  });

  it('la consola y la landing tampoco derivan «hoy» de UTC', async () => {
    // Era el hueco: este barrido no miraba `apps/web`, y ahí estaban la fecha
    // por defecto de un asiento, el período «actual» y la normativa «de hoy».
    const archivos = await archivosDe('apps/web', (n) => n.endsWith('.html'));
    expect(archivos.map((a) => a.split(sep).pop())).toContain('consola.html');

    const sospechosos: string[] = [];
    for (const archivo of archivos) {
      const relativo = relative(RAIZ, archivo).split(sep).join('/');
      sospechosos.push(...formatear(relativo, hallazgosDeUtc(await readFile(archivo, 'utf8'))));
    }

    expect(
      sospechosos,
      'Estas páginas arman «hoy» con el reloj de UTC o de la zona del navegador. Usá ' +
        '`hoyEnArgentina()` (consola.html) o anotá la línea con `// s37-permite: <motivo>`:\n  ' +
        sospechosos.join('\n  '),
    ).toEqual([]);
  });

  it('cada anotación `s37-permite` tapa algo real (ninguna sobra) y hay motivo en todas', async () => {
    // El otro lado de las anotaciones por línea: una que ya no tapa nada es una
    // puerta abierta que nadie recuerda haber dejado, y esa línea podría
    // cambiar después sin que el control la mire.
    const archivos = [
      ...(await archivosDe('apps/api/src', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))),
      ...(await archivosDe('packages', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))).filter((f) =>
        f.includes(`${sep}src${sep}`),
      ),
      ...(await archivosDe('apps/web', (n) => n.endsWith('.html'))),
      ...(await readdir(SCRIPTS)).filter((f) => f.endsWith('.mjs')).map((f) => join(SCRIPTS, f)),
    ];

    const inutiles: string[] = [];
    let anotadas = 0;
    for (const archivo of archivos) {
      const relativo = relative(RAIZ, archivo).split(sep).join('/');
      for (const [i, linea] of (await readFile(archivo, 'utf8')).split('\n').entries()) {
        if (!linea.includes('s37-permite')) continue;
        anotadas += 1;
        // Sin la anotación, la línea tiene que dar al menos un hallazgo por sí sola.
        const codigo = linea.replace(/\s*\/\/\s*s37-permite.*$/, '');
        if (hallazgosDeUtc(codigo).length === 0) {
          inutiles.push(`${relativo}:${i + 1}  ${linea.trim().slice(0, 80)}`);
        }
      }
    }
    expect(anotadas).toBeGreaterThan(5);
    expect(inutiles, `Estas anotaciones no tapan ningún hallazgo; sacalas:\n  ${inutiles.join('\n  ')}`).toEqual([]);
  });

  it('el helper de calendario de @aai/shared declara su único uso de UTC en su propia línea', async () => {
    // Antes era una excepción para todo el archivo: cualquier getUTC* nuevo ahí pasaba sin mirarse.
    const fuente = await readFile(join(RAIZ, 'packages', 'shared', 'src', 'calendar-date.ts'), 'utf8');
    expect(hallazgosDeUtc(fuente)).toEqual([]);
    expect(fuente.split('\n').filter((l) => l.includes('s37-permite'))).toHaveLength(1);
    // Y un getUTC* nuevo en ese archivo sí se detecta.
    expect(hallazgosDeUtc(`${fuente}\nconst x = new Date().getUTCDate();`).length).toBeGreaterThan(0);
  });
  it('la siembra comercial le pregunta la fecha a la base', async () => {
    // El arreglo concreto, comprobado donde vive: la fecha por omisión sale de
    // `CURRENT_DATE` y no de ningún reloj del proceso.
    const fuente = await readFile(join(SCRIPTS, 'sembrar-comercial-b1.mjs'), 'utf8');
    expect(fuente).toContain('CURRENT_DATE');
    expect(hallazgosDeUtc(fuente)).toEqual([]);
  });
});
