/**
 * Cierre y apertura de ejercicio.
 *
 * ```
 * ABIERTO ──pre-close──► EN_CIERRE ──close──► CERRADO ──opening──► (N+1 con apertura)
 * ```
 *
 * ## Cierre de ejercicio ≠ cierre de período
 *
 * Están en archivos distintos porque son cosas distintas, y no comparten ni un
 * candado. `periods.ts` gobierna *en qué mes se puede escribir*. Esto gobierna
 * *qué clase de asiento admite el ejercicio entero* y, al final, determina el
 * resultado. Un período se cierra doce veces por año; un ejercicio, una.
 *
 * ## Qué decide cada capa
 *
 * - `evaluarChecklist` (motor, puro) decide **si se puede cerrar**.
 * - `planificarCierre` / `planificarApertura` (motor, puro) deciden **qué
 *   asiento corresponde**.
 * - Esto —el repositorio— resuelve los saldos, toma los números correlativos en
 *   una única transacción, escribe y deja el rastro.
 *
 * Ninguna regla contable se decide acá. Si apareciera un `if` sobre qué cuenta
 * se refunde, estaría en el lugar equivocado.
 *
 * ## Lo que este archivo se niega a hacer
 *
 * Arreglar los datos para poder cerrar. Si el checklist bloquea, contesta 422
 * con los ítems y no toca nada. Un cierre que acomoda lo que encuentra no es un
 * cierre: es una afirmación sobre un ejercicio que nadie revisó.
 */

import {
  evaluarChecklist,
  planificarApertura,
  planificarCierre,
  puedeCerrar,
  type ItemChecklist,
  type LineaDeCierre,
  type SaldoDeCuenta,
  type TipoDeCuenta,
} from '@aai/accounting-engine';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import { moneyFromDecimalString, toDecimalString, type Currency, type Money } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflictoTipado, notFound, unprocessable } from '../http/errors.js';

/** CCyC art. 325: moneda nacional. Mismo criterio que `books.ts`. */
const MONEDA: Currency = 'ARS';

interface Ejercicio {
  id: string;
  code: string;
  start_date: string;
  end_date: string;
  status: 'ABIERTO' | 'EN_CIERRE' | 'CERRADO';
}

interface SaldoSerializado {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: TipoDeCuenta;
  /** Decimal en pesos, como lo guarda la base. Nunca un `number`. */
  readonly saldo: string;
}

