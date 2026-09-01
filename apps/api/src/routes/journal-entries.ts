/**
 * Libro Diario: alta, aprobación, contraasiento y balance de sumas y saldos.
 *
 * El reparto de responsabilidades con `@aai/accounting-engine` es el que define
 * este archivo:
 *
 * - El **motor** decide si el asiento puede existir. Es puro: recibe un contexto
 *   y devuelve errores tipados.
 * - El **repositorio** —esto— arma ese contexto, y dentro de una única
 *   transacción toma el número correlativo e inserta.
 *
 * El número no lo asigna el motor a propósito. Un libro rubricado exige una
 * secuencia sin huecos, y eso solo lo garantiza quien controla la transacción:
 * `next_entry_number` toma la fila del contador para actualización, así que dos
 * posteos concurrentes se serializan y un rollback no consume un número.
 *
 * Las validaciones corren **dos veces**: acá y como constraints en PostgreSQL.
 * Es deliberado. El invariante Debe = Haber no puede depender de que esta capa
 * esté libre de bugs.
 */

import {
  balanceDeSumasYSaldos,
  construirContraasiento,
  diferenciaEnMenor,
  prepararPosteo,
  type AccountSnapshot,
  type FiscalYearSnapshot,
  type JournalEntryDraft,
  type JournalEntryLineDraft,
  type DecisionSnapshot,
  type LedgerContext,
  type PeriodSnapshot,
} from '@aai/accounting-engine';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  isCurrency,
  moneyFromDecimalString,
  parseCalendarDate,
  toDecimalString,
  zero,
  type CalendarDate,
  type Currency,
  type Money,
  type RoundingMode,
} from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

const MODOS_REDONDEO = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'] as const;

