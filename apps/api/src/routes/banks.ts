/**
 * Bancos: importación de extractos y conciliación asistida.
 *
 * Igual que `books.ts` y `vat.ts`: acá no se decide nada. Lo único que este
 * archivo aporta al dominio es **separar el CSV en columnas**, que es un problema
 * de lectura de archivos; la interpretación de cada celda y todo el matching
 * viven en `@aai/bank-engine`.
 *
 * El endpoint que más importa es el que **no** existe: no hay ninguno que
 * confirme una conciliación en lote. Confirmar es de a uno, con el match a la
 * vista, y la base lo exige además de esta capa.
 */

import {
  conciliar,
  huellaDeMovimiento,
  interpretarExtracto,
  repetidosEnElLote,
  totalesDelLote,
  verificarCadenaDeSaldos,
  type LineaConciliable,
  type MapeoDeExtracto,
  type MovimientoBancario,
  type SentidoBancario,
} from '@aai/bank-engine';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  moneyFromDecimalString,
  parseCalendarDate,
  toDecimalString,
  type Currency,
} from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';

const MONEDA: Currency = 'ARS';

export async function bankRoutes(app: FastifyInstance): Promise<void> {
  app.get('/banks/accounts', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'bank:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT b.id, b.bank_name AS "banco", b.cbu, b.alias, b.numero, b.currency AS "moneda",
                  b.status AS "estado", a.code AS "cuentaCodigo", a.name AS "cuentaNombre"
             FROM bank_accounts b
             JOIN accounts a ON a.id = b.account_id
            WHERE b.company_id = $1
            ORDER BY b.bank_name`,
          [tenant.companyId],
        );
        return { cuentas: result.rows };
      },
    );
  });

  /**
   * Importa un extracto ya subido como documento.
   *
   * El archivo tiene que estar archivado antes: un extracto importado cuyo
   * original no se guardó no se puede volver a leer para verificar cómo se
   * interpretó cada fila.
   *
   * La respuesta trae **los errores de interpretación y el resultado de la cadena
   * de saldos aunque la importación haya funcionado**. Un extracto con tres filas
   * ilegibles importado como si tuviera tres filas menos es peor que uno que no
   * importa.
   */
  app.post<{ Params: { bankAccountId: string } }>(
    '/banks/accounts/:bankAccountId/statements',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'bank:import');
      const auth = requireAuth(request);
      const params = z.object({ bankAccountId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          layoutId: z.string().uuid(),
          documentId: z.string().uuid().optional(),
          desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          saldoInicial: z.string().regex(/^-?\d+([.,]\d{1,2})?$/),
          saldoFinal: z.string().regex(/^-?\d+([.,]\d{1,2})?$/),
          /** Contenido del CSV, tal cual. La separación en columnas se hace acá. */
          contenido: z.string().min(1).max(20_000_000),
        })
        .parse(request.body);
      const actorId = `user:${auth.user.userId}`;

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const layout = await cargarLayout(tx, tenant.companyId, body.layoutId);
        if (layout === null) throw notFound('No existe ese mapeo de extracto para esta empresa');

        const filas = separarCsv(body.contenido, layout.separador);
        const { movimientos, errores } = interpretarExtracto(filas, layout.mapeo);

        const saldoInicial = moneyFromDecimalString(body.saldoInicial, MONEDA);
        const saldoFinal = moneyFromDecimalString(body.saldoFinal, MONEDA);
        const cadena = verificarCadenaDeSaldos(movimientos, saldoInicial, saldoFinal);
        const todosLosErrores = [...errores, ...cadena.errores];

        // La cadena rota aborta: desde la fila afectada todo está corrido, y
        // guardar los movimientos que "parecían bien" dejaría el extracto a
        // medias sin que nadie lo note.
        if (cadena.errores.length > 0) {
          return reply.code(422).send({
            error: 'EXTRACTO_INCONSISTENTE',
            message:
              'La cadena de saldos del extracto no cierra. No se importó nada: desde la fila señalada, todo lo que sigue está corrido.',
            errores: todosLosErrores,
          });
        }

        const extracto = await tx.query<{ id: string }>(
          `INSERT INTO bank_statements
             (company_id, bank_account_id, layout_id, source_document_id, desde, hasta,
              saldo_inicial, saldo_final, cadena_verificada, errores, imported_by)
           VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10::jsonb, $11)
           RETURNING id`,
          [
            tenant.companyId,
            params.bankAccountId,
            body.layoutId,
            body.documentId ?? null,
            body.desde,
            body.hasta,
            toDecimalString(saldoInicial),
            toDecimalString(saldoFinal),
            // `null` cuando el extracto no traía columna de saldo. No es lo mismo
            // que haber verificado y que dé bien.
            cadena.verificable ? true : null,
            JSON.stringify(todosLosErrores),
            actorId,
          ],
        );
        const statementId = extracto.rows[0]!.id;

        for (const movimiento of movimientos) {
          await tx.query(
            `INSERT INTO bank_transactions
               (company_id, statement_id, fecha, fecha_valor, descripcion, importe, sentido,
                referencia, saldo_posterior, crudo, huella)
             VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11)`,
            [
              tenant.companyId,
              statementId,
              movimiento.fecha,
              movimiento.fechaValor,
              movimiento.descripcion,
              toDecimalString(movimiento.importe),
              movimiento.sentido,
              movimiento.referencia,
              movimiento.saldoPosterior === null ? null : toDecimalString(movimiento.saldoPosterior),
              movimiento.crudo,
              huellaDeMovimiento(movimiento),
            ],
          );
        }

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'bank_statement.import',
          objectType: 'bank_statements',
          objectId: statementId,
          ip: clientIp(request),
          newValue: { movimientos: movimientos.length, errores: todosLosErrores.length },
        });

        const totales = totalesDelLote(movimientos, MONEDA);
        reply.code(201);
        return {
          extractoId: statementId,
          movimientos: movimientos.length,
          entradas: toDecimalString(totales.entradas),
          salidas: toDecimalString(totales.salidas),
          cadenaVerificada: cadena.verificable,
          ...(cadena.verificable
            ? {}
            : {
                aviso:
                  'El extracto no trae columna de saldo, así que la cadena no se pudo verificar. No es lo mismo que haberla verificado y que dé bien.',
              }),
          errores: todosLosErrores,
          repetidos: repetidosEnElLote(movimientos),
        };
      });
    },
  );

  /**
   * Propone la conciliación de un período. **No la guarda ni la confirma.**
   *
   * Es una lectura: se puede volver a pedir cuantas veces haga falta y siempre da
   * lo mismo sobre los mismos datos. Lo que se guarda es lo que una persona
   * confirma, en el endpoint de abajo.
   */
  app.post<{ Params: { bankAccountId: string } }>(
    '/banks/accounts/:bankAccountId/reconciliations/propose',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'bank:reconcile');
      const auth = requireAuth(request);
      const params = z.object({ bankAccountId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          saldoSegunExtracto: z.string().regex(/^-?\d+([.,]\d{1,2})?$/),
          ventanaDias: z.coerce.number().int().min(0).max(90).optional(),
        })
        .parse(request.body);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const cuenta = await cargarCuenta(tx, tenant.companyId, params.bankAccountId);
          if (cuenta === null) throw notFound('No existe esa cuenta bancaria en esta empresa');

          const movimientos = await cargarMovimientos(
            tx,
            tenant.companyId,
            params.bankAccountId,
            body.desde,
            body.hasta,
          );
          const lineas = await cargarLineas(
            tx,
            tenant.companyId,
            cuenta.accountId,
            body.desde,
            body.hasta,
          );
          const saldoLibro = await saldoContable(tx, tenant.companyId, cuenta.accountId, body.hasta);

          const acta = conciliar(
            {
              bankAccountId: params.bankAccountId,
              desde: parseCalendarDate(body.desde),
              hasta: parseCalendarDate(body.hasta),
              moneda: MONEDA,
              saldoSegunExtracto: moneyFromDecimalString(body.saldoSegunExtracto, MONEDA),
              saldoSegunLibro: saldoLibro,
              movimientos,
              lineas,
            },
            body.ventanaDias === undefined ? {} : { ventanaDias: body.ventanaDias },
          );

          return {
            desde: acta.desde,
            hasta: acta.hasta,
            saldoSegunExtracto: toDecimalString(acta.saldoSegunExtracto),
            saldoSegunLibro: toDecimalString(acta.saldoSegunLibro),
            ajusteNeto: toDecimalString(acta.ajusteNeto),
            saldoConciliado: toDecimalString(acta.saldoConciliado),
            cierra: acta.cierra,
            explicacion: acta.explicacion,
            cobertura: acta.cobertura,
            propuestas: acta.conciliados.map((propuesta) => ({
              tipo: propuesta.tipo,
              score: propuesta.score,
              movimientoIds: propuesta.movimientoIds,
              entryLineIds: propuesta.entryLineIds,
              importe: toDecimalString(propuesta.importe),
              senales: propuesta.senales,
            })),
            ambiguos: acta.ambiguos,
            diferencias: acta.diferencias.map((diferencia) => ({
              ...diferencia,
              importe: toDecimalString(diferencia.importe),
            })),
          };
        },
      );
    },
  );

  /**
   * Confirma **un** match.
   *
   * De a uno, y con el actor grabado. No existe un endpoint que confirme en lote:
   * el criterio de la fase es "0 conciliaciones confirmadas sin intervención
   * humana", y un botón de "aceptar todas" es exactamente cómo esa intervención
   * se vuelve un trámite (R-25).
   */
  app.post<{ Params: { reconciliationId: string } }>(
    '/banks/reconciliations/:reconciliationId/matches',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'bank:reconcile');
      const auth = requireAuth(request);
      const params = z.object({ reconciliationId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          bankTransactionId: z.string().uuid(),
          entryLineId: z.string().uuid(),
          matchType: z.enum(['EXACTO', 'APROXIMADO', 'AGRUPADO', 'MANUAL']),
          score: z.coerce.number().int().min(0).max(100),
          senales: z.array(z.unknown()).default([]),
        })
        .parse(request.body);
      const actorId = `user:${auth.user.userId}`;

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const guardado = await tx.query<{ id: string }>(
          `INSERT INTO bank_reconciliation_matches
             (company_id, reconciliation_id, bank_transaction_id, journal_entry_line_id,
              match_type, score, senales, confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
           RETURNING id`,
          [
            tenant.companyId,
            params.reconciliationId,
            body.bankTransactionId,
            body.entryLineId,
            body.matchType,
            body.score,
            JSON.stringify(body.senales),
            actorId,
          ],
        );

        await tx.query(
          `UPDATE bank_transactions SET status = 'CONCILIADO' WHERE id = $1 AND company_id = $2`,
          [body.bankTransactionId, tenant.companyId],
        );

        reply.code(201);
        return { matchId: guardado.rows[0]!.id, confirmadoPor: actorId };
      });
    },
  );

  /**
   * Confirma la conciliación.
   *
   * La base verifica dos cosas que esta capa no repite porque no haría falta y
   * repetirlas daría la impresión de que son opcionales: que no queden matches
   * sin revisar, y que el acta cierre.
   */
  app.post<{ Params: { reconciliationId: string } }>(
    '/banks/reconciliations/:reconciliationId/confirm',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'bank:confirm');
      const auth = requireAuth(request);
      const params = z.object({ reconciliationId: z.string().uuid() }).parse(request.params);
      const actorId = `user:${auth.user.userId}`;

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        try {
          await tx.query(
            `UPDATE bank_reconciliations
                SET status = 'CONFIRMADA', confirmed_by = $2, confirmed_at = now()
              WHERE id = $1 AND company_id = $3 AND status = 'BORRADOR'`,
            [params.reconciliationId, actorId, tenant.companyId],
          );
        } catch (error) {
          // El mensaje de la base ya explica qué falta y con qué artículo. Se
          // devuelve tal cual en vez de reescribirlo: dos redacciones del mismo
          // control se desincronizan.
          throw conflict(
            error instanceof Error ? error.message : 'No se pudo confirmar la conciliación',
          );
        }

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'bank_reconciliation.confirm',
          objectType: 'bank_reconciliations',
          objectId: params.reconciliationId,
          ip: clientIp(request),
          newValue: { status: 'CONFIRMADA' },
        });

        reply.code(200);
        return { reconciliationId: params.reconciliationId, status: 'CONFIRMADA' };
      });
    },
  );

  /** Del movimiento del banco hasta el comprobante, en un salto. */
  app.get<{ Params: { matchId: string } }>('/banks/trace/:matchId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'bank:read');
    const auth = requireAuth(request);
    const params = z.object({ matchId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT * FROM bank_trace WHERE match_id = $1 AND company_id = $2`,
          [params.matchId, tenant.companyId],
        );
        const fila = result.rows[0];
        if (fila === undefined) throw notFound('No existe ese match en esta empresa');
        return fila;
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Lectura del CSV — lo único de dominio que pasa por acá
// ---------------------------------------------------------------------------