export async function closureRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Pre-cierre: corre el checklist y, si pasa, congela el ejercicio.
   *
   * A partir de acá el ejercicio solo admite AJUSTE, REFUNDICION y CIERRE — lo
   * hace valer el trigger `je_fiscal_year_guard` de la 0038, no este handler.
   * Sin ese congelamiento la etapa sería decorativa: seguirían entrando asientos
   * que cambian el resultado que se está por determinar.
   */
  app.post<{ Params: { fiscalYearId: string } }>(
    '/fiscal-years/:fiscalYearId/pre-close',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'fiscal_year:close');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { fiscalYearId } = paramsSchema.parse(request.params);

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const ejercicio = await bloquearEjercicio(tx, fiscalYearId);
        if (ejercicio.status !== 'ABIERTO') {
          throw estadoInvalido(
            ejercicio,
            'Solo se pre-cierra un ejercicio ABIERTO',
            ejercicio.status === 'EN_CIERRE'
              ? 'Ya está en cierre: seguí con POST /fiscal-years/:id/close'
              : 'Ya está cerrado',
          );
        }

        const checklist = await correrChecklist(tx, tenant.companyId, ejercicio);
        if (!puedeCerrar(checklist)) throw bloqueado(checklist);

        const expediente = await tx.query<{ id: string }>(
          `INSERT INTO accounting_closures
             (company_id, fiscal_year_id, checklist, status, performed_by)
           VALUES ($1, $2, $3::jsonb, 'EN_CURSO', $4)
           RETURNING id`,
          [tenant.companyId, fiscalYearId, JSON.stringify(checklist), actorId],
        );

        await tx.query(`UPDATE fiscal_years SET status = 'EN_CIERRE' WHERE id = $1`, [
          fiscalYearId,
        ]);

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'PRE_CERRAR_EJERCICIO',
          objectType: 'fiscal_year',
          objectId: fiscalYearId,
          oldValue: { status: 'ABIERTO' },
          newValue: { status: 'EN_CIERRE', closureId: expediente.rows[0]!.id },
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          closureId: expediente.rows[0]!.id,
          ejercicio: ejercicio.code,
          status: 'EN_CIERRE',
          checklist,
        };
      });
    },
  );

  /**
   * Cierre: determina el resultado y lo registra en dos asientos.
   *
   * El orden dentro de la transacción no es casual. Los asientos se insertan
   * **antes** de marcar el ejercicio CERRADO, porque el trigger de la 0038
   * rechaza cualquier asiento en un ejercicio cerrado — incluido el de cierre.
   * Invertir las dos líneas hace que el cierre no pueda cerrarse a sí mismo.
   */
  app.post<{ Params: { fiscalYearId: string } }>(
    '/fiscal-years/:fiscalYearId/close',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'fiscal_year:close');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { fiscalYearId } = paramsSchema.parse(request.params);

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const ejercicio = await bloquearEjercicio(tx, fiscalYearId);
        if (ejercicio.status !== 'EN_CIERRE') {
          throw estadoInvalido(
            ejercicio,
            'Solo se cierra un ejercicio que pasó por el pre-cierre',
            ejercicio.status === 'ABIERTO'
              ? 'Corré primero POST /fiscal-years/:id/pre-close'
              : 'El ejercicio ya está cerrado',
          );
        }

        const expediente = await tx.query<{ id: string }>(
          `SELECT id FROM accounting_closures
            WHERE fiscal_year_id = $1 AND status = 'EN_CURSO'`,
          [fiscalYearId],
        );
        const closureId = expediente.rows[0]?.id;
        if (closureId === undefined) {
          // No debería pasar: EN_CIERRE lo pone el pre-cierre junto con el
          // expediente. Si pasa, la base y el estado no coinciden y cerrar sin
          // expediente dejaría un cierre sin checklist detrás.
          throw conflictoTipado(
            'E_FISCAL_YEAR_STATE',
            `El ejercicio ${ejercicio.code} está EN_CIERRE pero no tiene expediente de cierre en curso.`,
          );
        }

        // El checklist se vuelve a correr. El del pre-cierre quedó archivado como
        // lo que se vio ese día; lo que autoriza a cerrar es lo que se ve hoy.
        const checklist = await correrChecklist(tx, tenant.companyId, ejercicio);
        if (!puedeCerrar(checklist)) throw bloqueado(checklist);

        const cuentaResultado = await resolverCuentaDeResultado(tx, tenant.companyId);
        const saldos = await saldosAlCierre(tx, tenant.companyId, ejercicio.end_date);
        rechazarCuentasQueNoSePuedenCerrar(saldos.conDimension);

        const plan = planificarCierre(saldos.saldos, cuentaResultado, MONEDA);
        if (!plan.ok) {
          throw unprocessable('CIERRE_INVALIDO', 'El ejercicio no se puede cerrar', {
            errores: plan.errors,
          });
        }

        const periodo = await periodoDe(tx, tenant.companyId, ejercicio.end_date);

        const refundicionId =
          plan.value.refundicion.length === 0
            ? null
            : await postearAsientoDeCierre(tx, {
                companyId: tenant.companyId,
                ejercicio,
                periodId: periodo,
                kind: 'REFUNDICION',
                descripcion: `Refundición de resultados del ejercicio ${ejercicio.code}`,
                justificacion: `Refundición de resultados — cierre ${closureId}`,
                lineas: plan.value.refundicion,
                actorId,
              });

        const cierreId =
          plan.value.cierre.length === 0
            ? null
            : await postearAsientoDeCierre(tx, {
                companyId: tenant.companyId,
                ejercicio,
                periodId: periodo,
                kind: 'CIERRE',
                descripcion: `Cierre del ejercicio ${ejercicio.code}`,
                justificacion: `Cierre de cuentas patrimoniales — cierre ${closureId}`,
                lineas: plan.value.cierre,
                actorId,
              });

        const saldosFinales: SaldoSerializado[] = plan.value.saldosFinales.map((s) => ({
          accountId: s.accountId,
          code: s.code,
          name: s.name,
          type: s.type,
          saldo: toDecimalString(s.saldo),
        }));

        await tx.query(
          `UPDATE accounting_closures
              SET status = 'COMPLETADO', checklist = $2::jsonb,
                  closed_by = $3, closed_at = now(),
                  resultado = $4, resultado_account_id = $5,
                  refundicion_entry_id = $6, cierre_entry_id = $7,
                  saldos = $8::jsonb
            WHERE id = $1`,
          [
            closureId,
            JSON.stringify(checklist),
            actorId,
            toDecimalString(plan.value.resultado),
            cuentaResultado.accountId,
            refundicionId,
            cierreId,
            JSON.stringify(saldosFinales),
          ],
        );

        // Recién ahora. Antes de esta línea el ejercicio todavía admitía los
        // asientos de cierre; después no admite ninguno.
        await tx.query(`UPDATE fiscal_years SET status = 'CERRADO' WHERE id = $1`, [fiscalYearId]);

        // Un ejercicio cerrado no deja meses abiertos detrás. El período y el
        // ejercicio son conceptos distintos, pero un mes abierto dentro de un
        // ejercicio cerrado sería una puerta que no lleva a ninguna parte: el
        // trigger del ejercicio rechaza igual.
        await tx.query(
          `UPDATE periods SET status = 'CERRADO', closed_at = now(), closed_by = $2
            WHERE fiscal_year_id = $1 AND status <> 'CERRADO'`,
          [fiscalYearId, auth.user.email],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CERRAR_EJERCICIO',
          objectType: 'fiscal_year',
          objectId: fiscalYearId,
          oldValue: { status: 'EN_CIERRE' },
          newValue: {
            status: 'CERRADO',
            closureId,
            resultado: toDecimalString(plan.value.resultado),
            refundicionEntryId: refundicionId,
            cierreEntryId: cierreId,
          },
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          closureId,
          ejercicio: ejercicio.code,
          status: 'CERRADO',
          resultado: toDecimalString(plan.value.resultado),
          ingresos: toDecimalString(plan.value.ingresos),
          gastos: toDecimalString(plan.value.gastos),
          cuentaResultado: cuentaResultado.code,
          refundicionEntryId: refundicionId,
          cierreEntryId: cierreId,
          saldosFinales,
        };
      });
    },
  );

  /**
   * Apertura del ejercicio siguiente, derivada de los saldos que archivó el
   * cierre.
   *
   * No se recalculan. Recalcularlos permitiría que el asiento de apertura y el
   * cierre que dice originarlo no coincidan, y esa diferencia no la vería nadie:
   * los dos cuadran por separado.
   */
  app.post<{ Params: { fiscalYearId: string } }>(
    '/fiscal-years/:fiscalYearId/opening',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'fiscal_year:close');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { fiscalYearId } = paramsSchema.parse(request.params);
      const body = z.object({ siguienteEjercicioId: z.string().uuid() }).parse(request.body);

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const anterior = await bloquearEjercicio(tx, fiscalYearId);
        if (anterior.status !== 'CERRADO') {
          throw conflictoTipado(
            'E_OPENING_WITHOUT_CLOSURE',
            `La apertura deriva de un ejercicio cerrado, y ${anterior.code} está ${anterior.status}.`,
            { status: anterior.status },
          );
        }

        const expediente = await tx.query<{
          id: string;
          saldos: SaldoSerializado[] | null;
          apertura_entry_id: string | null;
        }>(
          `SELECT id, saldos, apertura_entry_id FROM accounting_closures
            WHERE fiscal_year_id = $1 AND status = 'COMPLETADO'`,
          [fiscalYearId],
        );
        const cierre = expediente.rows[0];
        if (cierre === undefined || cierre.saldos === null) {
          throw conflictoTipado(
            'E_OPENING_WITHOUT_CLOSURE',
            `El ejercicio ${anterior.code} no tiene un cierre completado con saldos archivados.`,
          );
        }
        if (cierre.apertura_entry_id !== null) {
          // Idempotencia. La base lo impide igual —`accounting_closures_inmutable`
          // y el índice único de APERTURA por ejercicio—, pero un 409 explicando
          // cuál es el asiento sirve más que una excepción de PostgreSQL.
          throw conflictoTipado(
            'E_FISCAL_YEAR_STATE',
            `El cierre de ${anterior.code} ya derivó su asiento de apertura.`,
            { aperturaEntryId: cierre.apertura_entry_id },
          );
        }

        const siguiente = await bloquearEjercicio(tx, body.siguienteEjercicioId);
        if (siguiente.status !== 'ABIERTO') {
          throw estadoInvalido(
            siguiente,
            'La apertura se registra en un ejercicio ABIERTO',
            'El ejercicio de destino ya no admite la apertura',
          );
        }
        if (siguiente.start_date <= anterior.end_date) {
          throw conflictoTipado(
            'E_DATE_OUT_OF_PERIOD',
            `El ejercicio ${siguiente.code} (desde ${siguiente.start_date}) no es posterior a ${anterior.code} (hasta ${anterior.end_date}).`,
          );
        }

        const saldos: SaldoDeCuenta[] = cierre.saldos.map((s) => ({
          accountId: s.accountId,
          code: s.code,
          name: s.name,
          type: s.type,
          saldo: moneyFromDecimalString(s.saldo, MONEDA),
        }));

        const plan = planificarApertura(saldos, MONEDA);
        if (!plan.ok) {
          throw unprocessable('APERTURA_INVALIDA', 'La apertura no se puede registrar', {
            errores: plan.errors,
          });
        }

        const periodo = await periodoDe(tx, tenant.companyId, siguiente.start_date);
        const aperturaId =
          plan.value.length === 0
            ? null
            : await postearAsientoDeCierre(tx, {
                companyId: tenant.companyId,
                ejercicio: siguiente,
                periodId: periodo,
                kind: 'APERTURA',
                fecha: siguiente.start_date,
                descripcion: `Apertura del ejercicio ${siguiente.code}`,
                justificacion: `Apertura derivada del cierre ${cierre.id} del ejercicio ${anterior.code}`,
                lineas: plan.value,
                actorId,
              });

        await tx.query(
          `UPDATE accounting_closures
              SET apertura_entry_id = $2, apertura_fiscal_year_id = $3,
                  apertura_by = $4, apertura_at = now()
            WHERE id = $1`,
          [cierre.id, aperturaId, siguiente.id, actorId],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'ABRIR_EJERCICIO',
          objectType: 'fiscal_year',
          objectId: siguiente.id,
          newValue: {
            closureId: cierre.id,
            desdeEjercicio: anterior.code,
            aperturaEntryId: aperturaId,
            lineas: plan.value.length,
          },
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          closureId: cierre.id,
          desdeEjercicio: anterior.code,
          ejercicio: siguiente.code,
          aperturaEntryId: aperturaId,
          lineas: plan.value.length,
        };
      });
    },
  );

  /**
   * El expediente del cierre: quién, cuándo, con qué saldos, qué resultado, qué
   * asientos y qué apertura derivó.
   *
   * Es la respuesta a la FASE K en una sola consulta. Que esté acá y no armado
   * por pantalla es lo mismo que con `ledger_trace`: cada consumidor que rearma
   * el camino por su cuenta es una punta que se puede escapar.
   */
  app.get<{ Params: { fiscalYearId: string } }>(
    '/fiscal-years/:fiscalYearId/closure',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'report:read');
      const auth = requireAuth(request);
      const { fiscalYearId } = paramsSchema.parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const result = await tx.query(
            `SELECT c.id AS "closureId", c.status, c.checklist,
                    c.performed_by AS "preCerradoPor", c.performed_at AS "preCerradoEl",
                    c.closed_by AS "cerradoPor", c.closed_at AS "cerradoEl",
                    c.resultado::text, a.code AS "cuentaResultado",
                    c.refundicion_entry_id AS "refundicionEntryId",
                    c.cierre_entry_id AS "cierreEntryId",
                    c.saldos AS "saldosFinales",
                    c.apertura_entry_id AS "aperturaEntryId",
                    c.apertura_by AS "aperturaPor", c.apertura_at AS "aperturaEl",
                    sig.code AS "aperturaEjercicio",
                    fy.code AS "ejercicio", fy.status AS "ejercicioStatus"
               FROM accounting_closures c
               JOIN fiscal_years fy ON fy.id = c.fiscal_year_id
               LEFT JOIN accounts a ON a.id = c.resultado_account_id
               LEFT JOIN fiscal_years sig ON sig.id = c.apertura_fiscal_year_id
              WHERE c.fiscal_year_id = $1 AND c.status <> 'ABORTADO'`,
            [fiscalYearId],
          );
          const fila = result.rows[0];
          if (fila === undefined) {
            throw notFound('Ese ejercicio no tiene expediente de cierre en esta empresa');
          }
          return fila;
        },
      );
    },
  );
}