const lineaSchema = z.object({
  accountCode: z.string().min(1).max(40),
  /** Importes como texto decimal. Nunca `number`: un JSON con float ya perdió. */
  debit: z.string().regex(/^\d+([.,]\d{1,2})?$/).default('0'),
  credit: z.string().regex(/^\d+([.,]\d{1,2})?$/).default('0'),
  currency: z.string().length(3).default('ARS'),
  fx: z
    .object({
      rate: z.string().regex(/^\d+([.,]\d+)?$/),
      source: z.string().min(1).max(120),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  costCenterCode: z.string().max(40).optional(),
  partyId: z.string().uuid().optional(),
  taxTransactionId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
});

const asientoSchema = z.object({
  journalCode: z.enum([
    'GENERAL', 'COMPRAS', 'VENTAS', 'BANCOS', 'CAJA', 'SUELDOS', 'AJUSTES', 'CIERRE', 'APERTURA',
  ]),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1).max(500),
  kind: z.enum(['NORMAL', 'AJUSTE', 'APERTURA', 'CIERRE', 'REVERSION']).default('NORMAL'),
  currency: z.string().length(3).default('ARS'),
  lines: z.array(lineaSchema).min(2).max(500),
  source: z.object({
    type: z.enum(['INVOICE', 'RECEIPT', 'BANK', 'MANUAL', 'CLOSING']),
    id: z.string().uuid().nullable().default(null),
  }),
  ruleApplications: z
    .array(
      z.object({
        ruleKey: z.string().min(1),
        ruleVersion: z.number().int().positive(),
        normVersionId: z.string().uuid(),
      }),
    )
    .default([]),
  manualJustification: z.string().min(3).max(1000).optional(),
  /**
   * Modo de redondeo de la conversión de moneda extranjera.
   *
   * Sin valor por defecto en la API: quien postea en moneda extranjera tiene que
   * elegirlo y poder citar de dónde sale (ADR-005). Se exige solo si hace falta.
   */
  fxRoundingMode: z.enum(MODOS_REDONDEO).optional(),
  aiPredictionId: z.string().uuid().optional(),
  /**
   * La decisión que funda este asiento.
   *
   * Opcional: los asientos manuales de siempre siguen entrando sin ella, con su
   * `manualJustification`. La base comprueba que sea de la misma empresa y que
   * NO sea de ambiente PRUEBA — `assert_entry_decision_coherente`, migración 0034.
   */
  decisionId: z.string().uuid().optional(),
  /** `PROPUESTO` lo somete a aprobación; `BORRADOR` lo deja editable. */
  status: z.enum(['BORRADOR', 'PROPUESTO']).default('PROPUESTO'),
});

export async function journalEntryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/journal-entries', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:create');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const body = asientoSchema.parse(request.body);

    const necesitaFx = body.lines.some((linea) => linea.currency !== body.currency);
    if (necesitaFx && body.fxRoundingMode === undefined) {
      throw badRequest(
        'Hay líneas en moneda extranjera: falta declarar el modo de redondeo de la conversión. ' +
          'No tiene valor por defecto porque el criterio depende de la norma aplicable.',
      );
    }

    const draft = aDraft(body, tenant.companyId, actorId);

    const resultado = await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const context = await armarContexto(tx, tenant.companyId, draft, {
        fxRoundingMode: body.fxRoundingMode ?? 'HALF_UP',
        actorCanPostToBlocked: tenant.permissions.has('period:close'),
      });

      const preparado = prepararPosteo(draft, context);
      if (!preparado.ok) return { rechazado: preparado.errors } as const;

      const asiento = preparado.value;
      const numero = await tx.query<{ next_entry_number: number }>(
        'SELECT next_entry_number($1, $2, $3)',
        [tenant.companyId, draft.journalCode, asiento.fiscalYearId],
      );
      const entryNumber = numero.rows[0]!.next_entry_number;

      const cabecera = await tx.query<{ id: string }>(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, currency, total_debit, total_credit,
            source_type, source_id, ai_prediction_id, decision_id, manual_justification, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id`,
        [
          tenant.companyId,
          draft.journalCode,
          asiento.periodId,
          asiento.fiscalYearId,
          entryNumber,
          draft.entryDate,
          draft.description,
          draft.kind,
          body.status,
          draft.currency,
          toDecimalString(asiento.totalDebit),
          toDecimalString(asiento.totalCredit),
          draft.source.type,
          draft.source.id,
          body.aiPredictionId ?? null,
          body.decisionId ?? null,
          draft.manualJustification ?? null,
          actorId,
        ],
      );
      const entryId = cabecera.rows[0]!.id;

      for (const linea of asiento.lines) {
        // Dos importes, dos columnas (migración 0020).
        //
        // `debit`/`credit` llevan el CONVERTIDO a moneda de contabilidad, que es
        // lo que el libro suma y lo que la cabecera declara como total. Guardar
        // acá el original hacía que `assert_entry_consistent` abortara el COMMIT
        // en cuanto una línea venía en otra moneda.
        //
        // `original_*` lleva la operación tal como ocurrió. Sin eso, la
        // conversión no se puede rehacer.
        const enOtraMoneda = linea.draft.currency !== draft.currency;
        await tx.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, currency,
              original_currency, original_debit, original_credit,
              fx_rate, fx_source, fx_date, cost_center_id, party_id, description, tax_transaction_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   (SELECT id FROM cost_centers WHERE company_id = $1 AND code = $14),
                   $15, $16, $17)`,
          [
            tenant.companyId,
            entryId,
            linea.lineNo,
            linea.account.id,
            toDecimalString(linea.debit),
            toDecimalString(linea.credit),
            draft.currency,
            enOtraMoneda ? linea.draft.currency : null,
            enOtraMoneda ? toDecimalString(linea.draft.debit) : null,
            enOtraMoneda ? toDecimalString(linea.draft.credit) : null,
            linea.draft.fx === undefined
              ? null
              : razonATexto(linea.draft.fx.rate.numerator, linea.draft.fx.rate.denominator),
            linea.draft.fx?.source ?? null,
            linea.draft.fx?.date ?? null,
            linea.draft.costCenterCode ?? null,
            linea.draft.partyId ?? null,
            linea.draft.description ?? null,
            linea.draft.taxTransactionId ?? null,
          ],
        );
      }

      await recordAudit(tx, tenant.companyId, {
        actorType: body.aiPredictionId === undefined ? 'USER' : 'AI',
        actorId,
        action: 'CREAR_ASIENTO',
        objectType: 'journal_entry',
        objectId: entryId,
        newValue: { entryNumber, status: body.status, total: toDecimalString(asiento.totalDebit) },
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { entryId, entryNumber, asiento } as const;
    });

    if ('rechazado' in resultado) {
      // 422: la petición está bien formada y el asiento no puede existir. El
      // contador necesita la lista completa, no el primer problema.
      return reply.code(422).send({
        error: 'ASIENTO_INVALIDO',
        message: 'El asiento no cumple las validaciones contables',
        errores: resultado.rechazado,
      });
    }

    reply.code(201);
    return {
      id: resultado.entryId,
      entryNumber: resultado.entryNumber,
      totalDebit: toDecimalString(resultado.asiento.totalDebit),
      totalCredit: toDecimalString(resultado.asiento.totalCredit),
      status: body.status,
    };
  });

  app.post('/journal-entries/:entryId/approve', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:approve');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const params = z.object({ entryId: z.string().uuid() }).parse(request.params);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const previo = await tx.query<{ status: string; created_by: string }>(
        'SELECT status, created_by FROM journal_entries WHERE id = $1',
        [params.entryId],
      );
      if (previo.rowCount === 0) throw notFound('Asiento no encontrado');
      if (previo.rows[0]!.status === 'APROBADO') throw conflict('El asiento ya está aprobado');
      if (previo.rows[0]!.status === 'ANULADO') throw conflict('El asiento está anulado');

      const actualizado = await tx.query(
        `UPDATE journal_entries
            SET status = 'APROBADO', approved_by = $2, approved_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING id, entry_number AS "entryNumber", status`,
        [params.entryId, actorId],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'APROBAR_ASIENTO',
        objectType: 'journal_entry',
        objectId: params.entryId,
        oldValue: previo.rows[0],
        newValue: actualizado.rows[0],
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return actualizado.rows[0];
    });
  });

  app.post('/journal-entries/:entryId/reverse', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:reverse');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const params = z.object({ entryId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        motivo: z.string().min(3).max(500),
        fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(request.body);

    const resultado = await withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const original = await leerAsiento(tx, tenant.companyId, params.entryId);
      if (original === null) throw notFound('Asiento no encontrado');

      const contra = construirContraasiento(original.paraAnular, {
        fecha: parseCalendarDate(body.fecha ?? original.paraAnular.entryDate),
        motivo: body.motivo,
        actor: { userId: auth.user.userId },
      });
      if (!contra.ok) throw conflict(contra.motivo);

      const context = await armarContexto(tx, tenant.companyId, contra.draft, {
        fxRoundingMode: 'HALF_UP',
        actorCanPostToBlocked: tenant.permissions.has('period:close'),
      });
      const preparado = prepararPosteo(contra.draft, context);
      if (!preparado.ok) return { rechazado: preparado.errors } as const;

      const asiento = preparado.value;
      const numero = await tx.query<{ next_entry_number: number }>(
        'SELECT next_entry_number($1, $2, $3)',
        [tenant.companyId, contra.draft.journalCode, asiento.fiscalYearId],
      );

      const cabecera = await tx.query<{ id: string }>(
        `INSERT INTO journal_entries
           (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
            description, kind, status, currency, total_debit, total_credit,
            source_type, source_id, reverses_entry_id, manual_justification,
            created_by, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'REVERSION', 'APROBADO', $8, $9, $10,
                 $11, NULL, $12, $13, $14, $14, now())
         RETURNING id`,
        [
          tenant.companyId,
          contra.draft.journalCode,
          asiento.periodId,
          asiento.fiscalYearId,
          numero.rows[0]!.next_entry_number,
          contra.draft.entryDate,
          contra.draft.description,
          contra.draft.currency,
          toDecimalString(asiento.totalDebit),
          toDecimalString(asiento.totalCredit),
          contra.draft.source.type,
          params.entryId,
          contra.draft.manualJustification ?? null,
          actorId,
        ],
      );
      const entryId = cabecera.rows[0]!.id;

      for (const linea of asiento.lines) {
        await tx.query(
          `INSERT INTO journal_entry_lines
             (company_id, entry_id, line_no, account_id, debit, credit, currency, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            tenant.companyId,
            entryId,
            linea.lineNo,
            linea.account.id,
            // El contraasiento se arma desde importes ya registrados, así que el
            // convertido y el original son el mismo número. Se usa igual
            // `linea.debit` —el resuelto— para que no haya dos caminos distintos
            // por los que un importe llega a `journal_entry_lines`.
            toDecimalString(linea.debit),
            toDecimalString(linea.credit),
            contra.draft.currency,
            linea.draft.description ?? null,
          ],
        );
      }

      // El original queda ANULADO **conservando su número**. El hueco en la
      // secuencia sería peor que el asiento anulado.
      await tx.query(
        `UPDATE journal_entries SET status = 'ANULADO', updated_at = now() WHERE id = $1`,
        [params.entryId],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'ANULAR_ASIENTO',
        objectType: 'journal_entry',
        objectId: params.entryId,
        newValue: { contraasientoId: entryId },
        motivo: body.motivo,
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      return { entryId, entryNumber: numero.rows[0]!.next_entry_number } as const;
    });

    if ('rechazado' in resultado) {
      return reply.code(422).send({
        error: 'CONTRAASIENTO_INVALIDO',
        message: 'El contraasiento no cumple las validaciones contables',
        errores: resultado.rechazado,
      });
    }

    reply.code(201);
    return { contraasientoId: resultado.entryId, entryNumber: resultado.entryNumber };
  });

  app.get('/journal-entries', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        status: z.enum(['BORRADOR', 'PROPUESTO', 'APROBADO', 'ANULADO']).optional(),
        limite: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query<{ id: string; fecha: string }>(
          `SELECT id, journal_code AS "libro", entry_number AS "numero",
                  entry_date::text AS "fecha",
                  description AS "descripcion", kind, status, currency,
                  total_debit AS "debe", total_credit AS "haber",
                  source_type AS "origenTipo", source_id AS "origenId",
                  ai_prediction_id AS "prediccionId", reverses_entry_id AS "anulaA"
             FROM journal_entries
            WHERE company_id = $1
              AND ($2::date IS NULL OR entry_date >= $2::date)
              AND ($3::date IS NULL OR entry_date <= $3::date)
              AND ($4::text IS NULL OR status = $4)
              -- Keyset ASCENDENTE: el Diario se lee del más viejo al más nuevo, y
              -- el orden de la página tiene que ser el orden del libro. El
              -- desempate por id lo vuelve total; journal_code y entry_number
              -- no servían porque el par puede repetirse entre ejercicios.
              AND ($5::date IS NULL
                   OR (entry_date, id) > ($5::date, $6::uuid))
            ORDER BY entry_date, id
            LIMIT $7`,
          [
            tenant.companyId,
            query.desde ?? null,
            query.hasta ?? null,
            query.status ?? null,
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(result.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));
        return { asientos: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
  });

  /**
   * Balance de sumas y saldos.
   *
   * Si las tres igualdades no se cumplen, la respuesta lo dice y marca modo
   * degradado. No es un reporte con una advertencia al pie: un balance que no
   * cuadra significa que el libro está roto, y emitir estados contables sobre él
   * sería firmar algo que no se sostiene (§8).
   */
  app.get('/reports/trial-balance', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const moneda = await monedaDeContabilidad(tx, tenant.companyId);

        const movimientos = await tx.query<{
          account_id: string;
          code: string;
          name: string;
          nature: 'DEUDORA' | 'ACREEDORA';
          debito: string;
          credito: string;
        }>(
          // ANULADO entra junto con APROBADO, igual que en el Mayor y en
          // `ledger_movements`. Un asiento anulado pasó por aprobado y sus
          // movimientos existieron; lo que los compensa es el contraasiento, no
          // su desaparición (CCyC art. 324 inc. c).
          //
          // Filtrando solo por APROBADO el balance dejaba afuera el original y
          // conservaba su contraasiento, así que restaba una vez lo que nunca
          // había sumado. Y seguía **cuadrando**: el contraasiento está
          // balanceado, con lo cual las tres igualdades se cumplían sobre un
          // saldo equivocado. Ese es el modo de fallo que hay que evitar — un
          // libro roto que se ve sano.
          //
          // El corte superior es `<= hasta`, no `BETWEEN`, y las sumas se
          // filtran al rango: así entran también las cuentas que solo tienen
          // saldo anterior. Con `BETWEEN` esas cuentas llegaban al balance por
          // la lista de saldos iniciales, que no trae código ni nombre, y el
          // motor las armaba con `accountCode: ''`. El balance de un mes sin
          // movimientos salía entero sin códigos.
          `SELECT l.account_id, a.code, a.name, a.nature,
                  coalesce(sum(l.debit)  FILTER (WHERE e.entry_date >= $2::date), 0)::text AS debito,
                  coalesce(sum(l.credit) FILTER (WHERE e.entry_date >= $2::date), 0)::text AS credito
             FROM journal_entry_lines l
             JOIN journal_entries e ON e.id = l.entry_id
             JOIN accounts a ON a.id = l.account_id
            WHERE e.company_id = $1 AND e.status IN ('APROBADO', 'ANULADO')
              AND e.entry_date <= $3::date
            GROUP BY l.account_id, a.code, a.name, a.nature`,
          [tenant.companyId, query.desde, query.hasta],
        );

        const iniciales = await tx.query<{ account_id: string; saldo: string }>(
          // Mismo universo que arriba y que `saldosAnterioresA` en books.ts. Si
          // el saldo inicial y los movimientos salieran de conjuntos distintos,
          // el arrastre de un período al siguiente perdería exactamente los
          // asientos anulados.
          `SELECT l.account_id, (sum(l.debit) - sum(l.credit))::text AS saldo
             FROM journal_entry_lines l
             JOIN journal_entries e ON e.id = l.entry_id
            WHERE e.company_id = $1 AND e.status IN ('APROBADO', 'ANULADO')
              AND e.entry_date < $2::date
            GROUP BY l.account_id`,
          [tenant.companyId, query.desde],
        );

        const balance = balanceDeSumasYSaldos(
          movimientos.rows.map((fila) => ({
            accountId: fila.account_id,
            accountCode: fila.code,
            accountName: fila.name,
            nature: fila.nature,
            debit: moneyFromDecimalString(fila.debito, moneda),
            credit: moneyFromDecimalString(fila.credito, moneda),
          })),
          iniciales.rows.map((fila) => ({
            accountId: fila.account_id,
            monto: moneyFromDecimalString(fila.saldo, moneda),
          })),
          moneda,
        );

        return {
          desde: query.desde,
          hasta: query.hasta,
          moneda,
          lineas: balance.lineas.map((linea) => ({
            codigo: linea.accountCode,
            nombre: linea.accountName,
            naturaleza: linea.nature,
            saldoInicial: toDecimalString(linea.saldoInicial),
            debitos: toDecimalString(linea.debitos),
            creditos: toDecimalString(linea.creditos),
            saldoFinal: toDecimalString(linea.saldoFinal),
          })),
          totales: {
            debitos: toDecimalString(balance.totalDebitos),
            creditos: toDecimalString(balance.totalCreditos),
            saldosDeudores: toDecimalString(balance.totalSaldosDeudores),
            saldosAcreedores: toDecimalString(balance.totalSaldosAcreedores),
          },
          verificaciones: balance.verificaciones,
          cuadra: balance.cuadra,
          diferenciaEnMenor: diferenciaEnMenor(balance),
          ...(balance.cuadra
            ? {}
            : {
                modoDegradado: true,
                aviso:
                  'El balance no cuadra. El sistema no emite estados contables en este estado: ' +
                  'un balance descuadrado es un libro roto, no un reporte con una salvedad.',
              }),
        };
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Armado del contexto
// ---------------------------------------------------------------------------

async function armarContexto(
  tx: Tx,
  companyId: string,
  draft: JournalEntryDraft,
  opciones: { fxRoundingMode: RoundingMode; actorCanPostToBlocked: boolean },
): Promise<LedgerContext> {
  const cuentas = await tx.query<{
    id: string;
    code: string;
    name: string;
    type: AccountSnapshot['type'];
    nature: AccountSnapshot['nature'];
    is_postable: boolean;
    status: 'ACTIVE' | 'ARCHIVED';
    currency: string;
    tax_role: string | null;
    requires_cost_center: boolean;
    requires_third_party: boolean;
  }>(
    `SELECT id, code, name, type, nature, is_postable, status, currency,
            tax_role, requires_cost_center, requires_third_party
       FROM accounts WHERE company_id = $1`,
    [companyId],
  );

  const periodos = await tx.query<{
    id: string;
    fiscal_year_id: string;
    number: number;
    start_date: Date;
    end_date: Date;
    status: PeriodSnapshot['status'];
  }>(
    'SELECT id, fiscal_year_id, number, start_date, end_date, status FROM periods WHERE company_id = $1',
    [companyId],
  );

  const ejercicios = await tx.query<{
    id: string;
    code: string;
    start_date: Date;
    end_date: Date;
    status: FiscalYearSnapshot['status'];
  }>('SELECT id, code, start_date, end_date, status FROM fiscal_years WHERE company_id = $1', [
    companyId,
  ]);

  const centros = await tx.query<{ code: string }>(
    `SELECT code FROM cost_centers WHERE company_id = $1 AND status = 'ACTIVE'`,
    [companyId],
  );

  // Solo se consulta el comprobante de este asiento: traer todos sería inútil, y
  // el índice único de la base es igualmente la garantía final.
  const duplicado =
    draft.source.id === null
      ? { rowCount: 0 }
      : await tx.query(
          `SELECT 1 FROM journal_entries
            WHERE company_id = $1 AND source_type = $2 AND source_id = $3
              AND status IN ('PROPUESTO', 'APROBADO')`,
          [companyId, draft.source.type, draft.source.id],
        );

  return {
    companyId,
    accountingCurrency: await monedaDeContabilidad(tx, companyId),
    accounts: cuentas.rows.map((fila) => ({
      id: fila.id,
      code: fila.code,
      name: fila.name,
      type: fila.type,
      nature: fila.nature,
      isPostable: fila.is_postable,
      status: fila.status,
      currency: isCurrency(fila.currency) ? fila.currency : 'ARS',
      taxRole: fila.tax_role,
      requiresCostCenter: fila.requires_cost_center,
      requiresThirdParty: fila.requires_third_party,
    })),
    periods: periodos.rows.map((fila) => ({
      id: fila.id,
      fiscalYearId: fila.fiscal_year_id,
      number: fila.number,
      startDate: aFecha(fila.start_date),
      endDate: aFecha(fila.end_date),
      status: fila.status,
    })),
    fiscalYears: ejercicios.rows.map((fila) => ({
      id: fila.id,
      code: fila.code,
      startDate: aFecha(fila.start_date),
      endDate: aFecha(fila.end_date),
      status: fila.status,
    })),
    costCenterCodes: centros.rows.map((fila) => fila.code),
    postedSources:
      (duplicado.rowCount ?? 0) > 0 && draft.source.id !== null
        ? [`${draft.source.type}:${draft.source.id}`]
        : [],
    fxRoundingMode: opciones.fxRoundingMode,
    actorCanPostToBlocked: opciones.actorCanPostToBlocked,
    decision: await resolverDecision(tx, draft),
  };
}

/**
 * La decisión que funda el asiento, resuelta y verificada — o `null`.
 *
 * Todas las condiciones van en el `WHERE`, no en un `if` posterior: si una fila
 * no las cumple, no aparece, y el motor recibe `null`. Eso es la inversión que
 * usa el resto del sistema — se entrega la prueba o nada.
 *
 * ## Por qué se comprueba acá si la base ya lo impide
 *
 * Los triggers de la 0034 y la 0036 son la garantía y no se tocan: rechazan una
 * decisión de otra empresa, de ambiente PRUEBA, o de otro comprobante. Pero lo
 * hacen con una excepción de PostgreSQL en el `INSERT`, que sale al cliente como
 * 500. Resolverla acá convierte eso en un error de validación tipado
 * —`E_DECISION_NOT_FOUND`— antes de intentar persistir.
 *
 * La duplicación es deliberada y en un solo sentido: la base sigue mandando, y
 * esto solo mejora el mensaje. Si divergen, la base gana y el asiento no entra.
 */
async function resolverDecision(
  tx: Tx,
  draft: JournalEntryDraft,
): Promise<DecisionSnapshot | null> {
  if (draft.decisionId === undefined) return null;

  const r = await tx.query<{
    id: string;
    origen: 'DETERMINISTICA' | 'PROPUESTA_IA' | 'MANUAL';
    resultado: string;
    reglas: string;
  }>(
    `SELECT d.id, d.origen, d.resultado,
            (SELECT count(*) FROM rule_applications ra WHERE ra.decision_id = d.id)::text AS reglas
       FROM accounting_decisions d
      WHERE d.id = $1
        AND d.ambiente = 'PRODUCTIVO'
        AND d.estado <> 'SUPERSEDIDA'
        -- Coherencia con el origen del asiento: una decisión sobre otro
        -- comprobante no funda este. Cuando la decisión no tiene comprobante
        -- —un ajuste de cierre— no hay nada que comparar.
        AND (d.tax_transaction_id IS NULL OR d.tax_transaction_id = $2::uuid)`,
    [draft.decisionId, draft.source.id],
  );
  // El RLS ya limitó la consulta a la empresa en contexto: una decisión ajena
  // no llega hasta acá.
  const fila = r.rows[0];
  if (fila === undefined) return null;

  return {
    id: fila.id,
    origen: fila.origen,
    resultado: fila.resultado,
    reglasAplicadas: Number(fila.reglas),
  };
}

/**
 * Moneda en la que la empresa lleva su contabilidad.
 *
 * Hoy es siempre ARS: `companies` no tiene columna de moneda funcional, y no la
 * inventamos acá. Cuando exista —una sucursal de un grupo extranjero puede
 * llevar la contabilidad en otra moneda— esta función es el único lugar a tocar,
 * porque todo el motor la consulta a través de `LedgerContext`.
 */
async function monedaDeContabilidad(tx: Tx, companyId: string): Promise<Currency> {
  void tx;
  void companyId;
  return 'ARS';
}

async function leerAsiento(
  tx: Tx,
  companyId: string,
  entryId: string,
): Promise<{ paraAnular: Parameters<typeof construirContraasiento>[0] } | null> {
  const cabecera = await tx.query<{
    id: string;
    journal_code: JournalEntryDraft['journalCode'];
    entry_date: Date;
    description: string;
    currency: string;
    status: 'BORRADOR' | 'PROPUESTO' | 'APROBADO' | 'ANULADO';
    source_type: JournalEntryDraft['source']['type'];
    source_id: string | null;
  }>(
    `SELECT id, journal_code, entry_date, description, currency, status, source_type, source_id
       FROM journal_entries WHERE id = $1 AND company_id = $2`,
    [entryId, companyId],
  );
  if (cabecera.rowCount === 0) return null;
  const fila = cabecera.rows[0]!;
  const moneda: Currency = isCurrency(fila.currency) ? fila.currency : 'ARS';

  const lineas = await tx.query<{
    code: string;
    debit: string;
    credit: string;
    currency: string;
    description: string | null;
  }>(
    `SELECT a.code, l.debit::text, l.credit::text, l.currency, l.description
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId],
  );

  return {
    paraAnular: {
      id: fila.id,
      companyId,
      journalCode: fila.journal_code,
      entryDate: aFecha(fila.entry_date),
      description: fila.description,
      currency: moneda,
      status: fila.status,
      lines: lineas.rows.map((linea): JournalEntryLineDraft => {
        const monedaLinea: Currency = isCurrency(linea.currency) ? linea.currency : 'ARS';
        return {
          accountCode: linea.code,
          debit: moneyFromDecimalString(linea.debit, monedaLinea),
          credit: moneyFromDecimalString(linea.credit, monedaLinea),
          currency: monedaLinea,
          ...(linea.description !== null ? { description: linea.description } : {}),
        };
      }),
      source: { type: fila.source_type, id: fila.source_id },
    },
  };
}

