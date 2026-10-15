/**
 * La huella de una operación (`huellaDeLaOperacion`) y la forma de la clave (`claveDeIdempotencia`).
 *
 * La huella decide si dos pedidos con la misma clave son «el mismo pedido reintentado» o «dos pedidos distintos con una
 * clave mal reutilizada». Tiene que ser estable ante lo irrelevante (el orden de los campos, un campo `undefined`) y
 * sensible a lo que importa (cualquier dato, la operación, la empresa).
 */

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { claveDeIdempotencia, huellaDeLaOperacion } from '../../apps/api/src/http/idempotencia.js';

describe('huellaDeLaOperacion', () => {
  it('es un SHA-256 en hexadecimal', () => {
    expect(huellaDeLaOperacion('caja.movimiento', { a: 1 })).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('no depende del orden de los campos, tampoco en objetos anidados ni dentro de listas', () => {
    const a = huellaDeLaOperacion('x', { b: 2, a: 1, c: { y: 1, x: 2 }, l: [{ q: 1, p: 2 }] });
    const b = huellaDeLaOperacion('x', { l: [{ p: 2, q: 1 }], c: { x: 2, y: 1 }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('un campo undefined es lo mismo que un campo ausente (JSON no lo distingue)', () => {
    expect(huellaDeLaOperacion('x', { a: 1, b: undefined })).toBe(huellaDeLaOperacion('x', { a: 1 }));
  });

  it('el orden de una LISTA sí importa: las líneas de una salida son una secuencia', () => {
    expect(huellaDeLaOperacion('x', { l: [1, 2] })).not.toBe(huellaDeLaOperacion('x', { l: [2, 1] }));
  });

  it('cambia con cualquier dato, con la operación y con la empresa', () => {
    const base = huellaDeLaOperacion('caja.movimiento', { empresa: 'e1', importe: '10.00' });
    expect(huellaDeLaOperacion('caja.movimiento', { empresa: 'e1', importe: '10.01' })).not.toBe(base);
    expect(huellaDeLaOperacion('stock.ajuste', { empresa: 'e1', importe: '10.00' })).not.toBe(base);
    expect(huellaDeLaOperacion('caja.movimiento', { empresa: 'e2', importe: '10.00' })).not.toBe(base);
  });

  it('un null y un cero a la izquierda no se confunden con la ausencia ni con el número', () => {
    expect(huellaDeLaOperacion('x', { a: null })).not.toBe(huellaDeLaOperacion('x', {}));
    expect(huellaDeLaOperacion('x', { a: '1' })).not.toBe(huellaDeLaOperacion('x', { a: 1 }));
  });
});

describe('claveDeIdempotencia', () => {
  const pedido = (valor: string | string[] | undefined) =>
    ({ headers: valor === undefined ? {} : { 'idempotency-key': valor } }) as unknown as FastifyRequest;

  it('acepta de 16 a 128 caracteres de letras, números, guion y guion bajo', () => {
    expect(claveDeIdempotencia(pedido('a'.repeat(16)))).toBe('a'.repeat(16));
    expect(claveDeIdempotencia(pedido('A-b_9'.repeat(25) + 'abc'))).toHaveLength(128);
    expect(claveDeIdempotencia(pedido(crypto.randomUUID()))).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('rechaza la ausente, la vacía, la corta, la larga y la que tiene caracteres fuera de la lista', () => {
    for (const mala of [undefined, '', 'a'.repeat(15), 'a'.repeat(129), `${'a'.repeat(20)} `, `${'a'.repeat(20)}ñ`, `${'a'.repeat(20)};--`]) {
      expect(() => claveDeIdempotencia(pedido(mala)), String(mala)).toThrow();
    }
  });

  it('el mensaje de la ausente dice qué hacer y menciona el encabezado', () => {
    try {
      claveDeIdempotencia(pedido(undefined));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/Idempotency-Key/u);
    }
  });
});
