/**
 * `scripts/verificar-zona-de-negocio.mjs` — la comprobación de la zona, ejecutada de verdad.
 *
 * El script es lo que se corre en el servidor después de un deploy (V2 y V7 del
 * plan). Si está roto, esa verificación miente. Acá se lo ejecuta como proceso
 * contra la base de pruebas, dos veces:
 *
 *   · con el cliente crudo en UTC, como la base de producción: tiene que
 *     **distinguir** (la conexión cruda se equivoca en los instantes de las
 *     21:00 a las 24:00 ART y la de la aplicación no);
 *   · con el cliente crudo ya en hora argentina, como la base de desarrollo: sale
 *     bien pero lo dice —`distingue: false`—, para que nadie lo confunda con la
 *     prueba de que `initPool` pide la zona.
 *
 * Ninguna de las dos depende de la hora a la que corre el test: la matriz son
 * instantes fijos.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZONA_DE_NEGOCIO, hoyEnZonaDeNegocio } from '@aai/shared';
import { describe, expect, it } from 'vitest';
import { hasDatabase } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Informe {
  zonaDeNegocio: string;
  desdeLaAplicacion: { zona: string; currentDate: string };
  conexionCruda: { zona: string; currentDate: string };
  matriz: { instante: string; esperado: string; aplicacion: string; cruda: string }[];
  funcionesDeHash: { proname: string; fijado: string }[];
  zonaOk: boolean;
  matrizOk: boolean;
  fechaOk: boolean;
  distingue: boolean;
}

function correr(pgoptions: string): { codigo: number | null; informe: Informe; salida: string } {
  const r = spawnSync(process.execPath, [join('scripts', 'verificar-zona-de-negocio.mjs')], {
    cwd: RAIZ,
    env: { ...process.env, PGOPTIONS: pgoptions },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const salida = `${r.stdout}\n${r.stderr}`;
  const inicio = r.stdout.indexOf('{');
  const fin = r.stdout.lastIndexOf('}');
  expect(inicio, `el script no imprimió el informe:\n${salida}`).toBeGreaterThan(-1);
  return { codigo: r.status, informe: JSON.parse(r.stdout.slice(inicio, fin + 1)) as Informe, salida };
}

suite('verificar-zona-de-negocio.mjs', () => {
  it('con el cliente crudo en UTC (como producción): pasa, y distingue', () => {
    const { codigo, informe, salida } = correr('-c timezone=UTC');

    expect(codigo, salida).toBe(0);
    expect(informe.desdeLaAplicacion.zona).toBe(ZONA_DE_NEGOCIO);
    expect(informe.conexionCruda.zona).toBe('UTC');
    expect(informe.zonaOk && informe.matrizOk && informe.fechaOk).toBe(true);
    expect(informe.distingue, 'la comprobación no distinguió UTC de Argentina').toBe(true);

    // La matriz es fija y cubre los bordes pedidos: 20:59:59, 21:00:00, 21:00:01,
    // 23:59:59 y 00:00:00 ART, un fin de mes, un fin de año y los dos febreros.
    const por = new Map(informe.matriz.map((f) => [f.instante, f]));
    for (const [instante, esperado, enUtc] of [
      ['2026-10-05T23:59:59Z', '2026-10-05', '2026-10-05'], // 20:59:59 ART
      ['2026-10-06T00:00:00Z', '2026-10-05', '2026-10-06'], // 21:00:00 ART: UTC ya es mañana
      ['2026-10-06T00:00:01Z', '2026-10-05', '2026-10-06'], // 21:00:01 ART
      ['2026-10-06T02:59:59Z', '2026-10-05', '2026-10-06'], // 23:59:59 ART
      ['2026-10-06T03:00:00Z', '2026-10-06', '2026-10-06'], // 00:00:00 ART
      ['2026-11-01T00:00:00Z', '2026-10-31', '2026-11-01'], // fin de mes
      ['2027-01-01T00:00:00Z', '2026-12-31', '2027-01-01'], // fin de año
      ['2027-03-01T02:59:59Z', '2027-02-28', '2027-03-01'], // febrero común
      ['2028-03-01T02:59:59Z', '2028-02-29', '2028-03-01'], // febrero bisiesto
    ] as const) {
      const fila = por.get(instante);
      expect(fila, `falta el instante ${instante}`).toBeDefined();
      expect(fila!.esperado, `${instante} esperado`).toBe(esperado);
      expect(fila!.aplicacion, `${instante} en la aplicación`).toBe(esperado);
      expect(fila!.cruda, `${instante} en la conexión cruda (UTC)`).toBe(enUtc);
    }
  });

  it('lo esperado de la matriz es lo que calcula @aai/shared, no una tabla escrita a mano', () => {
    const { informe } = correr('-c timezone=UTC');
    for (const f of informe.matriz) {
      expect(f.esperado, f.instante).toBe(hoyEnZonaDeNegocio(new Date(f.instante)));
    }
  });

  it('con el cliente crudo ya en hora argentina: pasa, pero dice que no distingue', () => {
    const { codigo, informe, salida } = correr(`-c timezone=${ZONA_DE_NEGOCIO}`);
    expect(codigo, salida).toBe(0);
    expect(informe.matrizOk).toBe(true);
    expect(informe.distingue).toBe(false);
    expect(salida).toMatch(/no se demostró que initPool la pida/);
  });

  it('informa lo que tienen fijado las tres funciones de hash', () => {
    const { informe } = correr('-c timezone=UTC');
    expect(informe.funcionesDeHash.map((f) => f.proname)).toEqual([
      'audit_chain_link',
      'normative_audit_chain_link',
      'verify_audit_chain',
    ]);
    for (const f of informe.funcionesDeHash) {
      expect(f.fijado, f.proname).toMatch(/TimeZone=UTC/);
      expect(f.fijado, f.proname).toMatch(/DateStyle=ISO/);
    }
  });
});
