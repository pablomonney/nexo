/**
 * FASE G — la regla del art. 12 conectada al hecho, todavía en DRAFT.
 *
 * Estos tests no activan nada. Comprueban qué haría la regla **si** se activara,
 * que es la información que hace falta para decidir si activarla.
 *
 * La resolución se hace con el AST y las condiciones **tal como están guardadas
 * en `accounting_rules`**, no con una copia escrita acá: si alguien edita la
 * regla en la base, estos tests tienen que notarlo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluar, ErrorDeRegla } from '@aai/normative-engine';
import {
  HECHO_VINCULACION,
  hechosDeAfectacion,
  proveerVinculacion,
  type Afectacion,
  type DeclaracionDeAfectacion,
} from '@aai/tax-engine';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const CLAVE = 'AR-IVA-CF-VINCULACION-001';

/** Qué haría la regla con lo que el sistema sabe hoy de esa operación. */
type Desenlace =
  | { tipo: 'FUENTE_NO_ENCONTRADA'; motivo: string }
  | { tipo: 'REQUIERE_REVISION'; motivo: string }
  | { tipo: 'REGLA_NO_APLICA' }
  | { tipo: 'NO_COMPUTABLE' };

function resolver(ast: unknown, declaracion: DeclaracionDeAfectacion | null): Desenlace {
  const provision = proveerVinculacion(declaracion);
  if (provision.estado === 'AUSENTE') return { tipo: 'FUENTE_NO_ENCONTRADA', motivo: provision.motivo };
  if (provision.estado === 'REQUIERE_REVISION') return { tipo: 'REQUIERE_REVISION', motivo: provision.motivo };

  try {
    return evaluar(ast, hechosDeAfectacion(provision))
      ? { tipo: 'NO_COMPUTABLE' }
      : { tipo: 'REGLA_NO_APLICA' };
  } catch (error) {
    // No debería pasar con un hecho provisto; si pasa, es un AST que cambió.
    if (error instanceof ErrorDeRegla) return { tipo: 'FUENTE_NO_ENCONTRADA', motivo: error.message };
    throw error;
  }
}

