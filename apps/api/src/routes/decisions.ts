/**
 * Decisiones contables — el punto donde el sistema deja escrito por qué.
 *
 * Hasta ahora `accounting_decisions` existía y estaba probada, y ningún código
 * productivo la escribía. Esto la conecta.
 *
 * ## Qué hace, exactamente
 *
 * `POST /comprobantes/:taxTransactionId/decision` corre el circuito sobre una
 * operación fiscal que ya existe: junta los hechos documentales, los
 * tributarios, busca la afectación declarada, consulta las reglas **ACTIVE** que
 * cubran el caso, y registra la decisión que resulte — sea cual sea.
 *
 * **Siempre queda una decisión.** También cuando no hay regla, cuando falta un
 * hecho y cuando el resultado es "esto lo mira una persona". Esa es justamente la
 * información que hoy se perdía: el sistema sabía que no podía decidir y no lo
 * anotaba en ningún lado.
 *
 * Lo que **no** hace es inventar una decisión donde no hubo ninguna. No se emite
 * una fila por cada comprobante que entra al sistema: se emite cuando alguien
 * pide decidir sobre uno.
 *
 * ## No crea asientos
 *
 * Decidir y registrar son actos distintos y de personas distintas. El asiento
 * se crea por `POST /journal-entries` citando `decisionId`, y ahí la base
 * comprueba que la decisión sea de la misma empresa y no sea de ambiente PRUEBA.
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';
import {
  decidir,
  type ComprobanteNormalizado,
  type HechoConOrigen,
  type ResultadoDeRegla,
  type Revision,
} from '@aai/accounting-engine';
import { moneyFromDecimalString } from '@aai/shared';
import { HECHO_VINCULACION, proveerVinculacion, type DeclaracionDeAfectacion } from '@aai/tax-engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, conflictoTipado, notFound } from '../http/errors.js';

const cuerpo = z
  .object({
    /**
     * Una decisión que la persona toma por su cuenta, sin regla que la funde.
     * Exige justificación: es el caso "esto lo resuelvo yo y explico por qué".
     */
    manual: z
      .object({
        justificacion: z.string().min(30, 'La justificación tiene que decir por qué, no "ok"'),
        resultado: z.enum(['PROPUESTA_DE_ASIENTO', 'SIN_EFECTO']),
      })
      .optional(),
    /** Marca la decisión como de prueba: puede citar reglas no activas y no funda asientos. */
    ambiente: z.enum(['PRODUCTIVO', 'PRUEBA']).default('PRODUCTIVO'),
  })
  .default({ ambiente: 'PRODUCTIVO' });

interface FilaOperacion {
  id: string;
  document_id: string | null;
  direction: 'COMPRAS' | 'VENTAS';
  cbte_tipo: number;
  punto_venta: number;
  cbte_numero: string;
  cbte_fecha: string;
  cuit_contraparte: string;
  razon_social: string | null;
  neto: string;
  iva: string;
  total: string;
  constatacion: string;
}

function normalizar(fila: FilaOperacion, companyId: string): ComprobanteNormalizado {
  return {
    taxTransactionId: fila.id,
    documentId: fila.document_id,
    companyId,
    direccion: fila.direction,
    cuitContraparte: fila.cuit_contraparte,
    razonSocial: fila.razon_social,
    cbteTipo: fila.cbte_tipo,
    // La letra sale del catálogo de tipos, que hoy no tiene la vigencia
    // verificada. Se deja en null en vez de deducirla del código.
    letra: null,
    puntoVenta: fila.punto_venta,
    numero: Number(fila.cbte_numero),
    fecha: fila.cbte_fecha,
    moneda: 'ARS',
    // Las columnas son numeric(18,2): pesos con dos decimales, NO centavos.
    // Convertirlas con BigInt() falla, y hacerlo a mano invitaba a perder el
    // punto decimal en silencio.
    neto: moneyFromDecimalString(fila.neto, 'ARS'),
    iva: moneyFromDecimalString(fila.iva, 'ARS'),
    total: moneyFromDecimalString(fila.total, 'ARS'),
    cae: null,
    caeVencimiento: null,
  };
}

