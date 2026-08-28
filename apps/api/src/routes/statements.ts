/**
 * Estados contables: ESP y ER.
 *
 * Igual que las demás rutas: acá no se decide nada. Lo que sí hace este archivo,
 * y las otras no, es **traer el saldo de cada cuenta al cierre desde el Diario**
 * —no desde `account_balances`—, por la misma razón que el Mayor de FASE 7 y la
 * conciliación de FASE 9: un estado contable que toma sus cifras de una tabla
 * derivada hereda el error de esa tabla justo en el número que después se firma.
 *
 * El endpoint de emisión se niega cuando el motor dice `emisible: false`. No es
 * una validación duplicada de la que hace la base: la base impide guardar un
 * EMITIDO sin firma y sin hash, y esto impide llegar a firmarlo cuando los
 * controles no pasan.
 */

import {
  construirEstado,
  plantillaAplicable,
  validarPlantilla,
  type EcuacionPatrimonial,
  type EstadoContable,
  type MarcoContable,
  type PlantillaEstado,
  type Regulador,
  type SaldoDeCuenta,
  type TipoCuenta,
  type TipoEnte,
  type TipoEstado,
} from '@aai/financial-statements';
import { recordAudit, withCompany, type Tx } from '@aai/db';
import { createHash } from 'node:crypto';
import { moneyFromDecimalString, parseCalendarDate, toDecimalString, type Currency } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { badRequest, conflict, notFound } from '../http/errors.js';

const MONEDA: Currency = 'ARS';

const pedidoSchema = z.object({
  ejercicio: z.string().uuid(),
  tipo: z.enum(['ESP', 'ER']),
  comparativo: z.string().uuid().optional(),
});

