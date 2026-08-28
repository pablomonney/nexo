/**
 * Notas complementarias (Ley 19.550, art. 65).
 *
 * ## La dirección
 *
 * ```
 * CONTABILIDAD → NOTA
 * ```
 *
 * Nunca al revés. Una nota **explica** algo ya registrado; no funda un asiento,
 * ni una decisión, ni una regla, y no altera ningún saldo. Eso no se sostiene
 * revisando este archivo: se sostiene en que una cifra de nota solo se puede
 * construir apuntando a un renglón de un estado ya emitido —`note_figures.
 * statement_line_id` es `NOT NULL`— y en que `notes` no tiene ninguna llave
 * hacia el Diario con la que pudiera tocarlo.
 *
 * ## Qué decide cada capa
 *
 * - `proponerNotas` (motor, puro) decide **qué notas se pueden sostener** y con
 *   qué evidencia. Es determinística: mismas cifras, mismo texto, mismo orden.
 * - `verificarNotas` (motor, puro) decide si el juego es coherente con el estado.
 * - Esto escribe, firma y deja el rastro.
 *
 * Ningún `if` sobre contenido contable vive acá.
 *
 * ## Los tres estados de evidencia
 *
 * `status` es el trámite —quién firmó—; `evidencia` es qué la sostiene. Son ejes
 * distintos y lo único que los liga es que **una nota sin evidencia no se
 * aprueba**: no hay nada detrás que firmar. Lo hace valer un CHECK de la 0040,
 * no este archivo.
 *
 * ## Lo que este archivo se niega a hacer
 *
 * Redactar lo que no puede sostener. Cuando la evidencia no alcanza, la nota se
 * crea `INSUFFICIENT_EVIDENCE`, **sin texto**, con el faltante escrito. Un
 * párrafo plausible sobre bienes de uso que el sistema no tiene sería
 * exactamente lo contrario de lo que estas notas existen para lograr.
 */

import {
  cifrasDeLasNotas,
  notasNoGenerables,
  proponerNotas,
  verificarNotas,
  type BloqueDeNota,
  type CifraDeNota,
  type EstadoContable,
  type Nota,
  type NotaPropuesta,
} from '@aai/financial-statements';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import { moneyFromDecimalString, toDecimalString, type Currency } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflictoTipado, notFound, unprocessable } from '../http/errors.js';
import { armarEstado } from './statements.js';

