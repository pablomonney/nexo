/**
 * El motor de sugerencias de imputación, sin base de datos.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que un pago parcial no produzca propuesta.** Es la decisión que
 *      gobierna todo el motor. Un cobro que entra en varias facturas como pago
 *      parcial no es un caso difícil: es un caso en el que elegir sería
 *      suponer.
 *   2. **Que el empate no se rompa.** Tres facturas de $1.000 y un cobro de
 *      $1.000 tienen tres candidatos igual de exactos. El sistema los muestra
 *      todos y no aplica la convención de la más vieja primero, porque es una
 *      convención y cambia qué se reclama después.
 *   3. **Que el puntaje solo ordene.** Nunca decide si algo se propone: eso lo
 *      decide el importe exacto, que es precondición.
 *
 * Es una función pura, así que estos casos se arman en tres líneas. Montarlos
 * contra PostgreSQL costaría tres facturas y tres asientos por caso, y la
 * mitad no se probaría.
 */

import { describe, expect, it } from 'vitest';
import {
  sugerirImputaciones,
  type MovimientoDisponible,
  type PendienteImputable,
} from '@aai/api/imputaciones/sugerir';

const mov = (lineaId: string, disponible: string, fecha = '2026-03-10'): MovimientoDisponible => ({
  lineaId,
  fecha,
  disponible,
  numeroAsiento: 1,
});

const pend = (
  id: string,
  pendiente: string,
  fecha = '2026-03-01',
  diasDeMora: number | null = 0,
): PendienteImputable => ({
  taxTransactionId: id,
  installmentId: null,
  etiqueta: id,
  pendiente,
  fecha,
  diasDeMora,
});

