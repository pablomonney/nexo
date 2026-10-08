/**
 * El reconocimiento de preguntas, sin base de datos.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que una palabra genérica no alcance para contestar.** Es la regla que
 *      gobierna todo el reconocedor. La primera versión mezclaba todas las
 *      palabras en una lista y «¿cuántos empleados tengo en Rosario?» se
 *      contestaba con el saldo de caja: la palabra «tengo» alcanzaba. Ahora
 *      hace falta una palabra del núcleo, que es la que solo tiene sentido en
 *      esa pregunta.
 *   2. **Que el empate no se rompa.** Dos preguntas igual de plausibles se
 *      ofrecen las dos. Elegir sería contestar una pregunta que nadie hizo, y
 *      esa respuesta se lee igual que la correcta.
 *   3. **Que el filtro por permisos exista de verdad.** No se puede probar con
 *      los roles de este esquema —los cinco tienen los seis permisos de lectura
 *      que el catálogo usa— así que se prueba donde vive la regla.
 *   4. **Que el mes escrito en la pregunta se entienda**, incluso «marzo» a
 *      secas, y que un mes que todavía no pasó se lea como el del año anterior:
 *      nadie pregunta por las ventas del futuro.
 *
 * Todo esto es función pura. Montarlo contra PostgreSQL costaría una empresa y
 * un juego de comprobantes por caso, y probaría lo mismo.
 */

import { describe, expect, it } from 'vitest';
import { parseCalendarDate, hoyEnZonaDeNegocio } from '@aai/shared';
import {
  CATALOGO,
  coincidencias,
  mesDe,
  normalizar,
  pesos,
  fueraDeAlcance,
  preguntasPara,
} from '@aai/api/intelligence/catalogo';