export async function statementRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Arma el estado y devuelve sus controles. No lo guarda.
   *
   * Se puede pedir cuantas veces haga falta: sobre los mismos asientos da lo
   * mismo. Lo que se guarda es lo que una persona emite.
   */
  app.get('/statements', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'statement:read');
    const auth = requireAuth(request);
    const query = pedidoSchema.parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => serializar(await armar(tx, tenant.companyId, query)),
    );
  });

  /**
   * Emite el estado del ejercicio.
   *
   * Exige `statement:issue`, que solo tiene el Contador: emitir un estado
   * contable es afirmar la situación patrimonial de una empresa.
   */
  app.post('/statements/issue', async (request, reply) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'statement:issue');
    const auth = requireAuth(request);
    const body = pedidoSchema.parse(request.body);
    const actorId = `user:${auth.user.userId}`;

    return withCompany({ companyId: tenant.companyId, actorId }, async (tx) => {
      const armado = await armar(tx, tenant.companyId, body);

      if (!armado.estado.emisible) {
        return reply.code(409).send({
          error: 'ESTADO_NO_EMISIBLE',
          message: armado.estado.motivo,
          controles: armado.estado.controles.filter((control) => !control.cumple),
        });
      }

      const contenido = canonico(armado.estado);
      const sha256 = createHash('sha256').update(contenido, 'utf8').digest('hex');

      // Se anula el vigente antes de emitir el nuevo. El índice único parcial
      // admite uno solo no anulado, y anular con motivo es el camino previsto —
      // la emisión anterior queda a la vista, como un asiento anulado.
      await tx.query(
        `UPDATE financial_statements
            SET status = 'ANULADO',
                anulado_motivo = 'Reemplazado por una emisión posterior'
          WHERE company_id = $1 AND fiscal_year_id = $2 AND statement_kind = $3
            AND status <> 'ANULADO'`,
        [tenant.companyId, body.ejercicio, body.tipo],
      );

      const guardado = await tx.query<{ id: string }>(
        `INSERT INTO financial_statements
           (company_id, fiscal_year_id, template_id, statement_kind, comparative_year_id,
            fecha_cierre, status, controles, content_sha256, issued_at, issued_by)
         -- Nace BORRADOR y se firma al final, después de escribir los renglones.
         --
         -- No es un detalle de orden: el trigger fsl_immutable_when_issued rechaza toda
         -- línea cuyo estado padre esté EMITIDO, así que insertar la cabecera ya
         -- firmada hacía que el primer renglón rebotara. El endpoint no podía
         -- completarse nunca, y no se había notado porque los tests insertan las
         -- filas por SQL y ninguno lo llamaba.
         --
         -- El candado se queda como está: agregarle un renglón a un estado ya
         -- emitido tiene que seguir siendo imposible. Lo que estaba mal era
         -- firmar antes de terminar de escribir.
         VALUES ($1, $2, $3, $4, $5, $6::date, 'BORRADOR', $7::jsonb, $8, now(), $9)
         RETURNING id`,
        [
          tenant.companyId,
          body.ejercicio,
          armado.plantilla.id,
          body.tipo,
          body.comparativo ?? null,
          armado.estado.fechaCierre,
          JSON.stringify(armado.estado.controles),
          sha256,
          actorId,
        ],
      );
      const statementId = guardado.rows[0]!.id;

      let orden = 0;
      for (const renglon of armado.estado.renglones) {
        orden += 1;
        await tx.query(
          `INSERT INTO financial_statement_lines
             (company_id, statement_id, orden, line_code, label, line_type, nivel,
              amount, comparative_amount, note_ref, fundamento, lineage)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
          [
            tenant.companyId,
            statementId,
            orden,
            renglon.codigo,
            renglon.etiqueta,
            renglon.tipo,
            renglon.nivel,
            toDecimalString(renglon.importe),
            renglon.comparativo === null ? null : toDecimalString(renglon.comparativo),
            renglon.nota,
            renglon.fundamento,
            JSON.stringify(
              renglon.origen.map((origen) => ({
                accountId: origen.accountId,
                codigo: origen.codigo,
                aporte: toDecimalString(origen.aporte),
              })),
            ),
          ],
        );
      }

      // Firmado. A partir de acá los renglones son inmutables.
      await tx.query(`UPDATE financial_statements SET status = 'EMITIDO' WHERE id = $1`, [
        statementId,
      ]);

      await recordAudit(tx, tenant.companyId, {
        actorType: 'USER',
        actorId,
        action: 'financial_statement.issue',
        objectType: 'financial_statements',
        objectId: statementId,
        ip: clientIp(request),
        newValue: { tipo: body.tipo, sha256, renglones: orden },
      });

      reply.code(201);
      return { estadoId: statementId, tipo: body.tipo, sha256, renglones: orden };
    });
  });

  /** De una cifra del balance a las cuentas que la formaron. */
  app.get<{ Params: { lineId: string } }>('/statements/trace/:lineId', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'statement:read');
    const auth = requireAuth(request);
    const params = z.object({ lineId: z.string().uuid() }).parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const result = await tx.query(
          `SELECT * FROM statement_trace WHERE line_id = $1 AND company_id = $2
            ORDER BY account_code`,
          [params.lineId, tenant.companyId],
        );
        if (result.rows.length === 0) {
          throw notFound('No existe ese renglón, o no tiene cuentas detrás');
        }
        return { origen: result.rows };
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Armado
// ---------------------------------------------------------------------------

interface Armado {
  readonly plantilla: PlantillaEstado;
  readonly estado: EstadoContable;
}

async function armar(
  tx: Tx,
  companyId: string,
  pedido: { ejercicio: string; tipo: TipoEstado; comparativo?: string | undefined },
): Promise<Armado> {
  const ejercicio = await cargarEjercicio(tx, companyId, pedido.ejercicio);
  if (ejercicio === null) throw notFound('No existe ese ejercicio en esta empresa');

  const marco = await marcoDeLaEmpresa(tx, companyId, ejercicio.cierre);
  const plantillas = await cargarPlantillas(tx, companyId, pedido.tipo);
  const plantilla = plantillaAplicable(plantillas, {
    tipo: pedido.tipo,
    marco: marco.marco,
    tipoEnte: marco.tipoEnte,
    regulador: marco.regulador,
    fecha: parseCalendarDate(ejercicio.cierre),
  });

  if (plantilla === null) {
    // No se elige una plantilla "parecida". La estructura de un estado contable
    // sale de una norma; sin plantilla para ese marco, el sistema no tiene de
    // dónde sacarla y lo dice.
    throw conflict(
      `FUENTE NO ENCONTRADA: no hay plantilla ${pedido.tipo} vigente al ${ejercicio.cierre} para marco ${marco.marco}, ente ${marco.tipoEnte} y regulador ${marco.regulador}. Cargá la plantilla con la norma de la que sale; el sistema no arma una estructura por su cuenta.`,
    );
  }

  const errores = validarPlantilla(plantilla);
  if (errores.length > 0) {
    throw badRequest(
      `La plantilla ${plantilla.id} no es válida: ${errores.map((e) => `${e.codigo} en ${e.nodo}`).join('; ')}`,
    );
  }

  const saldos = await saldosAlCierre(tx, companyId, ejercicio.cierre);
  const comparativo =
    pedido.comparativo === undefined
      ? undefined
      : await cargarEjercicio(tx, companyId, pedido.comparativo);

  const estado = construirEstado(plantilla, {
    companyId,
    moneda: MONEDA,
    fechaCierre: parseCalendarDate(ejercicio.cierre),
    saldos,
    ...(comparativo === undefined || comparativo === null
      ? {}
      : {
          saldosComparativos: await saldosAlCierre(tx, companyId, comparativo.cierre),
          fechaCierreComparativo: parseCalendarDate(comparativo.cierre),
        }),
  });

  return { plantilla, estado };
}


async function cargarEjercicio(
  tx: Tx,
  companyId: string,
  fiscalYearId: string,
): Promise<{ cierre: string } | null> {
  const result = await tx.query<{ end_date: string }>(
    `SELECT end_date::text FROM fiscal_years WHERE id = $1 AND company_id = $2`,
    [fiscalYearId, companyId],
  );
  const fila = result.rows[0];
  return fila === undefined ? null : { cierre: fila.end_date };
}

/**
 * Marco, tipo de ente y regulador de la empresa.
 *
 * Se lee de `company_reporting_frameworks`. Cuando no hay fila, **no se supone
 * `RT_FACPCE`**: es la misma decisión que la FASE 4 tomó en `predictions.ts`.
 * Suponer el marco más común sería decidir por el ente cuál es su normativa
 * aplicable, que es la afirmación más cara que este sistema puede hacer.
 */
async function marcoDeLaEmpresa(
  tx: Tx,
  companyId: string,
  cierre: string,
): Promise<{ marco: MarcoContable; tipoEnte: TipoEnte; regulador: Regulador }> {
  // El marco sale de `company_reporting_frameworks`, que lo versiona en el
  // tiempo; el tipo de ente y el regulador salen de `companies`, que es donde
  // viven. Son dos hechos distintos: el marco se decide y se puede cambiar, el
  // tipo de ente es lo que la sociedad es.
  const result = await tx.query<{
    framework: string;
    entity_type: string;
    regulator: string | null;
  }>(
    `SELECT f.framework, c.entity_type, c.regulator
       FROM companies c
       JOIN company_reporting_frameworks f ON f.company_id = c.id
      WHERE c.id = $1
        AND f.valid_from <= $2::date
        AND (f.valid_to IS NULL OR f.valid_to >= $2::date)
      ORDER BY f.valid_from DESC
      LIMIT 1`,
    [companyId, cierre],
  );

  const fila = result.rows[0];
  if (fila === undefined) {
    throw conflict(
      'La empresa no tiene marco contable declarado para esa fecha. El sistema no lo supone: qué normativa le aplica a un ente lo determina el profesional, no el default más frecuente.',
    );
  }

  return {
    marco: fila.framework as MarcoContable,
    tipoEnte: fila.entity_type as TipoEnte,
    // `NULL` en la base significa "sin organismo de contralor", y acá se
    // representa con un valor para poder buscar la plantilla por él.
    regulador: (fila.regulator ?? 'NINGUNO') as Regulador,
  };
}

async function cargarPlantillas(
  tx: Tx,
  companyId: string,
  tipo: TipoEstado,
): Promise<PlantillaEstado[]> {
  const result = await tx.query<{
    id: string;
    statement_kind: TipoEstado;
    framework: MarcoContable;
    entity_type: TipoEnte;
    regulator: Regulador;
    version: number;
    valid_from: string;
    valid_to: string | null;
    structure: PlantillaEstado['raiz'];
    norm_version_id: string;
    articulo: string;
    scope_types: PlantillaEstado['alcance']['tipos'];
    scope_fundamento: string;
    equation: EcuacionPatrimonial | null;
  }>(
    `SELECT id, statement_kind, framework, entity_type, regulator, version,
            valid_from::text, valid_to::text, structure, norm_version_id, articulo,
            scope_types, scope_fundamento, equation
       FROM statement_templates
      WHERE (company_id IS NULL OR company_id = $1) AND statement_kind = $2`,
    [companyId, tipo],
  );

  return result.rows.map((fila) => ({
    id: fila.id,
    tipo: fila.statement_kind,
    marco: fila.framework,
    tipoEnte: fila.entity_type,
    regulador: fila.regulator,
    version: fila.version,
    vigenteDesde: parseCalendarDate(fila.valid_from),
    vigenteHasta: fila.valid_to === null ? null : parseCalendarDate(fila.valid_to),
    normVersionId: fila.norm_version_id,
    articulo: fila.articulo,
    raiz: fila.structure,
    alcance: { tipos: fila.scope_types, fundamento: fila.scope_fundamento },
    // La ecuación es de la plantilla. Antes era una constante de este archivo
    // con códigos —`A`, `P`— que la plantilla sembrada no tiene, así que el
    // control fallaba siempre y ningún ESP era emisible.
    ...(fila.equation === null ? {} : { ecuacion: fila.equation }),
  }));
}

/**
 * Saldo de cada cuenta al cierre, desde el Diario.
 *
 * `e.status IN ('APROBADO','ANULADO')` porque un asiento anulado conserva sus
 * movimientos y lo compensa su contraasiento — el mismo criterio del Mayor.
 */
async function saldosAlCierre(
  tx: Tx,
  companyId: string,
  cierre: string,
): Promise<SaldoDeCuenta[]> {
  const result = await tx.query<{
    account_id: string;
    code: string;
    name: string;
    type: TipoCuenta;
    is_postable: boolean;
    saldo: string;
  }>(
    // El `FILTER` no es un adorno: sin él, los filtros de abajo NO filtran nada.
    //
    // Están en el `ON` de un LEFT JOIN encadenado después del join de líneas,
    // que es incondicional. Una línea de un asiento en BORRADOR o posterior a la
    // fecha de corte igual entra al `sum`, con `e` en NULL. El estado se armaba
    // sobre el plan de cuentas entero sin ninguna de sus restricciones —asientos
    // sin aprobar incluidos— y el error es invisible: los números se ven
    // razonables y el balance cuadra, porque cada asiento de más está
    // balanceado.
    //
    // Lo encontró un test que dejó un asiento PROPUESTO a propósito y lo vio
    // aparecer en el estado.
    `SELECT a.id AS account_id, a.code, a.name, a.type, a.is_postable,
            COALESCE(sum(l.debit - l.credit) FILTER (WHERE e.id IS NOT NULL), 0)::text AS saldo
       FROM accounts a
       LEFT JOIN journal_entry_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id
                                  AND e.status IN ('APROBADO', 'ANULADO')
                                  AND e.entry_date <= $2::date
                                  -- Los asientos del cierre NO entran en el
                                  -- estado, y es la decisión que hace que un
                                  -- estado contable siga siendo cierto antes y
                                  -- después de cerrar el ejercicio.
                                  --
                                  -- Un estado contable describe la SITUACIÓN a
                                  -- una fecha. La refundición y el cierre son el
                                  -- mecanismo para poder reabrir los libros: no
                                  -- son hechos económicos del ejercicio. El
                                  -- cierre patrimonial lleva todas las cuentas a
                                  -- cero, así que incluirlo produciría un balance
                                  -- de ceros —formalmente cuadrado y sin ninguna
                                  -- información—, y la refundición vaciaría el
                                  -- estado de resultados.
                                  --
                                  -- Dejándolos afuera, el mismo ejercicio da el
                                  -- mismo estado el día antes de cerrarlo y el
                                  -- día después. Que esa igualdad se cumpla es
                                  -- lo que prueba que el estado sale del Mayor y
                                  -- no del momento en que se lo pidió.
                                  AND e.kind NOT IN ('REFUNDICION', 'CIERRE')
      WHERE a.company_id = $1 AND a.status = 'ACTIVE'
      GROUP BY a.id, a.code, a.name, a.type, a.is_postable
      ORDER BY a.code`,
    [companyId, cierre],
  );

  return result.rows.map((fila) => ({
    accountId: fila.account_id,
    codigo: fila.code,
    nombre: fila.name,
    tipo: fila.type,
    saldo: moneyFromDecimalString(fila.saldo, MONEDA),
    imputable: fila.is_postable,
  }));
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

/**
 * Forma canónica para el hash, con el mismo criterio que `book-export.ts`:
 * punto decimal, LF, nada dependiente del locale.
 */
function canonico(estado: EstadoContable): string {
  return estado.renglones
    .map((renglon) =>
      [
        renglon.codigo,
        renglon.tipo,
        String(renglon.nivel),
        renglon.etiqueta,
        toDecimalString(renglon.importe),
        renglon.comparativo === null ? '' : toDecimalString(renglon.comparativo),
        renglon.origen.map((origen) => `${origen.codigo}=${toDecimalString(origen.aporte)}`).join(','),
      ].join(';'),
    )
    .join('\n');
}

function serializar(armado: Armado): unknown {
  const { estado, plantilla } = armado;
  return {
    tipo: estado.tipo,
    marco: estado.marco,
    fechaCierre: estado.fechaCierre,
    fechaCierreComparativo: estado.fechaCierreComparativo,
    moneda: estado.moneda,
    plantilla: {
      id: plantilla.id,
      version: plantilla.version,
      normVersionId: plantilla.normVersionId,
      articulo: plantilla.articulo,
      // El alcance viaja con la respuesta: es lo que permite contestar por qué
      // una cuenta no aparece sin tener que abrir la plantilla.
      alcance: plantilla.alcance,
    },
    emisible: estado.emisible,
    motivo: estado.motivo,
    controles: estado.controles,
    clasificacion: estado.clasificacion,
    renglones: estado.renglones.map((renglon) => ({
      codigo: renglon.codigo,
      etiqueta: renglon.etiqueta,
      tipo: renglon.tipo,
      nivel: renglon.nivel,
      importe: toDecimalString(renglon.importe),
      comparativo: renglon.comparativo === null ? null : toDecimalString(renglon.comparativo),
      nota: renglon.nota,
      fundamento: renglon.fundamento,
      // Cada cifra viaja con las cuentas que la formaron: es el punto 8 del MVP
      // resuelto en la respuesta, sin necesidad de una segunda llamada.
      origen: renglon.origen.map((origen) => ({
        accountId: origen.accountId,
        codigo: origen.codigo,
        aporte: toDecimalString(origen.aporte),
      })),
    })),
  };
}
