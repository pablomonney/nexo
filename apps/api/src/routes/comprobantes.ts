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

import { createArcaClient, parseEnvironment } from '@aai/arca';
import { DbCapabilityStore, DbCredentialStore } from '../arca/credential-store.js';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import {
  badRequest, conflict, conflictoTipado, notFound, unprocessable,
} from '../http/errors.js';
import { armarPagina, corteDe, parametrosDeCorte } from '../http/paginacion.js';

/** `YYYY-MM-DD` o nada. Se valida acá para no castear texto libre en la consulta. */
const fechaOpcional = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD')
  .optional();

/** Lo que devuelve una fila del listado. Solo se tipa lo que la paginación usa. */
interface FilaOperacion {
  readonly id: string;
  readonly fecha: string;
}

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
   * Constatación **declarada por una persona**, cuando la hizo por fuera.
   *
   * Hasta la 0043 este campo era `constatacion: 'OK' | ...` a secas, y ahí
   * estaba el problema: un valor escrito en el cuerpo del pedido quedaba
   * guardado igual que una respuesta de ARCA, y una vez en la tabla se veían
   * idénticos. Eso convierte una verificación en una afirmación — la frontera
   * que el §11 pide no cruzar— y deja entrar un comprobante apócrifo como
   * constatado, con su crédito fiscal detrás.
   *
   * Ahora hay dos caminos y quedan distinguidos en la fila:
   *
   *   · `POST /tax-transactions/:id/constatar` pregunta a ARCA y guarda la
   *     respuesta con `constatacion_origen = 'ARCA'` y el id de la consulta;
   *   · este campo declara lo que una persona verificó por su cuenta, y queda
   *     como `DECLARACION_PROFESIONAL`, con su firma y su fecha.
   *
   * Omitirlo deja la operación en `NO_CONSULTADO`, que es distinto de
   * `NO_VERIFICABLE`: el primero dice que nadie preguntó y el segundo que se
   * preguntó y no se pudo.
   */
  constatacionDeclarada: z
    .object({
      resultado: z.enum(['OK', 'WARN', 'FAIL', 'NO_VERIFICABLE']),
      /** Dónde y cómo se verificó. Queda en la fila y en la bitácora. */
      motivo: z.string().min(10).max(500),
    })
    .optional(),
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
            neto, iva, no_gravado, exento, percepciones, total,
            constatacion, constatacion_origen, constatacion_por, constatacion_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 CASE WHEN $21::text IS NULL THEN NULL ELSE now() END, $22)
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
          // Los tres van juntos o ninguno: el CHECK `tt_constatacion_coherente`
          // rechaza un resultado sin procedencia y una procedencia sin resultado.
          body.constatacionDeclarada?.resultado ?? 'NO_CONSULTADO',
          body.constatacionDeclarada === undefined ? 'NO_CONSULTADO' : 'DECLARACION_PROFESIONAL',
          body.constatacionDeclarada === undefined ? null : auth.user.email,
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
          constatacion: body.constatacionDeclarada?.resultado ?? 'NO_CONSULTADO',
          constatacionOrigen:
            body.constatacionDeclarada === undefined ? 'NO_CONSULTADO' : 'DECLARACION_PROFESIONAL',
        },
        ...(body.constatacionDeclarada === undefined
          ? {}
          : { motivo: body.constatacionDeclarada.motivo }),
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

  /**
   * El libro de comprobantes de la empresa.
   *
   * Hasta acá solo se llegaba a una operación fiscal **por el documento que la
   * originó**, de a una. Un contador que quiere ver las compras de julio tenía
   * que conocer de antemano el id de cada documento; sin este listado no hay
   * revisión, ni control cruzado, ni forma de encontrar lo que se cargó mal.
   *
   * ## El permiso es `journal_entry:read`, y no uno nuevo
   *
   * `docs/OPERACION.md` §E.2 recomendaba crear `tax_transaction:read`. Al
   * implementarlo apareció que ya existe el permiso correcto y que crear otro
   * habría sido el error: **todas** las lecturas de una operación fiscal —esta
   * misma ruta por documento, la afectación, la decisión y su historial— exigen
   * hoy `journal_entry:read`. En este esquema ese permiso significa «leer la
   * cadena contable y fiscal», y lo tienen ADMINISTRADOR, AUDITOR, CONTADOR y
   * SOLO_LECTURA — no USUARIO_EMPRESA ni CARGADOR, que es exactamente el corte
   * que se buscaba.
   *
   * ## Los dos sellos van separados
   *
   * `constatacion` y `constatacionOrigen` se devuelven los dos, siempre. Un
   * `OK` declarado por una persona y un `OK` que contestó ARCA valen distinto
   * (§11), y fundirlos en una sola columna es cómo se pierde esa diferencia.
   */
  app.get('/tax-transactions', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);

    const query = z
      .object({
        direccion: z.enum(['COMPRAS', 'VENTAS']).optional(),
        desde: fechaOpcional,
        hasta: fechaOpcional,
        cuitContraparte: z.string().regex(/^\d{11}$/).optional(),
        cbteTipo: z.coerce.number().int().min(1).max(999).optional(),
        constatacion: z.enum(['OK', 'WARN', 'FAIL', 'NO_VERIFICABLE', 'NO_CONSULTADO']).optional(),
        constatacionOrigen: z
          .enum(['NO_CONSULTADO', 'ARCA', 'DECLARACION_PROFESIONAL', 'ORIGEN_NO_REGISTRADO'])
          .optional(),
        periodoId: z.string().uuid().optional(),
        documentId: z.string().uuid().optional(),
        conAfectacion: z.enum(['si', 'no']).optional(),
        conDecision: z.enum(['si', 'no']).optional(),
        limite: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(512).optional(),
      })
      .parse(request.query);

    const [cursorFecha, cursorId] = parametrosDeCorte(corteDe(query.cursor));

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query<FilaOperacion>(
          `SELECT t.id, t.direction AS direccion, t.cbte_tipo AS "cbteTipo",
                  t.punto_venta AS "puntoVenta", t.cbte_numero::text AS numero,
                  t.cbte_fecha::text AS fecha, t.cuit_contraparte AS "cuitContraparte",
                  t.razon_social AS "razonSocial", t.condicion_iva AS "condicionIva",
                  t.neto::text AS neto, t.iva::text AS iva,
                  t.no_gravado::text AS "noGravado", t.exento::text AS exento,
                  t.percepciones::text AS percepciones, t.total::text AS total,
                  t.constatacion, t.constatacion_origen AS "constatacionOrigen",
                  t.constatacion_at AS "constatacionAt",
                  t.document_id AS "documentId", t.entry_id AS "entryId",
                  t.period_id AS "periodoId", t.created_at AS "creadoEn",
                  a.afectacion,
                  a.origen AS "afectacionOrigen",
                  d.id AS "decisionId", d.estado AS "decisionEstado",
                  d.resultado AS "decisionResultado"
             FROM tax_transactions t
             -- Toda unión lleva la igualdad de empresa explícita. RLS ya filtra;
             -- esto hace que una fila cruzada sea imposible aunque no filtrara.
             LEFT JOIN tax_affectations a
                    ON a.tax_transaction_id = t.id AND a.company_id = t.company_id
             LEFT JOIN LATERAL (
                    SELECT ad.id, ad.estado, ad.resultado
                      FROM accounting_decisions ad
                     WHERE ad.tax_transaction_id = t.id
                       AND ad.company_id = t.company_id
                       AND ad.estado <> 'SUPERSEDIDA'
                     ORDER BY ad.created_at DESC
                     LIMIT 1) d ON true
            WHERE t.company_id = $1
              AND ($2::text  IS NULL OR t.direction = $2)
              AND ($3::date  IS NULL OR t.cbte_fecha >= $3::date)
              AND ($4::date  IS NULL OR t.cbte_fecha <= $4::date)
              AND ($5::text  IS NULL OR t.cuit_contraparte = $5)
              AND ($6::int   IS NULL OR t.cbte_tipo = $6)
              AND ($7::text  IS NULL OR t.constatacion = $7)
              AND ($8::text  IS NULL OR t.constatacion_origen = $8)
              AND ($9::uuid  IS NULL OR t.period_id = $9::uuid)
              AND ($10::uuid IS NULL OR t.document_id = $10::uuid)
              AND ($11::bool IS NULL OR ($11 = (a.id IS NOT NULL)))
              AND ($12::bool IS NULL OR ($12 = (d.id IS NOT NULL)))
              AND ($13::date IS NULL
                   OR (t.cbte_fecha, t.id) < ($13::date, $14::uuid))
            ORDER BY t.cbte_fecha DESC, t.id DESC
            LIMIT $15`,
          [
            tenant.companyId,
            query.direccion ?? null,
            query.desde ?? null,
            query.hasta ?? null,
            query.cuitContraparte ?? null,
            query.cbteTipo ?? null,
            query.constatacion ?? null,
            query.constatacionOrigen ?? null,
            query.periodoId ?? null,
            query.documentId ?? null,
            query.conAfectacion === undefined ? null : query.conAfectacion === 'si',
            query.conDecision === undefined ? null : query.conDecision === 'si',
            cursorFecha,
            cursorId,
            query.limite + 1,
          ],
        );

        const pagina = armarPagina(result.rows, query.limite, (fila) => ({
          fecha: fila.fecha,
          id: fila.id,
        }));
        return { operaciones: pagina.items, cursor: pagina.cursor, limite: pagina.limite };
      },
    );
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

  /**
   * Preguntarle a ARCA si el comprobante está autorizado.
   *
   * Esta ruta es la diferencia entre «WSCDC responde» y «NEXO usa ARCA». Hasta
   * ahora el paquete `@aai/arca` lo importaban dos scripts y nada más: el
   * producto guardaba el resultado de una constatación que nunca hacía.
   *
   * ## Qué se le manda, y de dónde sale
   *
   * Los datos de identificación del comprobante salen de la **fila guardada**,
   * no del cuerpo del pedido: se constata lo que el sistema registró, que es lo
   * que después va a fundar un asiento. Si viniera del pedido, se podría
   * constatar un comprobante y guardar otro.
   *
   * Lo único que llega de afuera es lo que el sistema no tiene: el CAE y su
   * modalidad, y el documento del receptor. Están impresos en el comprobante y
   * `tax_transactions` no los modela.
   *
   * ## Qué NO hace
   *
   * No decide nada fiscal. `APROBADO` significa que el comprobante está
   * autorizado, y **solo** eso: no dice que la operación económica haya existido
   * ni que el crédito fiscal sea computable. Son dimensiones distintas de
   * validación (§11), y la segunda la resuelve una regla que hoy no existe.
   *
   * Tampoco falla cuando ARCA falla. Un servicio caído es un resultado
   * —`NO_VERIFICABLE` con motivo—, no un error de programa: colapsar «no pude
   * preguntar» con «está bien» convierte una caída del organismo en un
   * comprobante aprobado en silencio.
   */
  app.post<{ Params: { taxTransactionId: string } }>(
    '/tax-transactions/:taxTransactionId/constatar',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'tax_transaction:constatar');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { taxTransactionId } = z
        .object({ taxTransactionId: z.string().uuid() })
        .parse(request.params);
      const body = z
        .object({
          modalidad: z.enum(['CAE', 'CAEA', 'CAI']).default('CAE'),
          /** El código de autorización impreso en el comprobante. */
          cae: z.string().regex(/^\d{8,20}$/, 'El CAE es una cadena de dígitos'),
          /** Tipo y número de documento del receptor, como los pide el WSCDC. */
          tipoDocReceptor: z.string().regex(/^\d{1,3}$/).default('80'),
          nroDocReceptor: z.string().regex(/^\d{1,11}$/),
        })
        .parse(request.body ?? {});

      const operacion = await withCompany({ companyId: tenant.companyId, actorId }, (tx) =>
        tx.query<{
          id: string;
          direction: string;
          cbte_tipo: number;
          punto_venta: number;
          cbte_numero: string;
          cbte_fecha: string;
          cuit_contraparte: string | null;
          total: string;
          constatacion_origen: string;
        }>(
          `SELECT t.id, t.direction, t.cbte_tipo, t.punto_venta, t.cbte_numero::text,
                  to_char(t.cbte_fecha, 'YYYYMMDD') AS cbte_fecha,
                  t.cuit_contraparte, t.total::text, t.constatacion_origen
             FROM tax_transactions t WHERE t.id = $1`,
          [taxTransactionId],
        ),
      );
      if (operacion.rowCount === 0) throw notFound('La operación fiscal no existe');
      const op = operacion.rows[0]!;

      // En COMPRAS el emisor es la contraparte; en VENTAS, la propia empresa. Sin
      // esta distinción se constataría el comprobante equivocado, con un CUIT que
      // ARCA no reconocería como emisor.
      const cuitEmisor =
        op.direction === 'COMPRAS'
          ? op.cuit_contraparte
          : await withCompany({ companyId: tenant.companyId, actorId }, async (tx) =>
              (
                await tx.query<{ cuit: string }>('SELECT cuit FROM companies WHERE id = $1', [
                  tenant.companyId,
                ])
              ).rows[0]?.cuit ?? null,
            );

      if (cuitEmisor === null) {
        throw unprocessable(
          'SIN_CUIT_EMISOR',
          'La operación es de COMPRAS y no tiene CUIT de contraparte cargado. Sin emisor no hay ' +
            'nada que preguntarle a ARCA.',
        );
      }

      // El ambiente `mock` no lleva credenciales ni capacidades: el simulador
      // responde por sí mismo y agregarle un store lo haría contestar
      // `SIN_CREDENCIAL` en desarrollo, que no es lo que se está simulando.
      //
      // Fuera de `mock` van los dos. Sin certificado vigente, el cliente real
      // contesta `NO_VERIFICABLE / SIN_CREDENCIAL`; sin `wscdc` habilitado en
      // WSASS, `SERVICIO_NO_HABILITADO`. Las dos son respuestas visibles y
      // distintas de «el comprobante está mal», que es lo que importa.
      const ambiente = parseEnvironment(config.arca.environment);
      const credenciales = ambiente === 'mock' ? undefined : new DbCredentialStore(actorId);

      const cliente = createArcaClient({
        environment: ambiente,
        timeoutMs: config.arca.timeoutMs,
        ...(credenciales === undefined
          ? {}
          : { credentials: credenciales, capabilities: new DbCapabilityStore(actorId) }),
      });

      const comenzo = Date.now();
      const resultado = await cliente.constatarComprobante(tenant.companyId, {
        modalidad: body.modalidad,
        cuitEmisor,
        puntoVenta: op.punto_venta,
        tipoComprobante: op.cbte_tipo,
        numeroComprobante: Number(op.cbte_numero),
        fecha: op.cbte_fecha,
        importeTotal: op.total,
        codigoAutorizacion: body.cae,
        tipoDocReceptor: body.tipoDocReceptor,
        nroDocReceptor: body.nroDocReceptor,
      });
      const duracion = Date.now() - comenzo;

      // El log primero y la operación después, en la misma transacción: la fila
      // del log es lo que el CHECK `tt_constatacion_arca_con_consulta` exige como
      // prueba de que la consulta ocurrió. Sin ella no se puede escribir el
      // resultado, y es a propósito.
      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const clave = `${cuitEmisor}-${op.punto_venta}-${op.cbte_tipo}-${op.cbte_numero}`;

        const consulta = await tx.query<{ id: string }>(
          `INSERT INTO arca_query_log
             (company_id, environment, service, operation, request_key, outcome, reason,
              response_raw, duration_ms, credential_id)
           VALUES ($1, $2, 'wscdc', 'ComprobanteConstatar', $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING id`,
          [
            tenant.companyId,
            resultado.ambiente,
            clave,
            resultado.estado,
            resultado.motivoNoVerificable ?? null,
            JSON.stringify({
              observaciones: resultado.observaciones,
              errores: resultado.errores,
              respuestaCruda: resultado.respuestaCruda ?? null,
              consultadoEn: resultado.consultadoEn,
            }),
            duracion,
            // Con qué certificado se firmó, para poder acotar el alcance de uno
            // comprometido. Nulo en mock, donde no se firma nada.
            credenciales?.ultimaCredencialUsada ?? null,
          ],
        );

        const estadoGuardado = traducirEstado(resultado);

        await tx.query(
          `UPDATE tax_transactions
              SET constatacion = $2,
                  constatacion_origen = 'ARCA',
                  constatacion_at = now(),
                  constatacion_por = $3,
                  arca_query_id = $4
            WHERE id = $1`,
          [taxTransactionId, estadoGuardado, auth.user.email, consulta.rows[0]!.id],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'CONSTATAR_COMPROBANTE',
          objectType: 'tax_transactions',
          objectId: taxTransactionId,
          oldValue: { constatacionOrigen: op.constatacion_origen },
          newValue: {
            constatacion: estadoGuardado,
            constatacionOrigen: 'ARCA',
            ambiente: resultado.ambiente,
            arcaQueryId: consulta.rows[0]!.id,
          },
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return {
          taxTransactionId,
          constatacion: estadoGuardado,
          origen: 'ARCA' as const,
          ambiente: resultado.ambiente,
          estadoArca: resultado.estado,
          motivoNoVerificable: resultado.motivoNoVerificable ?? null,
          observaciones: resultado.observaciones,
          errores: resultado.errores,
          arcaQueryId: consulta.rows[0]!.id,
          consultadoEn: resultado.consultadoEn,
          /**
           * Lo que este resultado NO significa. Va en la respuesta y no en la
           * documentación porque es donde lo va a leer quien tome la decisión.
           */
          alcance:
            'La constatación dice si el comprobante está autorizado por ARCA. No dice que la ' +
            'operación económica haya existido ni que el crédito fiscal sea computable: eso ' +
            'exige la declaración de afectación y una regla vigente.',
        };
      });
    },
  );

  /**
   * Resuelve la contraparte de un comprobante contra el maestro de terceros.
   *
   * No corrige el comprobante. `cuit_contraparte` y `razon_social` siguen
   * diciendo lo que dice el papel; esto afirma **a quién corresponden**. Si el
   * tercero elegido tiene un CUIT distinto del declarado, el trigger
   * `tt_party_coherente` (migración 0047) lo rechaza: vincular al proveedor
   * equivocado es un error invisible —el subdiario sigue saliendo bien— que
   * después aparece como una cuenta corriente que crece sin motivo.
   *
   * `null` desvincula. Es una operación legítima: alguien resolvió mal y lo
   * corrige. Queda en la bitácora como cualquier otra modificación.
   */
  app.post('/tax-transactions/:taxTransactionId/party', async (request) => {
    const tenant = await requireCompany(request);
    // Escribe sobre el comprobante, y elige del maestro: los dos permisos.
    requirePermission(tenant, 'tax_affectation:declare');
    requirePermission(tenant, 'party:read');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);
    const body = z.object({ partyId: z.string().uuid().nullable() }).parse(request.body);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const antes = await tx.query<{ party_id: string | null; cuit: string | null }>(
          `SELECT party_id, cuit_contraparte AS cuit FROM tax_transactions
            WHERE id = $1 AND company_id = $2`,
          [taxTransactionId, tenant.companyId],
        );
        if (antes.rowCount === 0) throw notFound('Comprobante no encontrado');

        try {
          await tx.query(
            'UPDATE tax_transactions SET party_id = $3 WHERE id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId, body.partyId],
          );
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          // 23514 llega del trigger de coherencia; 23503 de la clave foránea con
          // empresa incluida —un tercero de otra empresa no existe desde acá—.
          // Se reconoce por el texto y se responde con el propio: el mensaje de
          // PostgreSQL no se reenvía al cliente, como en el resto del sistema.
          if (failure.code === '23514' && (failure.message ?? '').includes('No se vincula')) {
            throw unprocessable(
              'TERCERO_NO_COINCIDE',
              'El tercero elegido tiene un CUIT distinto del que declara el comprobante. ' +
                'Vinculá el tercero que corresponde, o corregí el comprobante si el error está ahí.',
            );
          }
          if (failure.code === '23503') throw notFound('El tercero no existe en esta empresa');
          throw error;
        }

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId: `user:${auth.user.userId}`,
          action: 'VINCULAR_TERCERO',
          objectType: 'tax_transactions',
          objectId: taxTransactionId,
          oldValue: { partyId: antes.rows[0]!.party_id },
          newValue: { partyId: body.partyId },
          motivo:
            body.partyId === null
              ? 'Se desvincula el tercero'
              : 'Se resuelve la contraparte contra el maestro',
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        return { taxTransactionId, partyId: body.partyId };
      },
    );
  });

  app.get('/tax-transactions/:taxTransactionId/lines', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const cabecera = await tx.query(
          `SELECT neto::text, iva::text, exento::text, no_gravado::text AS "noGravado",
                  total::text
             FROM tax_transactions WHERE id = $1 AND company_id = $2`,
          [taxTransactionId, tenant.companyId],
        );
        if (cabecera.rowCount === 0) throw notFound('Comprobante no encontrado');

        const renglones = await tx.query(
          `SELECT l.id, l.line_no AS "linea", l.product_id AS "productoId",
                  p.code AS "productoCodigo", l.descripcion,
                  l.cantidad::text, l.unidad, l.precio_unitario::text AS "precioUnitario",
                  l.descuento::text, l.tratamiento, l.neto::text, l.iva::text
             FROM tax_transaction_lines l
             LEFT JOIN products p ON p.id = l.product_id AND p.company_id = l.company_id
            WHERE l.tax_transaction_id = $1 AND l.company_id = $2
            ORDER BY l.line_no`,
          [taxTransactionId, tenant.companyId],
        );

        return {
          cabecera: cabecera.rows[0],
          renglones: renglones.rows,
          /**
           * Que no haya renglones no es un defecto del comprobante. Va dicho en
           * la respuesta y no en la documentación porque es donde lo lee quien
           * se pregunta por qué la tabla está vacía.
           */
          alcance:
            renglones.rowCount === 0
              ? 'Este comprobante no tiene detalle cargado. Es válido igual: la cabecera es lo ' +
                'que declara el papel. El detalle hace falta para margen y stock, no para el IVA.'
              : 'La suma de los renglones coincide con la cabecera: lo verifica la base al confirmar.',
        };
      },
    );
  });

  /**
   * Reemplaza el detalle completo de un comprobante.
   *
   * Se reemplaza entero y no se editan renglones sueltos por una razón
   * aritmética: los renglones tienen que cerrar contra la cabecera, y una
   * edición parcial pasa por estados intermedios que no cierran. Mandar el
   * detalle completo hace que la transacción entera sea el paso, y el candado
   * diferido la verifica una sola vez al confirmar.
   *
   * Enviar una lista vacía borra el detalle. Es legítimo: alguien lo cargó mal
   * y prefiere quedarse sin detalle antes que con uno falso.
   */
  app.put('/tax-transactions/:taxTransactionId/lines', async (request) => {
    const tenant = await requireCompany(request);
    // Mismo permiso que registrar la operación: es el mismo hecho, con más
    // detalle. Un permiso propio dejaría a quien registra sin poder detallar.
    requirePermission(tenant, 'journal_entry:create');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    const cantidad = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Cantidad con hasta cuatro decimales');
    const precio = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Precio con hasta cuatro decimales');
    const monto = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Importe con hasta dos decimales');

    const body = z
      .object({
        renglones: z
          .array(
            z.object({
              productoId: z.string().uuid().nullish(),
              descripcion: z.string().min(1).max(500),
              cantidad,
              unidad: z.string().min(1).max(30).default('UNIDAD'),
              precioUnitario: precio,
              descuento: monto.default('0'),
              tratamiento: z.enum(['GRAVADO', 'EXENTO', 'NO_GRAVADO']).default('GRAVADO'),
              neto: monto,
              iva: monto.default('0'),
            }),
          )
          .max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const existe = await tx.query(
            'SELECT 1 FROM tax_transactions WHERE id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId],
          );
          if (existe.rowCount === 0) throw notFound('Comprobante no encontrado');

          await tx.query(
            'DELETE FROM tax_transaction_lines WHERE tax_transaction_id = $1 AND company_id = $2',
            [taxTransactionId, tenant.companyId],
          );

          let linea = 0;
          for (const r of body.renglones) {
            linea += 1;
            await tx.query(
              `INSERT INTO tax_transaction_lines
                 (company_id, tax_transaction_id, line_no, product_id, descripcion,
                  cantidad, unidad, precio_unitario, descuento, tratamiento, neto, iva)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [
                tenant.companyId, taxTransactionId, linea, r.productoId ?? null,
                r.descripcion, r.cantidad, r.unidad, r.precioUnitario,
                r.descuento, r.tratamiento, r.neto, r.iva,
              ],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DETALLAR_COMPROBANTE',
            objectType: 'tax_transactions',
            objectId: taxTransactionId,
            newValue: { renglones: body.renglones.length },
            motivo:
              body.renglones.length === 0
                ? 'Se borra el detalle del comprobante'
                : 'Se carga el detalle del comprobante',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return { taxTransactionId, renglones: body.renglones.length };
        },
      );
    } catch (error) {
      const fallo = error as { code?: string; message?: string };
      const mensaje = fallo.message ?? '';
      if (mensaje.includes('no cierran con la cabecera')) {
        throw unprocessable(
          'RENGLONES_NO_CIERRAN',
          'La suma de los renglones no da los totales del comprobante. Cada tratamiento ' +
            'suma en su columna: lo gravado al neto, lo exento al exento, lo no gravado al ' +
            'no gravado. Sin tolerancia: un peso de diferencia es un concepto que falta.',
        );
      }
      if (mensaje.includes('ya funda un asiento aprobado')) {
        throw conflictoTipado(
          'COMPROBANTE_IMPUTADO',
          'El comprobante ya funda un asiento aprobado: su detalle no se edita. ' +
            'La corrección va por contraasiento.',
        );
      }
      if (fallo.code === '23503') {
        throw notFound('Alguno de los productos no existe en esta empresa');
      }
      throw error;
    }
  });
}

/**
 * Del vocabulario de ARCA al de `tax_transactions.constatacion`.
 *
 * `WARN` es el caso que obliga a mirar: el WSCDC puede responder aprobado **y**
 * observado a la vez —el manual muestra `Resultado=A` con `Obs 200`—, y guardar
 * eso como `OK` a secas perdería la observación justo donde importa.
 */
function traducirEstado(resultado: {
  estado: string;
  observaciones: readonly unknown[];
}): 'OK' | 'WARN' | 'FAIL' | 'NO_VERIFICABLE' {
  if (resultado.estado === 'RECHAZADO') return 'FAIL';
  if (resultado.estado === 'NO_VERIFICABLE') return 'NO_VERIFICABLE';
  return resultado.observaciones.length > 0 ? 'WARN' : 'OK';
}