export async function noteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Propone el juego de notas de un estado emitido y lo guarda como borrador.
   *
   * Sobre un estado **emitido**, no sobre uno que se recalcula: las cifras de la
   * nota apuntan a renglones concretos, y un renglón que todavía puede cambiar
   * no es un respaldo. Es la misma razón por la que `note_figures` referencia
   * `financial_statement_lines` y no una cuenta.
   */
  app.post<{ Params: { statementId: string } }>(
    '/statements/:statementId/notes/generate',
    async (request, reply) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'note:write');
      const auth = requireAuth(request);
      const actorId = `user:${auth.user.userId}`;
      const { statementId } = paramsSchema.parse(request.params);
      const body = z
        .object({
          /** Renglones a desagregar por cuenta. Los elige quien pide las notas. */
          rubros: z.array(z.string().min(1).max(60)).max(30).default([]),
        })
        .parse(request.body ?? {});

      return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
        const emitido = await cargarEmitido(tx, tenant.companyId, statementId);
        if (emitido.notasVigentes > 0) {
          throw conflictoTipado(
            'NOTAS_YA_GENERADAS',
            `El estado ya tiene ${emitido.notasVigentes} nota(s). Corregir una nota es emitir una versión nueva, no volver a generar el juego.`,
          );
        }

        // El estado se reconstruye desde el Mayor con la misma plantilla y la
        // misma fecha de corte con que se emitió. Las cifras de la nota van a
        // apuntar a los renglones GUARDADOS, así que abajo se verifica que los
        // dos coincidan antes de escribir nada.
        const armado = await armarEstado(tx, tenant.companyId, {
          ejercicio: emitido.fiscalYearId,
          tipo: emitido.tipo,
        });

        const propuestas = proponerNotas(armado.estado, {
          marco: armado.plantilla.marco,
          articulo: armado.plantilla.articulo,
          moneda: armado.estado.moneda,
          rubrosADesagregar: body.rubros,
        });

        const renglones = await tx.query<{ id: string; line_code: string; amount: string }>(
          `SELECT id, line_code, amount::text FROM financial_statement_lines
            WHERE statement_id = $1`,
          [statementId],
        );
        const porCodigo = new Map(renglones.rows.map((fila) => [fila.line_code, fila]));

        const guardadas: { numero: number; tipo: string; evidencia: string; cifras: number }[] = [];
        for (const propuesta of propuestas) {
          const nota = await tx.query<{ id: string }>(
            `INSERT INTO notes
               (company_id, statement_id, numero, titulo, body_blocks, fundamento,
                generated_by, status, note_type, evidencia, created_by)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'RULE', 'BORRADOR', $7, $8, $9)
             RETURNING id`,
            [
              tenant.companyId,
              statementId,
              propuesta.numero,
              propuesta.titulo,
              JSON.stringify(serializarBloques(propuesta.bloques)),
              `${propuesta.fundamento} — ${propuesta.motivo}`,
              propuesta.tipo,
              propuesta.evidencia,
              actorId,
            ],
          );

          const cifras = await escribirCifras(
            tx,
            tenant.companyId,
            nota.rows[0]!.id,
            propuesta,
            porCodigo,
          );
          guardadas.push({
            numero: propuesta.numero,
            tipo: propuesta.tipo,
            evidencia: propuesta.evidencia,
            cifras,
          });
        }

        await recordAudit(tx, tenant.companyId, {
          actorType: 'USER',
          actorId,
          action: 'NOTAS_GENERADAS',
          objectType: 'financial_statements',
          objectId: statementId,
          ip: clientIp(request),
          newValue: { notas: guardadas.length, detalle: guardadas },
        });

        reply.code(201);
        return {
          statementId,
          notas: guardadas,
          // Lo que el sistema NO puede proponer, con lo que le falta a cada una.
          // Se devuelve en vez de omitirse: una nota ausente y una imposible se
          // ven igual —no está— y mandan a hacer cosas distintas.
          noGenerables: notasNoGenerables(),
        };
      });
    },
  );

  /**
   * Aprueba una nota. Es el acto por el que alguien se hace cargo de lo que dice.
   *
   * Una nota `INSUFFICIENT_EVIDENCE` no se puede aprobar y lo impide la base
   * (`notes_no_se_aprueba_sin_evidencia`). Acá se contesta un error legible en
   * vez de dejar que salga una excepción de PostgreSQL.
   */
  app.post<{ Params: { noteId: string } }>('/notes/:noteId/approve', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'note:write');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.params);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const nota = await leerNota(tx, noteId);
      if (nota.status !== 'BORRADOR') {
        throw conflictoTipado(
          'NOTA_NO_ES_BORRADOR',
          `La nota ${nota.numero} está ${nota.status}: solo se aprueba un borrador.`,
        );
      }
      if (nota.evidencia === 'INSUFFICIENT_EVIDENCE') {
        throw unprocessable(
          'INSUFFICIENT_EVIDENCE',
          `La nota ${nota.numero} no tiene evidencia suficiente: ${nota.fundamento}. ` +
            'Aprobarla sería firmar algo que el sistema no puede sostener.',
        );
      }

      await tx.query(
        `UPDATE notes SET status = 'APROBADA', approved_by = $2, approved_at = now()
          WHERE id = $1`,
        [noteId, actorId],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'NOTA_APROBADA',
        objectType: 'notes',
        objectId: noteId,
        oldValue: { status: nota.status },
        newValue: { status: 'APROBADA', evidencia: nota.evidencia },
        ip: clientIp(request),
      });

      return { noteId, numero: nota.numero, status: 'APROBADA', evidencia: nota.evidencia };
    });
  });

  /**
   * Emite una versión nueva de una nota aprobada.
   *
   * Es el único camino para corregirla: la 0040 hace inmutable el contenido de
   * una nota aprobada. Quedan las dos, encadenadas por `supersedes_id`, y el
   * motivo dice qué cambió — «se actualizó» no es un motivo.
   */
  app.post<{ Params: { noteId: string } }>('/notes/:noteId/revise', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'note:write');
    const auth = requireAuth(request);
    const actorId = `user:${auth.user.userId}`;
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        motivo: z.string().min(10).max(500),
        titulo: z.string().min(1).max(200).optional(),
        bloques: z.array(z.unknown()).optional(),
      })
      .parse(request.body);

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const anterior = await leerNota(tx, noteId);
      if (anterior.status === 'SUPERSEDIDA') {
        throw conflictoTipado(
          'NOTA_YA_SUPERSEDIDA',
          `La nota ${anterior.numero} ya fue reemplazada. Revisá la versión vigente.`,
        );
      }

      // La anterior pasa a SUPERSEDIDA **antes** de insertar la nueva: el índice
      // `notes_numero_vigente` admite un solo número no supersedido por estado,
      // así que insertar primero y superseder después hace chocar a la nota
      // consigo misma. Es la única transición que la 0040 le permite a una nota
      // aprobada, y es la que libera el número.
      await tx.query(`UPDATE notes SET status = 'SUPERSEDIDA' WHERE id = $1`, [noteId]);

      const nueva = await tx.query<{ id: string; version: number }>(
        `INSERT INTO notes
           (company_id, statement_id, numero, titulo, body_blocks, fundamento,
            generated_by, status, note_type, evidencia, created_by,
            version, supersedes_id, motivo_version)
         SELECT company_id, statement_id, numero,
                COALESCE($2, titulo), COALESCE($3::jsonb, body_blocks), fundamento,
                'HUMAN', 'BORRADOR', note_type, evidencia, $4,
                version + 1, id, $5
           FROM notes WHERE id = $1
         RETURNING id, version`,
        [
          noteId,
          body.titulo ?? null,
          body.bloques === undefined ? null : JSON.stringify(body.bloques),
          actorId,
          body.motivo,
        ],
      );

      // Las cifras se rehacen apuntando a los mismos renglones: siguen siendo
      // del mismo estado emitido, así que el respaldo no cambia.
      await tx.query(
        `INSERT INTO note_figures
           (company_id, note_id, orden, label, statement_line_id, amount, comparative_amount, lineage)
         SELECT company_id, $2, orden, label, statement_line_id, amount, comparative_amount, lineage
           FROM note_figures WHERE note_id = $1
          ORDER BY orden`,
        [noteId, nueva.rows[0]!.id],
      );

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'NOTA_VERSIONADA',
        objectType: 'notes',
        objectId: nueva.rows[0]!.id,
        oldValue: { noteId, version: anterior.version, status: anterior.status },
        newValue: { version: nueva.rows[0]!.version, supersedes: noteId },
        motivo: body.motivo,
        ip: clientIp(request),
      });

      reply.code(201);
      return {
        noteId: nueva.rows[0]!.id,
        version: nueva.rows[0]!.version,
        supersedes: noteId,
        numero: anterior.numero,
      };
    });
  });

  /**
   * El paquete: el estado, sus notas y si está completo.
   *
   * Contesta las tres preguntas de una emisión —de dónde salió este número, qué
   * nota lo explica, qué respalda esa nota— sin que quien consuma tenga que
   * rearmar el camino.
   */
  app.get<{ Params: { statementId: string } }>(
    '/statements/:statementId/package',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'statement:read');
      const auth = requireAuth(request);
      const { statementId } = paramsSchema.parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const paquete = await tx.query(
            `SELECT * FROM statement_package WHERE statement_id = $1`,
            [statementId],
          );
          if (paquete.rowCount === 0) throw notFound('No existe ese estado en esta empresa');

          const notas = await tx.query(
            `SELECT n.id, n.numero, n.titulo, n.note_type AS "tipo", n.evidencia, n.status,
                    n.version, n.supersedes_id AS "supersedes", n.motivo_version AS "motivoVersion",
                    n.fundamento, n.generated_by AS "generadaPor",
                    n.created_by AS "creadaPor", n.approved_by AS "aprobadaPor",
                    n.approved_at AS "aprobadaEl",
                    (SELECT count(*) FROM note_figures f WHERE f.note_id = n.id)::int AS "cifras"
               FROM notes n
              WHERE n.statement_id = $1
              ORDER BY n.numero, n.version`,
            [statementId],
          );

          const fila = paquete.rows[0] as Record<string, unknown>;
          const pendientes =
            Number(fila['notas_a_revisar'] ?? 0) + Number(fila['notas_sin_evidencia'] ?? 0);

          return {
            estado: fila,
            notas: notas.rows,
            // «Completo» acá significa: todas las notas vigentes están aprobadas
            // y ninguna quedó sin evidencia o pendiente de revisión.
            //
            // NO significa que estén todas las que la ley exige. El sistema no
            // sabe cuáles son obligatorias: las plantillas de los arts. 63 y 64
            // no declaran ninguna remisión a nota, y determinar la obligatoriedad
            // exige una fuente normativa que no está archivada.
            completo: pendientes === 0 && Number(fila['notas'] ?? 0) === Number(fila['notas_aprobadas'] ?? 0),
            obligatoriedad: 'REQUIRES_EXTERNAL_INPUT',
            motivoObligatoriedad:
              'Qué notas son legalmente obligatorias no está determinado: las plantillas sembradas ' +
              'no declaran remisiones y no hay fuente normativa archivada que enumere el juego mínimo. ' +
              'El paquete informa qué notas tiene, no que estén todas.',
          };
        },
      );
    },
  );

  /**
   * Verifica el juego de notas contra el estado reconstruido.
   *
   * Es el control cruzado del motor —remisiones en las dos direcciones, cifras
   * que apuntan a renglones que ya no existen, borradores de IA sin revisar—
   * corrido sobre lo que está guardado.
   */
  app.get<{ Params: { statementId: string } }>(
    '/statements/:statementId/notes/verify',
    async (request) => {
      const tenant = await requireCompany(request);
      requirePermission(tenant, 'statement:read');
      const auth = requireAuth(request);
      const { statementId } = paramsSchema.parse(request.params);

      return withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const emitido = await cargarEmitido(tx, tenant.companyId, statementId);
          const armado = await armarEstado(tx, tenant.companyId, {
            ejercicio: emitido.fiscalYearId,
            tipo: emitido.tipo,
          });

          const notas = await cargarNotas(tx, statementId);
          const resultado = verificarNotas(armado.estado, notas);

          return {
            statementId,
            consistente: resultado.consistente,
            errores: resultado.errores,
            cifras: cifrasDeLasNotas(notas).length,
          };
        },
      );
    },
  );
}

