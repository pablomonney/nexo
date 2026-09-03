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
import {
  CATALOGO,
  coincidencias,
  mesDe,
  normalizar,
  pesos,
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
    expect(coincidencias('cuantos empleados tengo en Rosario')).toEqual([]);
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
      'analysis:read', 'report:read',
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

  it('reconoce el mes escrito de las dos formas', () => {
    expect(mesDe('cuanto vendi en 2026-03')).toBe('2026-03');
    expect(mesDe('cuanto vendi en marzo de 2025')).toBe('2025-03');
    expect(mesDe('cuanto vendi')).toBeNull();
  });

  it('un mes que todavía no pasó se lee como el del año anterior', () => {
    const hoy = new Date();
    const mesQueViene = (hoy.getUTCMonth() + 2) % 12; // 0-11, dos meses adelante
    const nombres = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ];
    // Solo tiene sentido comprobarlo cuando ese mes cae después del corriente.
    if (mesQueViene + 1 > hoy.getUTCMonth() + 1) {
      const leido = mesDe(`cuanto vendi en ${nombres[mesQueViene]}`);
      expect(leido).toBe(
        `${hoy.getUTCFullYear() - 1}-${String(mesQueViene + 1).padStart(2, '0')}`,
      );
    }
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
