/**
 * El primer circuito completo, con un comprobante que existe de verdad.
 *
 * COMPROBANTE → NORMALIZADO → SELLO FISCAL → HECHOS → AFECTACIÓN
 *            → MOTOR NORMATIVO → DECISIÓN → PROPUESTA → ASIENTO → LIBRO DIARIO
 *
 * El comprobante sale de `var/corpus-homologacion/`: tiene CAE real emitido por
 * ARCA en homologación. No se fabrica ninguno acá.
 *
 * ## Lo que este test demuestra, y lo que descubre
 *
 * El circuito llega hasta el final, pero **no por la vía automática**. La única
 * regla cargada está en DRAFT, y el motor descarta las reglas no activas en dos
 * capas independientes. Así que la decisión automática termina en
 * `REQUIERE_REVISION` con el motivo `REGLA_NO_ACTIVA` — que es el
 * comportamiento correcto y no se toca para que el test pase.
 *
 * El asiento existe igual, por el camino que ya existía: lo crea y lo aprueba
 * una persona. Lo que este circuito agrega es que ese asiento **conserva de
 * dónde vino**, y eso es lo que hace posible el recorrido de trazabilidad del
 * último bloque.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '@aai/shared';
import {
  decidir,
  explicarDecision,
  hechosDocumentales,
  hechosTributarios,
  type ComprobanteNormalizado,
  type HechoConOrigen,
  type ResultadoDeRegla,
  type Revision,
} from '@aai/accounting-engine';
import { hechosDeAfectacion, proveerVinculacion, type DeclaracionDeAfectacion } from '@aai/tax-engine';
import { connect, hasDatabase, seed, type Client, type Fixture } from './helpers/db.js';

const suite = hasDatabase ? describe : describe.skip;

const RAIZ = join(import.meta.dirname, '..', '..');
const CLAVE_REGLA = 'AR-IVA-CF-VINCULACION-001';

interface ComprobanteDelCorpus {
  cuitEmisor: string;
  ptoVta: number;
  cbteTipo: number;
  cbteNro: number;
  cbteFch: string;
  docTipo: number;
  docNro: string;
  impTotal: number;
  moneda: string;
  cae: string;
  caeFchVto: string;
  concepto: string;
}

/** El comprobante real. Si el corpus no está, la suite se saltea: no se inventa. */
function comprobanteDelCorpus(): ComprobanteDelCorpus | null {
  try {
    const crudo = readFileSync(
      join(RAIZ, 'var', 'corpus-homologacion', 'comprobantes.json'),
      'utf8',
    );
    const lista = JSON.parse(crudo) as ComprobanteDelCorpus[];
    return lista[0] ?? null;
  } catch {
    return null;
  }
}

const DEL_CORPUS = comprobanteDelCorpus();
const conCorpus = hasDatabase && DEL_CORPUS !== null ? describe : describe.skip;