/** CCyC art. 325: moneda nacional. Mismo criterio que el resto del sistema. */
const MONEDA: Currency = 'ARS';

const paramsSchema = z.object({ statementId: z.string().uuid() });

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

interface EstadoEmitido {
  readonly fiscalYearId: string;
  readonly tipo: 'ESP' | 'ER';
  readonly notasVigentes: number;
}

async function cargarEmitido(
  tx: Tx,
  companyId: string,
  statementId: string,
): Promise<EstadoEmitido> {
  const result = await tx.query<{
    fiscal_year_id: string;
    statement_kind: 'ESP' | 'ER';
    status: string;
    notas: string;
  }>(
    `SELECT s.fiscal_year_id, s.statement_kind, s.status,
            (SELECT count(*) FROM notes n
              WHERE n.statement_id = s.id AND n.status <> 'SUPERSEDIDA')::text AS notas
       FROM financial_statements s
      WHERE s.id = $1 AND s.company_id = $2`,
    [statementId, companyId],
  );
  const fila = result.rows[0];
  // El RLS ya acotó a la empresa: un estado ajeno no llega hasta acá.
  if (fila === undefined) throw notFound('No existe ese estado en esta empresa');

  if (fila.status !== 'EMITIDO') {
    // Las cifras de una nota apuntan a renglones concretos. Un estado que
    // todavía puede cambiar no es un respaldo: la nota quedaría diciendo un
    // número que el estado ya no dice.
    throw conflictoTipado(
      'ESTADO_NO_EMITIDO',
      `El estado está ${fila.status}. Las notas se apoyan en renglones emitidos: emitilo primero.`,
    );
  }

  return {
    fiscalYearId: fila.fiscal_year_id,
    tipo: fila.statement_kind,
    notasVigentes: Number(fila.notas),
  };
}

