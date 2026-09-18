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
  totalesPorTipo,
  verificarActa,
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
import { separarCsv } from '../csv.js';

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
   * Alta de una cuenta bancaria.
   *
   * **No existía.** `bank_accounts` no tenía un solo INSERT productivo: la
   * cuenta se creaba por SQL en los tests y en ningún otro lado, así que el
   * módulo de bancos entero —importar extractos, proponer conciliación,
   * confirmarla— empezaba en una fila que nadie podía crear. Es el mismo defecto
   * que tuvo `bank_reconciliations`, un escalón más abajo.
   *
   * Lo que sí decide este endpoint: **la cuenta contable es obligatoria**. Sin
   * ella no hay nada que conciliar, porque conciliar es comparar el extracto
   * contra el Mayor de esa cuenta. Y tiene que ser imputable: una cuenta de
   * agrupación no lleva movimientos.
   */
  app.post('/banks/accounts', async (request, reply) => {
    const tenant = await requireCompany(request);
    // El alta de una cuenta bancaria es configuración contable —fija contra qué
    // cuenta del Mayor se concilia—, no una tarea de tesorería.
    requirePermission(tenant, 'account:write');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const body = z
      .object({
        banco: z.string().min(1).max(120),
        /** Código de la cuenta contable que representa a este banco. */
        cuentaCodigo: z.string().min(1).max(40),
        // 22 dígitos. El dígito verificador NO se valida: el algoritmo sale de
        // una comunicación del BCRA que no está archivada, y validar contra un
        // algoritmo recordado de memoria es peor que no validar.
        cbu: z
          .string()
          .regex(/^\d{22}$/, 'El CBU son 22 dígitos')
          .nullable()
          .default(null),
        alias: z.string().min(1).max(60).nullable().default(null),
        numero: z.string().min(1).max(40).nullable().default(null),
        moneda: z.string().length(3).default(MONEDA),
      })
      .parse(request.body);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const cuenta = await tx.query<{
        id: string;
        is_postable: boolean;
        name: string;
        status: string;
      }>(
        'SELECT id, is_postable, name, status FROM accounts WHERE company_id = $1 AND code = $2',
        [tenant.companyId, body.cuentaCodigo],
      );
      if (cuenta.rowCount === 0) {
        throw notFound(`No existe la cuenta ${body.cuentaCodigo} en el plan de esta empresa`);
      }
      if (!cuenta.rows[0]!.is_postable) {
        throw badRequest(
          `La cuenta ${body.cuentaCodigo} es de agrupación y no admite movimientos. ` +
            'Una cuenta bancaria tiene que apuntar a una cuenta imputable: si no, no hay Mayor ' +
            'contra el cual conciliar.',
        );
      }
      // El candado equivalente está en la base desde la 0129. Acá se comprueba
      // igual para que el error sea este texto y no el del disparador.
      if (cuenta.rows[0]!.status !== 'ACTIVE') {
        throw badRequest(
          `La cuenta ${body.cuentaCodigo} está archivada, y archivarla fue decir que ya no se ` +
            'usa. Una conciliación abierta contra una cuenta dada de baja no se puede cerrar.',
        );
      }

      const existente = await tx.query<{ id: string; bank_name: string }>(
        'SELECT id, bank_name FROM bank_accounts WHERE company_id = $1 AND account_id = $2',
        [tenant.companyId, cuenta.rows[0]!.id],
      );
      if (Number(existente.rowCount) > 0) {
        // Dos cuentas bancarias sobre la misma cuenta contable serían dos actas
        // de conciliación sobre el mismo saldo del Mayor.
        throw conflict(
          `La cuenta ${body.cuentaCodigo} ya está asignada a "${existente.rows[0]!.bank_name}". ` +
            'Una cuenta contable representa a un solo banco.',
          { bankAccountId: existente.rows[0]!.id },
        );
      }

      const fila = await tx.query<{ id: string }>(
        `INSERT INTO bank_accounts
           (company_id, bank_name, cbu, alias, numero, currency, account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          tenant.companyId,
          body.banco,
          body.cbu,
          body.alias,
          body.numero,
          body.moneda,
          cuenta.rows[0]!.id,
        ],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'CREAR_CUENTA_BANCARIA',
        objectType: 'bank_accounts',
        objectId: fila.rows[0]!.id,
        ip: clientIp(request),
        newValue: { banco: body.banco, cuenta: body.cuentaCodigo, cbu: body.cbu },
      });

      reply.code(201);
      return {
        id: fila.rows[0]!.id,
        banco: body.banco,
        cuentaCodigo: body.cuentaCodigo,
        cuentaNombre: cuenta.rows[0]!.name,
        alcance:
          'La conciliación de esta cuenta compara el extracto contra el Mayor de ' +
          `${body.cuentaCodigo}. Cambiar de cuenta contable es dar de alta otra cuenta bancaria.`,
      };
    });
  });

  /** Los mapeos de extracto de la empresa, para poder elegir uno al importar. */
  app.get('/banks/statement-layouts', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'bank:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT l.id, l.nombre, l.bank_account_id AS "cuentaId", b.bank_name AS "banco",
                  l.filas_encabezado AS "filasEncabezado", l.esquema_signo AS "esquema",
                  l.formato_fecha AS "formatoFecha", l.formato_importe AS "formatoImporte",
                  l.separador, l.columna_saldo AS "columnaSaldo"
             FROM bank_statement_layouts l
             JOIN bank_accounts b ON b.id = l.bank_account_id
            WHERE l.company_id = $1
            ORDER BY b.bank_name, l.nombre`,
          [tenant.companyId],
        );
        return { mapeos: r.rows };
      },
    );
  });

  /**
   * Alta de un mapeo de extracto.
   *
   * El otro INSERT que faltaba: `POST /banks/accounts/:id/statements` pide un
   * `layoutId` que **no se podía obtener** —la tabla no tenía escritor—, así que
   * el camino de importación estaba cortado en su primer paso. Es el mismo
   * hallazgo que la conciliación sin INSERT, repetido un escalón más arriba.
   *
   * El mapeo se declara entero acá y no se adivina al importar: qué columna es
   * el débito y qué formato tiene la fecha lo sabe quien mira el archivo del
   * banco, y adivinarlo produce un extracto interpretado al revés que igual
   * "importa bien".
   */
  app.post('/banks/statement-layouts', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'bank:import');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;

    const columna = z.number().int().min(0).max(200);
    const body = z
      .object({
        bankAccountId: z.string().uuid(),
        nombre: z.string().min(1).max(80),
        filasEncabezado: z.number().int().min(0).max(50).default(1),
        columnaFecha: columna,
        columnaFechaValor: columna.nullable().default(null),
        columnaDescripcion: columna,
        columnaReferencia: columna.nullable().default(null),
        columnaSaldo: columna.nullable().default(null),
        formatoFecha: z.enum(['DD/MM/AAAA', 'DD-MM-AAAA', 'AAAA-MM-DD', 'DD/MM/AA']),
        formatoImporte: z.enum(['ES_AR', 'EN_US', 'PLANO']),
        separador: z.string().length(1).default(';'),
        // El esquema del banco: dos columnas, o una con signo. El constraint
        // `layout_coherente` exige que las columnas del esquema elegido estén,
        // y el discriminante hace que el pedido no se pueda escribir a medias.
        signo: z.discriminatedUnion('tipo', [
          z.object({
            tipo: z.literal('COLUMNAS_SEPARADAS'),
            columnaDebito: columna,
            columnaCredito: columna,
          }),
          z.object({
            tipo: z.literal('COLUMNA_UNICA_CON_SIGNO'),
            columnaImporte: columna,
            /** Si un importe negativo es plata que sale. Lo dice el banco, no el sistema. */
            negativoEsSalida: z.boolean(),
          }),
        ]),
      })
      .parse(request.body);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const cuenta = await cargarCuenta(tx, tenant.companyId, body.bankAccountId);
      if (cuenta === null) throw notFound('No existe esa cuenta bancaria en esta empresa');

      // El discriminante se estrecha una vez y se usa por rama: `separadas` como
      // booleano suelto no le dice nada al compilador sobre qué campos hay.
      const signo = body.signo;
      const columnas =
        signo.tipo === 'COLUMNAS_SEPARADAS'
          ? {
              debito: signo.columnaDebito,
              credito: signo.columnaCredito,
              importe: null,
              negativoEsSalida: null,
            }
          : {
              debito: null,
              credito: null,
              importe: signo.columnaImporte,
              negativoEsSalida: signo.negativoEsSalida,
            };
      const fila = await tx.query<{ id: string }>(
        `INSERT INTO bank_statement_layouts
           (company_id, bank_account_id, nombre, filas_encabezado, columna_fecha,
            columna_fecha_valor, columna_descripcion, columna_referencia, columna_saldo,
            esquema_signo, columna_debito, columna_credito, columna_importe, negativo_es_salida,
            formato_fecha, formato_importe, separador, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id`,
        [
          tenant.companyId,
          body.bankAccountId,
          body.nombre,
          body.filasEncabezado,
          body.columnaFecha,
          body.columnaFechaValor,
          body.columnaDescripcion,
          body.columnaReferencia,
          body.columnaSaldo,
          signo.tipo,
          columnas.debito,
          columnas.credito,
          columnas.importe,
          columnas.negativoEsSalida,
          body.formatoFecha,
          body.formatoImporte,
          body.separador,
          actorId,
        ],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'CREAR_MAPEO_DE_EXTRACTO',
        objectType: 'bank_statement_layouts',
        objectId: fila.rows[0]!.id,
        ip: clientIp(request),
        newValue: { nombre: body.nombre, esquema: signo.tipo },
      });

      reply.code(201);
      return {
        id: fila.rows[0]!.id,
        nombre: body.nombre,
        alcance:
          body.columnaSaldo === null
            ? 'Sin columna de saldo, la cadena de saldos del extracto no se va a poder ' +
              'verificar al importar. No es lo mismo que haberla verificado y que dé bien.'
            : 'Con columna de saldo: cada importación va a verificar que la cadena cierre.',
      };
    });
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
              movimiento.saldoPosterior === null
                ? null
                : toDecimalString(movimiento.saldoPosterior),
              movimiento.crudo,
              huellaDeMovimiento(movimiento),
            ],
          );
        }

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'IMPORTAR_EXTRACTO',
          objectType: 'bank_statements',
          objectId: statementId,
          ip: clientIp(request),
          newValue: {
            movimientos: movimientos.length,
            errores: todosLosErrores.length,
          },
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
          const saldoLibro = await saldoContable(
            tx,
            tenant.companyId,
            cuenta.accountId,
            body.hasta,
          );

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
  /**
   * Abrir la conciliación de un período.
   *
   * ## Por qué esta ruta no existía, y qué significaba
   *
   * `bank_reconciliations` no tenía **ni un solo INSERT** en toda la
   * aplicación: ni ruta, ni trigger. Se podían proponer coincidencias y
   * confirmarlas, pero no había forma de crear la conciliación que las
   * sostiene, así que ninguno de esos dos endpoints se podía usar. El test de
   * la fase la insertaba por SQL directo y la consola pedía el identificador
   * con un `prompt` que nadie podía contestar.
   *
   * Lo encontró la auditoría de selectores: un campo que pide un uuid sin
   * decir de dónde sacarlo casi siempre está tapando que no hay de dónde.
   *
   * ## El saldo del libro no se declara
   *
   * Sale del Mayor, sumando los movimientos de la cuenta hasta la fecha de
   * corte. Pedirlo dejaría dos respuestas para la misma pregunta, y el acta se
   * cerraría contra un número que alguien tipeó.
   *
   * El del extracto **sí** se declara: lo dice el banco, y este sistema no lo
   * puede derivar de nada.
   */
  app.post<{ Params: { bankAccountId: string } }>(
    '/banks/accounts/:bankAccountId/reconciliations',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'bank:reconcile');
      const auth = requireAuth(request);
      const params = z.object({ bankAccountId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          saldoExtracto: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
          // Las partidas conciliatorias, netas. Cero mientras no se releven:
          // el acta no cierra hasta que extracto + ajustes = libro, y eso lo
          // comprueba la base al confirmar.
          ajusteNeto: z
            .string()
            .regex(/^-?\d+(\.\d{1,2})?$/)
            .default('0'),
        })
        .parse(request.body);

      const actorId = `user:${auth.user.userId}`;

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const cuenta = await tx.query<{ account_id: string }>(
          'SELECT account_id FROM bank_accounts WHERE id = $1 AND company_id = $2',
          [params.bankAccountId, tenant.companyId],
        );
        if (cuenta.rowCount === 0) throw notFound('Cuenta bancaria no encontrada');

        // El período que contiene la fecha de corte. Sin él no hay dónde
        // colgar la conciliación, y la unicidad por cuenta y período es la que
        // impide dos actas del mismo mes.
        const periodo = await tx.query<{ id: string }>(
          `SELECT id FROM periods
            WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`,
          [tenant.companyId, body.hasta],
        );
        if (periodo.rowCount === 0) {
          throw conflict(
            `No hay ningún período que contenga el ${body.hasta}. La conciliación vive en ` +
              'un período: sin él no se puede abrir.',
          );
        }

        // El saldo del libro, derivado. `debit - credit` es el saldo de una
        // cuenta de activo, que es lo que una cuenta bancaria es.
        const libro = await tx.query<{ saldo: string }>(
          `SELECT coalesce(sum(lm.debit - lm.credit), 0)::text AS saldo
             FROM ledger_movements lm
            WHERE lm.company_id = $1 AND lm.account_id = $2 AND lm.movement_date <= $3::date`,
          [tenant.companyId, cuenta.rows[0]!.account_id, body.hasta],
        );

        try {
          const r = await tx.query<{ id: string }>(
            `INSERT INTO bank_reconciliations
               (company_id, bank_account_id, period_id, desde, hasta,
                saldo_extracto, saldo_libro, ajuste_neto, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              tenant.companyId,
              params.bankAccountId,
              periodo.rows[0]!.id,
              body.desde,
              body.hasta,
              body.saldoExtracto,
              libro.rows[0]!.saldo,
              body.ajusteNeto,
              actorId,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId,
            action: 'ABRIR_CONCILIACION',
            objectType: 'bank_reconciliations',
            objectId: r.rows[0]!.id,
            newValue: {
              desde: body.desde,
              hasta: body.hasta,
              saldoExtracto: body.saldoExtracto,
              saldoLibro: libro.rows[0]!.saldo,
            },
            motivo: 'Apertura de la conciliación del período',
            ip: clientIp(request),
          });

          reply.code(201);
          return {
            reconciliationId: r.rows[0]!.id,
            saldoLibro: libro.rows[0]!.saldo,
            alcance:
              'El saldo del libro sale del Mayor y no se declara: pedirlo dejaría dos ' +
              'respuestas para la misma pregunta. El acta cierra cuando ' +
              '`saldoExtracto + ajusteNeto = saldoLibro`, y eso lo comprueba la base al ' +
              'confirmar.',
          };
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw conflict(
              'Esa cuenta ya tiene una conciliación de ese período. Dos actas confirmadas ' +
                'del mismo mes son dos verdades distintas sobre el mismo saldo.',
            );
          }
          throw error;
        }
      });
    },
  );

  /** Las conciliaciones de la empresa, para poder elegir una. */
  /**
   * Vuelve a hacer la cuenta de una conciliación ya confirmada.
   *
   * Una conciliación guardada es un dato derivado, y un dato derivado que nadie
   * vuelve a verificar se desincroniza en silencio: alcanza con un asiento nuevo
   * en el período, un extracto reimportado o una línea anulada. Es el mismo
   * principio que `ledger:verify` sobre el Mayor y que la comprobación del
   * promedio contra su derivación (ADR-022).
   *
   * El motor tenía la verificación escrita —`verificarActa` en
   * `@aai/bank-engine`— y **no la llamaba nadie**: la encontró el barrido S-16.
   * Una verificación que no corre no verifica nada.
   */
  app.get<{ Params: { reconciliationId: string } }>(
    '/banks/reconciliations/:reconciliationId/verificar',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'bank:read');
      const auth = requireAuth(request);
      const params = z.object({ reconciliationId: z.string().uuid() }).parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const guardada = await tx.query<{
            bank_account_id: string;
            status: string;
            desde: string;
            hasta: string;
            saldo_extracto: string;
            saldo_libro: string;
            ajuste_neto: string;
          }>(
            `SELECT bank_account_id, status, desde::text, hasta::text,
                    saldo_extracto::text, saldo_libro::text, ajuste_neto::text
               FROM bank_reconciliations
              WHERE id = $1 AND company_id = $2`,
            [params.reconciliationId, tenant.companyId],
          );
          if (guardada.rowCount === 0) throw notFound('No existe esa conciliación en esta empresa');
          const r = guardada.rows[0]!;

          const cuenta = await cargarCuenta(tx, tenant.companyId, r.bank_account_id);
          if (cuenta === null) throw notFound('La cuenta bancaria ya no existe');

          const movimientos = await cargarMovimientos(
            tx,
            tenant.companyId,
            r.bank_account_id,
            r.desde,
            r.hasta,
          );
          const lineas = await cargarLineas(
            tx,
            tenant.companyId,
            cuenta.accountId,
            r.desde,
            r.hasta,
          );
          const saldoLibro = await saldoContable(tx, tenant.companyId, cuenta.accountId, r.hasta);

          const acta = conciliar({
            bankAccountId: r.bank_account_id,
            desde: parseCalendarDate(r.desde),
            hasta: parseCalendarDate(r.hasta),
            moneda: MONEDA,
            saldoSegunExtracto: moneyFromDecimalString(r.saldo_extracto, MONEDA),
            saldoSegunLibro: saldoLibro,
            movimientos,
            lineas,
          });

          // Rehacer la cuenta sin extracto importado no verifica nada: sin el
          // lado del banco, **cada** línea del Mayor parece una partida
          // conciliatoria, y el veredicto diría "algo cambió" sin que haya
          // cambiado nada. Peor todavía: la comparación quedaría entre dos
          // números guardados, que por definición siempre dan lo mismo.
          //
          // Cuando no hay contra qué rehacerla, la respuesta es "no se puede
          // afirmar" —no `false`, y mucho menos `true`—.
          const extractos = await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n
               FROM bank_statements
              WHERE company_id = $1 AND bank_account_id = $2
                AND desde <= $4::date AND hasta >= $3::date`,
            [tenant.companyId, r.bank_account_id, r.desde, r.hasta],
          );
          const verificable = (extractos.rows[0]?.n ?? 0) > 0;

          // Se compara contra el saldo de libro **guardado**: el acta cierra
          // cuando el conciliado coincide con él, y si el libro cambió después
          // de confirmar, eso es exactamente lo que hay que detectar.
          const veredicto = verificable
            ? verificarActa(acta, moneyFromDecimalString(r.saldo_libro, MONEDA))
            : {
                coincide: null,
                detalle:
                  'No se importó ningún extracto que cubra el período de esta conciliación, ' +
                  'así que no hay contra qué rehacer la cuenta. Esto no dice que la ' +
                  'conciliación esté mal: dice que no se puede verificar.',
              };
          const totales = totalesPorTipo(acta, MONEDA);

          return {
            estado: r.status,
            verificable,
            coincide: veredicto.coincide,
            detalle: veredicto.detalle,
            guardado: {
              saldoExtracto: r.saldo_extracto,
              saldoLibro: r.saldo_libro,
              ajusteNeto: r.ajuste_neto,
            },
            // Sin extracto no hay recálculo que mostrar: las partidas que
            // saldrían de ahí son un artefacto de que falta un lado, y una
            // pantalla que las muestre estaría mostrando datos inventados.
            recalculado: verificable
              ? {
                  saldoConciliado: toDecimalString(acta.saldoConciliado),
                  saldoSegunLibro: toDecimalString(acta.saldoSegunLibro),
                  ajusteNeto: toDecimalString(acta.ajusteNeto),
                  cierra: acta.cierra,
                }
              : null,
            partidasConciliatorias: verificable
              ? {
                  enBancoNoEnLibro: toDecimalString(totales.enBancoNoEnLibro),
                  enLibroNoEnBanco: toDecimalString(totales.enLibroNoEnBanco),
                }
              : null,
            alcance:
              'Se rehace la conciliación desde los movimientos del extracto y las líneas del ' +
              'Mayor de hoy, y se compara contra lo que quedó guardado al confirmarla. Que no ' +
              'coincida no significa que esté mal: significa que algo cambió después, y dice ' +
              'qué mirar. Si nunca se importó un extracto del período, no se puede verificar y ' +
              'la respuesta lo dice en vez de suponer.',
          };
        },
      );
    },
  );

  app.get('/banks/reconciliations', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'bank:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        status: z.enum(['BORRADOR', 'CONFIRMADA', 'ANULADA']).optional(),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT r.id, r.status, r.desde::text, r.hasta::text,
                  r.saldo_extracto::text AS "saldoExtracto",
                  r.saldo_libro::text AS "saldoLibro",
                  r.ajuste_neto::text AS "ajusteNeto",
                  (r.saldo_extracto + r.ajuste_neto - r.saldo_libro)::text AS "diferencia",
                  b.bank_name AS banco, b.id AS "cuentaId",
                  (SELECT count(*)::int FROM bank_reconciliation_matches m
                    WHERE m.reconciliation_id = r.id) AS coincidencias
             FROM bank_reconciliations r
             JOIN bank_accounts b ON b.id = r.bank_account_id AND b.company_id = r.company_id
            WHERE r.company_id = $1 AND ($2::text IS NULL OR r.status = $2)
            ORDER BY r.hasta DESC
            LIMIT 100`,
          [tenant.companyId, query.status ?? null],
        );

        return {
          conciliaciones: r.rows,
          alcance:
            '`diferencia` es lo que todavía no cierra: extracto más ajustes menos libro. ' +
            'Mientras no sea cero la base no deja confirmar, y eso es el acta.',
        };
      },
    );
  });

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
          action: 'CONFIRMAR_CONCILIACION',
          objectType: 'bank_reconciliations',
          objectId: params.reconciliationId,
          ip: clientIp(request),
          newValue: { status: 'CONFIRMADA' },
        });

        reply.code(200);
        return {
          reconciliationId: params.reconciliationId,
          status: 'CONFIRMADA',
        };
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
      throw badRequest(
        `El mapeo "${fila.nombre}" está incompleto: faltan las columnas de importe.`,
      );
    }
  } else if (fila.columna_importe === null || fila.negativo_es_salida === null) {
    throw badRequest(
      `El mapeo "${fila.nombre}" está incompleto: falta la columna de importe o su óptica.`,
    );
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
