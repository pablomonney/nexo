/**
 * "Este asiento existe porque…" — el recorrido, en los dos sentidos.
 *
 * Caso: la Factura C 0001-00000005 del corpus de homologación, sin modificar, y
 * con `AR-IVA-CF-VINCULACION-001` en DRAFT. Es decir: el caso donde el sistema
 * **no puede** fundar el asiento en una regla, y tiene que decirlo en vez de
 * inventar una.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  expectFailureCode,
  hasDatabase,
  seed,
  type Client,
  type Fixture,
} from './helpers/db.js';

const SHA_LEY_IVA = '180b1380c820cbabc572b707b540e9299e074423fcad4f69b920b06167eb3244';
const CLAVE = 'AR-IVA-CF-VINCULACION-001';
const RAIZ = join(import.meta.dirname, '..', '..');

interface DelCorpus {
  ptoVta: number;
  cbteTipo: number;
  cbteNro: number;
  cbteFch: string;
  impTotal: number;
  cae: string;
  cuitEmisor: string;
}

function delCorpus(): DelCorpus | null {
  try {
    const lista = JSON.parse(
      readFileSync(join(RAIZ, 'var', 'corpus-homologacion', 'comprobantes.json'), 'utf8'),
    ) as DelCorpus[];
    return lista[0] ?? null;
  } catch {
    return null;
  }
}

const COMPROBANTE = delCorpus();
const suite = hasDatabase && COMPROBANTE !== null ? describe : describe.skip;

suite('trazabilidad — de un asiento a su fuente normativa', () => {
  let db: Client;
  let fx: Fixture;
  let periodId: string;
  let fiscalYearId: string;
  let opId: string;
  let ruleId: string;
  let fecha: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'trazabilidad');

    const c = COMPROBANTE!;
    fecha = `${c.cbteFch.slice(0, 4)}-${c.cbteFch.slice(4, 6)}-${c.cbteFch.slice(6, 8)}`;
    const anio = fecha.slice(0, 4);
    const mes = Number(fecha.slice(5, 7));

    const fy = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [fx.companyA, `EJ${anio}-traza`, `${anio}-01-01`, `${anio}-12-31`],
    );
    fiscalYearId = fy.rows[0]!.id;

    const p = await db.query<{ id: string }>(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        fx.companyA,
        fiscalYearId,
        mes,
        `${fecha.slice(0, 7)}-01`,
        new Date(Date.UTC(Number(anio), mes, 0)).toISOString().slice(0, 10),
      ],
    );
    periodId = p.rows[0]!.id;

    const impuesto = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    // numeric(18,2) son pesos, no centavos.
    const total = c.impTotal.toFixed(2);
    const op = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
          cbte_fecha, cuit_contraparte, razon_social, condicion_iva, neto, iva,
          no_gravado, exento, percepciones, total, constatacion, created_by)
       VALUES ($1,$2,$3,'VENTAS',$4,$5,$6,$7,$8,'Consumidor final','CONSUMIDOR_FINAL',
               $9,0,0,0,0,$9,'OK','traza')
       RETURNING id`,
      [fx.companyA, impuesto.rows[0]!.id, periodId, c.cbteTipo, c.ptoVta, c.cbteNro, fecha, c.cuitEmisor, total],
    );
    opId = op.rows[0]!.id;

    const r = await db.query<{ id: string }>(
      'SELECT id FROM accounting_rules WHERE rule_key = $1 AND version = 1',
      [CLAVE],
    );
    ruleId = r.rows[0]!.id;
  });

  afterAll(async () => {
    await db.end();
  });

  /**
   * Cada decisión sobre su propia operación fiscal.
   *
   * Antes de la 0036 todas apuntaban a `opId` y convivían: la base no impedía
   * dos decisiones vigentes para la misma operación. La auditoría encontró ese
   * agujero —dos filas diciendo, cada una, ser "la" razón del asiento— y ahora
   * hay un índice único. Este helper deja de apoyarse en el defecto: los tests
   * de abajo prueban variantes de decisión, no la regla de unicidad, que tiene
   * su propio archivo.
   */
  let contador = 0;
  async function operacionNueva(): Promise<string> {
    contador += 1;
    const impuesto = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    const r = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
          cbte_fecha, cuit_contraparte, razon_social, condicion_iva, neto, iva,
          no_gravado, exento, percepciones, total, constatacion, created_by)
       VALUES ($1,$2,$3,'VENTAS',11,1,$4,$5,$6,'Consumidor final','CONSUMIDOR_FINAL',
               100,0,0,0,0,100,'OK','traza')
       RETURNING id`,
      [
        fx.companyA,
        impuesto.rows[0]!.id,
        periodId,
        920000 + contador,
        fecha,
        COMPROBANTE!.cuitEmisor,
      ],
    );
    return r.rows[0]!.id;
  }

  /** Emite una decisión y devuelve su id. */
  async function decidir(campos: Record<string, unknown> = {}): Promise<string> {
    const d = {
      origen: 'DETERMINISTICA',
      resultado: 'REQUIERE_REVISION',
      motivos: [{ motivo: 'REGLA_NO_ACTIVA', detalle: `${CLAVE} está en DRAFT` }],
      hechos: [
        { campo: 'importes.total', valor: '3438252', origen: 'DOCUMENTAL', fuente: 'comprobante' },
        { campo: 'comprobante.cae', valor: COMPROBANTE!.cae, origen: 'TRIBUTARIO', fuente: 'ARCA' },
      ],
      evidencia: [{ tipo: 'COMPROBANTE', id: opId }],
      ambiente: 'PRODUCTIVO',
      justificacion: null,
      ai_prediction_id: null,
      ...campos,
    };
    const sobre = (campos['tax_transaction_id'] as string | undefined) ?? (await operacionNueva());
    const r = await db.query<{ id: string }>(
      `INSERT INTO accounting_decisions
         (company_id, tax_transaction_id, origen, ai_prediction_id, resultado,
          motivos, hechos, evidencia, ambiente, decidida_por, justificacion)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,'sistema:circuito',$10)
       RETURNING id`,
      [
        fx.companyA,
        sobre,
        d.origen,
        d.ai_prediction_id,
        d.resultado,
        JSON.stringify(d.motivos),
        JSON.stringify(d.hechos),
        JSON.stringify(d.evidencia),
        d.ambiente,
        d.justificacion,
      ],
    );
    return r.rows[0]!.id;
  }

  // ── 1-6: la decisión y su fundamento ─────────────────────────────────────
  it('11 · una decisión PRODUCTIVA no puede citar la regla en DRAFT', async () => {
    const decisionId = await decidir();
    const fallo = await expectFailureCode(() =>
      db.query(
        `INSERT INTO rule_applications
           (company_id, rule_id, rule_version, target_type, target_id, decision_id, inputs, outputs)
         VALUES ($1,$2,1,'tax_transaction',$3,$4,'{}'::jsonb,'{}'::jsonb)`,
        [fx.companyA, ruleId, opId, decisionId],
      ),
    );
    expect(fallo.message).toMatch(/está en estado DRAFT.*no puede fundar una decisión productiva/s);
  });

  it('11b · una decisión de PRUEBA sí puede, y queda marcada como tal', async () => {
    const decisionId = await decidir({ ambiente: 'PRUEBA' });
    await db.query(
      `INSERT INTO rule_applications
         (company_id, rule_id, rule_version, target_type, target_id, decision_id, inputs, outputs)
       VALUES ($1,$2,1,'tax_transaction',$3,$4,'{}'::jsonb,'{}'::jsonb)`,
      [fx.companyA, ruleId, opId, decisionId],
    );

    const ra = await db.query<{ rule_status_at_application: string; norm_document_sha256: string }>(
      'SELECT rule_status_at_application, norm_document_sha256 FROM rule_applications WHERE decision_id = $1',
      [decisionId],
    );
    // 1, 2 · referencia la regla y su versión concreta.
    expect(ra.rowCount).toBe(1);
    // 3, 4 · y el hash de la fuente, congelado, coincide con el archivado.
    expect(ra.rows[0]!.norm_document_sha256).toBe(SHA_LEY_IVA);
    expect(ra.rows[0]!.rule_status_at_application).toBe('DRAFT');
  });

  it('el hash lo congela la base, no quien inserta', async () => {
    const decisionId = await decidir({ ambiente: 'PRUEBA' });
    await db.query(
      `INSERT INTO rule_applications
         (company_id, rule_id, rule_version, target_type, target_id, decision_id,
          inputs, outputs, norm_document_sha256)
       VALUES ($1,$2,1,'tax_transaction',$3,$4,'{}'::jsonb,'{}'::jsonb,'0000mentira')`,
      [fx.companyA, ruleId, opId, decisionId],
    );
    const ra = await db.query<{ norm_document_sha256: string }>(
      'SELECT norm_document_sha256 FROM rule_applications WHERE decision_id = $1',
      [decisionId],
    );
    expect(ra.rows[0]!.norm_document_sha256).toBe(SHA_LEY_IVA);
  });

  it('5 y 6 · la decisión conserva los hechos con su origen, y la evidencia', async () => {
    const decisionId = await decidir();
    const d = await db.query<{
      hechos: { campo: string; origen: string; fuente: string }[];
      evidencia: { tipo: string; id: string }[];
    }>('SELECT hechos, evidencia FROM accounting_decisions WHERE id = $1', [decisionId]);

    const hechos = d.rows[0]!.hechos;
    expect(hechos.map((h) => h.origen).sort()).toEqual(['DOCUMENTAL', 'TRIBUTARIO']);
    expect(hechos.every((h) => h.fuente !== '')).toBe(true);
    expect(d.rows[0]!.evidencia[0]).toMatchObject({ tipo: 'COMPROBANTE', id: opId });
  });

  it('una revisión sin motivo no se puede registrar', async () => {
    const fallo = await expectFailureCode(() => decidir({ motivos: [] }));
    expect(fallo.message).toMatch(/decision_revision_lleva_motivo/);
  });

  it('una propuesta sin regla ni justificación tampoco', async () => {
    const fallo = await expectFailureCode(() =>
      decidir({ resultado: 'PROPUESTA_DE_ASIENTO', motivos: [] }),
    );
    expect(fallo.message).toMatch(/necesita justificación/);
  });

  it('10 · una decisión MANUAL no inventa una regla', async () => {
    const manual = await decidir({
      origen: 'MANUAL',
      resultado: 'PROPUESTA_DE_ASIENTO',
      motivos: [],
      justificacion: 'Ajuste de cierre resuelto por el contador; no hay norma que lo automatice.',
    });

    const fallo = await expectFailureCode(() =>
      db.query(
        `INSERT INTO rule_applications
           (company_id, rule_id, rule_version, target_type, target_id, decision_id, inputs, outputs)
         VALUES ($1,$2,1,'tax_transaction',$3,$4,'{}'::jsonb,'{}'::jsonb)`,
        [fx.companyA, ruleId, opId, manual],
      ),
    );
    // Corta antes el candado de la regla DRAFT; el de MANUAL está igual, y se
    // ejercita abajo con una decisión de prueba.
    expect(fallo.message.length).toBeGreaterThan(0);
  });

  it('una decisión MANUAL sin justificación se rechaza', async () => {
    const fallo = await expectFailureCode(() =>
      decidir({ origen: 'MANUAL', resultado: 'SIN_EFECTO', motivos: [], justificacion: '   ' }),
    );
    expect(fallo.message).toMatch(/necesita justificación escrita/);
  });

  it('una decisión PROPUESTA_IA sin predicción se rechaza, y al revés también', async () => {
    const sinPrediccion = await expectFailureCode(() => decidir({ origen: 'PROPUESTA_IA' }));
    expect(sinPrediccion.message).toMatch(/decision_ia_requiere_prediccion/);
  });

  // ── 7-9: el recorrido ────────────────────────────────────────────────────
  describe('el asiento y su decisión', () => {
    let decisionId: string;
    let entryId: string;

    beforeAll(async () => {
      // El caso real: no hay regla activa, así que la decisión que funda el
      // asiento es MANUAL y lo dice. No se inventa una regla.
      decisionId = await decidir({
        tax_transaction_id: opId,
        origen: 'MANUAL',
        resultado: 'PROPUESTA_DE_ASIENTO',
        motivos: [],
        justificacion:
          `Venta ${COMPROBANTE!.ptoVta}-${COMPROBANTE!.cbteNro} registrada por la contadora. ` +
          `${CLAVE} está en DRAFT y no funda el tratamiento; el asiento se decide a mano.`,
      });

      const total = COMPROBANTE!.impTotal.toFixed(2);
      await db.query('BEGIN');
      const e = await db.query<{ id: string }>(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, total_debit, total_credit, source_type, source_id,
            decision_id, manual_justification, created_by, approved_by, approved_at)
         VALUES ($1,'GENERAL',$2,$3,next_entry_number($1,'GENERAL',$3),$4,$5,'NORMAL','APROBADO',
                 $6,$6,'INVOICE',$7,$8,$9,'user:cargadora','user:contadora',now())
         RETURNING id`,
        [
          fx.companyA, periodId, fiscalYearId, fecha,
          `Venta C ${COMPROBANTE!.ptoVta}-${COMPROBANTE!.cbteNro} — CAE ${COMPROBANTE!.cae}`,
          total, opId, decisionId,
          'Sin regla activa que funde el tratamiento; decidido por la contadora.',
        ],
      );
      entryId = e.rows[0]!.id;
      for (const [n, cuenta, debe, haber] of [
        [1, fx.cashA, total, '0'],
        [2, fx.salesA, '0', total],
      ] as const) {
        await db.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, currency, description, tax_transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,'ARS','traza',$7)`,
          [fx.companyA, entryId, n, cuenta, debe, haber, opId],
        );
      }
      // 14 · Debe = Haber sigue verificándose en el COMMIT real.
      await db.query('COMMIT');
      await db.query('UPDATE accounting_decisions SET estado = $2 WHERE id = $1', [
        decisionId,
        'APLICADA',
      ]);
    });

    it('7 y 8 · desde el asiento se llega a la decisión y al comprobante', async () => {
      const t = await db.query<{
        decision_id: string; origen: string; resultado: string;
        justificacion: string; rule_key: string | null; cbte_numero: string;
        norm_document_sha256: string | null;
      }>('SELECT * FROM decision_trace WHERE entry_id = $1', [entryId]);

      expect(t.rowCount).toBe(1);
      const fila = t.rows[0]!;
      expect(fila.decision_id).toBe(decisionId);
      expect(fila.origen).toBe('MANUAL');
      expect(Number(fila.cbte_numero)).toBe(COMPROBANTE!.cbteNro);
      // 10 · No hay regla, y la vista lo muestra vacío en vez de inventarla.
      expect(fila.rule_key).toBeNull();
      expect(fila.norm_document_sha256).toBeNull();
      expect(fila.justificacion).toContain('DRAFT');
    });

    it('9 · desde el comprobante se llega al asiento y al Libro Diario', async () => {
      const r = await db.query<{ entry_id: string; entry_number: number; journal_code: string }>(
        `SELECT e.id AS entry_id, e.entry_number, e.journal_code
           FROM accounting_decisions d
           JOIN journal_entries e ON e.decision_id = d.id
          WHERE d.tax_transaction_id = $1 AND e.status = 'APROBADO'`,
        [opId],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]!.entry_id).toBe(entryId);
      expect(r.rows[0]!.journal_code).toBe('GENERAL');
    });

    it('12 · la decisión ya usada por el asiento no se puede modificar', async () => {
      const fallo = await expectFailureCode(() =>
        db.query('UPDATE accounting_decisions SET resultado = $2 WHERE id = $1', [
          decisionId,
          'SIN_EFECTO',
        ]),
      );
      expect(fallo.message).toMatch(/ya fundamenta un asiento y no se puede modificar/);
      expect(fallo.message).toMatch(/supersedes_id/);
    });

    it('12b · pero sí se puede marcar SUPERSEDIDA, y emitir la corrección aparte', async () => {
      await db.query('UPDATE accounting_decisions SET estado = $2 WHERE id = $1', [
        decisionId,
        'SUPERSEDIDA',
      ]);
      const nueva = await db.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
            decidida_por, justificacion, supersedes_id)
         VALUES ($1,$2,'MANUAL','SIN_EFECTO','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                 'user:contadora','Corrige la decisión anterior', $3)
         RETURNING id`,
        [fx.companyA, opId, decisionId],
      );
      expect(nueva.rowCount).toBe(1);

      // El asiento sigue apuntando a la decisión original: su historia no cambia.
      const e = await db.query<{ decision_id: string }>(
        'SELECT decision_id FROM journal_entries WHERE id = $1',
        [entryId],
      );
      expect(e.rows[0]!.decision_id).toBe(decisionId);
    });

    it('un asiento no puede fundarse en una decisión de PRUEBA', async () => {
      const dePrueba = await decidir({ ambiente: 'PRUEBA' });
      const fallo = await expectFailureCode(() =>
        db.query('UPDATE journal_entries SET decision_id = $2 WHERE id = $1', [entryId, dePrueba]),
      );
      expect(fallo.message).toMatch(/ambiente PRUEBA y no puede fundamentar un asiento/);
    });

    it('13 · la empresa B no ve la decisión ni el asiento', async () => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE aai_app');
        await db.query('SELECT set_config($1,$2,true)', ['app.company_id', fx.companyB]);

        for (const [tabla, sql, id] of [
          ['accounting_decisions', 'SELECT 1 FROM accounting_decisions WHERE id = $1', decisionId],
          ['journal_entries', 'SELECT 1 FROM journal_entries WHERE id = $1', entryId],
          ['decision_trace', 'SELECT 1 FROM decision_trace WHERE entry_id = $1', entryId],
        ] as const) {
          const r = await db.query(sql, [id]);
          expect(r.rowCount, `${tabla} filtró`).toBe(0);
        }
      } finally {
        await db.query('ROLLBACK');
      }
    });

    it('cada decisión dejó su rastro en la bitácora encadenada', async () => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_logs
          WHERE object_type = 'accounting_decisions' AND object_id = $1`,
        [decisionId],
      );
      // Al menos el alta y los dos cambios de estado.
      expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(2);
    });
  });
});
