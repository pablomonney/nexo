/**
 * Libros: Diario, Mayor, emisión con hash y verificación de la proyección.
 *
 * Todo lo que decide algo está en `@aai/accounting-engine`. Este archivo lee la
 * base, arma los objetos que el motor espera y devuelve lo que el motor dijo.
 * Ninguna regla contable ni ninguna formalidad del CCyC se decide acá — si
 * apareciera un `if` sobre numeración o sobre fechas en este archivo, estaría en
 * el lugar equivocado.
 *
 * El único endpoint que escribe es la emisión, y lo que escribe es un hecho —
 * "se emitió esto, con este hash, esta persona, este día"—, no contabilidad.
 */

import {
  asientosDelDiario,
  balanceDesdeMayor,
  construirLibroDiario,
  construirLibroMayor,
  exportarDiarioCsv,
  exportarMayorCsv,
  hashDeLibro,
  pieDeLibro,
  resumenCoincideConDetalle,
  resumirPorMes,
  saldosPorNaturaleza,
  verificarProyeccion,
  type AsientoDelLibro,
  type AsientoResumido,
  type SubdiarioDeclarado,
  type CuentaParaElMayor,
  type EntryStatus,
  type LibroDiario,
  type LibroMayor,
  type LineaDelLibro,
  type MovimientoMaterializado,
  type SaldoDeApertura,
} from '@aai/accounting-engine';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  calendarDate,
  daysInMonth,
  moneyFromDecimalString,
  parseCalendarDate,
  toDecimalString,
  type CalendarDate,
  type Currency,
  type Money,
} from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, notFound } from '../http/errors.js';
import { declararSubdiario } from '../tax/subdiario.js';

const rangoSchema = z.object({
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ejercicio: z.string().uuid().optional(),
  asientosPorFolio: z.coerce.number().int().min(1).max(500).optional(),
});