describe('Sugerencias de imputación', () => {
  it('propone cuando hay un único pendiente por el importe exacto', () => {
    const r = sugerirImputaciones([mov('L1', '1000.00')], [pend('F1', '1000.00')]);

    expect(r.propuestas).toHaveLength(1);
    expect(r.propuestas[0]!.taxTransactionId).toBe('F1');
    expect(r.ambiguas).toEqual([]);
    expect(r.sinPropuesta).toEqual([]);
  });

  it('no propone un pago parcial, y dice por qué', () => {
    // 300 entra en una factura de 900. «Entra» no es «es»: elegirla sería
    // suponer qué se pagó.
    const r = sugerirImputaciones([mov('L1', '300.00')], [pend('F1', '900.00')]);

    expect(r.propuestas).toEqual([]);
    expect(r.sinPropuesta).toHaveLength(1);
    expect(r.sinPropuesta[0]!.motivo).toContain('parcial');
  });

  it('cuando no hay nada que alcance, lo dice distinto de un pago parcial', () => {
    const r = sugerirImputaciones([mov('L1', '5000.00')], [pend('F1', '900.00')]);

    expect(r.sinPropuesta[0]!.motivo).toContain('importe exacto');
    expect(r.sinPropuesta[0]!.motivo).not.toContain('parcial');
  });

  it('tres facturas iguales y un cobro igual son ambiguas, no una propuesta', () => {
    const r = sugerirImputaciones(
      [mov('L1', '1000.00')],
      [
        pend('F1', '1000.00', '2026-01-01'),
        pend('F2', '1000.00', '2026-02-01'),
        pend('F3', '1000.00', '2026-03-01'),
      ],
    );

    expect(r.propuestas, 'no se elige ninguna').toEqual([]);
    expect(r.ambiguas).toHaveLength(1);
    expect(r.ambiguas[0]!.candidatos).toHaveLength(3);
    expect(r.ambiguas[0]!.motivo).toContain('convención');
  });

  it('la más vieja no gana sola: los tres candidatos vienen completos', () => {
    const r = sugerirImputaciones(
      [mov('L1', '1000.00')],
      [pend('F1', '1000.00', '2026-01-01'), pend('F2', '1000.00', '2026-02-01')],
    );

    const ids = r.ambiguas[0]!.candidatos.map((c) => c.taxTransactionId).sort();
    expect(ids).toEqual(['F1', 'F2']);
  });

  it('no ofrece el mismo pendiente a dos movimientos', () => {
    // Si lo hiciera, confirmar las dos propuestas dejaría la factura cancelada
    // por el doble, y el candado de la base lo rechazaría después de que la
    // persona ya hizo el trabajo.
    const r = sugerirImputaciones(
      [mov('L1', '500.00'), mov('L2', '500.00')],
      [pend('F1', '500.00')],
    );

    expect(r.propuestas).toHaveLength(1);
    expect(r.sinPropuesta).toHaveLength(1);
  });

  it('el puntaje ordena pero nunca decide: sube con la cercanía y la mora', () => {
    const cerca = sugerirImputaciones(
      [mov('L1', '100.00', '2026-03-05')],
      [pend('F1', '100.00', '2026-03-01', 10)],
    ).propuestas[0]!;

    const lejos = sugerirImputaciones(
      [mov('L2', '100.00', '2026-12-01')],
      [pend('F2', '100.00', '2026-03-01', 0)],
    ).propuestas[0]!;

    expect(cerca.score).toBeGreaterThan(lejos.score);
    // Las dos se proponen igual: el puntaje no fue el que decidió.
    expect(lejos.taxTransactionId).toBe('F2');
  });

  it('cada propuesta viaja con las señales que la componen', () => {
    const r = sugerirImputaciones(
      [mov('L1', '100.00', '2026-03-05')],
      [pend('F1', '100.00', '2026-03-01', 10)],
    );
    const claves = r.propuestas[0]!.senales.map((s) => s.clave);

    // El puntaje solo es defendible si se puede abrir. Un número sin las
    // señales al lado es una afirmación que hay que creer.
    expect(claves).toContain('IMPORTE_EXACTO');
    expect(claves).toContain('POSTERIOR_AL_COMPROBANTE');
    expect(claves).toContain('DENTRO_DE_VENTANA');
    expect(claves).toContain('PENDIENTE_VENCIDO');
  });

  it('un cobro anterior al comprobante se propone igual, marcado como anticipo', () => {
    const r = sugerirImputaciones(
      [mov('L1', '100.00', '2026-02-01')],
      [pend('F1', '100.00', '2026-03-01')],
    );

    expect(r.propuestas).toHaveLength(1);
    expect(r.propuestas[0]!.senales.map((s) => s.clave)).toContain('ANTERIOR_AL_COMPROBANTE');
  });

  it('sin mora declarada no suma puntaje por mora, y no la inventa', () => {
    const conNull = sugerirImputaciones(
      [mov('L1', '100.00')],
      [pend('F1', '100.00', '2026-03-01', null)],
    ).propuestas[0]!;

    expect(conNull.senales.map((s) => s.clave)).not.toContain('PENDIENTE_VENCIDO');
  });

  it('compara importes al centavo y no por punto flotante', () => {
    // 300.99 * 100 da 30098.999999999996 en IEEE 754. Si la comparación pasara
    // por ahí, este caso no encontraría el match exacto que sí existe.
    const r = sugerirImputaciones([mov('L1', '300.99')], [pend('F1', '300.99')]);

    expect(r.propuestas).toHaveLength(1);
  });

  it('propone contra una cuota cuando el pendiente es de un plan', () => {
    const r = sugerirImputaciones(
      [mov('L1', '250.00')],
      [
        {
          taxTransactionId: 'F1',
          installmentId: 'C2',
          etiqueta: '0001-15 cuota 2',
          pendiente: '250.00',
          fecha: '2026-03-01',
          diasDeMora: 0,
        },
      ],
    );

    expect(r.propuestas[0]!.installmentId, 'sin la cuota, la API rechaza la imputación')
      .toBe('C2');
  });

  it('sin movimientos ni pendientes no inventa nada', () => {
    expect(sugerirImputaciones([], [])).toEqual({
      propuestas: [],
      ambiguas: [],
      sinPropuesta: [],
    });
  });
});