/** El sello fiscal, traducido del catálogo de `tax_transactions.constatacion`. */
function sello(constatacion: string): { estado: 'APROBADO' | 'RECHAZADO' | 'NO_VERIFICABLE'; motivo: string | null } {
  if (constatacion === 'OK') return { estado: 'APROBADO', motivo: null };
  if (constatacion === 'FAIL') return { estado: 'RECHAZADO', motivo: 'La constatación devolvió FAIL' };
  return { estado: 'NO_VERIFICABLE', motivo: constatacion };
}

/** La afectación declarada, leída de la vista — nunca de la tabla. */
async function afectacionDeclarada(
  tx: Tx,
  taxTransactionId: string,
): Promise<DeclaracionDeAfectacion | null> {
  const r = await tx.query<{
    company_id: string;
    tax_transaction_id: string;
    afectacion: DeclaracionDeAfectacion['afectacion'];
    proporcion_gravada: number | null;
    declarada_por: string;
    declarada_at: Date;
    evidencia: DeclaracionDeAfectacion['evidencia'];
  }>(
    `SELECT company_id, tax_transaction_id, afectacion, proporcion_gravada,
            declarada_por, declarada_at, evidencia
       FROM tax_affectations_declaradas WHERE tax_transaction_id = $1`,
    [taxTransactionId],
  );
  const f = r.rows[0];
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

export async function decisionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/comprobantes/:taxTransactionId/decision', async (request, reply) => {
    const tenant = await requireCompany(request);
    // Decidir el tratamiento de un comprobante es un acto contable, no de carga.
    requirePermission(tenant, 'journal_entry:create');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);
    const body = cuerpo.parse(request.body ?? {});

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const operacion = await tx.query<FilaOperacion>(
        `SELECT id, document_id, direction, cbte_tipo, punto_venta, cbte_numero::text,
                cbte_fecha::text, cuit_contraparte, razon_social,
                neto::text, iva::text, total::text, constatacion
           FROM tax_transactions WHERE id = $1`,
        [taxTransactionId],
      );
      // El RLS ya filtró: una operación de otra empresa no aparece, y "no
      // aparece" es lo mismo que "no existe" desde acá.
      if (operacion.rowCount === 0) throw notFound('Operación fiscal no encontrada');

      // ── Idempotencia ────────────────────────────────────────────────────
      // Una decisión vigente por operación. Volver a pedir no emite otra: la
      // segunda decisión sería indistinguible de la primera y las dos dirían ser
      // "la" razón del asiento.
      const previa = await tx.query<{ id: string; estado: string }>(
        `SELECT id, estado FROM accounting_decisions
          WHERE tax_transaction_id = $1 AND estado <> 'SUPERSEDIDA'
          ORDER BY decidida_at DESC LIMIT 1`,
        [taxTransactionId],
      );
      if (Number(previa.rowCount) > 0) {
        reply.code(200);
        return { decisionId: previa.rows[0]!.id, yaExistia: true, estado: previa.rows[0]!.estado };
      }

      const normalizado = normalizar(operacion.rows[0]!, tenant.companyId);

      // ── Hechos profesionales ────────────────────────────────────────────
      const declaracion = await afectacionDeclarada(tx, taxTransactionId);
      const provision = proveerVinculacion(declaracion);
      const hechosProfesionales: HechoConOrigen[] = [];
      const revisionesPrevias: Revision[] = [];

      if (provision.estado === 'PROVISTO') {
        hechosProfesionales.push({
          campo: HECHO_VINCULACION,
          valor: provision.valor,
          origen: 'PROFESIONAL',
          fuente: `declaración de ${provision.declaracion.declaradaPor} el ${provision.declaracion.declaradaAt}`,
        });
      } else if (provision.estado === 'REQUIERE_REVISION') {
        revisionesPrevias.push({ motivo: 'REQUIERE_PRORRATEO', detalle: provision.explicacion });
      } else {
        revisionesPrevias.push({
          motivo: 'SIN_HECHO_REQUERIDO',
          detalle:
            `No hay declaración de afectación para esta operación (${provision.motivo}). ` +
            'El hecho no se deduce del comprobante: lo declara quien conoce la operación.',
        });
      }

      // ── Reglas ──────────────────────────────────────────────────────────
      // Solo ACTIVE. Es el mismo filtro que usa el resto del sistema y no se
      // toca: una regla en DRAFT no funda nada productivo.
      // Por CLAVE, no por dominio.
      //
      // La primera versión buscaba "toda regla ACTIVE de dominio tax en AR" y
      // levantó una regla de fixture llamada `R-fvxfyie5`. El motor normativo
      // resuelve por `ruleKey` justamente por eso: qué reglas gobiernan un caso
      // es una decisión del diseño, no el resultado de un filtro amplio que
      // cualquier fila nueva puede colarse.
      //
      // La lista es corta porque hay una sola regla cargada. Crece cuando se
      // carguen más, y crecerla es un acto deliberado.
      const CLAVES_APLICABLES = ['AR-IVA-CF-VINCULACION-001'] as const;

      const reglas = await tx.query<{
        id: string;
        rule_key: string;
        version: number;
        status: string;
      }>(
        `SELECT r.id, r.rule_key, r.version, r.status
           FROM accounting_rules r
          WHERE r.rule_key = ANY($2)
            AND r.status = 'ACTIVE'
            AND r.valid_from <= $1::date
            AND (r.valid_to IS NULL OR r.valid_to >= $1::date)`,
        [normalizado.fecha, CLAVES_APLICABLES],
      );

      const resultadosDeRegla: ResultadoDeRegla[] = reglas.rows.map((r) => ({
        ruleKey: r.rule_key,
        version: r.version,
        estado: 'APLICADA',
        motivo: 'Vigente y aplicable a la fecha del comprobante',
        cita: null,
      }));

      const esManual = body.manual !== undefined;

      const decision = decidir(
        {
          comprobante: normalizado,
          sello: sello(operacion.rows[0]!.constatacion),
          hechosProfesionales,
          reglas: resultadosDeRegla,
          revisionesPrevias,
        },
        // El armador de renglones va vacío **acá a propósito**, y desde la
        // 0074 con un motivo distinto del que tenía antes.
        //
        // Antes salía vacío porque no existía dónde estuviera declarado a qué
        // cuenta va cada cosa. Ahora existe (`company_account_map`), y los
        // renglones se arman en `GET /tax-transactions/:id/asiento-propuesto`,
        // que los recalcula cuando alguien los pide.
        //
        // No se arman en esta transacción por una razón: acá se **registra una
        // decisión**, que es un hecho con firma, y una propuesta no lo es. Si
        // se guardara junto a la decisión quedaría congelada contra un mapeo
        // que puede cambiar mañana, y habría dos respuestas distintas a «qué
        // asiento propone este comprobante».
        () => [],
        actorId,
      );

      // Una decisión manual dice lo que la persona resolvió, no lo que el
      // circuito dedujo. Los hechos igual se conservan: son el contexto en que
      // esa persona decidió.
      const resultado = esManual ? body.manual!.resultado : decision.estado;
      const origen = esManual ? 'MANUAL' : 'DETERMINISTICA';
      const motivos = esManual ? [] : decision.revisiones;

      if (!esManual && decision.estado === 'PROPUESTA_DE_ASIENTO' && resultadosDeRegla.length === 0) {
        // No debería poder pasar —`decidir` exige una regla aplicada— pero si
        // pasara, se corta acá antes de escribir una fila que el trigger va a
        // rechazar con un mensaje menos claro.
        throw conflict('Una propuesta automática sin regla aplicada no se registra');
      }

      const evidencia = [
        { tipo: 'COMPROBANTE', id: taxTransactionId },
        ...(declaracion === null ? [] : [{ tipo: 'DECLARACION_PROFESIONAL', id: taxTransactionId }]),
      ];

      const fila = await tx.query<{ id: string }>(
        `INSERT INTO accounting_decisions
           (company_id, tax_transaction_id, document_id, origen, resultado,
            motivos, hechos, evidencia, ambiente, decidida_por, justificacion)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)
         ON CONFLICT (tax_transaction_id)
           WHERE tax_transaction_id IS NOT NULL AND estado <> 'SUPERSEDIDA'
           DO NOTHING
         RETURNING id`,
        [
          tenant.companyId,
          taxTransactionId,
          operacion.rows[0]!.document_id,
          origen,
          resultado,
          JSON.stringify(motivos),
          JSON.stringify(decision.hechos),
          JSON.stringify(evidencia),
          body.ambiente,
          actorId,
          esManual ? body.manual!.justificacion : null,
        ],
      );
      // El conflicto lo ganó otro pedido concurrente. Antes de la 0036 esto no
      // chocaba: quedaban dos decisiones vigentes, cada una diciendo ser "la"
      // razón del asiento. Ahora la base lo impide y acá se contesta lo mismo
      // que si el pedido hubiera llegado después.
      if (Number(fila.rowCount) === 0) {
        const ganadora = await tx.query<{ id: string; estado: string }>(
          `SELECT id, estado FROM accounting_decisions
            WHERE tax_transaction_id = $1 AND estado <> 'SUPERSEDIDA'`,
          [taxTransactionId],
        );
        reply.code(200);
        return {
          decisionId: ganadora.rows[0]!.id,
          yaExistia: true,
          estado: ganadora.rows[0]!.estado,
        };
      }

      const decisionId = fila.rows[0]!.id;

      // ── Aplicaciones de regla ───────────────────────────────────────────
      // Solo si hubo regla. Una decisión manual NO genera ninguna: el trigger lo
      // impide, y acá directamente no se intenta.
      if (!esManual) {
        for (const r of reglas.rows) {
          await tx.query(
            `INSERT INTO rule_applications
               (company_id, rule_id, rule_version, target_type, target_id, decision_id,
                inputs, outputs)
             VALUES ($1,$2,$3,'tax_transaction',$4,$5,$6::jsonb,$7::jsonb)`,
            [
              tenant.companyId,
              r.id,
              r.version,
              taxTransactionId,
              decisionId,
              JSON.stringify(Object.fromEntries(decision.hechos.map((h) => [h.campo, h.valor]))),
              JSON.stringify({ resultado }),
            ],
          );
        }
      }

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'DECISION_REGISTRADA',
        objectType: 'accounting_decisions',
        objectId: decisionId,
        newValue: { resultado, origen, ambiente: body.ambiente, reglas: reglas.rowCount },
        ...(esManual ? { motivo: body.manual!.justificacion } : {}),
      });

      reply.code(201);
      return {
        decisionId,
        resultado,
        origen,
        ambiente: body.ambiente,
        reglasAplicadas: reglas.rows.map((r) => ({ ruleKey: r.rule_key, version: r.version })),
        motivos,
        hechos: decision.hechos,
        // Sin regla no hay clave de regla, y se dice con `null` en vez de omitir
        // el campo: omitirlo dejaría al lector adivinando si hubo o no.
        ruleKey: reglas.rows[0]?.rule_key ?? null,
      };
    });
  });

  app.get('/comprobantes/:taxTransactionId/decision', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT d.id, d.origen, d.resultado, d.ambiente, d.estado, d.motivos, d.hechos,
                  d.evidencia, d.justificacion, d.decidida_por AS "decididaPor",
                  d.decidida_at AS "decididaAt",
                  (SELECT json_agg(json_build_object(
                      'ruleKey', r2.rule_key, 'version', ra.rule_version,
                      'sha256', ra.norm_document_sha256,
                      'estadoAlAplicar', ra.rule_status_at_application))
                     FROM rule_applications ra
                     JOIN accounting_rules r2 ON r2.id = ra.rule_id
                    WHERE ra.decision_id = d.id) AS reglas,
                  (SELECT e.id FROM journal_entries e WHERE e.decision_id = d.id LIMIT 1) AS "entryId"
             FROM accounting_decisions d
            WHERE d.tax_transaction_id = $1 AND d.estado <> 'SUPERSEDIDA'
            ORDER BY d.decidida_at DESC LIMIT 1`,
          [taxTransactionId],
        );
        if (r.rowCount === 0) throw notFound('No hay decisión registrada para esa operación');
        return r.rows[0];
      },
    );
  });

  /**
   * Corregir una decisión: emitir la que la reemplaza.
   *
   * Hasta esta fase el modelo soportaba la corrección —`supersedes_id`, el
   * estado `SUPERSEDIDA`, el índice de una sola vigente— y **no había ruta**:
   * el único camino era un UPDATE a mano. Una operación quedaba con la decisión
   * que se le hubiera puesto primero, para siempre, salvo que alguien entrara
   * por `psql`.
   *
   * ## Corregir no es editar
   *
   * La decisión anterior no se toca en su contenido: pasa a `SUPERSEDIDA` y
   * queda encadenada. El asiento que la citó sigue mostrando exactamente lo que
   * citó, que es lo que un tercero necesita para entender por qué se asentó lo
   * que se asentó **entonces**.
   *
   * Lo que sí cambia es hacia adelante: desde la 0044 una decisión supersedida
   * **no puede fundar un asiento nuevo**. Sin ese candado la corrección era una
   * anotación optativa.
   *
   * ## El orden importa, y lo impone la base
   *
   * Primero se apaga la anterior, después entra la nueva. Al revés choca contra
   * `accounting_decisions_una_vigente`, y el mensaje sería una violación de
   * unicidad en vez de decir qué pasó. Es el mismo orden que las notas
   * aprendieron en su momento.
   */
  app.post<{ Params: { taxTransactionId: string } }>(
    '/comprobantes/:taxTransactionId/decision/supersede',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'decision:supersede');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { taxTransactionId } = z
        .object({ taxTransactionId: z.string().uuid() })
        .parse(request.params);

      const body = z
        .object({
          /**
           * Qué cambió y por qué. Mínimo 30 caracteres, igual que la constancia
           * del §32: «se corrigió» no dice nada que sirva dentro de dos años.
           */
          motivo: z.string().min(30, 'El motivo tiene que decir qué cambió, no "se corrigió"'),
          resultado: z.enum(['PROPUESTA_DE_ASIENTO', 'SIN_EFECTO', 'REQUIERE_REVISION']),
          /** La decisión que se corrige. Se exige para no corregir la equivocada. */
          supersedeId: z.string().uuid(),
        })
        .parse(request.body);

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const vigente = await tx.query<{
          id: string;
          estado: string;
          origen: string;
          resultado: string;
          hechos: unknown;
          evidencia: unknown;
          motivos: unknown;
        }>(
          `SELECT id, estado, origen, resultado, hechos, evidencia, motivos
             FROM accounting_decisions
            WHERE tax_transaction_id = $1 AND estado <> 'SUPERSEDIDA'`,
          [taxTransactionId],
        );
        if (vigente.rowCount === 0) {
          throw notFound('Esa operación no tiene una decisión vigente que corregir');
        }

        // Se corrige la que quien pide dice corregir, o no se corrige nada. Sin
        // esta comparación, dos personas trabajando a la vez podrían pisar una
        // decisión que la otra acaba de emitir sin haberla visto.
        if (vigente.rows[0]!.id !== body.supersedeId) {
          throw conflictoTipado(
            'DECISION_CAMBIO',
            `La decisión vigente de esa operación es ${vigente.rows[0]!.id} y el pedido dice ` +
              `corregir la ${body.supersedeId}. Volvé a leerla antes de corregirla.`,
            { vigente: vigente.rows[0]!.id },
          );
        }

        // 1 · Apagar la anterior. El trigger de inmutabilidad admite este cambio
        //     de estado y ningún otro si la decisión ya fundamenta un asiento.
        await tx.query(
          `UPDATE accounting_decisions SET estado = 'SUPERSEDIDA' WHERE id = $1`,
          [body.supersedeId],
        );

        // 2 · Emitir la nueva. Es MANUAL por construcción: una corrección la
        //     resuelve una persona. Si el motor volviera a resolver lo mismo,
        //     no habría nada que corregir.
        const nueva = await tx.query<{ id: string; decidida_at: string }>(
          `INSERT INTO accounting_decisions
             (company_id, tax_transaction_id, origen, resultado, motivos, hechos, evidencia,
              ambiente, decidida_por, justificacion, supersedes_id)
           VALUES ($1, $2, 'MANUAL', $3, $4::jsonb, $5::jsonb, $6::jsonb,
                   'PRODUCTIVO', $7, $8, $9)
           RETURNING id, decidida_at::text`,
          [
            tenant.companyId,
            taxTransactionId,
            body.resultado,
            // Los motivos de la anterior no se arrastran: eran de otra decisión.
            // Una corrección REQUIERE_REVISION lleva el suyo, que es el motivo.
            body.resultado === 'REQUIERE_REVISION'
              ? JSON.stringify([{ motivo: 'CORRECCION_PROFESIONAL', detalle: body.motivo }])
              : '[]',
            // Los hechos y la evidencia sí se conservan: son el contexto en que
            // se decidió, y no cambiaron porque alguien haya cambiado de
            // criterio. Copiarlos es más honesto que dejarlos vacíos.
            JSON.stringify(vigente.rows[0]!.hechos),
            JSON.stringify(vigente.rows[0]!.evidencia),
            actorId,
            body.motivo,
            body.supersedeId,
          ],
        );

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'DECISION_CORREGIDA',
          objectType: 'accounting_decisions',
          objectId: nueva.rows[0]!.id,
          oldValue: {
            id: body.supersedeId,
            estado: vigente.rows[0]!.estado,
            resultado: vigente.rows[0]!.resultado,
            origen: vigente.rows[0]!.origen,
          },
          newValue: {
            id: nueva.rows[0]!.id,
            estado: 'EMITIDA',
            resultado: body.resultado,
            origen: 'MANUAL',
            supersedes: body.supersedeId,
          },
          motivo: body.motivo,
          ip: clientIp(request),
          userAgent: request.headers['user-agent'] ?? null,
        });

        reply.code(201);
        return {
          decisionId: nueva.rows[0]!.id,
          supersede: body.supersedeId,
          resultado: body.resultado,
          decididaAt: nueva.rows[0]!.decidida_at,
          /**
           * La anterior no desaparece. Se dice en la respuesta porque es la
           * pregunta que sigue: «¿y la que estaba?».
           */
          anterior: {
            id: body.supersedeId,
            estado: 'SUPERSEDIDA',
            nota:
              'Se conserva. El asiento que la citó sigue mostrándola, y desde la 0044 ya no ' +
              'puede fundar un asiento nuevo.',
          },
        };
      });
    },
  );

  /**
   * El historial de decisiones de una operación, de la más nueva a la más vieja.
   *
   * Existe porque la corrección solo sirve si se puede leer: una cadena de
   * `supersedes_id` guardada y no consultable es un dato que nadie va a mirar.
   */
  app.get<{ Params: { taxTransactionId: string } }>(
    '/comprobantes/:taxTransactionId/decision/historial',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'journal_entry:read');
      const auth = requireAuth(request);
      const { taxTransactionId } = z
        .object({ taxTransactionId: z.string().uuid() })
        .parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const operacion = await tx.query('SELECT id FROM tax_transactions WHERE id = $1', [
            taxTransactionId,
          ]);
          if (operacion.rowCount === 0) throw notFound('Operación fiscal no encontrada');

          const filas = await tx.query(
            `SELECT d.id, d.estado, d.origen, d.resultado, d.ambiente,
                    d.decidida_por AS "decididaPor", d.decidida_at::text AS "decididaAt",
                    d.justificacion, d.supersedes_id::text AS "supersede",
                    (SELECT count(*)::int FROM journal_entries e WHERE e.decision_id = d.id) AS "asientos"
               FROM accounting_decisions d
              WHERE d.tax_transaction_id = $1
              ORDER BY d.decidida_at DESC`,
            [taxTransactionId],
          );

          return {
            vigente: filas.rows.find((f) => (f as { estado: string }).estado !== 'SUPERSEDIDA') ?? null,
            historial: filas.rows,
          };
        },
      );
    },
  );
}