export async function bookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Libro Diario del rango, con sus controles de forma.
   *
   * Devuelve `cumpleFormalidades` en la raíz, no escondido entre los controles:
   * quien consume esta respuesta tiene que tropezarse con el dato, no buscarlo.
   */
  app.get('/books/diario', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = rangoSchema.parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const contexto = await resolverContexto(tx, tenant.companyId, query);
        const libro = construirLibroDiario(contexto.asientos, contexto.opcionesDiario);
        return respuestaDiario(libro);
      },
    );
  });

  app.get('/books/diario.csv', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = rangoSchema.parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const contexto = await resolverContexto(tx, tenant.companyId, query);
        const libro = construirLibroDiario(contexto.asientos, contexto.opcionesDiario);
        const csv = exportarDiarioCsv(libro);

        // El hash viaja en un header para que quien descarga pueda verificar el
        // archivo sin volver a pedirlo, y para que coincida con el de la emisión.
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="diario-${query.desde}-a-${query.hasta}.csv"`,
          )
          .header('x-content-sha256', hashDeLibro(csv))
          .header('x-cumple-formalidades', String(libro.cumpleFormalidades))
          .send(csv);
      },
    );
  });

  /**
   * Libro Mayor del rango.
   *
   * Los saldos iniciales se calculan desde el Diario anterior al rango, no se
   * leen de `account_balances`: si esa tabla estuviera desactualizada, el Mayor
   * heredaría el error justamente en el número que después se usa para
   * verificarla.
   */
  app.get('/books/mayor', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = rangoSchema
      .extend({ cuenta: z.string().max(40).optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const contexto = await resolverContexto(tx, tenant.companyId, query);
        const mayor = mayorDelRango(contexto);
        const cuentas =
          query.cuenta === undefined
            ? mayor.cuentas
            : mayor.cuentas.filter((cuenta) => cuenta.accountCode === query.cuenta);

        if (query.cuenta !== undefined && cuentas.length === 0) {
          throw notFound(`La cuenta ${query.cuenta} no tiene movimientos en el rango`);
        }

        // Las sumas por naturaleza salen del Mayor **completo**, no del
        // filtrado: son el control cruzado contra el balance de sumas y saldos,
        // y la suma de tres cuentas elegidas no cruza contra nada. Cuando se
        // pidió una cuenta sola, el campo dice `null` — que es "no se puede
        // afirmar", no cero.
        return respuestaMayor(
          { ...mayor, cuentas },
          query.cuenta === undefined ? saldosPorNaturaleza(mayor) : null,
        );
      },
    );
  });

  app.get('/books/mayor.csv', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = rangoSchema.parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const contexto = await resolverContexto(tx, tenant.companyId, query);
        const csv = exportarMayorCsv(mayorDelRango(contexto));

        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="mayor-${query.desde}-a-${query.hasta}.csv"`,
          )
          .header('x-content-sha256', hashDeLibro(csv))
          .send(csv);
      },
    );
  });

  /**
   * Diario resumido del mes (CCyC art. 327).
   *
   * El artículo permite que el Diario lleve un asiento resumido por mes **si el
   * resumen surge de anotaciones detalladas practicadas en subdiarios**. Las dos
   * condiciones se verifican acá, y ninguna se da por cumplida:
   *
   *   1. **El subdiario existe y está emitido.** Sale de `vat_books`: si el
   *      período no se generó, no hay registro detallado del que surja nada.
   *   2. **Es el mismo subdiario.** El subdiario se vuelve a armar hoy y su
   *      hash se compara con el que quedó archivado al generar el libro. Si el
   *      detalle cambió después, el resumen ya no surge de él — y esa es
   *      exactamente la afirmación que el artículo pide poder verificar
   *      (ADR-021: un documento cita el hecho; no lo genera).
   *
   * Lo que no tiene subdiario no se resume: va al Diario detallado, que siempre
   * es legal. Resumir sin subdiario, no.
   */
  app.get('/books/diario-resumido', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const query = z
      .object({
        anio: z.coerce.number().int().min(2000).max(2100),
        mes: z.coerce.number().int().min(1).max(12),
        ejercicio: z.string().uuid().optional(),
      })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const desde = calendarDate(query.anio, query.mes, 1);
        const hasta = calendarDate(query.anio, query.mes, daysInMonth(query.anio, query.mes));

        const contexto = await resolverContexto(tx, tenant.companyId, {
          desde,
          hasta,
          ...(query.ejercicio === undefined ? {} : { ejercicio: query.ejercicio }),
        });
        const asientos = asientosDelDiario(
          construirLibroDiario(contexto.asientos, contexto.opcionesDiario),
        );

        const resumibles = asientos.filter((asiento) => esResumible(asiento.journalCode));
        const detallados = asientos.filter((asiento) => !esResumible(asiento.journalCode));

        const { declarados, observaciones } = await declaracionesDelMes(
          tx,
          tenant.companyId,
          query.anio,
          query.mes,
          new Set(resumibles.map((asiento) => asiento.journalCode)),
        );

        const armado = resumirPorMes(resumibles, declarados, contexto.opcionesMayor.moneda);

        return {
          periodo: `${String(query.anio)}-${String(query.mes).padStart(2, '0')}`,
          desde,
          hasta,
          moneda: contexto.opcionesMayor.moneda,
          resumible: armado.ok && observaciones.length === 0,
          resumidos: armado.ok
            ? armado.value.map((resumen) => serializarResumen(resumen, asientos))
            : [],
          // Los rechazos del motor y los del archivo van juntos: quien cierra el
          // mes necesita ver de una vez todo lo que le falta, no descubrirlo de
          // a uno.
          rechazos: [
            ...observaciones,
            ...(armado.ok
              ? []
              : armado.error.map((rechazo) => ({
                  motivo: rechazo.motivo,
                  journalCode: rechazo.journalCode,
                  detalle: rechazo.detalle,
                  fundamento: rechazo.fundamento,
                }))),
          ],
          // Lo que va detallado no es un problema: es el Diario normal.
          detallados: {
            asientos: detallados.length,
            libros: [...new Set(detallados.map((asiento) => asiento.journalCode))].sort(),
          },
          alcance:
            'Un asiento resumido reemplaza en el Diario a los asientos del mes de ese subdiario. ' +
            'Este endpoint arma el resumen y lo verifica contra el detalle; no lo registra: ' +
            'registrar el resumen es un acto con firma y va por el único escritor del Mayor.',
        };
      },
    );
  });

  /**
   * Verifica que el Mayor materializado coincida con el Diario.
   *
   * Es el control que `ACCOUNTING_ENGINE.md` §7 promete. Corre a pedido, en el
   * cierre y en CI. El resultado queda archivado con fecha y nombre: una
   * verificación que no deja rastro no sirve para demostrar nada después.
   *
   * Cuando discrepa, la respuesta es 200 con `coincide: false`, no un 500. La
   * verificación funcionó — lo que falló es el Mayor, y ese es exactamente el
   * hallazgo que se pidió.
   */
  /**
   * Verificar el Mayor contra el Diario, y dejar constancia.
   *
   * Exige `ledger:verify` y no `report:read`. La diferencia no es formal: esta
   * ruta **escribe** una fila en `ledger_verifications` con `ran_by`, o sea una
   * constancia firmada de que alguien comparó los libros. Con el permiso de
   * lectura, SOLO_LECTURA y USUARIO_EMPRESA podían dejar esa constancia con su
   * nombre. Es la única frontera que los cincuenta permisos anteriores no
   * expresaban: entre mirar un reporte y firmar una verificación.
   */
  app.post('/books/ledger-verification', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'ledger:verify');
    const auth = requireAuth(request);
    const query = rangoSchema.parse(request.body ?? request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const contexto = await resolverContexto(tx, tenant.companyId, query);

        const mayor = mayorDelRango(contexto);
        const materializado = await tx.query<{
          entry_line_id: string;
          account_id: string;
          movement_date: string;
          debit: string;
          credit: string;
        }>(
          `SELECT m.entry_line_id, m.account_id, m.movement_date::text, m.debit::text, m.credit::text
             FROM ledger_movements m
            WHERE m.company_id = $1
              AND m.movement_date BETWEEN $2::date AND $3::date`,
          [tenant.companyId, query.desde, query.hasta],
        );

        const filas: MovimientoMaterializado[] = materializado.rows.map((fila) => ({
          entryLineId: fila.entry_line_id,
          accountId: fila.account_id,
          fecha: parseCalendarDate(fila.movement_date),
          debe: moneyFromDecimalString(fila.debit, contexto.moneda),
          haber: moneyFromDecimalString(fila.credit, contexto.moneda),
        }));

        const resultado = verificarProyeccion(mayor, filas);

        await tx.query(
          `INSERT INTO ledger_verifications
             (company_id, fiscal_year_id, ran_by, movimientos, discrepancias, detalle, resultado)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            tenant.companyId,
            contexto.fiscalYearId,
            `user:${auth.user.userId}`,
            resultado.movimientos,
            resultado.discrepancias.length,
            JSON.stringify(resultado.discrepancias),
            resultado.coincide ? 'COINCIDE' : 'DISCREPA',
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'VERIFICAR_MAYOR',
          objectType: 'ledger_verifications',
          objectId: contexto.fiscalYearId,
          ip: clientIp(request),
          newValue: {
            desde: query.desde,
            hasta: query.hasta,
            movimientos: resultado.movimientos,
            resultado: resultado.coincide ? 'COINCIDE' : 'DISCREPA',
          },
        });

        return {
          desde: query.desde,
          hasta: query.hasta,
          movimientos: resultado.movimientos,
          coincide: resultado.coincide,
          discrepancias: resultado.discrepancias,
          ...(resultado.coincide
            ? {}
            : {
                aviso:
                  'El Mayor no coincide con el Diario. Vale el Diario: es el libro con eficacia ' +
                  'probatoria (CCyC art. 330) y el Mayor es su proyección. Reconstruí el Mayor ' +
                  'antes de emitir cualquier estado.',
              }),
        };
      },
    );
  });

  /**
   * Emite un libro y registra la emisión con su hash.
   *
   * Emitir es un acto del profesional: exige `book:emit`, que solo tiene el
   * Contador. Un libro con formalidades incumplidas **se emite igual** —negarse
   * dejaría a la empresa sin poder ver el problema— pero las observaciones
   * quedan grabadas en la emisión, así que después no se puede decir que no se
   * sabía.
   */
  app.post('/books/emissions', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'book:emit');
    const auth = requireAuth(request);
    const body = rangoSchema
      .extend({
        libro: z.enum(['DIARIO', 'MAYOR']),
        autorizacionRegistro: z.string().max(200).optional(),
      })
      .parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const contexto = await resolverContexto(tx, tenant.companyId, body);

        const diario = construirLibroDiario(contexto.asientos, contexto.opcionesDiario);
        const contenido =
          body.libro === 'DIARIO'
            ? exportarDiarioCsv(diario)
            : exportarMayorCsv(mayorDelRango(contexto));
        const sha256 = hashDeLibro(contenido);

        const emision = await tx.query<{ id: string }>(
          `INSERT INTO book_emissions
             (company_id, fiscal_year_id, book, desde, hasta, content_sha256, asientos,
              controles, cumple_formalidades, autorizacion_registro, emitted_by)
           VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8::jsonb, $9, $10, $11)
           RETURNING id`,
          [
            tenant.companyId,
            contexto.fiscalYearId,
            body.libro,
            body.desde,
            body.hasta,
            sha256,
            diario.asientos,
            JSON.stringify(diario.controles),
            diario.cumpleFormalidades,
            body.autorizacionRegistro ?? null,
            `user:${auth.user.userId}`,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'book.emit',
          objectType: 'book_emissions',
          objectId: emision.rows[0]!.id,
          ip: clientIp(request),
          newValue: {
            libro: body.libro,
            sha256,
            cumpleFormalidades: diario.cumpleFormalidades,
          },
        });

        reply.code(201);
        return {
          emisionId: emision.rows[0]!.id,
          libro: body.libro,
          sha256,
          asientos: diario.asientos,
          cumpleFormalidades: diario.cumpleFormalidades,
          pie: pieDeLibro(diario, contenido, body.autorizacionRegistro ?? null),
        };
      },
    );
  });

  app.get('/books/emissions', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT id, book AS "libro", desde, hasta, content_sha256 AS "sha256",
                  asientos, cumple_formalidades AS "cumpleFormalidades",
                  autorizacion_registro AS "autorizacionRegistro",
                  emitted_by AS "emitidoPor", emitted_at AS "emitidoEl"
             FROM book_emissions
            WHERE company_id = $1
            ORDER BY emitted_at DESC
            LIMIT 100`,
          [tenant.companyId],
        );
        return { emisiones: result.rows };
      },
    );
  });

  /**
   * De un movimiento del Mayor hasta el documento original, en un salto.
   *
   * Es el punto 8 del MVP: *tomar cualquier número, hacer clic, y llegar al PDF
   * original*. La vista `ledger_trace` de la migración 0019 es ese camino; acá
   * solo se lo expone.
   */
  app.get<{ Params: { movementId: string } }>('/books/trace/:movementId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'report:read');
    const auth = requireAuth(request);
    const params = z.object({ movementId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT * FROM ledger_trace WHERE movement_id = $1 AND company_id = $2`,
          [params.movementId, tenant.companyId],
        );
        const fila = result.rows[0];
        if (fila === undefined) {
          throw notFound('No existe ese movimiento en el Mayor de esta empresa');
        }
        return fila;
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Carga del Diario desde la base
// ---------------------------------------------------------------------------

interface ContextoDeLibros {
  readonly asientos: readonly AsientoDelLibro[];
  readonly moneda: Currency;
  readonly fiscalYearId: string;
  readonly opcionesDiario: Parameters<typeof construirLibroDiario>[1];
  readonly opcionesMayor: Parameters<typeof construirLibroMayor>[1];
}

/**
 * El Mayor del rango, armado sobre los asientos que quedaron en el Diario.
 *
 * Nunca sobre `contexto.asientos`, que es la lista cruda de la base y trae los
 * BORRADOR y PROPUESTO. Ese era el error: `construirLibroMayor` filtra por
 * cuenta y por fecha pero **no por estado** —confía en que quien llama ya le
 * pasó los registrables, como dice su encabezado— y acá se le pasaba todo. El
 * Mayor mostraba asientos que nadie aprobó, `/books/ledger-verification` los
 * denunciaba como sobrantes contra `ledger_movements` —que sí filtra— y el
 * control quedaba informando una discrepancia que no era del Mayor sino de esta
 * llamada.
 *
 * Que sea una sola función y no cuatro llamadas es parte del arreglo: mientras
 * la forma correcta y la incorrecta se escribían igual de fácil, el próximo
 * endpoint iba a volver a elegir mal.
 */
/**
 * Los libros que pueden llevar asiento resumido.
 *
 * Son los que tienen un subdiario del que el resumen pueda surgir. `GENERAL` no
 * está y no es un olvido: un asiento manual no tiene registro auxiliar detrás,
 * así que va al Diario tal como se cargó.
 */
const LIBROS_CON_SUBDIARIO = ['COMPRAS', 'VENTAS'] as const;

function esResumible(journalCode: string): boolean {
  return (LIBROS_CON_SUBDIARIO as readonly string[]).includes(journalCode);
}

/**
 * Las declaraciones de subdiario del mes, verificadas contra lo archivado.
 *
 * Devuelve solo las que se pudieron verificar. Las que no, salen como
 * observación con el motivo: un subdiario que no se puede verificar no es un
 * subdiario declarado, y tratarlo como si lo fuera es exactamente lo que el art.
 * 327 no permite.
 */
async function declaracionesDelMes(
  tx: Tx,
  companyId: string,
  anio: number,
  mes: number,
  presentes: ReadonlySet<string>,
): Promise<{
  declarados: SubdiarioDeclarado[];
  observaciones: {
    motivo: string;
    journalCode: string;
    detalle: string;
    fundamento: string;
  }[];
}> {
  const declarados: SubdiarioDeclarado[] = [];
  const observaciones: {
    motivo: string;
    journalCode: string;
    detalle: string;
    fundamento: string;
  }[] = [];

  const libro = await tx.query<{
    status: string;
    compras_sha256: string | null;
    ventas_sha256: string | null;
  }>(
    `SELECT status, compras_sha256, ventas_sha256
       FROM vat_books WHERE company_id = $1 AND anio = $2 AND mes = $3`,
    [companyId, anio, mes],
  );
  const fila = libro.rows[0];

  for (const direccion of LIBROS_CON_SUBDIARIO) {
    if (!presentes.has(direccion)) continue;

    if (fila === undefined || fila.status === 'PENDIENTE') {
      observaciones.push({
        motivo: 'SUBDIARIO_NO_EMITIDO',
        journalCode: direccion,
        detalle:
          `El Libro de IVA de ${String(anio)}-${String(mes).padStart(2, '0')} no está generado, ` +
          `así que no hay subdiario de ${direccion} emitido del que el resumen pueda surgir. ` +
          'Generá el libro del período o registrá el Diario en detalle.',
        fundamento: FUNDAMENTO_327,
      });
      continue;
    }

    const archivado = direccion === 'COMPRAS' ? fila.compras_sha256 : fila.ventas_sha256;
    const firmado = await declararSubdiario(tx, companyId, direccion, anio, mes);

    if (archivado === null) {
      observaciones.push({
        motivo: 'SUBDIARIO_SIN_HASH_ARCHIVADO',
        journalCode: direccion,
        detalle:
          `El libro del período se generó antes de que el sistema archivara el hash del ` +
          `subdiario de ${direccion}, así que no hay contra qué verificar que el detalle sea ` +
          'el mismo. Volvé a generar el libro del período.',
        fundamento: FUNDAMENTO_327,
      });
      continue;
    }

    if (archivado !== firmado.sha256) {
      observaciones.push({
        motivo: 'SUBDIARIO_CAMBIO_DESPUES_DE_EMITIDO',
        journalCode: direccion,
        detalle:
          `El subdiario de ${direccion} rehecho hoy no da el mismo archivo que el que se ` +
          `archivó al generar el libro (${archivado.slice(0, 12)}… contra ` +
          `${firmado.sha256.slice(0, 12)}…). Algo cambió después: un comprobante nuevo, uno ` +
          'anulado o una alícuota reidentificada. El resumen ya no surge de lo que se emitió.',
        fundamento: FUNDAMENTO_327,
      });
      continue;
    }

    declarados.push(firmado.declarado);
  }

  return { declarados, observaciones };
}

const FUNDAMENTO_327 =
  'CCyC art. 327 — los resúmenes no pueden cubrir más de un mes y deben surgir de anotaciones detalladas practicadas en subdiarios';

function serializarResumen(resumen: AsientoResumido, detalle: readonly AsientoDelLibro[]): unknown {
  // El control que `resumenCoincideConDetalle` promete. Corre siempre y viaja en
  // la respuesta: una verificación que no se muestra no la mira nadie.
  const coincide = resumenCoincideConDetalle(resumen, detalle);

  return {
    journalCode: resumen.journalCode,
    fecha: resumen.fecha,
    descripcion: resumen.descripcion,
    totalDebe: toDecimalString(resumen.totalDebe),
    totalHaber: toDecimalString(resumen.totalHaber),
    operaciones: resumen.asientosResumidos.length,
    asientosResumidos: resumen.asientosResumidos,
    subdiario: {
      nombre: resumen.subdiario.nombre,
      desde: resumen.subdiario.desde,
      hasta: resumen.subdiario.hasta,
      referencia: resumen.subdiario.referencia,
    },
    lineas: resumen.lineas.map((linea) => ({
      cuentaId: linea.accountId,
      codigo: linea.accountCode,
      nombre: linea.accountName,
      debe: toDecimalString(linea.debe),
      haber: toDecimalString(linea.haber),
      operaciones: linea.operaciones,
    })),
    verificacion: {
      coincide,
      detalle: coincide
        ? 'El resumen suma exactamente lo mismo que los asientos que condensó.'
        : 'El resumen NO suma lo mismo que el detalle que dice condensar. No lo registres: ' +
          'es un error del armado, no del mes.',
    },
  };
}

function mayorDelRango(contexto: ContextoDeLibros): LibroMayor {
  const diario = construirLibroDiario(contexto.asientos, contexto.opcionesDiario);
  return construirLibroMayor(asientosDelDiario(diario), contexto.opcionesMayor);
}

/**
 * Trae los asientos del rango con sus líneas y arma las opciones de los dos
 * libros a la vez.
 *
 * Que los dos salgan del **mismo** conjunto de asientos no es una comodidad: es
 * lo que hace que el Mayor sea una proyección del Diario y no otra consulta que
 * casualmente da parecido.
 */
async function resolverContexto(
  tx: Tx,
  companyId: string,
  query: {
    desde: string;
    hasta: string;
    ejercicio?: string | undefined;
    asientosPorFolio?: number | undefined;
  },
): Promise<ContextoDeLibros> {
  const moneda = monedaDeContabilidad();
  const desde = parseCalendarDate(query.desde);
  const hasta = parseCalendarDate(query.hasta);

  if (desde > hasta) {
    throw badRequest('La fecha "desde" no puede ser posterior a "hasta"');
  }

  const ejercicio = await resolverEjercicio(tx, companyId, query.ejercicio ?? null, desde);
  if (ejercicio === null) {
    // No se elige un ejercicio por el ente. Sin ejercicio que contenga la fecha
    // no hay libro: pedirlo es parte de la pregunta, no un detalle técnico.
    throw badRequest(
      `No hay un ejercicio que contenga la fecha ${query.desde}. Indicá el ejercicio o cargá el que corresponde.`,
    );
  }

  const cabeceras = await tx.query<{
    id: string;
    journal_code: string;
    entry_number: number;
    entry_date: string;
    description: string;
    kind: string;
    status: EntryStatus;
    fiscal_year_id: string;
    period_id: string;
    reverses_entry_id: string | null;
    source_type: string;
    source_id: string | null;
    document_id: string | null;
    manual_justification: string | null;
    decision_id: string | null;
    ai_prediction_id: string | null;
    created_by: string;
    approved_by: string | null;
  }>(
    `SELECT e.id, e.journal_code, e.entry_number, e.entry_date::text, e.description, e.kind,
            e.status, e.fiscal_year_id, e.period_id, e.reverses_entry_id,
            e.source_type, e.source_id::text,
            d.id::text AS document_id,
            e.manual_justification, e.decision_id::text, e.ai_prediction_id::text,
            e.created_by, e.approved_by
       FROM journal_entries e
       LEFT JOIN documents d ON d.id = e.source_id
                            AND e.source_type IN ('INVOICE', 'RECEIPT', 'BANK')
      WHERE e.company_id = $1
        AND e.entry_date BETWEEN $2::date AND $3::date
      ORDER BY e.entry_date, e.journal_code, e.entry_number`,
    [companyId, query.desde, query.hasta],
  );

  const lineas = await tx.query<{
    id: string;
    entry_id: string;
    line_no: number;
    account_id: string;
    code: string;
    name: string;
    nature: 'DEUDORA' | 'ACREEDORA';
    debit: string;
    credit: string;
    currency: string;
    original_currency: string | null;
    original_debit: string | null;
    original_credit: string | null;
    fx_rate: string | null;
    fx_source: string | null;
    fx_date: string | null;
    cost_center_code: string | null;
    party_id: string | null;
    description: string | null;
    tax_transaction_id: string | null;
  }>(
    `SELECT l.id, l.entry_id, l.line_no, l.account_id, a.code, a.name, a.nature,
            l.debit::text, l.credit::text, l.currency,
            l.original_currency, l.original_debit::text, l.original_credit::text,
            l.fx_rate::text, l.fx_source, l.fx_date::text,
            c.code AS cost_center_code, l.party_id::text, l.description,
            l.tax_transaction_id::text
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN cost_centers c ON c.id = l.cost_center_id
      WHERE e.company_id = $1
        AND e.entry_date BETWEEN $2::date AND $3::date
      ORDER BY l.entry_id, l.line_no`,
    [companyId, query.desde, query.hasta],
  );

  // El catálogo del Mayor sale del plan de cuentas, no de las líneas del rango.
  //
  // Salía de las líneas, y por eso una cuenta con saldo inicial y sin
  // movimientos en el rango aparecía con código y nombre vacíos: el Mayor
  // siempre incluye las cuentas con saldo de apertura —si no, los totales no
  // cerrarían— pero no tenía de dónde sacar su ficha. El Mayor de febrero de una
  // empresa que solo operó en enero salía entero con `codigo: ""`.
  //
  // El plan de cuentas es chico y es lo que el Mayor está proyectando; leerlo
  // completo cuesta una consulta y saca el problema de raíz en vez de parchear
  // el caso de las cuentas sin movimiento.
  const plan = await tx.query<{
    id: string;
    code: string;
    name: string;
    nature: 'DEUDORA' | 'ACREEDORA';
  }>('SELECT id, code, name, nature FROM accounts WHERE company_id = $1', [companyId]);

  const porAsiento = new Map<string, LineaDelLibro[]>();
  const catalogo = new Map<string, CuentaParaElMayor>(
    plan.rows.map((fila) => [
      fila.id,
      { id: fila.id, code: fila.code, name: fila.name, nature: fila.nature },
    ]),
  );
  for (const fila of lineas.rows) {
    catalogo.set(fila.account_id, {
      id: fila.account_id,
      code: fila.code,
      name: fila.name,
      nature: fila.nature,
    });
    const linea: LineaDelLibro = {
      id: fila.id,
      lineNo: fila.line_no,
      accountId: fila.account_id,
      accountCode: fila.code,
      accountName: fila.name,
      debit: moneyFromDecimalString(fila.debit, moneda),
      credit: moneyFromDecimalString(fila.credit, moneda),
      monedaOriginal: (fila.original_currency ?? null) as Currency | null,
      importeOriginal: importeOriginal(fila),
      fxRate: fila.fx_rate,
      fxSource: fila.fx_source,
      fxDate: fila.fx_date === null ? null : parseCalendarDate(fila.fx_date),
      costCenterCode: fila.cost_center_code,
      partyId: fila.party_id,
      description: fila.description,
      taxTransactionId: fila.tax_transaction_id,
    };
    const lista = porAsiento.get(fila.entry_id);
    if (lista === undefined) porAsiento.set(fila.entry_id, [linea]);
    else lista.push(linea);
  }

  const asientos: AsientoDelLibro[] = cabeceras.rows.map((fila) => ({
    id: fila.id,
    journalCode: fila.journal_code as AsientoDelLibro['journalCode'],
    entryNumber: fila.entry_number,
    entryDate: parseCalendarDate(fila.entry_date),
    description: fila.description,
    kind: fila.kind as AsientoDelLibro['kind'],
    status: fila.status,
    fiscalYearId: fila.fiscal_year_id,
    periodId: fila.period_id,
    reversesEntryId: fila.reverses_entry_id,
    sourceType: fila.source_type as AsientoDelLibro['sourceType'],
    sourceId: fila.source_id,
    documentId: fila.document_id,
    manualJustification: fila.manual_justification,
    decisionId: fila.decision_id,
    aiPredictionId: fila.ai_prediction_id,
    createdBy: fila.created_by,
    approvedBy: fila.approved_by,
    lines: porAsiento.get(fila.id) ?? [],
  }));

  const saldosIniciales = await saldosAnterioresA(tx, companyId, query.desde, moneda);

  return {
    asientos,
    moneda,
    fiscalYearId: ejercicio,
    opcionesDiario: {
      companyId,
      fiscalYearId: ejercicio,
      moneda,
      desde,
      hasta,
      ...(query.asientosPorFolio === undefined ? {} : { asientosPorFolio: query.asientosPorFolio }),
    },
    opcionesMayor: {
      companyId,
      moneda,
      desde,
      hasta,
      cuentas: [...catalogo.values()],
      saldosIniciales,
    },
  };
}

function importeOriginal(fila: {
  original_currency: string | null;
  original_debit: string | null;
  original_credit: string | null;
}): LineaDelLibro['importeOriginal'] {
  if (fila.original_currency === null) return null;
  const bruto =
    fila.original_debit !== null && fila.original_debit !== '0.00'
      ? fila.original_debit
      : fila.original_credit;
  if (bruto === null) return null;
  return moneyFromDecimalString(bruto, fila.original_currency as Currency);
}

/**
 * Saldos acumulados hasta el día anterior al rango.
 *
 * Sale del Diario, no de `account_balances`. Es a propósito: `account_balances`
 * es la tabla que se va a verificar contra esto, y una verificación que toma su
 * punto de partida de lo verificado no verifica nada.
 */
async function saldosAnterioresA(
  tx: Tx,
  companyId: string,
  desde: string,
  moneda: Currency,
): Promise<SaldoDeApertura[]> {
  const result = await tx.query<{ account_id: string; saldo: string }>(
    `SELECT l.account_id, (sum(l.debit) - sum(l.credit))::text AS saldo
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1
        AND e.status IN ('APROBADO', 'ANULADO')
        AND e.entry_date < $2::date
      GROUP BY l.account_id`,
    [companyId, desde],
  );
  return result.rows.map((fila) => ({
    accountId: fila.account_id,
    monto: moneyFromDecimalString(fila.saldo, moneda),
  }));
}

async function resolverEjercicio(
  tx: Tx,
  companyId: string,
  pedido: string | null,
  desde: CalendarDate,
): Promise<string | null> {
  if (pedido !== null) return pedido;
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM fiscal_years
      WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date
      LIMIT 1`,
    [companyId, desde],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Moneda en la que se lleva la contabilidad.
 *
 * Devuelve `ARS` porque el CCyC art. 325 exige moneda nacional y todavía no hay
 * un caso relevado que la cambie. Está en una función y no como literal para que
 * el día que exista ese caso haya un solo lugar donde tocarlo.
 */
function monedaDeContabilidad(): Currency {
  return 'ARS';
}

// ---------------------------------------------------------------------------
// Serialización
// ---------------------------------------------------------------------------

function respuestaDiario(libro: LibroDiario): unknown {
  return {
    desde: libro.desde,
    hasta: libro.hasta,
    moneda: libro.moneda,
    asientos: libro.asientos,
    cumpleFormalidades: libro.cumpleFormalidades,
    controles: libro.controles,
    excluidos: libro.excluidos,
    totales: {
      debe: toDecimalString(libro.totalDebe),
      haber: toDecimalString(libro.totalHaber),
    },
    folios: libro.folios.map((folio) => ({
      numero: folio.numero,
      transporte: {
        debe: toDecimalString(folio.transporteDebe),
        haber: toDecimalString(folio.transporteHaber),
      },
      acumulado: {
        debe: toDecimalString(folio.acumuladoDebe),
        haber: toDecimalString(folio.acumuladoHaber),
      },
      asientos: folio.asientos.map((asiento) => ({
        id: asiento.id,
        libro: asiento.journalCode,
        numero: asiento.entryNumber,
        fecha: asiento.entryDate,
        descripcion: asiento.description,
        tipo: asiento.kind,
        estado: asiento.status,
        anulaA: asiento.reversesEntryId,
        documentoId: asiento.documentId,
        decisionId: asiento.decisionId,
        prediccionId: asiento.aiPredictionId,
        aprobadoPor: asiento.approvedBy,
        lineas: asiento.lines.map((linea) => ({
          id: linea.id,
          numero: linea.lineNo,
          cuenta: linea.accountCode,
          nombre: linea.accountName,
          debe: toDecimalString(linea.debit),
          haber: toDecimalString(linea.credit),
          monedaOriginal: linea.monedaOriginal,
          importeOriginal:
            linea.importeOriginal === null ? null : toDecimalString(linea.importeOriginal),
          cotizacion: linea.fxRate,
          cotizacionFuente: linea.fxSource,
          cotizacionFecha: linea.fxDate,
          centroCosto: linea.costCenterCode,
          tercero: linea.partyId,
          detalle: linea.description,
        })),
      })),
    })),
  };
}

function respuestaMayor(
  mayor: LibroMayor,
  naturaleza: { deudores: Money; acreedores: Money } | null,
): unknown {
  const balance = balanceDesdeMayor(mayor);
  return {
    desde: mayor.desde,
    hasta: mayor.hasta,
    moneda: mayor.moneda,
    totales: {
      debe: toDecimalString(mayor.totalDebe),
      haber: toDecimalString(mayor.totalHaber),
    },
    // Suma de saldos deudores y acreedores del Mayor completo. Es contra esto
    // que se cruza el balance de sumas y saldos: si no dan lo mismo, uno de los
    // dos se armó sobre otro universo de asientos.
    saldosPorNaturaleza:
      naturaleza === null
        ? null
        : {
            deudores: toDecimalString(naturaleza.deudores),
            acreedores: toDecimalString(naturaleza.acreedores),
          },
    // El balance viaja con el Mayor a propósito: son la misma fuente leída de
    // dos maneras, y verlos juntos hace evidente si alguna vez dejan de coincidir.
    balance: {
      cuadra: balance.cuadra,
      verificaciones: balance.verificaciones,
    },
    cuentas: mayor.cuentas.map((cuenta) => ({
      id: cuenta.accountId,
      codigo: cuenta.accountCode,
      nombre: cuenta.accountName,
      naturaleza: cuenta.nature,
      saldoInicial: toDecimalString(cuenta.saldoInicial),
      totalDebe: toDecimalString(cuenta.totalDebe),
      totalHaber: toDecimalString(cuenta.totalHaber),
      saldoFinal: toDecimalString(cuenta.saldoFinal),
      movimientos: cuenta.movimientos.map((movimiento) => ({
        lineaId: movimiento.entryLineId,
        asientoId: movimiento.entryId,
        fecha: movimiento.fecha,
        libro: movimiento.journalCode,
        numero: movimiento.entryNumber,
        detalle: movimiento.detalle,
        debe: toDecimalString(movimiento.debe),
        haber: toDecimalString(movimiento.haber),
        saldo: toDecimalString(movimiento.saldo),
        anulado: movimiento.anulado,
        documentoId: movimiento.documentId,
        decisionId: movimiento.decisionId,
      })),
    })),
  };
}