/**
 * Separa un CSV en filas y columnas, respetando el entrecomillado.
 *
 * Es lo único que esta capa hace sobre el contenido: **no interpreta ninguna
 * celda**. Todas las decisiones —qué es una fecha, qué es un importe, de qué lado
 * está el movimiento— viven en el motor, con su mapeo declarado.
 *
 * Se aceptan CRLF y LF porque un extracto bajado de un homebanking viene de
 * cualquiera de los dos, y eso no es interpretar: es leer líneas.
 */
export function separarCsv(contenido: string, separador: string): string[][] {
  const filas: string[][] = [];
  let celda = '';
  let fila: string[] = [];
  let entreComillas = false;

  for (let i = 0; i < contenido.length; i += 1) {
    const caracter = contenido[i];
    if (entreComillas) {
      if (caracter === '"') {
        if (contenido[i + 1] === '"') {
          celda += '"';
          i += 1;
        } else {
          entreComillas = false;
        }
      } else {
        celda += caracter;
      }
      continue;
    }

    if (caracter === '"') entreComillas = true;
    else if (caracter === separador) {
      fila.push(celda);
      celda = '';
    } else if (caracter === '\n') {
      fila.push(celda);
      filas.push(fila);
      fila = [];
      celda = '';
    } else if (caracter !== '\r') {
      celda += caracter;
    }
  }

  if (celda !== '' || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }

  return filas;
}