async function leerNota(
  tx: Tx,
  noteId: string,
): Promise<{
  numero: number;
  status: string;
  evidencia: string;
  version: number;
  fundamento: string;
}> {
  const result = await tx.query<{
    numero: number;
    status: string;
    evidencia: string;
    version: number;
    fundamento: string;
  }>(
    'SELECT numero, status, evidencia, version, fundamento FROM notes WHERE id = $1 FOR UPDATE',
    [noteId],
  );
  const fila = result.rows[0];
  if (fila === undefined) throw notFound('No existe esa nota en esta empresa');
  return fila;
}

/**
 * Escribe las cifras de una nota, apuntando a renglones del estado emitido.
 *
 * Antes de escribir compara el importe de la propuesta con el del renglón
 * guardado. La base también lo verifica (`note_figures_match_line`), y esta
 * comprobación existe para convertir esa excepción en un error legible — y para
 * detectar el caso que importa: que el estado emitido y el reconstruido difieran,
 * lo que significaría que la contabilidad cambió después de emitir.
 */
async function escribirCifras(
  tx: Tx,
  companyId: string,
  noteId: string,
  propuesta: NotaPropuesta,
  porCodigo: ReadonlyMap<string, { id: string; amount: string }>,
): Promise<number> {
  let orden = 0;
  for (const bloque of propuesta.bloques) {
    for (const cifra of cifrasDelBloque(bloque)) {
      const renglon = porCodigo.get(cifra.renglonCodigo);
      if (renglon === undefined) {
        throw unprocessable(
          'INSUFFICIENT_EVIDENCE',
          `La nota ${propuesta.numero} cita el renglón ${cifra.renglonCodigo}, que no está en el estado emitido.`,
        );
      }

      // La cifra que se guarda es la del RENGLÓN EMITIDO, no la recalculada. Si
      // difieren, el estado y el Mayor dejaron de coincidir y eso es lo que hay
      // que mirar — no una nota que se acomoda al número nuevo.
      if (renglon.amount !== toDecimalString(cifra.importe)) {
        throw conflictoTipado(
          'ESTADO_DESACTUALIZADO',
          `El renglón ${cifra.renglonCodigo} dice ${renglon.amount} en el estado emitido y ${toDecimalString(cifra.importe)} al recalcularlo. ` +
            'La contabilidad cambió después de emitir: no se generan notas sobre un estado que ya no describe el Mayor.',
        );
      }

      orden += 1;
      await tx.query(
        `INSERT INTO note_figures
           (company_id, note_id, orden, label, statement_line_id, amount, comparative_amount, lineage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          companyId,
          noteId,
          orden,
          cifra.etiqueta,
          renglon.id,
          renglon.amount,
          cifra.comparativo === null ? null : toDecimalString(cifra.comparativo),
          JSON.stringify(
            cifra.origen.map((origen) => ({
              accountId: origen.accountId,
              codigo: origen.codigo,
              aporte: toDecimalString(origen.aporte),
            })),
          ),
        ],
      );
    }
  }
  return orden;
}

/**
 * Los bloques, con los importes como texto decimal.
 *
 * Un `Money` lleva su importe en `bigint`, y `JSON.stringify` no sabe
 * serializarlo — falla, que es lo correcto: un `bigint` convertido a `number`
 * pierde precisión en silencio y el gate `check:no-float` existe para que eso no
 * pase. Así que la conversión es explícita y por el mismo camino que el resto
 * del sistema: `toDecimalString`.
 */
function serializarBloques(bloques: readonly BloqueDeNota[]): unknown[] {
  const cifra = (c: CifraDeNota): unknown => ({
    etiqueta: c.etiqueta,
    renglonCodigo: c.renglonCodigo,
    importe: toDecimalString(c.importe),
    comparativo: c.comparativo === null ? null : toDecimalString(c.comparativo),
    origen: c.origen.map((o) => ({
      accountId: o.accountId,
      codigo: o.codigo,
      aporte: toDecimalString(o.aporte),
    })),
  });

  return bloques.map((bloque) => {
    if (bloque.tipo === 'CIFRAS') return { ...bloque, cifras: bloque.cifras.map(cifra) };
    if (bloque.tipo === 'CUADRO') {
      return { ...bloque, filas: bloque.filas.map((fila) => fila.map(cifra)) };
    }
    return bloque;
  });
}

/** La vuelta: importes de texto a `Money`, para que el motor los verifique. */
function deserializarBloques(guardados: readonly unknown[], moneda: Currency): BloqueDeNota[] {
  const cifra = (c: Record<string, unknown>): CifraDeNota => ({
    etiqueta: String(c['etiqueta']),
    renglonCodigo: String(c['renglonCodigo']),
    importe: moneyFromDecimalString(String(c['importe']), moneda),
    comparativo:
      c['comparativo'] === null || c['comparativo'] === undefined
        ? null
        : moneyFromDecimalString(String(c['comparativo']), moneda),
    origen: ((c['origen'] ?? []) as Record<string, unknown>[]).map((o) => ({
      accountId: String(o['accountId']),
      codigo: String(o['codigo']),
      aporte: moneyFromDecimalString(String(o['aporte']), moneda),
    })),
  });

  return guardados.map((bruto) => {
    const bloque = bruto as Record<string, unknown>;
    if (bloque['tipo'] === 'CIFRAS') {
      return {
        tipo: 'CIFRAS',
        cifras: (bloque['cifras'] as Record<string, unknown>[]).map(cifra),
      };
    }
    if (bloque['tipo'] === 'CUADRO') {
      return {
        tipo: 'CUADRO',
        encabezados: bloque['encabezados'] as string[],
        filas: (bloque['filas'] as Record<string, unknown>[][]).map((fila) => fila.map(cifra)),
      };
    }
    return {
      tipo: 'TEXTO',
      contenido: String(bloque['contenido']),
      origenTexto: bloque['origenTexto'] as BloqueDeNota extends { origenTexto: infer O } ? O : never,
    };
  });
}

function cifrasDelBloque(bloque: BloqueDeNota): readonly CifraDeNota[] {
  if (bloque.tipo === 'CIFRAS') return bloque.cifras;
  if (bloque.tipo === 'CUADRO') return bloque.filas.flat();
  return [];
}

/** Las notas guardadas, en la forma que el motor espera para verificarlas. */
async function cargarNotas(tx: Tx, statementId: string): Promise<Nota[]> {
  const filas = await tx.query<{
    id: string;
    numero: number;
    titulo: string;
    body_blocks: readonly unknown[];
    fundamento: string;
  }>(
    `SELECT id, numero, titulo, body_blocks, fundamento
       FROM notes WHERE statement_id = $1 AND status <> 'SUPERSEDIDA'
      ORDER BY numero`,
    [statementId],
  );

  return filas.rows.map((fila) => ({
    numero: fila.numero,
    titulo: fila.titulo,
    bloques: deserializarBloques(fila.body_blocks, MONEDA),
    referidaPor: [],
    fundamento: fila.fundamento,
  }));
}

export type { EstadoContable };
