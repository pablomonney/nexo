/**
 * IVA: subdiarios de Compras y Ventas, y Libro de IVA Digital.
 *
 * Igual que en `books.ts`: acá no se decide nada. Este archivo lee la base, arma
 * lo que `@aai/tax-engine` espera y devuelve lo que el motor dijo.
 *
 * Dos endpoints devuelven **negativas** en vez de hacer el trabajo, y son
 * endpoints igual —no botones ausentes— porque la pregunta se la va a hacer
 * alguien y merece una respuesta con el artículo adentro:
 *
 * - `GET /vat/books/:anio/:mes/export-file` explica que los diseños de registro
 *   no están en la norma (RG 4597 art. 8°).
 * - `POST /vat/books/:anio/:mes/present` explica que presentar exige Clave
 *   Fiscal Nivel 3 (art. 6°), que este sistema no pide ni guarda.
 */

import {
  armarLibroIvaDigital,
  construirSubdiario,
  evaluarCreditoFiscal,
  puedeGenerarArchivoDeImportacion,
  puedePresentarPorElContribuyente,
  type AlicuotaRelevada,
  type ClaseComprobante,
  type ComprobanteIva,
  type CondicionIva,
  type DireccionIva,
  type EstadoLibroIva,
  type ResultadoConstatacion,
  type Subdiario,
} from '@aai/tax-engine';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  calendarDate,
  daysInMonth,
  moneyFromDecimalString,
  parseCalendarDate,
  toDecimalString,
  type Currency,
} from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { notFound } from '../http/errors.js';

const MONEDA: Currency = 'ARS';

const periodoSchema = z.object({
  anio: z.coerce.number().int().min(2000).max(2100),
  mes: z.coerce.number().int().min(1).max(12),
});