describe('El catálogo de preguntas', () => {
  it('cada entrada declara su núcleo, y ninguna palabra del núcleo se repite entre dos', () => {
    // Si dos preguntas comparten una palabra de núcleo, esa palabra deja de
    // identificar: el empate sería permanente y ninguna se podría contestar.
    const vistas = new Map<string, string>();
    const compartidas: string[] = [];
    for (const pregunta of CATALOGO) {
      expect(pregunta.nucleo.length, `${pregunta.id} sin núcleo`).toBeGreaterThan(0);
      for (const palabra of pregunta.nucleo) {
        const previa = vistas.get(palabra);
        if (previa !== undefined) compartidas.push(`${palabra}: ${previa} y ${pregunta.id}`);
        vistas.set(palabra, pregunta.id);
      }
    }
    expect(compartidas, 'palabras de núcleo repetidas entre preguntas').toEqual([]);
  });

  it('una palabra genérica no alcanza para contestar', () => {
    // «tengo» y «cuánto» son apoyo en varias entradas y núcleo en ninguna.
    expect(coincidencias('cuantos empleados tengo')).toEqual([]);
    expect(coincidencias('cuanto')).toEqual([]);
    expect(coincidencias('hola')).toEqual([]);
  });

  it('una palabra del núcleo sí alcanza', () => {
    const r = coincidencias('cuanto vendi este mes');
    expect(r).toHaveLength(1);
    expect(r[0]!.pregunta.id).toBe('VENTAS_DEL_MES');
  });

  it('el apoyo ordena pero no decide', () => {
    // Las dos pegan en su núcleo; «me» y «cuanto» inclinan la balanza hacia la
    // de cobranzas sin que la otra deje de ser candidata por sí sola.
    const conApoyo = coincidencias('cuanto me deben');
    expect(conApoyo).toHaveLength(1);
    expect(conApoyo[0]!.pregunta.id).toBe('CUANTO_ME_DEBEN');

    const solo = coincidencias('deben');
    expect(solo).toHaveLength(1);
    expect(solo[0]!.pregunta.id).toBe('CUANTO_ME_DEBEN');
  });

  it('el empate se muestra entero', () => {
    const r = coincidencias('ventas y compras');
    expect(r.length).toBeGreaterThan(1);
    expect(r.map((c) => c.pregunta.id).sort()).toEqual(['COMPRAS_DEL_MES', 'VENTAS_DEL_MES']);
  });

  it('los permisos filtran el catálogo', () => {
    const todos = new Set([
      'analytics:read', 'allocation:read', 'party:read', 'stock:read',
      'analysis:read', 'report:read', 'product:read', 'check:read',
      'project:read', 'commission:read', 'branch:read', 'cost_center:read',
      // La cobranza del mes se fecha por el asiento que la registra (0090), así
      // que la respuesta exige poder leer el Mayor. Antes no lo miraba.
      'journal_entry:read',
    ]);
    expect(preguntasPara(todos)).toHaveLength(CATALOGO.length);

    // Sin `stock:read` se caen las dos que cruzan existencias.
    const sinStock = new Set([...todos].filter((p) => p !== 'stock:read'));
    const ids = preguntasPara(sinStock).map((p) => p.id);
    expect(ids).not.toContain('VALOR_DEL_STOCK');
    expect(ids).not.toContain('MARGEN');
    expect(ids).toContain('VENTAS_DEL_MES');

    // Sin ningún permiso queda solo lo que no exige ninguno.
    const ninguno = preguntasPara(new Set<string>());
    expect(ninguno.map((p) => p.id)).toEqual(['QUE_ME_FALTA']);
  });

  it('lo que el sistema no hace se dice, y no se contesta con lo más parecido', () => {
    // «¿cuántos empleados tengo en la sucursal de Rosario?» pega en el núcleo de
    // la pregunta de sucursales, porque dice «sucursal». La palabra está bien
    // reconocida y la pregunta es sobre otra cosa: contestarla con las ventas
    // por boca sería peor que un no.
    expect(coincidencias('cuantos empleados tengo en la sucursal de Rosario').length)
      .toBeGreaterThan(0);
    const afuera = fueraDeAlcance('cuantos empleados tengo en la sucursal de Rosario');
    expect(afuera?.tema).toBe('RRHH');
    expect(afuera?.motivo).toContain('ADR-012');

    expect(fueraDeAlcance('cuanto retuve de ganancias')?.tema).toBe('RETENCIONES');
    expect(fueraDeAlcance('me conviene comprar ahora')?.tema).toBe('CONSEJO');
    // Y una pregunta normal no cae en ninguno.
    expect(fueraDeAlcance('cuanto vendi este mes')).toBeNull();
  });

  it('reconoce el mes escrito de las dos formas', () => {
    const hoy = parseCalendarDate('2026-06-15');
    expect(mesDe('cuanto vendi en 2026-03', hoy)).toBe('2026-03');
    expect(mesDe('cuanto vendi en marzo de 2025', hoy)).toBe('2025-03');
    expect(mesDe('cuanto vendi', hoy)).toBeNull();
  });

  it('un mes que todavía no pasó se lee como el del año anterior', () => {
    // Fija, no `new Date()`: un `hoy` real convertía este caso en un test que
    // solo corre —y solo prueba algo— dos meses al año (S-37: un control que
    // depende del reloj es exactamente el que no estaba).
    const hoy = parseCalendarDate('2026-03-15');
    expect(mesDe('cuanto vendi en noviembre', hoy)).toBe('2025-11');
    expect(mesDe('cuanto vendi en marzo', hoy)).toBe('2026-03');
    expect(mesDe('cuanto vendi en enero', hoy)).toBe('2026-01');
  });

  it('en el borde del mes y del año, el «hoy» argentino decide cuál es el mes en curso', () => {
    // 21:00 ART = 00:00Z. Estos son los instantes del defecto: en UTC ya es el mes
    // (o el año) siguiente, en Argentina todavía no. `hoy` sale del mismo helper
    // que usa la aplicación, con instantes fijos y no con el reloj.
    const octubre = hoyEnZonaDeNegocio(new Date('2026-11-01T01:00:00Z')); // 22:00 ART del 31/10
    const noviembre = hoyEnZonaDeNegocio(new Date('2026-11-01T03:00:00Z')); // 00:00 ART del 01/11
    expect(octubre).toBe('2026-10-31');
    expect(noviembre).toBe('2026-11-01');
    expect(mesDe('cuanto vendi en octubre', octubre)).toBe('2026-10'); // el mes en curso
    expect(mesDe('cuanto vendi en noviembre', octubre)).toBe('2025-11'); // todavía no llegó
    expect(mesDe('cuanto vendi en noviembre', noviembre)).toBe('2026-11');

    const dic31 = hoyEnZonaDeNegocio(new Date('2027-01-01T01:00:00Z')); // 22:00 ART del 31/12/2026
    const ene01 = hoyEnZonaDeNegocio(new Date('2027-01-01T03:00:00Z')); // 00:00 ART del 01/01/2027
    expect(mesDe('cuanto vendi en diciembre', dic31)).toBe('2026-12');
    expect(mesDe('cuanto vendi en enero', dic31)).toBe('2026-01'); // enero de 2027 todavía no llegó
    expect(mesDe('cuanto vendi en enero', ene01)).toBe('2027-01');
    expect(mesDe('cuanto vendi en diciembre', ene01)).toBe('2026-12');
  });

  it('los importes se escriben como los escribe una persona', () => {
    expect(pesos('1234567.89')).toBe('1.234.567,89');
    expect(pesos('0')).toBe('0,00');
    expect(pesos(null)).toBeNull();
  });

  it('normalizar saca acentos, signos y mayúsculas', () => {
    expect(normalizar('¿Cuánto vendí?')).toBe('cuanto vendi');
    expect(normalizar('  MARGEN,  por  producto ')).toBe('margen por producto');
  });
});
