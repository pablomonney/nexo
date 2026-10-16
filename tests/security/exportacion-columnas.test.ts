/**
 * S-48 — la exportación completa no se lleva un secreto por olvido.
 *
 * La exportación toma **todas** las tablas con `company_id`, descubiertas del esquema. La contracara de «no se olvida
 * ninguna tabla» es «una columna nueva con una credencial adentro saldría sin que nadie la mire». Esta prueba obliga a
 * mirarla: toda columna cuyo nombre *parezca* sensible (contraseña, token, clave, secreto…) tiene que estar **excluida** o
 * **declarada segura con su motivo** en `apps/api/src/exportacion/politica.ts`.
 *
 * Y al revés: lo que la política dice excluir tiene que existir. Una exclusión que apunta a una columna que ya no está
 * le hace creer a quien lee el manifiesto que se protegió algo que ya se renombró.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLUMNAS_EXCLUIDAS,
  PATRON_SENSIBLE,
  TABLAS_EXCLUIDAS,
  columnaEsSegura,
} from '../../apps/api/src/exportacion/politica.js';
import { connect, hasDatabase, type Client } from '../integration/helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

suite('S-48 — la exportación completa y las columnas sensibles', () => {
  let db: Client;
  let columnas: { tabla: string; columna: string }[] = [];

  beforeAll(async () => {
    db = await connect();
    const r = await db.query<{ tabla: string; columna: string }>(
      `SELECT c.relname AS tabla, a.attname AS columna
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p')
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'company_id' AND NOT x.attisdropped)
        ORDER BY 1, 2`,
    );
    columnas = r.rows;
  });

  afterAll(async () => {
    await db?.end();
  });

  it('toda columna que parece sensible está excluida o declarada segura (con su motivo)', () => {
    const sinDecidir = columnas
      .filter(({ columna }) => PATRON_SENSIBLE.test(columna))
      .filter(({ tabla }) => !(tabla in TABLAS_EXCLUIDAS))
      .filter(({ tabla, columna }) => !(COLUMNAS_EXCLUIDAS[tabla] !== undefined && columna in COLUMNAS_EXCLUIDAS[tabla]!))
      .filter(({ tabla, columna }) => !columnaEsSegura(tabla, columna))
      .map(({ tabla, columna }) => `${tabla}.${columna}`);
    expect(
      sinDecidir,
      'Estas columnas parecen sensibles y la exportación completa las llevaría. Decidí en apps/api/src/exportacion/politica.ts: ' +
        'COLUMNAS_EXCLUIDAS si no deben salir, COLUMNAS_SEGURAS (con el motivo) si no son un secreto.',
    ).toEqual([]);
  });

  it('lo que la política excluye existe (una exclusión huérfana engaña a quien lee el manifiesto)', () => {
    const existentes = new Set(columnas.map((c) => `${c.tabla}.${c.columna}`));
    const tablas = new Set(columnas.map((c) => c.tabla));
    const huerfanas = [
      ...Object.keys(TABLAS_EXCLUIDAS).filter((t) => !tablas.has(t)).map((t) => `tabla ${t}`),
      ...Object.entries(COLUMNAS_EXCLUIDAS).flatMap(([t, cols]) =>
        Object.keys(cols).filter((c) => !existentes.has(`${t}.${c}`)).map((c) => `columna ${t}.${c}`),
      ),
    ];
    expect(huerfanas).toEqual([]);
  });

  it('cada exclusión y cada columna segura trae su motivo (no un texto vacío)', () => {
    const motivos = [
      ...Object.values(TABLAS_EXCLUIDAS),
      ...Object.values(COLUMNAS_EXCLUIDAS).flatMap((c) => Object.values(c)),
    ];
    expect(motivos.every((m) => m.trim().length >= 15)).toBe(true);
  });
});