suite('circuito completo — de un comprobante al Libro Diario', () => {
  let db: Client;
  let fx: Fixture;
  let opId: string;
  let normalizado: ComprobanteNormalizado;
  let cuentaCaja: string;
  let cuentaVentas: string;
  let periodId: string;
  let fiscalYearId: string;

  beforeAll(async () => {
    db = await connect();
    fx = await seed(db, 'circuito');
    cuentaCaja = fx.cashA;
    cuentaVentas = fx.salesA;

    if (DEL_CORPUS === null) return;

    // ── FASE 2: normalización ───────────────────────────────────────────────
    // El comprobante del corpus se convierte en una operación fiscal. Es una
    // VENTA: el CUIT emisor es el nuestro.
    const impuesto = await db.query<{ id: string }>("SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1");
    const totalCentavos = BigInt(Math.round(DEL_CORPUS.impTotal * 100));
    const fechaIso = `${DEL_CORPUS.cbteFch.slice(0, 4)}-${DEL_CORPUS.cbteFch.slice(4, 6)}-${DEL_CORPUS.cbteFch.slice(6, 8)}`;
    const anio = fechaIso.slice(0, 4);

    // El fixture trae un ejercicio 2025 y el comprobante es de 2026: el candado
    // `E_DATE_OUT_OF_PERIOD` lo rechaza, con razón. Se abre el ejercicio que le
    // corresponde en vez de moverle la fecha al comprobante — la fecha es un
    // dato del papel y el período es una decisión de la empresa.
    const ejercicio = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (company_id, code, start_date, end_date)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [fx.companyA, `EJ${anio}-circuito`, `${anio}-01-01`, `${anio}-12-31`],
    );
    fiscalYearId = ejercicio.rows[0]!.id;

    const periodo = await db.query<{ id: string }>(
      `INSERT INTO periods (company_id, fiscal_year_id, number, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        fx.companyA,
        fiscalYearId,
        Number(fechaIso.slice(5, 7)),
        `${fechaIso.slice(0, 7)}-01`,
        // Último día del mes, sin tabla de meses: el día 0 del siguiente.
        new Date(Date.UTC(Number(anio), Number(fechaIso.slice(5, 7)), 0)).toISOString().slice(0, 10),
      ],
    );
    periodId = periodo.rows[0]!.id;

    const op = await db.query<{ id: string }>(
      `INSERT INTO tax_transactions
         (company_id, tax_id, period_id, direction, cbte_tipo, punto_venta, cbte_numero,
          cbte_fecha, cuit_contraparte, razon_social, condicion_iva, neto, iva,
          no_gravado, exento, percepciones, total, constatacion, created_by)
       VALUES ($1, $2, $3, 'VENTAS', $4, $5, $6, $7, $8, 'Consumidor final', 'CONSUMIDOR_FINAL',
               $9, 0, 0, 0, 0, $9, 'OK', 'circuito')
       RETURNING id`,
      [
        fx.companyA,
        impuesto.rows[0]!.id,
        periodId,
        DEL_CORPUS.cbteTipo,
        DEL_CORPUS.ptoVta,
        DEL_CORPUS.cbteNro,
        fechaIso,
        // Sin receptor identificado: `docTipo 99` es consumidor final sin
        // identificar. Se conserva el CUIT del emisor, que es el dato que hay.
        DEL_CORPUS.cuitEmisor,
        totalCentavos.toString(),
      ],
    );
    opId = op.rows[0]!.id;

    normalizado = {
      taxTransactionId: opId,
      documentId: null,
      companyId: fx.companyA,
      direccion: 'VENTAS',
      cuitContraparte: DEL_CORPUS.cuitEmisor,
      razonSocial: 'Consumidor final',
      cbteTipo: DEL_CORPUS.cbteTipo,
      letra: 'C',
      puntoVenta: DEL_CORPUS.ptoVta,
      numero: DEL_CORPUS.cbteNro,
      fecha: fechaIso,
      moneda: 'ARS',
      neto: money(totalCentavos, 'ARS'),
      iva: money(0n, 'ARS'),
      total: money(totalCentavos, 'ARS'),
      cae: DEL_CORPUS.cae,
      caeVencimiento: DEL_CORPUS.caeFchVto,
    };
  });

  afterAll(async () => {
    await db.end();
  });

  conCorpus('el comprobante y su normalización', () => {
    it('1 · es un comprobante real, con CAE emitido por ARCA', () => {
      expect(DEL_CORPUS!.cae).toMatch(/^\d{14}$/);
      expect(DEL_CORPUS!.cbteTipo).toBe(11); // Factura C
    });

    it('2 · la normalización conserva todo lo que el comprobante trae', () => {
      expect(normalizado.numero).toBe(DEL_CORPUS!.cbteNro);
      expect(normalizado.puntoVenta).toBe(DEL_CORPUS!.ptoVta);
      expect(normalizado.total.amount).toBe(BigInt(Math.round(DEL_CORPUS!.impTotal * 100)));
      expect(normalizado.cae).toBe(DEL_CORPUS!.cae);
    });

    it('2b · y declara lo que NO trae: una Factura C no discrimina IVA', () => {
      // No es un cero calculado: la clase C no tiene IVA que discriminar, y el
      // ground truth del corpus dice `null` para ese campo.
      expect(normalizado.iva.amount).toBe(0n);
      expect(normalizado.letra).toBe('C');
      // Tampoco hay receptor identificado.
      expect(DEL_CORPUS!.docTipo).toBe(99);
      expect(DEL_CORPUS!.docNro).toBe('0');
    });
  });

  conCorpus('FASE 3 — los hechos, separados por origen', () => {
    it('3 · los hechos documentales salen del comprobante y lo dicen', () => {
      const hechos = hechosDocumentales(normalizado);
      expect(hechos.length).toBeGreaterThan(5);
      expect(hechos.every((h) => h.origen === 'DOCUMENTAL')).toBe(true);
      expect(hechos.every((h) => h.fuente.length > 0)).toBe(true);
      expect(hechos.find((h) => h.campo === 'importes.total')?.valor).toBe(
        normalizado.total.amount.toString(),
      );
    });

    it('4 · los hechos tributarios salen de ARCA y quedan aparte', () => {
      const hechos = hechosTributarios(normalizado, { estado: 'APROBADO', motivo: null });
      expect(hechos.every((h) => h.origen === 'TRIBUTARIO')).toBe(true);
      expect(hechos.find((h) => h.campo === 'comprobante.cae')?.valor).toBe(DEL_CORPUS!.cae);
      expect(hechos.every((h) => /ARCA/.test(h.fuente))).toBe(true);
    });

    it('ningún hecho puede existir sin origen ni fuente', () => {
      const todos = [
        ...hechosDocumentales(normalizado),
        ...hechosTributarios(normalizado, { estado: 'APROBADO', motivo: null }),
      ];
      for (const h of todos) {
        expect(['DOCUMENTAL', 'TRIBUTARIO', 'PROFESIONAL']).toContain(h.origen);
        expect(h.fuente).not.toBe('');
      }
    });
  });

  conCorpus('FASE 4 y 5 — afectación y motor normativo', () => {
    async function declaracionVigente(): Promise<DeclaracionDeAfectacion | null> {
      const r = await db.query(
        `SELECT company_id, tax_transaction_id, afectacion, proporcion_gravada,
                declarada_por, declarada_at, evidencia
           FROM tax_affectations_declaradas WHERE tax_transaction_id = $1`,
        [opId],
      );
      const f = r.rows[0] as
        | {
            company_id: string;
            tax_transaction_id: string;
            afectacion: DeclaracionDeAfectacion['afectacion'];
            proporcion_gravada: number | null;
            declarada_por: string;
            declarada_at: Date;
            evidencia: DeclaracionDeAfectacion['evidencia'];
          }
        | undefined;
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

    it('5 · sin declaración profesional el hecho no existe, y se dice', async () => {
      expect(await declaracionVigente()).toBeNull();
      const provision = proveerVinculacion(null);
      expect(provision.estado).toBe('AUSENTE');
      expect(hechosDeAfectacion(provision)).toEqual({});
    });

    it('5b · con declaración profesional el hecho aparece, marcado como PROFESIONAL', async () => {
      await db.query(
        `INSERT INTO tax_affectations
           (company_id, tax_transaction_id, afectacion, evidencia, origen, declarada_por, declarada_at)
         VALUES ($1, $2, 'GRAVADAS', $3::jsonb, 'DECLARACION_PROFESIONAL', 'user:contadora', now())`,
        [fx.companyA, opId, JSON.stringify([{ tipo: 'CUENTA', id: cuentaVentas }])],
      );

      const d = await declaracionVigente();
      expect(d?.afectacion).toBe('GRAVADAS');

      const hecho: HechoConOrigen = {
        campo: 'vinculadaConOperacionesGravadas',
        valor: true,
        origen: 'PROFESIONAL',
        fuente: `declaración de ${d!.declaradaPor} el ${d!.declaradaAt}`,
      };
      expect(hecho.origen).toBe('PROFESIONAL');
      expect(hecho.fuente).toContain('user:contadora');
    });

    it('13 · la regla en DRAFT no se puede usar: el motor la descarta', async () => {
      const regla = await db.query<{ status: string }>(
        'SELECT status FROM accounting_rules WHERE rule_key = $1 AND version = 1',
        [CLAVE_REGLA],
      );
      expect(regla.rows[0]!.status).toBe('DRAFT');

      // El catálogo que consume el motor se arma con este filtro. Es la primera
      // de las dos capas que la dejan afuera; la segunda es `resolve.ts`, que
      // descarta por estado aunque la regla llegue.
      const activas = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM accounting_rules
          WHERE status = 'ACTIVE' AND rule_key = $1`,
        [CLAVE_REGLA],
      );
      expect(activas.rows[0]!.n).toBe('0');
    });
  });

  conCorpus('FASE 6 — la decisión', () => {
    const reglaEnDraft: ResultadoDeRegla = {
      ruleKey: CLAVE_REGLA,
      version: 1,
      estado: 'DESCARTADA',
      motivo: 'La regla está en estado DRAFT',
      cita: {
        organismo: 'CONGRESO',
        norma: 'Ley 23.349',
        articulo: '12',
        inciso: 'a)',
        documentoSha256: '180b1380c820cbabc572b707b540e9299e074423fcad4f69b920b06167eb3244',
      },
    };

    const lineasDeVenta = (c: ComprobanteNormalizado) => [
      { accountCode: '1.1.01', debit: c.total, credit: money(0n, 'ARS'), descripcion: 'Cobro' },
      { accountCode: '4.1.01', debit: money(0n, 'ARS'), credit: c.total, descripcion: 'Venta' },
    ];

    it('6 · con la regla en DRAFT, la decisión es REQUIERE_REVISION con motivo nombrado', () => {
      const decision = decidir(
        {
          comprobante: normalizado,
          sello: { estado: 'APROBADO', motivo: null },
          hechosProfesionales: [
            {
              campo: 'vinculadaConOperacionesGravadas',
              valor: true,
              origen: 'PROFESIONAL',
              fuente: 'declaración de user:contadora',
            },
          ],
          reglas: [reglaEnDraft],
          revisionesPrevias: [],
        },
        lineasDeVenta,
        'sistema:circuito',
      );

      expect(decision.estado).toBe('REQUIERE_REVISION');
      expect(decision.revisiones.map((r) => r.motivo)).toContain('REGLA_NO_ACTIVA');
      expect(decision.propuesta).toBeNull();

      // Nunca un booleano pelado: la salida trae hechos con origen y la cita.
      expect(decision.hechos.some((h) => h.origen === 'PROFESIONAL')).toBe(true);
      expect(decision.normativa[0]?.articulo).toBe('12');

      const texto = explicarDecision(decision);
      expect(texto).toContain('DECISIÓN: REQUIERE_REVISION');
      expect(texto).toContain('REGLA_NO_ACTIVA');
      expect(texto).toContain('Ley 23.349');
    });

    it('12 · sin el hecho profesional, la revisión lo nombra como faltante', () => {
      const decision = decidir(
        {
          comprobante: normalizado,
          sello: { estado: 'APROBADO', motivo: null },
          hechosProfesionales: [],
          reglas: [],
          revisionesPrevias: [
            { motivo: 'SIN_HECHO_REQUERIDO', detalle: 'Falta la afectación declarada' } as Revision,
          ],
        },
        lineasDeVenta,
        'sistema:circuito',
      );
      expect(decision.estado).toBe('REQUIERE_REVISION');
      expect(decision.revisiones.map((r) => r.motivo)).toEqual(
        expect.arrayContaining(['SIN_HECHO_REQUERIDO', 'SIN_REGLA_APLICABLE']),
      );
      expect(decision.propuesta).toBeNull();
    });

    it('7 · con una regla APLICADA sí hay propuesta, y conserva su origen', () => {
      // Se construye la situación hipotética —ninguna regla está activa hoy—
      // para comprobar que el otro lado del corte también funciona.
      const decision = decidir(
        {
          comprobante: normalizado,
          sello: { estado: 'APROBADO', motivo: null },
          hechosProfesionales: [],
          reglas: [{ ...reglaEnDraft, estado: 'APLICADA', motivo: 'Condiciones satisfechas' }],
          revisionesPrevias: [],
        },
        lineasDeVenta,
        'sistema:circuito',
      );

      expect(decision.estado).toBe('PROPUESTA_DE_ASIENTO');
      expect(decision.propuesta).not.toBeNull();
      expect(decision.propuesta!.origen).toMatchObject({
        taxTransactionId: opId,
        reglaAplicada: CLAVE_REGLA,
        reglaVersion: 1,
        documentoSha256: reglaEnDraft.cita!.documentoSha256,
        propuestaPor: 'sistema:circuito',
      });
    });

    it('8 · la propuesta cuadra: Debe = Haber antes de tocar la base', () => {
      const decision = decidir(
        {
          comprobante: normalizado,
          sello: { estado: 'APROBADO', motivo: null },
          hechosProfesionales: [],
          reglas: [{ ...reglaEnDraft, estado: 'APLICADA', motivo: 'ok' }],
          revisionesPrevias: [],
        },
        lineasDeVenta,
        'sistema:circuito',
      );
      const lineas = decision.propuesta!.lineas;
      const debe = lineas.reduce((a, l) => a + l.debit.amount, 0n);
      const haber = lineas.reduce((a, l) => a + l.credit.amount, 0n);
      expect(debe).toBe(haber);
      expect(debe).toBe(normalizado.total.amount);
    });

    it('un sello fiscal no aprobado corta el circuito', () => {
      const decision = decidir(
        {
          comprobante: normalizado,
          sello: { estado: 'NO_VERIFICABLE', motivo: 'SIN_CREDENCIAL' },
          hechosProfesionales: [],
          reglas: [{ ...reglaEnDraft, estado: 'APLICADA', motivo: 'ok' }],
          revisionesPrevias: [],
        },
        lineasDeVenta,
        'sistema:circuito',
      );
      expect(decision.estado).toBe('REQUIERE_REVISION');
      expect(decision.revisiones.map((r) => r.motivo)).toContain('SELLO_FISCAL_NO_APROBADO');
    });
  });

  conCorpus('FASES 8 y 9 — asiento, Libro Diario y trazabilidad', () => {
    let entryId: string;

    it('9 y 10 · el asiento aprobado entra al Diario, con COMMIT real', async () => {
      const total = normalizado.total.amount.toString();

      await db.query('BEGIN');
      const entry = await db.query<{ id: string }>(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, total_debit, total_credit,
            source_type, source_id, created_by, approved_by, approved_at)
         VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), $4,
                 $5, 'NORMAL', 'APROBADO', $6, $6, 'INVOICE', $7, 'user:cargadora',
                 'user:contadora', now())
         RETURNING id`,
        [
          fx.companyA,
          periodId,
          fiscalYearId,
          normalizado.fecha,
          `Venta ${normalizado.letra}${normalizado.puntoVenta}-${normalizado.numero} — CAE ${normalizado.cae}`,
          total,
          opId,
        ],
      );
      entryId = entry.rows[0]!.id;

      for (const [n, cuenta, debe, haber] of [
        [1, cuentaCaja, total, '0'],
        [2, cuentaVentas, '0', total],
      ] as const) {
        await db.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, currency,
              description, tax_transaction_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'ARS', $7, $8)`,
          [fx.companyA, entryId, n, cuenta, debe, haber, 'Circuito', opId],
        );
      }

      // El COMMIT es la prueba: el CONSTRAINT TRIGGER diferido de Debe = Haber
      // dispara acá y en ningún otro momento.
      await db.query('COMMIT');

      const guardado = await db.query<{ total_debit: string; total_credit: string; status: string }>(
        'SELECT total_debit::text, total_credit::text, status FROM journal_entries WHERE id = $1',
        [entryId],
      );
      expect(guardado.rows[0]!.total_debit).toBe(guardado.rows[0]!.total_credit);
      expect(guardado.rows[0]!.status).toBe('APROBADO');
    });

    it('el trigger diferido sigue vivo: un asiento descuadrado NO puede commitear', async () => {
      await db.query('BEGIN');
      try {
        const malo = await db.query<{ id: string }>(
          `INSERT INTO journal_entries
             (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
              description, kind, status, total_debit, total_credit, source_type,
              manual_justification, created_by)
           VALUES ($1, 'GENERAL', $2, $3, next_entry_number($1, 'GENERAL', $3), $4,
                   'Descuadrado a propósito', 'NORMAL', 'PROPUESTO', 100, 100, 'MANUAL',
                   'Prueba del trigger diferido: la cabecera dice 100/100 y las lineas no', 'tester')
           RETURNING id`,
          [fx.companyA, periodId, fiscalYearId, normalizado.fecha],
        );
        // Cabecera dice 100/100; las líneas suman 100/0. Solo el COMMIT lo ve.
        await db.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, currency, description)
           VALUES ($1, $2, 1, $3, 100, 0, 'ARS', 'sola')`,
          [fx.companyA, malo.rows[0]!.id, cuentaCaja],
        );
        await expect(db.query('COMMIT')).rejects.toThrow();
      } finally {
        await db.query('ROLLBACK').catch(() => undefined);
      }
    });

    it('11 · el recorrido de trazabilidad llega hasta la fuente normativa', async () => {
      // Diario → asiento → operación fiscal → afectación → evidencia → declarante
      const traza = await db.query<{
        entry_id: string;
        entry_number: number;
        tax_transaction_id: string;
        cbte_numero: number;
        afectacion: string;
        declarada_por: string;
        evidencia: unknown;
      }>(
        `SELECT e.id AS entry_id, e.entry_number,
                t.id AS tax_transaction_id, t.cbte_numero,
                a.afectacion, a.declarada_por, a.evidencia
           FROM journal_entries e
           JOIN tax_transactions t ON t.id = e.source_id
           JOIN tax_affectations a ON a.tax_transaction_id = t.id
          WHERE e.id = $1`,
        [entryId],
      );

      expect(traza.rowCount).toBe(1);
      const t = traza.rows[0]!;
      expect(t.tax_transaction_id).toBe(opId);
      //  es bigint y pg lo devuelve como texto: se compara el valor.
      expect(Number(t.cbte_numero)).toBe(DEL_CORPUS!.cbteNro);
      expect(t.afectacion).toBe('GRAVADAS');
      expect(t.declarada_por).toBe('user:contadora');

      // Y desde la norma: el documento archivado con su hash.
      const norma = await db.query<{ sha256: string; organismo: string }>(
        `SELECT d.sha256, n.organismo
           FROM accounting_rules r
           JOIN norm_versions v ON v.id = r.norm_version_id
           JOIN norms n ON n.id = v.norm_id
           JOIN norm_documents d ON d.norm_version_id = v.id
          WHERE r.rule_key = $1`,
        [CLAVE_REGLA],
      );
      expect(norma.rows[0]!.sha256).toBe(
        '180b1380c820cbabc572b707b540e9299e074423fcad4f69b920b06167eb3244',
      );
    });

    it('GAP · el asiento no referencia la regla: `ai_prediction_id` es para la IA', async () => {
      // El eslabón asiento → regla NO existe en el esquema. `journal_entries`
      // tiene `ai_prediction_id`, que apunta a una propuesta del modelo, no a una
      // regla normativa. Hoy el puente es indirecto: asiento → tax_transaction →
      // afectación, y por otro lado regla → norma → documento.
      //
      // Se deja el gap escrito como test para que se vea, en vez de inventar la
      // columna que haría pasar el recorrido de un tirón.
      const columnas = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'journal_entries' AND column_name LIKE '%rule%'`,
      );
      expect(columnas.rowCount).toBe(0);
    });

    it('14 · la empresa B no ve nada de esto', async () => {
      await db.query('BEGIN');
      try {
        await db.query('SET LOCAL ROLE aai_app');
        await db.query('SELECT set_config($1, $2, true)', ['app.company_id', fx.companyB]);

        for (const consulta of [
          ['journal_entries', 'SELECT 1 FROM journal_entries WHERE id = $1'],
          ['tax_transactions', 'SELECT 1 FROM tax_transactions WHERE id = $1'],
        ] as const) {
          const r = await db.query(consulta[1], [consulta[0] === 'journal_entries' ? entryId : opId]);
          expect(r.rowCount, `${consulta[0]} filtró`).toBe(0);
        }

        const afect = await db.query('SELECT 1 FROM tax_affectations_declaradas WHERE tax_transaction_id = $1', [opId]);
        expect(afect.rowCount).toBe(0);
      } finally {
        await db.query('ROLLBACK');
      }
    });
  });
});