// ---------------------------------------------------------------------------
// Conversiones
// ---------------------------------------------------------------------------

function aDraft(
  body: z.infer<typeof asientoSchema>,
  companyId: string,
  actorId: string,
): JournalEntryDraft {
  const moneda: Currency = isCurrency(body.currency) ? body.currency : 'ARS';

  return {
    companyId,
    journalCode: body.journalCode,
    entryDate: parseCalendarDate(body.entryDate),
    description: body.description,
    kind: body.kind,
    currency: moneda,
    lines: body.lines.map((linea): JournalEntryLineDraft => {
      const monedaLinea: Currency = isCurrency(linea.currency) ? linea.currency : 'ARS';
      return {
        accountCode: linea.accountCode,
        debit: aMoney(linea.debit, monedaLinea),
        credit: aMoney(linea.credit, monedaLinea),
        currency: monedaLinea,
        ...(linea.fx !== undefined
          ? {
              fx: {
                rate: aRazon(linea.fx.rate),
                source: linea.fx.source,
                date: parseCalendarDate(linea.fx.date),
              },
            }
          : {}),
        ...(linea.costCenterCode !== undefined ? { costCenterCode: linea.costCenterCode } : {}),
        ...(linea.partyId !== undefined ? { partyId: linea.partyId } : {}),
        ...(linea.taxTransactionId !== undefined
          ? { taxTransactionId: linea.taxTransactionId }
          : {}),
        ...(linea.description !== undefined ? { description: linea.description } : {}),
      };
    }),
    source: body.source,
    ruleApplications: body.ruleApplications,
    ...(body.manualJustification !== undefined
      ? { manualJustification: body.manualJustification }
      : {}),
    // Hasta acá el decisionId llegaba al INSERT y nunca al motor: se persistia
    // una razon que la validacion no veia.
    ...(body.decisionId !== undefined ? { decisionId: body.decisionId } : {}),
    actor: { userId: actorId.replace(/^user:/, '') },
  };
}

function aMoney(texto: string, moneda: Currency): Money {
  if (texto.trim().length === 0) return zero(moneda);
  return moneyFromDecimalString(texto, moneda);
}

/** Cotización desde texto decimal a fracción exacta de enteros. */
function aRazon(texto: string): { numerator: bigint; denominator: bigint } {
  const normalizado = texto.trim().replace(',', '.');
  const [entero = '0', decimales = ''] = normalizado.split('.');
  return {
    numerator: BigInt(`${entero}${decimales}`),
    denominator: 10n ** BigInt(decimales.length),
  };
}

/** La fracción exacta, escrita con los seis decimales que admite `numeric(18,6)`. */
function razonATexto(numerator: bigint, denominator: bigint): string {
  const escalado = (numerator * 1_000_000n) / denominator;
  const negativo = escalado < 0n;
  const magnitud = (negativo ? -escalado : escalado).toString().padStart(7, '0');
  return `${negativo ? '-' : ''}${magnitud.slice(0, -6)}.${magnitud.slice(-6)}`;
}

function aFecha(valor: Date | string): CalendarDate {
  const texto = typeof valor === 'string' ? valor : valor.toISOString().slice(0, 10);
  return parseCalendarDate(texto.slice(0, 10));
}