suite('AR-IVA-CF-VINCULACION-001 — conectada, en DRAFT', () => {
  let db: Client;
  let fx: Fixture;
  let ast: unknown;
  let opId: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'regla-iva');

    const regla = await db.query<{ conditions: unknown; status: string }>(
      'SELECT conditions, status FROM accounting_rules WHERE rule_key = $1 AND version = 1',
      [CLAVE],
    );
    if (regla.rowCount === 0) {
      throw new Error(`La regla ${CLAVE} no está cargada. Corré: npm run reglas:cargar -- --aplicar`);
    }
    ast = regla.rows[0]!.conditions;

    const impuesto = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    const op = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero, cbte_fecha,
          cuit_contraparte, razon_social, condicion_iva, neto, iva, no_gravado, exento,
          percepciones, total, created_by)
       VALUES ($1, $2, $3, 'COMPRAS', 1, 1, 77, '2026-03-20', '30710000001', 'Proveedor',
               'RESPONSABLE_INSCRIPTO', 100000, 21000, 0, 0, 0, 121000, 'test')
       RETURNING id`,
      [fx.companyA, impuesto.rows[0]!.id, fx.periodA],
    );
    opId = op.rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
  });

  async function declarar(afectacion: Afectacion, origen = 'DECLARACION_PROFESIONAL'): Promise<void> {
    const proporcion = afectacion === 'MIXTA' ? 6000 : null;
    const evidencia =
      afectacion === 'NO_DETERMINADA' ? [] : [{ tipo: 'CUENTA', id: fx.cashA }];
    await db.query(
      `INSERT INTO tax_affectations
         (company_id, tax_transaction_id, afectacion, proporcion_gravada, evidencia,
          origen, declarada_por, declarada_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
       ON CONFLICT (tax_transaction_id) DO UPDATE
         SET afectacion = EXCLUDED.afectacion,
             proporcion_gravada = EXCLUDED.proporcion_gravada,
             evidencia = EXCLUDED.evidencia,
             origen = EXCLUDED.origen,
             declarada_por = EXCLUDED.declarada_por,
             declarada_at = EXCLUDED.declarada_at`,
      [
        fx.companyA,
        opId,
        afectacion,
        proporcion,
        JSON.stringify(evidencia),
        origen,
        origen === 'DECLARACION_PROFESIONAL' ? 'user:contadora' : null,
      ],
    );
  }

  async function declaracionVigente(): Promise<DeclaracionDeAfectacion | null> {
    const r = await db.query<Record<string, never>>(
      `SELECT company_id, tax_transaction_id, afectacion, proporcion_gravada,
              declarada_por, declarada_at, evidencia
         FROM tax_affectations_declaradas WHERE tax_transaction_id = $1`,
      [opId],
    );
    const f = r.rows[0] as unknown as {
      company_id: string; tax_transaction_id: string; afectacion: Afectacion;
      proporcion_gravada: number | null; declarada_por: string; declarada_at: Date;
      evidencia: DeclaracionDeAfectacion['evidencia'];
    } | undefined;
    if (f === undefined) return null;
    return {
      companyId: f.company_id,
      taxTransactionId: f.tax_transaction_id,
      afectacion: f.afectacion,
      proporcionGravada: f.proporcion_gravada,
      declaradaPor: f.declarada_por,
      declaradaAt: f.declarada_at.toISOString(),
      evidencia: f.evidencia,
    };
  }

  it('la regla sigue en DRAFT y no hay ninguna ACTIVE', async () => {
    const r = await db.query<{ status: string }>(
      'SELECT status FROM accounting_rules WHERE rule_key = $1',
      [CLAVE],
    );
    expect(r.rows[0]!.status).toBe('DRAFT');

    // Se cuentan solo las reglas que entraron por el cargador. Otras suites de
    // integración crean reglas de fixture en ACTIVE para ejercitar el motor, y
    // contarlas hacía que este test dependiera del orden de ejecución: pasaba
    // sobre una base recién creada y fallaba en la corrida completa.
    const activas = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounting_rules
        WHERE status = 'ACTIVE' AND proposed_by LIKE 'cargador:%'`,
    );
    expect(activas.rows[0]!.n).toBe('0');
  });

  it('el AST guardado es el que se espera: una igualdad contra false', () => {
    expect(ast).toEqual({ op: 'eq', field: HECHO_VINCULACION, value: false });
  });

  it('sin afectación declarada → FUENTE_NO_ENCONTRADA', async () => {
    expect(await declaracionVigente()).toBeNull();
    expect(resolver(ast, null)).toEqual({
      tipo: 'FUENTE_NO_ENCONTRADA',
      motivo: 'SIN_DECLARACION',
    });
  });

  it('con una sugerencia por precedente → FUENTE_NO_ENCONTRADA', async () => {
    await declarar('EXENTAS', 'SUGERIDA_POR_PRECEDENTE');
    const d = await declaracionVigente();
    expect(d).toBeNull();
    expect(resolver(ast, d).tipo).toBe('FUENTE_NO_ENCONTRADA');
  });

  it('con GRAVADAS → la condición del artículo se satisface, y la regla NO afirma computabilidad', async () => {
    await declarar('GRAVADAS');
    const d = await declaracionVigente();
    expect(d?.afectacion).toBe('GRAVADAS');

    const desenlace = resolver(ast, d);
    // La regla no dispara. Eso es todo lo que puede decir: el art. 12 enuncia una
    // condición necesaria, y de una necesaria no se deduce la afirmativa.
    expect(desenlace).toEqual({ tipo: 'REGLA_NO_APLICA' });
    expect(desenlace.tipo).not.toBe('NO_COMPUTABLE');
    // Y ninguna acción del catálogo permitiría afirmar lo contrario.
    const accion = await db.query<{ action: { resultado: string } }>(
      'SELECT action FROM accounting_rules WHERE rule_key = $1',
      [CLAVE],
    );
    expect(accion.rows[0]!.action.resultado).toBe('NO_COMPUTABLE');
  });

  it('con EXENTAS → NO_COMPUTABLE, fundado en la condición negativa', async () => {
    await declarar('EXENTAS');
    expect(resolver(ast, await declaracionVigente())).toEqual({ tipo: 'NO_COMPUTABLE' });
  });

  it('con NO_GRAVADAS → NO_COMPUTABLE', async () => {
    await declarar('NO_GRAVADAS');
    expect(resolver(ast, await declaracionVigente())).toEqual({ tipo: 'NO_COMPUTABLE' });
  });

  it('con MIXTA → REQUIERE_REVISION, no NO_COMPUTABLE', async () => {
    await declarar('MIXTA');
    const desenlace = resolver(ast, await declaracionVigente());
    expect(desenlace).toEqual({ tipo: 'REQUIERE_REVISION', motivo: 'MIXTA_SIN_PRORRATEO' });
  });

  it('con NO_DETERMINADA → FUENTE_NO_ENCONTRADA, igual que sin declaración', async () => {
    await declarar('NO_DETERMINADA');
    const d = await declaracionVigente();
    expect(d).toBeNull();
    expect(resolver(ast, d).tipo).toBe('FUENTE_NO_ENCONTRADA');
  });
});