export async function vatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Subdiario de IVA Compras o Ventas del período.
   *
   * `excluidos` viaja en la raíz. Un comprobante que quedó fuera de los totales
   * y solo aparece si alguien scrollea la lista es un comprobante que nadie va a
   * ir a buscar.
   */
  app.get<{ Params: { direccion: string; anio: string; mes: string } }>(
    '/vat/subdiarios/:direccion/:anio/:mes',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:read');
      const auth = requireAuth(request);
      const params = periodoSchema
        .extend({ direccion: z.enum(['COMPRAS', 'VENTAS']) })
        .parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const subdiario = await armarSubdiario(
            tx,
            tenant.companyId,
            params.direccion,
            params.anio,
            params.mes,
          );
          return serializar(subdiario);
        },
      );
    },
  );

  /**
   * Libro de IVA Digital del período.
   *
   * No lo genera: lo arma y dice qué lo bloquea. Generar es un acto con
   * consecuencias —el art. 12 encadena los períodos— y va por POST con permiso
   * aparte.
   */
  app.get<{ Params: { anio: string; mes: string } }>(
    '/vat/books/:anio/:mes',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:read');
      const auth = requireAuth(request);
      const params = periodoSchema.parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const libro = await armarLibro(tx, tenant.companyId, params.anio, params.mes);
          return {
            ...libro.resumen,
            compras: serializar(libro.compras),
            ventas: serializar(libro.ventas),
          };
        },
      );
    },
  );

  /**
   * Genera el libro del período y lo deja registrado.
   *
   * Se niega si hay bloqueos. El del art. 12 —el período anterior sin generar—
   * no es una advertencia: la norma dice que la presentación "solo podrá
   * efectuarse" si el anterior se generó, y dejar generar igual produciría una
   * secuencia que el portal después rechaza.
   */
  app.post<{ Params: { anio: string; mes: string } }>(
    '/vat/books/:anio/:mes/generate',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:generate');
      const auth = requireAuth(request);
      const params = periodoSchema.parse(request.params);
      const actorId = `user:${auth.user.userId}`;

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const libro = await armarLibro(tx, tenant.companyId, params.anio, params.mes);

        if (libro.resumen.bloqueos.length > 0) {
          return reply.code(409).send({
            error: 'LIBRO_IVA_BLOQUEADO',
            message:
              'El período no se puede generar todavía. Cada bloqueo trae el artículo del que sale.',
            bloqueos: libro.resumen.bloqueos,
          });
        }

        const status: EstadoLibroIva = libro.resumen.sinMovimiento
          ? 'SIN_MOVIMIENTO'
          : 'GENERADO';

        const guardado = await tx.query<{ id: string }>(
          `INSERT INTO vat_books
             (company_id, anio, mes, vencimiento, status,
              comprobantes_compras, comprobantes_ventas, bloqueos, generated_at, generated_by)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7, '[]'::jsonb, now(), $8)
           ON CONFLICT (company_id, anio, mes) DO UPDATE
             SET status = EXCLUDED.status,
                 comprobantes_compras = EXCLUDED.comprobantes_compras,
                 comprobantes_ventas = EXCLUDED.comprobantes_ventas,
                 vencimiento = EXCLUDED.vencimiento,
                 generated_at = now(),
                 generated_by = EXCLUDED.generated_by
           RETURNING id`,
          [
            tenant.companyId,
            params.anio,
            params.mes,
            libro.resumen.vencimiento,
            status,
            libro.resumen.comprobantesCompras,
            libro.resumen.comprobantesVentas,
            actorId,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'vat_book.generate',
          objectType: 'vat_books',
          objectId: guardado.rows[0]!.id,
          ip: clientIp(request),
          newValue: { anio: params.anio, mes: params.mes, status },
        });

        reply.code(201);
        return {
          libroId: guardado.rows[0]!.id,
          status,
          vencimiento: libro.resumen.vencimiento,
          // Se devuelve junto con el alta, porque es acá donde el usuario espera
          // un botón de "presentar" y hay que decirle por qué no está.
          presentacion: puedePresentarPorElContribuyente(),
        };
      });
    },
  );

  /**
   * El archivo de importación de ARCA: no se genera.
   *
   * Devuelve 501 y no 404: el endpoint existe, la funcionalidad está
   * identificada, y lo que falta es una fuente. Un 404 haría pensar que nadie lo
   * pensó.
   */
  app.get('/vat/books/export-file', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'vat_book:read');
    return reply.code(501).send({
      error: 'DISENO_DE_REGISTRO_NO_RELEVADO',
      ...puedeGenerarArchivoDeImportacion(),
    });
  });

  app.post<{ Params: { anio: string; mes: string } }>(
    '/vat/books/:anio/:mes/present',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:generate');
      return reply.code(501).send({
        error: 'PRESENTACION_FUERA_DEL_SISTEMA',
        ...puedePresentarPorElContribuyente(),
      });
    },
  );

  /**
   * Qué se pudo verificar sobre el crédito fiscal de un comprobante.
   *
   * Nunca responde "computable". Devuelve los controles de forma con su
   * resultado y la lista de lo que falta relevar para poder decidir de fondo.
   */
  app.get<{ Params: { txId: string } }>(
    '/vat/credito-fiscal/:txId',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'vat_book:read');
      const auth = requireAuth(request);
      const params = z.object({ txId: z.string().uuid() }).parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const catalogo = await cargarAlicuotas(tx);
          const comprobantes = await cargarComprobantes(tx, tenant.companyId, {
            txId: params.txId,
          });
          const comprobante = comprobantes[0];
          if (comprobante === undefined) {
            throw notFound('No existe esa operación de IVA en esta empresa');
          }
          return evaluarCreditoFiscal(comprobante, catalogo);
        },
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Carga desde la base
// ---------------------------------------------------------------------------

/**
 * Alícuotas vigentes, con su norma.
 *
 * Devuelve un array vacío cuando `tax_rates` no tiene nada vigente a esa fecha —
 * porque nadie corrió `npm run tax:seed`, o porque el comprobante es anterior al
 * 18/11/2002, que es el borde hasta donde llega el texto ordenado archivado. El
 * motor lo traduce a `SIN_ALICUOTAS_RELEVADAS`; no hay ningún camino por el que
 * acá aparezca un 21% de la nada.
 */
