/**
 * El costo de una llamada y los dos topes que la gobiernan.
 *
 * Las dos piezas son funciones puras a propósito: la decisión se puede probar
 * sin base y sin proveedor, que es la única forma de ejercitar los bordes —el
 * precio ausente, el cupo justo en el límite— sin montar un escenario entero.
 */

import { describe, expect, it } from 'vitest';
import { calcularCostoEnMicros } from '@aai/ai-engine';
import { motivoDeCorte, type EstadoDelCupo } from '@aai/api/ai/cupo';

const USO = { tokensDeEntrada: 1000, tokensDeSalida: 500, tokensTotales: 1500 };
const PRECIO = { inputMicrosPorMil: 150, outputMicrosPorMil: 600 };

describe('El costo, cuando se puede afirmar', () => {
  it('multiplica por tramo y suma', () => {
    // 1000 de entrada a 150 por mil = 150; 500 de salida a 600 por mil = 300.
    expect(calcularCostoEnMicros(USO, PRECIO)).toBe(450);
  });

  it('sin precio declarado es null, no cero', () => {
    // Un costo cero se suma en un informe y no se distingue de una llamada
    // gratis. `null` obliga a decir «de estas N, M no tienen precio».
    expect(calcularCostoEnMicros(USO, null)).toBeNull();
  });

  it('sin uso informado es null, no cero', () => {
    expect(calcularCostoEnMicros(null, PRECIO)).toBeNull();
    expect(calcularCostoEnMicros(undefined, PRECIO)).toBeNull();
  });

  it('redondea hacia arriba, y por tramo', () => {
    // 1 token de entrada a 150 por mil = 0,15 micros. Truncar daría cero: una
    // llamada que costó algo figuraría como gratis.
    const unToken = { tokensDeEntrada: 1, tokensDeSalida: 1, tokensTotales: 2 };
    expect(calcularCostoEnMicros(unToken, PRECIO)).toBe(2);
  });

  it('un precio de cero es un precio, y da cero', () => {
    // Distinto de «no hay precio»: alguien declaró que este modelo es gratis.
    const gratis = { inputMicrosPorMil: 0, outputMicrosPorMil: 0 };
    expect(calcularCostoEnMicros(USO, gratis)).toBe(0);
  });

  it('es determinística: la misma cuenta da lo mismo siempre', () => {
    const a = calcularCostoEnMicros(USO, PRECIO);
    const b = calcularCostoEnMicros(USO, PRECIO);
    expect(a).toBe(b);
  });

  it('con volúmenes grandes no se va a coma flotante', () => {
    const millones = {
      tokensDeEntrada: 10_000_000,
      tokensDeSalida: 3_000_000,
      tokensTotales: 13_000_000,
    };
    const total = calcularCostoEnMicros(millones, PRECIO);
    expect(total).toBe(1_500_000 + 1_800_000);
    expect(Number.isInteger(total)).toBe(true);
  });
});

describe('Los dos topes', () => {
  const base: EstadoDelCupo = {
    usadasHoy: 5,
    topeDiario: null,
    delUsuarioEnElMinuto: 1,
    topePorMinuto: 20,
  };

  it('sin cupo declarado y sin bucle, se puede preguntar', () => {
    expect(motivoDeCorte(base)).toBeNull();
  });

  it('sin cupo declarado no hay tope diario, por más que se use', () => {
    // Cuántas preguntas entran en un día es una decisión comercial: NEXO no la
    // inventa, y no inventarla significa no cortar.
    expect(motivoDeCorte({ ...base, usadasHoy: 100_000 })).toBeNull();
  });

  it('el tope por minuto corta el bucle', () => {
    const corte = motivoDeCorte({ ...base, delUsuarioEnElMinuto: 20 });
    expect(corte?.codigo).toBe('LIMITE_POR_MINUTO');
    expect(corte?.detalle).toContain('se libera solo');
  });

  it('el cupo diario corta el gasto, y dice que es por empresa', () => {
    const corte = motivoDeCorte({ ...base, topeDiario: 5, usadasHoy: 5 });
    expect(corte?.codigo).toBe('CUPO_DIARIO_AGOTADO');
    expect(corte?.detalle).toContain('por empresa, no por usuario');
  });

  it('justo debajo del cupo todavía se puede', () => {
    expect(motivoDeCorte({ ...base, topeDiario: 5, usadasHoy: 4 })).toBeNull();
  });

  it('un cupo de cero corta desde la primera', () => {
    // Es una forma legítima de apagar la IA para una empresa sin tocar la
    // configuración del servidor.
    const corte = motivoDeCorte({ ...base, topeDiario: 0, usadasHoy: 0 });
    expect(corte?.codigo).toBe('CUPO_DIARIO_AGOTADO');
  });

  it('el bucle se corta antes que el cupo: es el problema más urgente', () => {
    // Con los dos superados, el motivo que se informa es el del minuto, que se
    // libera solo. Decirle a alguien que agotó el cupo del día cuando lo que
    // pasó fue que apretó veinte veces sería mandarlo a pedir una ampliación.
    const corte = motivoDeCorte({
      usadasHoy: 100,
      topeDiario: 10,
      delUsuarioEnElMinuto: 50,
      topePorMinuto: 20,
    });
    expect(corte?.codigo).toBe('LIMITE_POR_MINUTO');
  });
});