// ---------------------------------------------------------------------------
// Carga desde la base
// ---------------------------------------------------------------------------

async function cargarLayout(
  tx: Tx,
  companyId: string,
  layoutId: string,
): Promise<{ mapeo: MapeoDeExtracto; separador: string } | null> {
  const result = await tx.query<{
    nombre: string;
    filas_encabezado: number;
    columna_fecha: number;
    columna_fecha_valor: number | null;
    columna_descripcion: number;
    columna_referencia: number | null;
    columna_saldo: number | null;
    esquema_signo: 'COLUMNAS_SEPARADAS' | 'COLUMNA_UNICA_CON_SIGNO';
    columna_debito: number | null;
    columna_credito: number | null;
    columna_importe: number | null;
    negativo_es_salida: boolean | null;
    formato_fecha: MapeoDeExtracto['formatoFecha'];
    formato_importe: MapeoDeExtracto['formatoImporte'];
    separador: string;
  }>(`SELECT * FROM bank_statement_layouts WHERE id = $1 AND company_id = $2`, [
    layoutId,
    companyId,
  ]);

  const fila = result.rows[0];
  if (fila === undefined) return null;

  // El constraint `layout_coherente` garantiza que las columnas del esquema
  // elegido no son nulas. Igual se comprueba: un `!` acá sería confiar en un
  // constraint desde el otro lado de la red.
  if (fila.esquema_signo === 'COLUMNAS_SEPARADAS') {
    if (fila.columna_debito === null || fila.columna_credito === null) {
      throw badRequest(`El mapeo "${fila.nombre}" está incompleto: faltan las columnas de importe.`);
    }
  } else if (fila.columna_importe === null || fila.negativo_es_salida === null) {
    throw badRequest(`El mapeo "${fila.nombre}" está incompleto: falta la columna de importe o su óptica.`);
  }

  return {
    separador: fila.separador,
    mapeo: {
      nombre: fila.nombre,
      filasDeEncabezado: fila.filas_encabezado,
      columnaFecha: fila.columna_fecha,
      columnaFechaValor: fila.columna_fecha_valor,
      columnaDescripcion: fila.columna_descripcion,
      columnaReferencia: fila.columna_referencia,
      columnaSaldo: fila.columna_saldo,
      signo:
        fila.esquema_signo === 'COLUMNAS_SEPARADAS'
          ? {
              tipo: 'COLUMNAS_SEPARADAS',
              debitoDelBanco: fila.columna_debito ?? 0,
              creditoDelBanco: fila.columna_credito ?? 0,
            }
          : {
              tipo: 'COLUMNA_UNICA_CON_SIGNO',
              importe: fila.columna_importe ?? 0,
              negativoEsSalida: fila.negativo_es_salida ?? true,
            },
      formatoFecha: fila.formato_fecha,
      formatoImporte: fila.formato_importe,
      moneda: MONEDA,
    },
  };
}