async function cargarAlicuotas(tx: Tx): Promise<AlicuotaRelevada[]> {
  const result = await tx.query<{
    id: string;
    label: string;
    numerator: string;
    denominator: string;
    valid_from: string;
    valid_to: string | null;
    norm_version_id: string;
  }>(
    `SELECT r.id, r.label, r.numerator::text, r.denominator::text,
            r.valid_from::text, r.valid_to::text, r.norm_version_id
       FROM tax_rates r
       JOIN taxes t ON t.id = r.tax_id
      WHERE t.code = 'IVA'`,
  );

  return result.rows.map((fila) => ({
    id: fila.id,
    numerador: BigInt(fila.numerator),
    denominador: BigInt(fila.denominator),
    etiqueta: fila.label,
    vigenteDesde: parseCalendarDate(fila.valid_from),
    vigenteHasta: fila.valid_to === null ? null : parseCalendarDate(fila.valid_to),
    normVersionId: fila.norm_version_id,
  }));
}

interface FiltroComprobantes {
  readonly txId?: string;
  readonly desde?: string;
  readonly hasta?: string;
  readonly direccion?: DireccionIva;
}

/**
 * Operaciones de IVA con su clase resuelta **por fecha**.
 *
 * El `LEFT JOIN` contra `arca_comprobante_types` usa la fecha del comprobante,
 * no `now()`. Es la diferencia entre saber qué era la 991 en 2019 y saber qué es
 * hoy — y de la clase depende si el comprobante suma o resta en el período.
 */
async function cargarComprobantes(
  tx: Tx,
  companyId: string,
  filtro: FiltroComprobantes,
): Promise<ComprobanteIva[]> {
  const result = await tx.query<{
    id: string;
    direction: DireccionIva;
    cbte_tipo: number;
    clase: ClaseComprobante | null;
    punto_venta: number;
    cbte_numero: string;
    cbte_fecha: string;
    cuit_contraparte: string | null;
    razon_social: string | null;
    condicion_iva: CondicionIva;
    neto: string;
    iva: string;
    no_gravado: string;
    exento: string;
    percepciones: string;
    total: string;
    tax_rate_id: string | null;
    constatacion: ResultadoConstatacion;
    emisor_apocrifo: boolean | null;
    entry_id: string | null;
    document_id: string | null;
  }>(
    `SELECT t.id, t.direction, t.cbte_tipo, ct.clase,
            t.punto_venta, t.cbte_numero::text, t.cbte_fecha::text,
            t.cuit_contraparte, t.razon_social, t.condicion_iva,
            t.neto::text, t.iva::text, t.no_gravado::text, t.exento::text,
            t.percepciones::text, t.total::text,
            t.tax_rate_id, t.constatacion, t.emisor_apocrifo,
            t.entry_id::text, t.document_id::text
       FROM tax_transactions t
       LEFT JOIN arca_comprobante_types ct
              ON ct.codigo = t.cbte_tipo
             AND (ct.valid_from IS NULL OR ct.valid_from <= t.cbte_fecha)
             AND (ct.valid_to IS NULL OR ct.valid_to >= t.cbte_fecha)
      WHERE t.company_id = $1
        AND ($2::uuid IS NULL OR t.id = $2::uuid)
        AND ($3::date IS NULL OR t.cbte_fecha >= $3::date)
        AND ($4::date IS NULL OR t.cbte_fecha <= $4::date)
        AND ($5::text IS NULL OR t.direction = $5)
      ORDER BY t.cbte_fecha, t.punto_venta, t.cbte_numero`,
    [
      companyId,
      filtro.txId ?? null,
      filtro.desde ?? null,
      filtro.hasta ?? null,
      filtro.direccion ?? null,
    ],
  );

  return result.rows.map((fila) => ({
    id: fila.id,
    direccion: fila.direction,
    tipoComprobante: fila.cbte_tipo,
    clase: fila.clase,
    puntoVenta: fila.punto_venta,
    numero: Number(fila.cbte_numero),
    fecha: parseCalendarDate(fila.cbte_fecha),
    cuitContraparte: fila.cuit_contraparte,
    razonSocialContraparte: fila.razon_social,
    condicionContraparte: fila.condicion_iva,
    renglones: [
      {
        neto: moneyFromDecimalString(fila.neto, MONEDA),
        iva: moneyFromDecimalString(fila.iva, MONEDA),
        noGravado: moneyFromDecimalString(fila.no_gravado, MONEDA),
        exento: moneyFromDecimalString(fila.exento, MONEDA),
        alicuotaId: fila.tax_rate_id,
      },
    ],
    percepciones: moneyFromDecimalString(fila.percepciones, MONEDA),
    total: moneyFromDecimalString(fila.total, MONEDA),
    constatacion: fila.constatacion,
    emisorApocrifo: fila.emisor_apocrifo,
    entryId: fila.entry_id,
    documentId: fila.document_id,
  }));
}

