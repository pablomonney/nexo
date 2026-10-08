/**
 * S-46 — La consola cuenta «hoy» en hora argentina, y el ejercicio propuesto
 * contiene la fecha de hoy para cualquier cierre.
 *
 * ## Los defectos que este control existe para que no vuelvan
 *
 * 1. **La fecha por defecto en UTC.** `new Date().toISOString().slice(0, 10)` es
 *    el día de UTC: entre las 21:00 y las 24:00 ART ya es mañana. Con eso la
 *    consola llenaba la fecha de un asiento nuevo, el período «actual» del
 *    inicio y la normativa «vigente hoy».
 * 2. **El ejercicio propuesto, desde el propio día del cierre.**
 *    `prepararAltaDeEjercicio` comparaba el *instante* actual contra la
 *    medianoche UTC del cierre. El 31/12 a las 00:00 ART (= 03:00Z) ya era
 *    «posterior» al cierre, así que proponía el ejercicio 2027 —desde
 *    2027-01-01— cuando todavía estaba en el 2026. Y no solo de noche: todo el
 *    día del cierre.
 *
 * ## Cómo se prueba sin depender del reloj
 *
 * La consola es un único archivo sin build. Este test **extrae las funciones
 * puras** del propio `consola.html` y las ejecuta en un contexto aislado con
 * instantes fijos, de modo que prueba el código que corre en el navegador y no
 * una copia. Lo que no puede cambiar es la hora a la que se corre el test.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { ZONA_DE_NEGOCIO, hoyEnZonaDeNegocio } from '@aai/shared';
import { beforeAll, describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Ejercicio {
  desde: string;
  hasta: string;
  codigo: string;
}
interface FuncionesDeLaConsola {
  ZONA_DE_NEGOCIO: string;
  hoyEnArgentina: (ahora?: Date) => string;
  diaDeUnInstante: (t: string) => string;
  momentoDeUnInstante: (t: string) => string;
  sumarDias: (fecha: string, dias: number) => string;
  diasDelMes: (anio: number, mes: number) => number;
  ejercicioQueContiene: (hoy: string, cierre: string) => Ejercicio;
}

/** El texto de `function nombre(...) { ... }` completo, por balance de llaves. */
function extraerFuncion(html: string, nombre: string): string {
  const inicio = html.indexOf(`function ${nombre}(`);
  expect(inicio, `la consola no define ${nombre}`).toBeGreaterThan(-1);
  let profundidad = 0;
  for (let i = html.indexOf('{', inicio); i < html.length; i += 1) {
    if (html[i] === '{') profundidad += 1;
    if (html[i] === '}') {
      profundidad -= 1;
      if (profundidad === 0) return html.slice(inicio, i + 1);
    }
  }
  throw new Error(`no se encontró el final de ${nombre}`);
}

/** Desde `const ZONA_DE_NEGOCIO` hasta el final de `ejercicioQueContiene`. */
function extraerBloque(html: string): string {
  const inicio = html.indexOf('const ZONA_DE_NEGOCIO');
  expect(inicio, 'la consola no define ZONA_DE_NEGOCIO').toBeGreaterThan(-1);
  const ultima = extraerFuncion(html, 'ejercicioQueContiene');
  return html.slice(inicio, html.indexOf(ultima, inicio) + ultima.length);
}