async function cargarCuenta(
  tx: Tx,
  companyId: string,
  bankAccountId: string,
): Promise<{ accountId: string } | null> {
  const result = await tx.query<{ account_id: string }>(
    `SELECT account_id FROM bank_accounts WHERE id = $1 AND company_id = $2`,
    [bankAccountId, companyId],
  );
  const fila = result.rows[0];
  return fila === undefined ? null : { accountId: fila.account_id };
}

async function cargarMovimientos(
  tx: Tx,
  companyId: string,
  bankAccountId: string,
  desde: string,
  hasta: string,
): Promise<MovimientoBancario[]> {
  const result = await tx.query<{
    id: string;
    fecha: string;
    fecha_valor: string | null;
    descripcion: string;
    importe: string;
    sentido: SentidoBancario;
    referencia: string | null;
    saldo_posterior: string | null;
    crudo: string;
  }>(
    `SELECT t.id, t.fecha::text, t.fecha_valor::text, t.descripcion, t.importe::text,
            t.sentido, t.referencia, t.saldo_posterior::text, t.crudo
       FROM bank_transactions t
       JOIN bank_statements s ON s.id = t.statement_id
      WHERE t.company_id = $1
        AND s.bank_account_id = $2
        AND t.fecha BETWEEN $3::date AND $4::date
        -- Los descartados no entran: alguien ya dijo por qué no van, con motivo.
        AND t.status <> 'DESCARTADO'
      ORDER BY t.fecha, t.id`,
    [companyId, bankAccountId, desde, hasta],
  );

  return result.rows.map((fila) => ({
    id: fila.id,
    fecha: parseCalendarDate(fila.fecha),
    fechaValor: fila.fecha_valor === null ? null : parseCalendarDate(fila.fecha_valor),
    descripcion: fila.descripcion,
    importe: moneyFromDecimalString(fila.importe, MONEDA),
    sentido: fila.sentido,
    referencia: fila.referencia,
    saldoPosterior:
      fila.saldo_posterior === null ? null : moneyFromDecimalString(fila.saldo_posterior, MONEDA),
    crudo: fila.crudo,
  }));
}