const paramsSchema = z.object({ fiscalYearId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

/**
 * Toma la fila del ejercicio para actualización.
 *
 * `FOR UPDATE` y no un `SELECT` suelto: dos pedidos de cierre concurrentes leen
 * los dos `EN_CIERRE`, los dos pasan el checklist y los dos escriben. Los
 * índices únicos de la 0038 contendrían la integridad —un solo asiento de cada
 * clase—, pero el perdedor recibiría un 500 en vez de un 409, y el ganador
 * podría ser cualquiera de los dos.
 */
async function bloquearEjercicio(tx: Tx, fiscalYearId: string): Promise<Ejercicio> {
  const result = await tx.query<Ejercicio>(
    `SELECT id, code, start_date::text, end_date::text, status
       FROM fiscal_years WHERE id = $1 FOR UPDATE`,
    [fiscalYearId],
  );
  const fila = result.rows[0];
  // El RLS ya acotó a la empresa en contexto: un ejercicio ajeno no llega.
  if (fila === undefined) throw notFound('Ejercicio no encontrado en esta empresa');
  return fila;
}

function estadoInvalido(ejercicio: Ejercicio, regla: string, sugerencia: string): Error {
  return conflictoTipado(
    'E_FISCAL_YEAR_STATE',
    `${regla}. ${ejercicio.code} está ${ejercicio.status}: ${sugerencia}.`,
    { ejercicio: ejercicio.code, status: ejercicio.status },
  );
}

function bloqueado(checklist: readonly ItemChecklist[]): Error {
  const pendientes = checklist.filter((i) => i.bloquea && !i.cumple);
  return unprocessable(
    'E_CLOSURE_BLOCKED',
    `El ejercicio no se puede cerrar: ${pendientes.length} control(es) bloqueante(s) sin cumplir. ` +
      'Los datos no se corrigen solos.',
    { pendientes, checklist },
  );
}

/**
 * Los hechos del checklist, acotados al ejercicio.
 *
 * Cada conteo es una consulta determinística; el criterio de qué bloquea y qué
 * solo advierte vive en `evaluarChecklist`, en el motor. Acá no hay ningún `if`.
 */
async function correrChecklist(
  tx: Tx,
  companyId: string,
  ejercicio: Ejercicio,
): Promise<readonly ItemChecklist[]> {
  const rango = [companyId, ejercicio.start_date, ejercicio.end_date] as const;

  const uno = async (sql: string, params: readonly unknown[] = rango): Promise<number> => {
    const r = await tx.query<{ n: string }>(sql, [...params]);
    return Number(r.rows[0]?.n ?? '0');
  };

  // Los dos que se cuentan por ejercicio y no por fecha llevan sus propios
  // parámetros: PostgreSQL no puede inferir el tipo de un `$n` que la consulta
  // no menciona, y pasarle el rango sin usarlo rompe la preparación.
  const asientosEnBorrador = await uno(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE company_id = $1 AND fiscal_year_id = $2 AND status = 'BORRADOR'`,
    [companyId, ejercicio.id],
  );
  const asientosPropuestosSinAprobar = await uno(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE company_id = $1 AND fiscal_year_id = $2 AND status = 'PROPUESTO'`,
    [companyId, ejercicio.id],
  );
  const comprobantesSinAsiento = await uno(
    `SELECT count(*)::text AS n FROM tax_transactions
      WHERE company_id = $1 AND cbte_fecha BETWEEN $2::date AND $3::date AND entry_id IS NULL`,
  );
  const documentosConHallazgoBloqueante = await uno(
    `SELECT count(*)::text AS n FROM documents_pendientes
      WHERE company_id = $1 AND received_at::date BETWEEN $2::date AND $3::date
        AND tiene_hallazgo_bloqueante`,
  );
  const duplicadosSinResolver = await uno(
    `SELECT count(*)::text AS n FROM documents_pendientes
      WHERE company_id = $1 AND received_at::date BETWEEN $2::date AND $3::date
        AND tiene_duplicado_sin_resolver`,
  );
  const propuestasDeIaSinRevisar = await uno(
    `SELECT count(*)::text AS n FROM predictions_pendientes
      WHERE company_id = $1 AND created_at::date BETWEEN $2::date AND $3::date`,
  );
  const bancosSinConciliar = await uno(
    `SELECT count(*)::text AS n FROM bank_transactions
      WHERE company_id = $1 AND fecha BETWEEN $2::date AND $3::date AND status = 'PENDIENTE'`,
  );

  // La diferencia del balance sale de las líneas, no de `account_balances`: esa
  // tabla es una proyección, y verificar el cuadre contra ella sería preguntarle
  // a la copia si la copia está bien.
  const diferencia = await tx.query<{ diferencia: string }>(
    `SELECT COALESCE(round((sum(l.debit) - sum(l.credit)) * 100), 0)::bigint::text AS diferencia
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND e.fiscal_year_id = $2
        AND e.status IN ('APROBADO', 'ANULADO')`,
    [companyId, ejercicio.id],
  );

  return evaluarChecklist({
    asientosEnBorrador,
    asientosPropuestosSinAprobar,
    comprobantesSinAsiento,
    documentosConHallazgoBloqueante,
    duplicadosSinResolver,
    propuestasDeIaSinRevisar,
    bancosSinConciliar,
    diferenciaSumasYSaldosEnMenor: diferencia.rows[0]?.diferencia ?? '0',
  });
}

/**
 * La cuenta que la empresa designó para recibir el resultado.
 *
 * Su ausencia es un error tipado y no un valor por defecto. Elegir esa cuenta es
 * una decisión del profesional sobre su propio plan: tomar «la primera PN» o
 * «la que se llame Resultado» sería inventar contabilidad ajena.
 */
async function resolverCuentaDeResultado(
  tx: Tx,
  companyId: string,
): Promise<{ accountId: string; code: string }> {
  const result = await tx.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts
      WHERE company_id = $1 AND closing_role = 'RESULTADO_DEL_EJERCICIO'`,
    [companyId],
  );
  const fila = result.rows[0];
  if (fila === undefined) {
    throw unprocessable(
      'E_RESULT_ACCOUNT_MISSING',
      'La empresa no designó qué cuenta recibe el resultado del ejercicio. ' +
        'Marcala con closingRole = "RESULTADO_DEL_EJERCICIO" en una cuenta de PN imputable.',
    );
  }
  return { accountId: fila.id, code: fila.code };
}

interface SaldosDelCierre {
  readonly saldos: readonly SaldoDeCuenta[];
  /** Cuentas con saldo que exigen una dimensión que el cierre no puede aportar. */
  readonly conDimension: readonly { code: string; que: string }[];
}

/**
 * Saldos acumulados de todas las cuentas hasta la fecha de cierre, inclusive.
 *
 * Acumulados y no «del ejercicio»: el saldo de una cuenta patrimonial arrastra
 * de los ejercicios anteriores. Para el primer ejercicio da lo mismo; a partir
 * del segundo, tomar solo el rango del ejercicio dejaría el patrimonio en cero.
 *
 * Y como el ejercicio anterior terminó con su asiento de cierre llevando todo a
 * cero, y el siguiente abrió con su apertura, el acumulado a través del corte
 * sigue siendo correcto sin ningún caso especial.
 */
async function saldosAlCierre(tx: Tx, companyId: string, hasta: string): Promise<SaldosDelCierre> {
  const result = await tx.query<{
    account_id: string;
    code: string;
    name: string;
    type: TipoDeCuenta;
    saldo: string;
    requires_cost_center: boolean;
    requires_third_party: boolean;
  }>(
    `SELECT l.account_id, a.code, a.name, a.type,
            (sum(l.debit) - sum(l.credit))::text AS saldo,
            a.requires_cost_center, a.requires_third_party
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.company_id = $1
        AND e.status IN ('APROBADO', 'ANULADO')
        AND e.entry_date <= $2::date
      GROUP BY l.account_id, a.code, a.name, a.type,
               a.requires_cost_center, a.requires_third_party
      ORDER BY a.code`,
    [companyId, hasta],
  );

  const saldos: SaldoDeCuenta[] = [];
  const conDimension: { code: string; que: string }[] = [];

  for (const fila of result.rows) {
    const saldo: Money = moneyFromDecimalString(fila.saldo, MONEDA);
    saldos.push({
      accountId: fila.account_id,
      code: fila.code,
      name: fila.name,
      type: fila.type,
      saldo,
    });
    if (saldo.amount === 0n) continue;
    if (fila.requires_cost_center) conDimension.push({ code: fila.code, que: 'centro de costo' });
    if (fila.requires_third_party) conDimension.push({ code: fila.code, que: 'tercero' });
  }

  return { saldos, conDimension };
}

/**
 * Una cuenta que exige centro de costo o tercero no se puede cancelar.
 *
 * El CANDADO 7 de la 0005 rechaza la línea, y con razón: la dimensión es
 * obligatoria porque sin ella el saldo no significa nada. Pero el asiento de
 * cierre cancela un saldo agregado, que por definición no tiene un tercero
 * único.
 *
 * Se detecta antes de escribir nada y se contesta con la lista, en vez de dejar
 * que el trigger tire una excepción a mitad de la transacción. Es un límite real
 * del modelo y está declarado como gap: la salida es imputar esas cuentas contra
 * una cuenta de agregación antes de cerrar, o no exigirles dimensión.
 */
function rechazarCuentasQueNoSePuedenCerrar(
  conDimension: readonly { code: string; que: string }[],
): void {
  if (conDimension.length === 0) return;
  throw unprocessable(
    'E_MISSING_DIMENSION',
    `Hay cuentas con saldo que exigen una dimensión que el asiento de cierre no puede aportar: ` +
      `${conDimension.map((c) => `${c.code} (${c.que})`).join(', ')}. ` +
      'Un saldo agregado no tiene un tercero ni un centro de costo únicos.',
    { cuentas: conDimension },
  );
}

async function periodoDe(tx: Tx, companyId: string, fecha: string): Promise<string> {
  const result = await tx.query<{ id: string; number: number; status: string }>(
    `SELECT id, number, status FROM periods
      WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`,
    [companyId, fecha],
  );
  const fila = result.rows[0];
  if (fila === undefined) {
    throw unprocessable(
      'E_DATE_OUT_OF_PERIOD',
      `No hay un período que contenga la fecha ${fecha}. El asiento no tiene dónde registrarse.`,
    );
  }
  if (fila.status === 'CERRADO') {
    // No se reabre por cuenta propia: reabrir un período cerrado exige dos
    // firmas (§36) y es una decisión, no un efecto colateral de cerrar.
    throw unprocessable(
      'E_PERIOD_CLOSED',
      `El período ${fila.number}, que contiene ${fecha}, está CERRADO y el asiento no puede entrar. ` +
        'Reabrilo formalmente antes de cerrar el ejercicio.',
    );
  }
  return fila.id;
}

/**
 * Inserta un asiento de cierre, refundición o apertura, ya aprobado.
 *
 * Aprobado directamente y no PROPUESTO: quien llama tiene `fiscal_year:close`,
 * que solo tiene el Contador, y el acto de cerrar **es** la aprobación. Mismo
 * criterio que el contraasiento en `journal-entries.ts`.
 *
 * No pasa por `prepararPosteo`. Las líneas no vienen de un formulario sino de
 * `planificarCierre`, que ya trabajó sobre saldos resueltos; lo que hay que
 * garantizar —Debe = Haber, cuentas imputables, período, ejercicio— lo
 * garantizan los siete candados de la 0005 más el de la 0038, que corren igual.
 */
async function postearAsientoDeCierre(
  tx: Tx,
  opciones: {
    companyId: string;
    ejercicio: Ejercicio;
    periodId: string;
    kind: 'REFUNDICION' | 'CIERRE' | 'APERTURA';
    fecha?: string;
    descripcion: string;
    justificacion: string;
    lineas: readonly LineaDeCierre[];
    actorId: string;
  },
): Promise<string> {
  const fecha = opciones.fecha ?? opciones.ejercicio.end_date;
  const total = opciones.lineas.reduce((acc, l) => acc + l.debit.amount, 0n);

  const numero = await tx.query<{ next_entry_number: number }>(
    'SELECT next_entry_number($1, $2, $3)',
    [opciones.companyId, opciones.kind === 'APERTURA' ? 'APERTURA' : 'CIERRE', opciones.ejercicio.id],
  );

  const cabecera = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries
       (company_id, journal_code, period_id, fiscal_year_id, entry_number, entry_date,
        description, kind, status, currency, total_debit, total_credit,
        source_type, source_id, manual_justification, created_by, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'APROBADO', $9, $10, $10,
             'CLOSING', NULL, $11, $12, $12, now())
     RETURNING id`,
    [
      opciones.companyId,
      opciones.kind === 'APERTURA' ? 'APERTURA' : 'CIERRE',
      opciones.periodId,
      opciones.ejercicio.id,
      numero.rows[0]!.next_entry_number,
      fecha,
      opciones.descripcion,
      opciones.kind,
      MONEDA,
      decimal(total),
      opciones.justificacion,
      opciones.actorId,
    ],
  );
  const entryId = cabecera.rows[0]!.id;

  let lineNo = 0;
  for (const linea of opciones.lineas) {
    lineNo += 1;
    await tx.query(
      `INSERT INTO journal_entry_lines
         (company_id, entry_id, line_no, account_id, debit, credit, currency, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opciones.companyId,
        entryId,
        lineNo,
        linea.accountId,
        toDecimalString(linea.debit),
        toDecimalString(linea.credit),
        MONEDA,
        linea.description,
      ],
    );
  }

  return entryId;
}

/**
 * Unidades menores a decimal, con aritmética entera.
 *
 * Dividir por 100 en punto flotante es exactamente lo que el gate
 * `check:no-float` existe para impedir, y sobre un total de cierre sería el peor
 * lugar posible para perder un centavo.
 */
function decimal(centavos: bigint): string {
  const signo = centavos < 0n ? '-' : '';
  const abs = centavos < 0n ? -centavos : centavos;
  return `${signo}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
