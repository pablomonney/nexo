/**
 * `scripts/recalcular-cadena.mjs` — la comprobación INDEPENDIENTE de la cadena.
 *
 * `verify_audit_chain()` y el trigger comparten fórmula y fijación (UTC, ISO):
 * verificar solo con la función es circular. El script recalcula el SHA-256 en
 * Node, con su propia copia de la fórmula, y este test comprueba tres cosas:
 *
 *   1. que coincide con lo que escribe el trigger —para filas escritas desde
 *      zonas y estilos de fecha distintos— y que no le importa el entorno del
 *      proceso que lo corre;
 *   2. que **detecta** (control negativo): un campo alterado, un hash alterado y
 *      un enlace roto, sobre filas reales leídas de la base;
 *   3. que la fórmula de Node es la del trigger: si alguien cambia una, el
 *      primer punto falla.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — módulo .mjs sin tipos, a propósito: es JavaScript plano.
import { payloadDeAuditoria, revisarVentana } from '../../scripts/lib/cadena.mjs';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Fila {
  id: string;
  seq: string;
  company_id: string;
  prev_hash: string;
  hash: string;
  actor_type: string;
  actor_id: string;
  action: string;
  object_type: string;
  object_id: string;
  old_value: string | null;
  new_value: string | null;
  motivo: string | null;
  occurred_at: string;
}

interface Informe {
  ok: boolean;
  revisadas: number;
  rotas: number;
  empresas: { empresa: string; revisadas: number; hashesRotos: unknown[]; enlacesRotos: unknown[] }[];
  normativa: { revisadas: number } | null;
}

function correr(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [join('scripts', 'recalcular-cadena.mjs'), ...args], {
    cwd: RAIZ,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const inicio = r.stdout.indexOf('{');
  const informe = inicio >= 0 ? (JSON.parse(r.stdout.slice(inicio)) as Informe) : undefined;
  return { codigo: r.status, informe, salida: `${r.stdout}\n${r.stderr}` };
}

suite('recalcular-cadena.mjs — el recálculo fuera de la base', () => {
  let client: Client;
  let fx: Fixture;

  beforeAll(async () => {
    client = await connect();
    fx = await seed(client, 'recalculo');
    // Filas escritas desde sesiones distintas: lo que el trigger guarda no puede depender de ellas.
    const sesiones: [string, string][] = [
      ['UTC', 'ISO, MDY'],
      ['America/Argentina/Buenos_Aires', 'ISO, MDY'],
      ['Asia/Tokyo', 'SQL, DMY'],
      ['Europe/Madrid', 'German, DMY'],
      ['America/New_York', 'Postgres, MDY'],
      ['Pacific/Kiritimati', 'SQL, MDY'],
    ];
    for (const [i, [zona, estilo]] of sesiones.entries()) {
      await client.query(`SET timezone = '${zona}'`);
      await client.query(`SET datestyle = '${estilo}'`);
      await client.query(
        `INSERT INTO audit_logs (company_id, actor_type, actor_id, action, object_type, object_id, new_value, motivo)
         VALUES ($1, 'USER', 'contador', 'APROBAR_ASIENTO', 'journal_entry', $2, '{"importe": 10.50, "ñ": "á"}', 'revisión')`,
        [fx.companyA, `recalculo-${i}`],
      );
    }
    await client.query('RESET timezone');
    await client.query('RESET datestyle');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('coincide con el trigger, y no le importa la zona ni el estilo del proceso que lo corre', () => {
    for (const pgoptions of [
      '-c timezone=UTC',
      '-c timezone=America/Argentina/Buenos_Aires',
      '-c timezone=Asia/Tokyo -c datestyle=SQL,DMY',
    ]) {
      const { codigo, informe, salida } = correr(['--empresa', fx.companyA, '--ultimas', '50'], {
        PGOPTIONS: pgoptions,
      });
      expect(codigo, `${pgoptions}\n${salida}`).toBe(0);
      expect(informe!.ok).toBe(true);
      expect(informe!.rotas).toBe(0);
      expect(informe!.empresas[0]!.revisadas).toBeGreaterThanOrEqual(6);
    }
  });

  it('sin --empresa recorre todas las cadenas, y una ventana corta revisa solo lo pedido', () => {
    const todas = correr(['--ultimas', '3'], { PGOPTIONS: '-c timezone=UTC' });
    expect(todas.codigo, todas.salida).toBe(0);
    expect(todas.informe!.empresas.length).toBeGreaterThanOrEqual(2);
    for (const e of todas.informe!.empresas) expect(e.revisadas).toBeLessThanOrEqual(4); // 3 + la de contexto
  });

  it('la fórmula de la cadena normativa (copia en Node) coincide con su trigger, escrita desde sesiones distintas', async () => {
    await client.query('BEGIN');
    try {
      const marca = `recalculo-norm-${Date.now()}`;
      for (const [i, [zona, estilo]] of (
        [['UTC', 'ISO, MDY'], ['Asia/Tokyo', 'SQL, DMY'], ['America/New_York', 'German, DMY']] as const
      ).entries()) {
        await client.query(`SET LOCAL timezone = '${zona}'`);
        await client.query(`SET LOCAL datestyle = '${estilo}'`);
        await client.query(
          `INSERT INTO normative_audit_logs
             (actor_type, actor_id, action, object_type, object_id, motivo, new_value, prev_hash, hash, seq)
           VALUES ('USER', 'user:revisora', 'RULE_APPROVED', 'accounting_rules', $1,
                   'Revisado contra el articulo citado y su documento archivado con hash.', '{"n": 1.50}', '', '', 0)`,
          [`${marca}-${i}`],
        );
      }
      await client.query("SET LOCAL timezone = 'UTC'");
      await client.query("SET LOCAL datestyle = 'ISO, MDY'");
      const { rows } = await client.query(
        `SELECT id::text AS id, seq::text AS seq, prev_hash, hash, actor_type, actor_id, action,
                object_type, object_id, old_value::text AS old_value, new_value::text AS new_value,
                motivo, occurred_at::text AS occurred_at
           FROM normative_audit_logs ORDER BY normative_audit_logs.seq DESC LIMIT 4`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
      // `payloadNormativo` se importa abajo para no ensanchar el encabezado del archivo.
      const { payloadNormativo } = (await import('../../scripts/lib/cadena.mjs')) as {
        payloadNormativo: (f: unknown) => string;
      };
      const r = revisarVentana(rows.reverse(), payloadNormativo) as { hashesRotos: unknown[]; enlacesRotos: unknown[] };
      expect(r.hashesRotos).toEqual([]);
      expect(r.enlacesRotos).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  describe('control negativo: detecta lo que debe detectar, sobre filas reales', () => {
    let filas: Fila[];

    beforeAll(async () => {
      await client.query('BEGIN');
      await client.query("SET LOCAL timezone = 'UTC'");
      await client.query("SET LOCAL datestyle = 'ISO, MDY'");
      const r = await client.query<Fila>(
        `SELECT id::text AS id, seq::text AS seq, company_id::text AS company_id, prev_hash, hash,
                actor_type, actor_id, action, object_type, object_id,
                old_value::text AS old_value, new_value::text AS new_value, motivo,
                occurred_at::text AS occurred_at
           FROM audit_logs WHERE company_id = $1 ORDER BY audit_logs.seq`,
        [fx.companyA],
      );
      await client.query('ROLLBACK');
      filas = r.rows;
      expect(filas.length).toBeGreaterThanOrEqual(6);
    });

    const copia = (): Fila[] => filas.map((f) => ({ ...f }));
    const revisar = (f: Fila[], opciones?: { desdeElPrincipio: boolean }) =>
      revisarVentana(f, payloadDeAuditoria, opciones) as {
        revisadas: number;
        hashesRotos: { id: string }[];
        enlacesRotos: { id: string }[];
      };

    it('la cadena intacta no da nada, y arranca en la génesis', () => {
      const r = revisar(copia(), { desdeElPrincipio: true });
      expect(r.hashesRotos).toEqual([]);
      expect(r.enlacesRotos).toEqual([]);
    });

    it.each([
      ['el motivo', (f: Fila) => (f.motivo = 'otro motivo')],
      ['el actor', (f: Fila) => (f.actor_id = 'intruso')],
      ['el valor nuevo', (f: Fila) => (f.new_value = '{"importe": 99}')],
      ['el año de la hora', (f: Fila) => (f.occurred_at = `1999${f.occurred_at.slice(4)}`)],
      ['el hash guardado', (f: Fila) => (f.hash = '0'.repeat(63) + '1')],
    ])('detecta si se altera %s', (_nombre, alterar) => {
      const f = copia();
      alterar(f[3]!);
      const r = revisar(f);
      expect(r.hashesRotos.map((x) => x.id)).toContain(f[3]!.id);
    });

    it('detecta un enlace roto aunque cada hash, por separado, sea correcto', () => {
      const f = copia();
      f.splice(2, 1); // se «borra» una fila de la mitad
      const r = revisar(f);
      expect(r.enlacesRotos.length).toBeGreaterThan(0);
      expect(r.hashesRotos).toEqual([]);
    });

    it('detecta una cadena que dice arrancar pero no trae la génesis', () => {
      const f = copia().slice(2);
      expect(revisar(f, { desdeElPrincipio: true }).enlacesRotos.length).toBe(1);
      expect(revisar(f, { desdeElPrincipio: false }).enlacesRotos).toEqual([]);
    });
  });
});