/**
 * Líneas del Mayor imputadas a la cuenta bancaria.
 *
 * `ENTRADA` cuando la línea es un débito contable: en la cuenta Banco, debitar es
 * que entre plata. La traducción se hace acá, en el `CASE`, para que el motor
 * reciba las dos puntas en la misma convención.
 */
async function cargarLineas(
  tx: Tx,
  companyId: string,
  accountId: string,
  desde: string,
  hasta: string,
): Promise<LineaConciliable[]> {
  const result = await tx.query<{
    id: string;
    entry_id: string;
    fecha: string;
    descripcion: string;
    importe: string;
    sentido: SentidoBancario;
    referencia: string | null;
    document_id: string | null;
    ya_conciliada: boolean;
  }>(
    `SELECT l.id, l.entry_id, e.entry_date::text AS fecha,
            COALESCE(l.description, e.description) AS descripcion,
            (CASE WHEN l.debit > 0 THEN l.debit ELSE l.credit END)::text AS importe,
            CASE WHEN l.debit > 0 THEN 'ENTRADA' ELSE 'SALIDA' END AS sentido,
            e.source_id::text AS referencia,
            d.id::text AS document_id,
            EXISTS (
              SELECT 1 FROM bank_reconciliation_matches m
                JOIN bank_reconciliations r ON r.id = m.reconciliation_id
               WHERE m.journal_entry_line_id = l.id AND r.status <> 'ANULADA'
            ) AS ya_conciliada
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN documents d ON d.id = e.source_id
                            AND e.source_type IN ('INVOICE', 'RECEIPT', 'BANK')
      WHERE l.company_id = $1
        AND l.account_id = $2
        AND e.status = 'APROBADO'
        AND e.entry_date BETWEEN $3::date AND $4::date
      ORDER BY e.entry_date, l.line_no`,
    [companyId, accountId, desde, hasta],
  );

  return result.rows.map((fila) => ({
    entryLineId: fila.id,
    entryId: fila.entry_id,
    fecha: parseCalendarDate(fila.fecha),
    descripcion: fila.descripcion,
    importe: moneyFromDecimalString(fila.importe, MONEDA),
    sentido: fila.sentido,
    referencia: fila.referencia,
    documentId: fila.document_id,
    yaConciliada: fila.ya_conciliada,
  }));
}

/**
 * Saldo contable de la cuenta banco al cierre del período.
 *
 * Sale del Diario, no de `account_balances`: es el mismo criterio que el Mayor de
 * FASE 7. Una conciliación que toma su saldo contable de una tabla derivada
 * hereda el error de esa tabla justo en el número que después se declara cerrado.
 */
async function saldoContable(
  tx: Tx,
  companyId: string,
  accountId: string,
  hasta: string,
): Promise<ReturnType<typeof moneyFromDecimalString>> {
  const result = await tx.query<{ saldo: string }>(
    `SELECT COALESCE(sum(l.debit) - sum(l.credit), 0)::text AS saldo
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.company_id = $1
        AND l.account_id = $2
        AND e.status IN ('APROBADO', 'ANULADO')
        AND e.entry_date <= $3::date`,
    [companyId, accountId, hasta],
  );
  return moneyFromDecimalString(result.rows[0]?.saldo ?? '0', MONEDA);
}