async function armarSubdiario(
  tx: Tx,
  companyId: string,
  direccion: DireccionIva,
  anio: number,
  mes: number,
): Promise<Subdiario> {
  const desde = calendarDate(anio, mes, 1);
  const hasta = calendarDate(anio, mes, daysInMonth(anio, mes));
  const catalogo = await cargarAlicuotas(tx);
  const comprobantes = await cargarComprobantes(tx, companyId, { desde, hasta, direccion });

  return construirSubdiario(comprobantes, {
    companyId,
    direccion,
    anio,
    mes,
    desde,
    hasta,
    moneda: MONEDA,
    catalogo,
  });
}

async function armarLibro(
  tx: Tx,
  companyId: string,
  anio: number,
  mes: number,
): Promise<{
  resumen: ReturnType<typeof armarLibroIvaDigital>;
  compras: Subdiario;
  ventas: Subdiario;
}> {
  const compras = await armarSubdiario(tx, companyId, 'COMPRAS', anio, mes);
  const ventas = await armarSubdiario(tx, companyId, 'VENTAS', anio, mes);

  const anteriorMes = mes === 1 ? 12 : mes - 1;
  const anteriorAnio = mes === 1 ? anio - 1 : anio;
  const anterior = await tx.query<{ status: EstadoLibroIva }>(
    `SELECT status FROM vat_books WHERE company_id = $1 AND anio = $2 AND mes = $3`,
    [companyId, anteriorAnio, anteriorMes],
  );

  return {
    resumen: armarLibroIvaDigital({
      companyId,
      periodo: { anio, mes },
      comprobantesCompras: compras.renglones.length,
      comprobantesVentas: ventas.renglones.length,
      excluidos: compras.excluidos.length + ventas.excluidos.length,
      // Sin fila del período anterior no se afirma que esté generado ni que no:
      // `null` significa "no hay antecedente en el sistema", que es distinto de
      // "está pendiente". La empresa puede haber empezado a operar acá este mes.
      periodoAnterior:
        anterior.rows[0] === undefined
          ? null
          : { periodo: { anio: anteriorAnio, mes: anteriorMes }, estado: anterior.rows[0].status },
    }),
    compras,
    ventas,
  };
}

function serializar(subdiario: Subdiario): unknown {
  return {
    direccion: subdiario.direccion,
    periodo: `${String(subdiario.anio)}-${String(subdiario.mes).padStart(2, '0')}`,
    desde: subdiario.desde,
    hasta: subdiario.hasta,
    moneda: subdiario.moneda,
    totales: {
      neto: toDecimalString(subdiario.totalNeto),
      iva: toDecimalString(subdiario.totalIva),
      noGravado: toDecimalString(subdiario.totalNoGravado),
      exento: toDecimalString(subdiario.totalExento),
      percepciones: toDecimalString(subdiario.totalPercepciones),
      total: toDecimalString(subdiario.total),
    },
    porAlicuota: subdiario.porAlicuota.map((fila) => ({
      alicuotaId: fila.alicuotaId,
      etiqueta: fila.etiqueta,
      neto: toDecimalString(fila.neto),
      iva: toDecimalString(fila.iva),
    })),
    excluidos: subdiario.excluidos,
    renglones: subdiario.renglones.map((renglon) => ({
      comprobanteId: renglon.comprobanteId,
      fecha: renglon.fecha,
      tipo: renglon.tipoComprobante,
      puntoVenta: renglon.puntoVenta,
      numero: renglon.numero,
      cuit: renglon.cuitContraparte,
      razonSocial: renglon.razonSocialContraparte,
      condicion: renglon.condicionContraparte,
      neto: toDecimalString(renglon.neto),
      iva: toDecimalString(renglon.iva),
      noGravado: toDecimalString(renglon.noGravado),
      exento: toDecimalString(renglon.exento),
      percepciones: toDecimalString(renglon.percepciones),
      total: toDecimalString(renglon.total),
      alicuotaId: renglon.alicuotaId,
      asientoId: renglon.entryId,
      documentoId: renglon.documentId,
      hallazgos: renglon.hallazgos,
    })),
  };
}
