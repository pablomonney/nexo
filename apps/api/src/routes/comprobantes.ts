/**
 * De un documento archivado a una operación fiscal.
 *
 * Es el eslabón que faltaba: `tax_transactions` existía desde la 0021 y las
 * únicas filas venían de fixtures. Sin escritor productivo, el recorrido
 * comprobante → decisión → asiento arrancaba en el aire.
 *
 * ## Por qué acá y no en la ingesta
 *
 * `POST /documents` archiva y extrae, y lo hace **aunque la extracción falle**.
 * Con el motor nulo —el que corre sin OCR configurado— la extracción está vacía
 * siempre. Crear ahí la operación fiscal significaría inventar los importes de
 * un documento que nadie leyó.
 *
 * ## Por qué no lo decide el sistema solo
 *
 * Afirmar "este documento es la Factura C 0001-00000005 por $34.382,52" es una
 * afirmación sobre el mundo, no una lectura. El motor documental **propone** —y
 * lo dice: sus campos vienen con confianza y método—, y una persona confirma.
 * Es el mismo reparto que en `document_extraction_fields`, donde la corrección
 * del contador inserta en vez de pisar la lectura del motor.
 *
 * Por eso los importes vienen en el pedido y quedan con autor. Lo que el
 * endpoint **sí** hace es no creerle a ninguno de los dos sin mirar al otro: si
 * hay una extracción con total leído y no coincide con el declarado, corta y
 * muestra los dos números. Un sistema que elige uno en silencio es peor que uno
 * que pregunta.
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';

/** Importe decimal como texto. Nunca `number`: un JSON con float ya perdió. */
const importe = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Importe decimal con hasta dos decimales, como texto')
  .default('0');

const cuerpo = z.object({
  direction: z.enum(['COMPRAS', 'VENTAS']),
  cbteTipo: z.number().int().positive(),
  puntoVenta: z.number().int().min(0),
  numero: z.number().int().min(0),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** El de la contraparte. En VENTAS a consumidor final sin identificar va null. */
  cuitContraparte: z.string().regex(/^\d{11}$/).nullable().default(null),
  razonSocial: z.string().min(1).max(200).nullable().default(null),
  condicionIva: z
    .enum([
      'RESPONSABLE_INSCRIPTO',
      'MONOTRIBUTO',
      'EXENTO',
      'CONSUMIDOR_FINAL',
      'NO_CATEGORIZADO',
      'DESCONOCIDA',
    ])
    .default('DESCONOCIDA'),
  neto: importe,
  iva: importe,
  noGravado: importe,
  exento: importe,
  percepciones: importe,
  total: importe,
  /**
   * Resultado de la constatación en ARCA, si se hizo.
   *
   * Por defecto `NO_CONSULTADO`, que es distinto de `NO_VERIFICABLE`: el primero
   * dice que nadie preguntó y el segundo que se preguntó y no se pudo. El
   * endpoint no consulta a ARCA por su cuenta.
   */
  constatacion: z
    .enum(['OK', 'WARN', 'FAIL', 'NO_VERIFICABLE', 'NO_CONSULTADO'])
    .default('NO_CONSULTADO'),
});

/** Suma de decimales de dos posiciones, sin punto flotante. */
function enCentavos(texto: string): bigint {
  const [entero, decimales = ''] = texto.split('.');
  return BigInt(entero!) * 100n + BigInt(decimales.padEnd(2, '0'));
}

/**
 * De centavos a texto decimal, con enteros.
 *
 * `Number(centavos) / 100` sería más corto y la puerta `check:no-float` lo
 * rechaza con razón: el mensaje de un error de importes no puede tener él mismo
 * un error de redondeo.
 */
