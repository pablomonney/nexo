/**
 * El test que reproduce la colisión antes de arreglarla.
 *
 * El flake se veía como `llave duplicada viola restricción de unicidad
 * «organizations_tax_id_key»` en una suite u otra, sin patrón, y desaparecía al
 * reintentar. Subir esperas o reintentos lo habría escondido sin tocar la causa.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCheckDigit } from '@aai/shared';
import { connect, hasDatabase, type Client } from './helpers/db.js';
import { sufijoLegadoQueColisiona, sufijoUnico } from './helpers/identificadores.js';

describe('la fórmula anterior descartaba el PID', () => {
  it('tres procesos distintos en el mismo milisegundo producen el MISMO sufijo', () => {
    const ahora = 1_787_000_123_456;
    const sufijos = [1234, 98_765, 4].map((pid) => sufijoLegadoQueColisiona(pid, ahora));

    // Este es el defecto, escrito como afirmación: el `${process.pid}` del
    // principio se cae con el `slice(-8)` del final.
    expect(new Set(sufijos).size).toBe(1);
  });

  it('y con él, el CUIT del estudio también colisiona', () => {
    const ahora = 1_787_000_123_456;
    const cuits = [1234, 98_765].map((pid) => withCheckDigit(`30${sufijoLegadoQueColisiona(pid, ahora)}`));
    // Las cinco suites usan el prefijo `30` para el estudio, así que la colisión
    // del sufijo es directamente una colisión de `organizations_tax_id_key`.
    expect(cuits[0]).toBe(cuits[1]);
  });

  it('se repite sola cada 27,8 horas, y las filas no se borran', () => {
    const ahora = 1_787_000_123_456;
    const unCicloDespues = ahora + 100_000_000;
    expect(sufijoLegadoQueColisiona(999, unCicloDespues)).toBe(sufijoLegadoQueColisiona(999, ahora));
  });
});

describe.skipIf(!hasDatabase)('sufijoUnico', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect();
  });
  afterAll(async () => {
    await client.end();
  });

  it('nunca repite, ni siquiera pedido muchas veces seguidas', async () => {
    // En serie y no con `Promise.all`: un `pg.Client` no admite consultas
    // concurrentes —las encola, y avisa que va a dejar de hacerlo—. El caso
    // concurrente de verdad es el de dos conexiones, que se prueba más abajo.
    const obtenidos: string[] = [];
    for (let i = 0; i < 50; i += 1) obtenidos.push(await sufijoUnico(client));
    expect(new Set(obtenidos).size).toBe(50);
  });

  it('devuelve ocho dígitos, para que el CUIT compuesto sea válido', async () => {
    const sufijo = await sufijoUnico(client);
    expect(sufijo).toMatch(/^\d{8}$/);
    // `30` + 8 dígitos + verificador = 11, que es lo que exige un CUIT.
    expect(withCheckDigit(`30${sufijo}`)).toHaveLength(11);
  });

  it('dos conexiones distintas tampoco se pisan', async () => {
    // Es el caso real: vitest corre las suites en procesos paralelos, cada uno
    // con su conexión. La secuencia es lo que los coordina sin que se hablen.
    const otro = await connect();
    try {
      const [a, b] = await Promise.all([sufijoUnico(client), sufijoUnico(otro)]);
      expect(a).not.toBe(b);
    } finally {
      await otro.end();
    }
  });
});