/** El cálculo de calendario con `Date` de un test: el oráculo, no el código bajo prueba. */
const oraculoSumarDias = (fecha: string, dias: number): string => {
  const [a, m, d] = fecha.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
};
const oraculoDias = (desde: string, hasta: string): number => {
  const f = (s: string) => {
    const [a, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(a, m - 1, d);
  };
  return Math.round((f(hasta) - f(desde)) / 86_400_000);
};

describe('S-46 — fechas de la consola', () => {
  let html: string;
  let c: FuncionesDeLaConsola;

  beforeAll(async () => {
    html = await readFile(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');
    const codigo = extraerBloque(html);
    c = runInNewContext(
      `${codigo}\n({ ZONA_DE_NEGOCIO, hoyEnArgentina, diaDeUnInstante, momentoDeUnInstante, sumarDias, diasDelMes, ejercicioQueContiene })`,
      { Intl, Date, Number, String, Math },
    ) as FuncionesDeLaConsola;
  });

  it('la zona de la consola es la misma que la de la aplicación', () => {
    expect(c.ZONA_DE_NEGOCIO).toBe(ZONA_DE_NEGOCIO);
  });

  describe('hoyEnArgentina: la matriz de borde alrededor de las 21:00 ART', () => {
    // 21:00 ART = 00:00Z del día siguiente. Instantes fijos: ningún caso lee el reloj.
    it.each([
      ['2026-10-05T23:59:59Z', '2026-10-05'], // 20:59:59 ART
      ['2026-10-06T00:00:00Z', '2026-10-05'], // 21:00:00 ART  ← en UTC ya es mañana
      ['2026-10-06T00:00:01Z', '2026-10-05'], // 21:00:01 ART
      ['2026-10-06T02:59:59Z', '2026-10-05'], // 23:59:59 ART
      ['2026-10-06T03:00:00Z', '2026-10-06'], // 00:00:00 ART del día nuevo
      ['2026-10-31T23:59:59Z', '2026-10-31'], // 20:59:59 ART, último día del mes
      ['2026-11-01T00:00:00Z', '2026-10-31'], // 21:00 ART: en UTC ya es noviembre
      ['2026-11-01T02:59:59Z', '2026-10-31'], // 23:59:59 ART
      ['2026-11-01T03:00:00Z', '2026-11-01'], // 00:00 ART del primero
      ['2026-12-31T23:59:59Z', '2026-12-31'],
      ['2027-01-01T00:00:00Z', '2026-12-31'], // 21:00 ART: en UTC ya es año nuevo
      ['2027-01-01T02:59:59Z', '2026-12-31'],
      ['2027-01-01T03:00:00Z', '2027-01-01'],
      ['2027-03-01T02:59:59Z', '2027-02-28'], // febrero común
      ['2028-03-01T02:59:59Z', '2028-02-29'], // febrero bisiesto
      ['2028-03-01T03:00:00Z', '2028-03-01'],
    ])('%s → %s', (instante, esperado) => {
      expect(c.hoyEnArgentina(new Date(instante))).toBe(esperado);
    });

    it('coincide con hoyEnZonaDeNegocio de @aai/shared en cada instante de la matriz', () => {
      const base = Date.UTC(2026, 0, 1, 0, 0, 0);
      for (let h = 0; h < 24 * 400; h += 1) {
        const instante = new Date(base + h * 3_600_000 + 59_000); // cada hora, :00:59
        expect(c.hoyEnArgentina(instante)).toBe(hoyEnZonaDeNegocio(instante));
      }
    });
  });

  describe('instantes que llegan de la API (timestamptz) se muestran en hora argentina', () => {
    it.each([
      ['2026-10-06T00:30:00.000Z', '2026-10-05', '2026-10-05 21:30:00'], // ISO con Z (columna serializada)
      ['2026-10-06T02:59:59.000Z', '2026-10-05', '2026-10-05 23:59:59'],
      ['2026-10-06T03:00:00.000Z', '2026-10-06', '2026-10-06 00:00:00'], // 00:00:00, no 24:00:00
      ['2026-10-05T23:59:59.000Z', '2026-10-05', '2026-10-05 20:59:59'],
      ['2026-10-06 01:30:00.123456+00', '2026-10-05', '2026-10-05 22:30:00'], // texto de PG en UTC
      ['2026-10-05 22:30:00.123456-03', '2026-10-05', '2026-10-05 22:30:00'], // texto de PG en Argentina
      ['2027-01-01T00:00:00.000Z', '2026-12-31', '2026-12-31 21:00:00'], // fin de año
    ])('%s → día %s, momento %s', (instante, dia, momento) => {
      expect(c.diaDeUnInstante(instante)).toBe(dia);
      expect(c.momentoDeUnInstante(instante)).toBe(momento);
    });

    it('una columna `date` (AAAA-MM-DD) no se convierte otra vez: sin doble conversión', () => {
      // new Date('2026-03-01') es 00:00Z = 28/02 21:00 ART: sin la guarda, el día se corre.
      for (const dia of ['2026-03-01', '2026-01-01', '2028-03-01', '2026-12-31']) {
        expect(c.diaDeUnInstante(dia), dia).toBe(dia);
        expect(c.momentoDeUnInstante(dia), dia).toBe(dia + ' 00:00:00');
      }
    });

    it('el horario de verano que Argentina tuvo hasta 2009 (UTC-2) también se resuelve', () => {
      // 2009-01-01T01:30Z con UTC-2 es 2008-12-31 23:30; con el desfase de hoy (UTC-3) sería 22:30.
      expect(c.diaDeUnInstante('2009-01-01T01:30:00Z')).toBe('2008-12-31');
      expect(c.momentoDeUnInstante('2009-01-01T01:30:00Z')).toBe('2008-12-31 23:30:00');
      // Fuera del verano (invierno de 2008, UTC-3).
      expect(c.momentoDeUnInstante('2008-07-01T01:30:00Z')).toBe('2008-06-30 22:30:00');
    });

    it('lo ilegible no rompe la pantalla', () => {
      expect(c.diaDeUnInstante('no es una fecha')).toBe('no es una ');
      expect(c.diaDeUnInstante('')).toBe('');
      expect(c.momentoDeUnInstante('')).toBe('');
    });

    it('ningún campo timestamptz de la consola se recorta ya en UTC', () => {
      // Los lugares que mostraban el día de UTC: creadoEn, ocurridoEn (x2),
      // creadaEl/importadaEl/revertidaEl (soloDia) y detectadaEl.
      for (const viejo of [
        'String(it.creadoEn).slice(0, 10)',
        'String(a.ocurridoEn).slice(0, 10)',
        "String(t || '').slice(0, 10) || '—'",
        "String(e.ocurridoEn).replace('T', ' ').slice(0, 19)",
        "String(a.detectadaEl || '').slice(0, 10)",
      ]) {
        expect(html.includes(viejo), 'sigue: ' + viejo).toBe(false);
      }
    });
  });

  describe('sumarDias y diasDelMes', () => {
    it('suma y resta días igual que el oráculo, a través de meses, años y bisiestos', () => {
      const fechas = ['2026-01-31', '2026-02-28', '2028-02-28', '2028-02-29', '2026-12-31', '2027-01-01'];
      for (const f of fechas) {
        for (const n of [-366, -31, -1, 0, 1, 29, 30, 31, 365, 366, 1461]) {
          expect(c.sumarDias(f, n), `${f} ${n >= 0 ? '+' : ''}${n}`).toBe(oraculoSumarDias(f, n));
        }
      }
    });

    it.each([
      [2026, 1, 31], [2026, 2, 28], [2028, 2, 29], [1900, 2, 28], [2000, 2, 29],
      [2026, 4, 30], [2026, 12, 31],
    ])('diasDelMes(%i, %i) = %i', (anio, mes, esperado) => {
      expect(c.diasDelMes(anio, mes)).toBe(esperado);
    });
  });

  describe('ejercicioQueContiene', () => {
    it('REGRESIÓN: 31/12 a las 00:00 ART (03:00Z) sigue en el ejercicio 2026', () => {
      // El código anterior devolvía {codigo: '2027', desde: '2027-01-01', hasta: '2027-12-31'}.
      const hoy = c.hoyEnArgentina(new Date('2026-12-31T03:00:00Z'));
      expect(hoy).toBe('2026-12-31');
      expect(c.ejercicioQueContiene(hoy, '12-31')).toEqual({
        desde: '2026-01-01',
        hasta: '2026-12-31',
        codigo: '2026',
      });
    });

    it.each([
      ['2026-12-31T00:00:00Z', '2026'], // 21:00 ART del 30/12
      ['2026-12-31T03:00:00Z', '2026'], // 00:00 ART del 31/12: el defecto
      ['2026-12-31T23:59:59Z', '2026'], // 20:59:59 ART
      ['2027-01-01T00:00:00Z', '2026'], // 21:00:00 ART: en UTC ya es 2027
      ['2027-01-01T02:59:59Z', '2026'], // 23:59:59 ART
      ['2027-01-01T03:00:00Z', '2027'], // 00:00:00 ART del 01/01
    ])('cierre 12-31, instante %s → ejercicio %s', (instante, codigo) => {
      const hoy = c.hoyEnArgentina(new Date(instante));
      expect(c.ejercicioQueContiene(hoy, '12-31').codigo).toBe(codigo);
    });

    it.each([
      // [hoy, cierre, desde, hasta, código]
      ['2026-06-30', '06-30', '2025-07-01', '2026-06-30', '2026'], // el día del cierre
      ['2026-07-01', '06-30', '2026-07-01', '2027-06-30', '2027'], // el día siguiente
      ['2026-03-31', '03-31', '2025-04-01', '2026-03-31', '2026'],
      ['2026-04-01', '03-31', '2026-04-01', '2027-03-31', '2027'],
      ['2026-01-31', '01-31', '2025-02-01', '2026-01-31', '2026'],
      ['2026-09-30', '09-30', '2025-10-01', '2026-09-30', '2026'],
      ['2026-11-30', '11-30', '2025-12-01', '2026-11-30', '2026'],
      ['2026-02-28', '02-28', '2025-03-01', '2026-02-28', '2026'],
      // 29/02: en un año común cierra el 28/02 y los ejercicios siguen contiguos.
      ['2027-02-28', '02-29', '2026-03-01', '2027-02-28', '2027'],
      ['2027-03-01', '02-29', '2027-03-01', '2028-02-29', '2028'],
      ['2028-02-29', '02-29', '2027-03-01', '2028-02-29', '2028'],
      ['2028-03-01', '02-29', '2028-03-01', '2029-02-28', '2029'],
      // Un cierre imposible se trata como 31/12 y la persona lo corrige.
      ['2026-05-10', '13-45', '2026-01-01', '2026-12-31', '2026'],
      ['2026-05-10', '', '2026-01-01', '2026-12-31', '2026'],
    ])('hoy %s, cierre %s → %s a %s (%s)', (hoy, cierre, desde, hasta, codigo) => {
      expect(c.ejercicioQueContiene(hoy, cierre)).toEqual({ desde, hasta, codigo });
    });

    it('para cualquier cierre válido y cualquier día de tres años: contiene hoy, es contiguo y dura un año', () => {
      const diasPorMes = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // febrero admite 29
      let casos = 0;
      for (let mes = 1; mes <= 12; mes += 1) {
        for (let dia = 1; dia <= diasPorMes[mes - 1]!; dia += 1) {
          const cierre = `${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
          for (let n = 0; n < 1096; n += 7) {
            // Cada 7 días a lo largo de 2027, 2028 y 2029; incluye todos los días de la semana.
            const hoy = oraculoSumarDias('2027-01-01', n);
            const e = c.ejercicioQueContiene(hoy, cierre);
            casos += 1;

            expect(e.desde <= hoy && hoy <= e.hasta, `${cierre} ${hoy}: ${e.desde}..${e.hasta}`).toBe(true);
            expect(e.codigo).toBe(e.hasta.slice(0, 4));
            const dias = oraculoDias(e.desde, e.hasta) + 1;
            expect([365, 366], `${cierre} ${hoy}: dura ${dias} días`).toContain(dias);

            // Contiguidad: el ejercicio de «el día después del cierre» empieza ahí.
            const siguiente = c.ejercicioQueContiene(oraculoSumarDias(e.hasta, 1), cierre);
            expect(siguiente.desde, `${cierre} ${hoy}`).toBe(oraculoSumarDias(e.hasta, 1));
          }
        }
      }
      expect(casos).toBeGreaterThan(5000);
    });

    it('el día del cierre pertenece al ejercicio que cierra, en cualquier cierre y año', () => {
      for (const [cierre, hasta] of [
        ['12-31', '2026-12-31'], ['06-30', '2026-06-30'], ['03-31', '2027-03-31'], ['09-30', '2028-09-30'],
      ] as const) {
        expect(c.ejercicioQueContiene(hasta, cierre).hasta, cierre).toBe(hasta);
      }
    });
  });

  describe('prepararAltaDeEjercicio (el pegamento con la pantalla), con reloj congelado', () => {
    interface Casilla {
      value: string;
      hidden: boolean;
    }
    /** Ejecuta la función REAL de la consola con un reloj fijo y una pantalla de mentira. */
    function correr(opciones: {
      ahora: string;
      cierre?: string;
      puede?: boolean;
      casillas?: Partial<Record<string, string>>;
      ejercicios?: { code: string }[];
    }): Record<string, Casilla> {
      const instanteFijo = new Date(opciones.ahora).getTime();
      class RelojFijo extends Date {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(instanteFijo);
          else super(...(args as [number]));
        }
        static override now(): number {
          return instanteFijo;
        }
      }
      const casillas: Record<string, Casilla> = {
        'fy-alta': { value: '', hidden: false },
        'fy-codigo': { value: opciones.casillas?.['fy-codigo'] ?? '', hidden: false },
        'fy-desde': { value: opciones.casillas?.['fy-desde'] ?? '', hidden: false },
        'fy-hasta': { value: opciones.casillas?.['fy-hasta'] ?? '', hidden: false },
      };
      const contexto = {
        Intl, Date: RelojFijo, Number, String, Math, Set,
        E: (id: string) => casillas[id],
        puede: () => opciones.puede ?? true,
        estado: { empresaDatos: opciones.cierre === undefined ? undefined : { fiscalYearEnd: opciones.cierre } },
        ejercicios: opciones.ejercicios ?? [],
      };
      runInNewContext(
        `${extraerBloque(html)}\n${extraerFuncion(html, 'prepararAltaDeEjercicio')}\nprepararAltaDeEjercicio(ejercicios)`,
        contexto,
      );
      return casillas;
    }

    it('REGRESIÓN: el 31/12 a las 00:00 ART propone el ejercicio 2026 completo', () => {
      const r = correr({ ahora: '2026-12-31T03:00:00Z', cierre: '12-31' });
      expect([r['fy-codigo']!.value, r['fy-desde']!.value, r['fy-hasta']!.value]).toEqual([
        '2026', '2026-01-01', '2026-12-31',
      ]);
    });

    it('a las 21:30 ART del 31/12 (ya es 2027 en UTC) sigue proponiendo 2026', () => {
      const r = correr({ ahora: '2027-01-01T00:30:00Z', cierre: '12-31' });
      expect(r['fy-codigo']!.value).toBe('2026');
    });

    it('un cierre que no es 31/12, sin que importe el año', () => {
      const r = correr({ ahora: '2026-07-01T02:00:00Z', cierre: '06-30' }); // 23:00 ART del 30/06
      expect([r['fy-desde']!.value, r['fy-hasta']!.value]).toEqual(['2025-07-01', '2026-06-30']);
    });

    it('sin datos de la empresa asume 31/12', () => {
      const r = correr({ ahora: '2026-05-10T15:00:00Z' });
      expect(r['fy-hasta']!.value).toBe('2026-12-31');
    });

    it('no repite un código usado ni pisa lo que la persona ya escribió', () => {
      const repetido = correr({ ahora: '2026-05-10T15:00:00Z', ejercicios: [{ code: '2026' }, { code: '2026-2' }] });
      expect(repetido['fy-codigo']!.value).toBe('2026-3');
      const escrito = correr({
        ahora: '2026-05-10T15:00:00Z',
        casillas: { 'fy-codigo': 'MI', 'fy-desde': '2026-02-01', 'fy-hasta': '2027-01-31' },
      });
      expect([escrito['fy-codigo']!.value, escrito['fy-desde']!.value, escrito['fy-hasta']!.value]).toEqual([
        'MI', '2026-02-01', '2027-01-31',
      ]);
    });

    it('sin permiso de escritura oculta la caja y no propone nada', () => {
      const r = correr({ ahora: '2026-05-10T15:00:00Z', puede: false });
      expect(r['fy-alta']!.hidden).toBe(true);
      expect(r['fy-codigo']!.value).toBe('');
    });
  });

  describe('el archivo no vuelve a derivar «hoy» de UTC', () => {
    it('todo el <script> de la consola es JavaScript válido', async () => {
      const { Script } = await import('node:vm');
      const bloques = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(bloques.length).toBeGreaterThan(0);
      for (const [i, codigo] of bloques.entries()) {
        expect(() => new Script(codigo, { filename: `consola-script-${i}` })).not.toThrow();
      }
    });


    it('ningún `new Date().toISOString()` ni getter de UTC fuera de los helpers permitidos', () => {
      // El control general es S-37 (que ahora también lee los HTML); esto fija el caso concreto.
      const sinComentarios = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const lineas = sinComentarios.split('\n');
      const malas = lineas.filter(
        (l) =>
          !l.includes('s37-permite') &&
          /new Date\(\)\s*\.\s*toISOString|getUTC(FullYear|Month|Date)\(\)|getFullYear\(\)|getMonth\(\)|getDate\(\)/.test(l),
      );
      expect(malas).toEqual([]);
    });

    it('las tres fechas por defecto de hoy salen de hoyEnArgentina()', () => {
      const usos = html.match(/const hoy = hoyEnArgentina\(\);/g) ?? [];
      expect(usos.length).toBe(3);
    });
  });
});