function aDecimal(centavos: bigint): string {
  const signo = centavos < 0n ? '-' : '';
  const abs = centavos < 0n ? -centavos : centavos;
  return `${signo}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** El total leído por el motor documental, si lo hay. */
async function totalExtraido(tx: Tx, documentId: string): Promise<string | null> {
  const r = await tx.query<{ raw_value: string }>(
    `SELECT f.raw_value
       FROM document_extraction_fields f
       JOIN document_extractions e ON e.id = f.extraction_id
      WHERE e.document_id = $1 AND f.field_path = 'importes.total'
      ORDER BY f.created_at DESC
      LIMIT 1`,
    [documentId],
  );
  return r.rows[0]?.raw_value ?? null;
}

export async function comprobanteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents/:documentId/tax-transaction', async (request, reply) => {
    const tenant = await requireCompany(request);
    // Registrar la operación fiscal de un comprobante es un acto contable: fija
    // los importes con los que después se va a decidir y asentar.
    requirePermission(tenant, 'journal_entry:create');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);
    const body = cuerpo.parse(request.body);

    // La aritmética se comprueba acá además de en la base. El CHECK
    // `tax_tx_total_cierra` es el que manda; esto existe para que el error diga
    // qué no cierra en vez de nombrar una restricción.
    const partes =
      enCentavos(body.neto) +
      enCentavos(body.iva) +
      enCentavos(body.noGravado) +
      enCentavos(body.exento) +
      enCentavos(body.percepciones);
    if (partes !== enCentavos(body.total)) {
      throw badRequest(
        `El total declarado (${body.total}) no es la suma de neto, IVA, no gravado, exento y ` +
          `percepciones (${aDecimal(partes)}).`,
      );
    }

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      // El RLS ya filtró: un documento de otra empresa no aparece.
      const documento = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM documents WHERE id = $1',
        [documentId],
      );
      if (documento.rowCount === 0) throw notFound('Documento no encontrado');

      // ── Idempotencia ────────────────────────────────────────────────────
      // Un documento archivado produce UNA operación fiscal. El índice único de
      // la 0035 lo garantiza; esto lo contesta sin depender de atrapar un 23505.
      const existente = await tx.query<{ id: string }>(
        'SELECT id FROM tax_transactions WHERE document_id = $1',
        [documentId],
      );
      if (Number(existente.rowCount) > 0) {
        reply.code(200);
        return { taxTransactionId: existente.rows[0]!.id, yaExistia: true };
      }

      // ── El período ──────────────────────────────────────────────────────
      const periodo = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM periods
          WHERE company_id = $1 AND $2::date BETWEEN start_date AND end_date`,
        [tenant.companyId, body.fecha],
      );
      if (periodo.rowCount === 0) {
        throw badRequest(
          `No hay período abierto que contenga la fecha ${body.fecha}. ` +
            'La operación fiscal vive en un período: sin él no se puede registrar.',
        );
      }

      // ── El impuesto ─────────────────────────────────────────────────────
      const impuesto = await tx.query<{ id: string }>(
        "SELECT id FROM taxes WHERE code = 'IVA' LIMIT 1",
      );
      if (impuesto.rowCount === 0) {
        throw conflict('El catálogo de impuestos no tiene IVA. Corré `npm run tax:seed`.');
      }

      // ── Contraste con lo que leyó el motor ──────────────────────────────
      const leido = await totalExtraido(tx, documentId);
      if (leido !== null) {
        const normalizado = leido.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
        if (/^\d+(\.\d{1,2})?$/.test(normalizado) && enCentavos(normalizado) !== enCentavos(body.total)) {
          throw conflict(
            `El total declarado (${body.total}) no coincide con el que extrajo el motor ` +
              `del documento (${leido}). Se corta: elegir uno en silencio es peor que preguntar. ` +
              'Corregí el campo con POST /documents/:id/fields o revisá el importe declarado.',
          );
        }
      }

      // `ON CONFLICT DO NOTHING` sobre el índice único de la 0035.
      //
      // El SELECT de arriba resuelve el caso normal —un reintento después de que
      // la primera terminó—, pero entre mirar y escribir hay una ventana. Dos
      // pedidos concurrentes la atraviesan los dos y el segundo chocaba con un
      // 23505 que salía como 500. La integridad nunca corrió peligro; lo que
      // fallaba era la respuesta: un cliente que reintenta merece la operación
      // que ya existe, no un error interno.
      const fila = await tx.query<{ id: string }>(
        `INSERT INTO tax_transactions
           (company_id, tax_id, document_id, period_id, direction, cbte_tipo, punto_venta,
            cbte_numero, cbte_fecha, cuit_contraparte, razon_social, condicion_iva,
            neto, iva, no_gravado, exento, percepciones, total, constatacion, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (document_id) WHERE document_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          tenant.companyId,
          impuesto.rows[0]!.id,
          documentId,
          periodo.rows[0]!.id,
          body.direction,
          body.cbteTipo,
          body.puntoVenta,
          body.numero,
          body.fecha,
          body.cuitContraparte,
          body.razonSocial,
          body.condicionIva,
          body.neto,
          body.iva,
          body.noGravado,
          body.exento,
          body.percepciones,
          body.total,
          body.constatacion,
          actorId,
        ],
      );
      // Sin filas devueltas: el conflicto lo ganó otro pedido concurrente. Se
      // contesta lo mismo que si hubiera llegado después, porque para el cliente
      // es lo mismo.
      if (Number(fila.rowCount) === 0) {
        const ganadora = await tx.query<{ id: string }>(
          'SELECT id FROM tax_transactions WHERE document_id = $1',
          [documentId],
        );
        reply.code(200);
        return { taxTransactionId: ganadora.rows[0]!.id, yaExistia: true };
      }

      const taxTransactionId = fila.rows[0]!.id;

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'OPERACION_FISCAL_REGISTRADA',
        objectType: 'tax_transactions',
        objectId: taxTransactionId,
        newValue: {
          documentId,
          direction: body.direction,
          comprobante: `${body.cbteTipo}-${body.puntoVenta}-${body.numero}`,
          total: body.total,
          constatacion: body.constatacion,
        },
        ip: clientIp(request),
        userAgent: request.headers['user-agent'] ?? null,
      });

      reply.code(201);
      return {
        taxTransactionId,
        documentId,
        periodId: periodo.rows[0]!.id,
        yaExistia: false,
      };
    });
  });

  app.get('/documents/:documentId/tax-transaction', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { documentId } = z.object({ documentId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT t.id, t.direction, t.cbte_tipo AS "cbteTipo", t.punto_venta AS "puntoVenta",
                  t.cbte_numero::text AS numero, t.cbte_fecha::text AS fecha,
                  t.total::text AS total, t.constatacion, t.created_by AS "registradaPor",
                  (SELECT d.id FROM accounting_decisions d
                    WHERE d.tax_transaction_id = t.id AND d.estado <> 'SUPERSEDIDA'
                    ORDER BY d.decidida_at DESC LIMIT 1) AS "decisionId"
             FROM tax_transactions t WHERE t.document_id = $1`,
          [documentId],
        );
        if (r.rowCount === 0) throw notFound('Ese documento no tiene operación fiscal registrada');
        return r.rows[0];
      },
    );
  });
}
