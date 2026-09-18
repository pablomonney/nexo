/**
 * El mapeo contable declarado, y el asiento que se propone con él.
 *
 * ## Por qué existe
 *
 * La auditoría integral encontró que el Mayor se escribe a mano: el único hecho
 * que produce asientos por sí solo es el cierre de ejercicio. El motor de
 * propuesta ya estaba escrito y salía vacío porque nadie le había dicho a qué
 * cuenta va cada cosa.
 *
 * ## La propuesta no se guarda
 *
 * Se recalcula cada vez desde el comprobante y el mapeo. Guardarla crearía una
 * tercera verdad —el comprobante, el asiento y una propuesta vieja— y la
 * propuesta es justamente lo único de los tres que no es un hecho.
 *
 * ## Y no crea el asiento
 *
 * Esta ruta **no escribe en el Diario**. Devuelve los renglones para que se
 * carguen por `POST /journal-entries`, que es el único camino que numera,
 * resuelve el período, guarda la trazabilidad y exige aprobación humana. Un
 * segundo escritor sería un segundo criterio.
 */

import { recordAudit, withCompany, type Tx } from '@aai/db';
import type { ClaseComprobante } from '@aai/tax-engine';
import {
  DESCRIPCION_DE_ROL,
  moneyFromDecimalString,
  ROLES_CONTABLES,
  ROLES_DE_COSTO,
  type RolContable,
} from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  armarRenglones,
  type CuentaDelRol,
  type LineaParaArmar,
} from '../contabilidad/armar-renglones.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const ROLES = ROLES_CONTABLES;

const PARA_QUE = DESCRIPCION_DE_ROL;

const DE_COSTO = new Set<RolContable>(ROLES_DE_COSTO);

/**
 * Cómo se llama el comprobante en la descripción del asiento.
 *
 * Mapa cerrado, con `DESCONOCIDO` como clave propia en vez de un `else`: si
 * mañana `arca_comprobante_types` trae una clase nueva, el compilador señala
 * este objeto en lugar de dejarla cayendo en la etiqueta de otra cosa. Las
 * clases que no dependen de la dirección la ignoran, y eso también se ve.
 */
const NOMBRE_DEL_COMPROBANTE: Readonly<
  Record<ClaseComprobante | 'DESCONOCIDO', (direccion: 'VENTAS' | 'COMPRAS') => string>
> = {
  FACTURA: (d) => (d === 'VENTAS' ? 'Venta' : 'Compra'),
  NOTA_DEBITO: (d) => `Nota de débito de ${d === 'VENTAS' ? 'venta' : 'compra'}`,
  NOTA_CREDITO: (d) => `Nota de crédito de ${d === 'VENTAS' ? 'venta' : 'compra'}`,
  RECIBO: () => 'Recibo',
  LIQUIDACION: () => 'Liquidación',
  // No se propone nada en este caso, pero la descripción viaja igual en la
  // respuesta y decir «Venta» sobre un comprobante de clase desconocida sería
  // afirmar justamente lo que no se pudo resolver.
  DESCONOCIDO: () => 'Comprobante',
};

interface FilaMapeo {
  readonly rol: RolContable;
  readonly codigo: string;
  readonly nombre: string;
  readonly exige_tercero: boolean;
}

export interface MapeoLeido {
  readonly mapeo: Map<RolContable, CuentaDelRol>;
  /** Roles declarados cuya cuenta ya no se puede imputar. Uno por rol. */
  readonly inutilizables: readonly string[];
}

/**
 * Lee el mapeo declarado como el diccionario que espera el armador.
 *
 * ## Por qué se filtra al leer y no alcanza con el disparador
 *
 * `assert_cuenta_del_rol` (0074/0079) comprueba tipo e imputabilidad **cuando se
 * declara el mapeo**. No puede comprobar nada después, porque lo que cambia es
 * la cuenta y no el mapeo: archivarla es un `UPDATE` sobre `accounts`, y
 * colgarle una hija la vuelve de agrupación por el disparador de la 0003. En los
 * dos casos la fila del mapeo queda intacta apuntando a una cuenta que ya no
 * recibe imputaciones.
 *
 * Es exactamente el mismo agujero que la Fase 4 cerró para las cuentas de
 * producto, y se cierra igual: las condiciones van en el `JOIN`. Un rol cuya
 * cuenta dejó de servir sale del diccionario, y entonces el armador lo ve como
 * un rol que falta —que es lo que es— y lo dice por el camino que ya existía.
 *
 * La diferencia entre «no lo declaraste» y «lo declaraste y ya no sirve» se
 * conserva aparte, porque el remedio no es el mismo.
 */
export async function leerMapeo(tx: Tx, companyId: string): Promise<MapeoLeido> {
  const r = await tx.query<FilaMapeo & { imputable: boolean }>(
    `SELECT m.rol, a.code AS codigo, a.name AS nombre,
            a.requires_third_party AS exige_tercero,
            (a.status = 'ACTIVE' AND a.is_postable) AS imputable
       FROM company_account_map m
       JOIN accounts a ON a.id = m.account_id AND a.company_id = m.company_id
      WHERE m.company_id = $1`,
    [companyId],
  );

  const utiles = r.rows.filter((f) => f.imputable);
  return {
    mapeo: new Map(
      utiles.map((f) => [f.rol, { rol: f.rol, codigo: f.codigo, exigeTercero: f.exige_tercero }]),
    ),
    inutilizables: r.rows
      .filter((f) => !f.imputable)
      .map(
        (f) =>
          `El rol ${f.rol} está declarado contra ${f.codigo} «${f.nombre}», que ya no admite ` +
          'imputación: está archivada o es de agrupación. Declará otra cuenta para ese rol.',
      ),
  };
}

interface FilaDeRenglon {
  readonly line_no: number;
  readonly neto: string;
  readonly descripcion: string;
  readonly producto: string | null;
  /** El código de la cuenta del producto, ya comprobada. `null` si no sirve. */
  readonly cuenta: string | null;
  /** El producto declaró una cuenta para esta dirección, sirva o no. */
  readonly declaro_cuenta: boolean;
}

export interface DetalleResuelto {
  readonly lineas: readonly LineaParaArmar[];
  /** Configuraciones que existen y no se pudieron usar. Una por producto. */
  readonly advertencias: readonly string[];
}

/**
 * Los renglones del comprobante, con la cuenta de cada producto ya comprobada.
 *
 * ## Las cuatro condiciones se comprueban en el `JOIN`, no en TypeScript
 *
 * Existe, es de esta empresa, está activa y es imputable. Van en la consulta por
 * el mismo motivo que en el aprendizaje (Fase 2): un `LEFT JOIN` que no
 * encuentra devuelve `null`, y `null` es precisamente «no hay cuenta que usar».
 * Traer la fila y filtrarla después deja abierta la posibilidad de que alguien
 * agregue un camino que se saltee el filtro; acá no hay filtro que saltear,
 * porque la cuenta inválida nunca llega a existir en el resultado.
 *
 * El `company_id` se repite en los dos `JOIN` aunque las claves foráneas de la
 * 0048 ya sean compuestas. No es redundancia por las dudas: es que el
 * aislamiento no puede depender de que la fila de arriba haya sido la correcta.
 *
 * ## Por qué se avisa
 *
 * Una cuenta archivada configurada en un producto cae en la genérica sin que
 * nada se rompa, y ese es el problema: el asiento sale bien y la configuración
 * sigue rota. Se dice cuál producto y qué pasó.
 */
export async function leerDetalle(
  tx: Tx,
  companyId: string,
  taxTransactionId: string,
  direccion: 'VENTAS' | 'COMPRAS',
): Promise<DetalleResuelto> {
  const columna = direccion === 'VENTAS' ? 'sales_account_id' : 'purchase_account_id';
  const r = await tx.query<FilaDeRenglon>(
    `SELECT l.line_no, l.neto::text, l.descripcion,
            p.name                       AS producto,
            a.code                       AS cuenta,
            (p.${columna} IS NOT NULL)   AS declaro_cuenta
       FROM tax_transaction_lines l
       LEFT JOIN products p
              ON p.id = l.product_id
             AND p.company_id = l.company_id
       LEFT JOIN accounts a
              ON a.id = p.${columna}
             AND a.company_id = p.company_id
             AND a.status = 'ACTIVE'
             AND a.is_postable
      WHERE l.tax_transaction_id = $1 AND l.company_id = $2
      ORDER BY l.line_no`,
    [taxTransactionId, companyId],
  );

  const advertencias: string[] = [];
  const vistos = new Set<string>();
  for (const f of r.rows) {
    if (!f.declaro_cuenta || f.cuenta !== null) continue;
    const producto = f.producto ?? 'un producto';
    if (vistos.has(producto)) continue;
    vistos.add(producto);
    advertencias.push(
      `«${producto}» tiene una cuenta de ${direccion === 'VENTAS' ? 'venta' : 'compra'} ` +
        'configurada que no se puede usar: está archivada o es de agrupación. Ese renglón ' +
        'fue a la cuenta genérica. El asiento sale bien y la configuración sigue rota.',
    );
  }

  return {
    lineas: r.rows.map((f) => ({
      lineNo: f.line_no,
      neto: moneyFromDecimalString(f.neto, 'ARS'),
      cuentaEspecifica: f.cuenta,
    })),
    advertencias,
  };
}

export async function mapeoContableRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounting-map', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'account:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const declarados = await tx.query<FilaMapeo & { declarado_por: string }>(
          `SELECT m.rol, a.code AS codigo, a.name AS nombre,
                  a.requires_third_party AS exige_tercero, m.declarado_por
             FROM company_account_map m
             JOIN accounts a ON a.id = m.account_id AND a.company_id = m.company_id
            WHERE m.company_id = $1`,
          [tenant.companyId],
        );
        const porRol = new Map(declarados.rows.map((f) => [f.rol, f]));

        const estado = await tx.query<{ roles_faltantes: string[]; comprobantes: number }>(
          `SELECT roles_faltantes, comprobantes
             FROM accounting_map_status WHERE company_id = $1`,
          [tenant.companyId],
        );

        return {
          // Todos los roles siempre, declarados o no: una lista que solo
          // muestra lo declarado esconde justamente lo que falta.
          roles: ROLES.map((rol) => {
            const fila = porRol.get(rol);
            return {
              rol,
              paraQue: PARA_QUE[rol],
              // Los dos del costo solo hacen falta si la empresa lleva
              // existencias. Reclamárselos a un estudio contable sería la misma
              // clase de error que reclamarle un depósito.
              necesarioSi: DE_COSTO.has(rol)
                ? 'Solo si la empresa lleva existencias y quiere asentar su costo'
                : 'Siempre, para que el sistema pueda proponer el asiento de un comprobante',
              cuenta: fila === undefined ? null : fila.codigo,
              nombre: fila === undefined ? null : fila.nombre,
              exigeTercero: fila === undefined ? null : fila.exige_tercero,
              declaradoPor: fila === undefined ? null : fila.declarado_por,
            };
          }),
          faltantes: estado.rows[0]?.roles_faltantes ?? [],
          comprobantes: estado.rows[0]?.comprobantes ?? 0,
          alcance:
            'Mientras falte un rol, el sistema **no propone** el asiento de los ' +
            'comprobantes que lo necesitan: elegir la cuenta por su cuenta sería inventar ' +
            'la contabilidad de esta empresa. Cada rol admite un solo tipo de cuenta, y la ' +
            'base lo comprueba: una cuenta del tipo equivocado descuadra el balance en ' +
            'silencio y el error aparece un ejercicio después.',
        };
      },
    );
  });

  /** Declarar uno o varios roles. Es la misma decisión que tocar el plan. */
  app.put('/accounting-map', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'account:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        asignaciones: z
          .array(z.object({ rol: z.enum(ROLES), cuenta: z.string().min(1).max(40) }))
          .min(1)
          .max(8),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          for (const a of body.asignaciones) {
            const cuenta = await tx.query<{ id: string }>(
              'SELECT id FROM accounts WHERE company_id = $1 AND code = $2',
              [tenant.companyId, a.cuenta],
            );
            if (cuenta.rowCount === 0) throw notFound(`No existe la cuenta ${a.cuenta}`);

            await tx.query(
              `INSERT INTO company_account_map (company_id, rol, account_id, declarado_por)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (company_id, rol) DO UPDATE
                 SET account_id = EXCLUDED.account_id,
                     declarado_por = EXCLUDED.declarado_por,
                     declarado_el = now()`,
              [tenant.companyId, a.rol, cuenta.rows[0]!.id, `user:${auth.user.userId}`],
            );
          }

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_MAPEO_CONTABLE',
            objectType: 'company_account_map',
            objectId: tenant.companyId,
            newValue: { asignaciones: body.asignaciones },
            motivo:
              'Se declara a qué cuenta va cada cosa. Cambia qué asientos propone el ' +
              'sistema, no los que ya están registrados.',
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          const estado = await tx.query<{ roles_faltantes: string[] }>(
            'SELECT roles_faltantes FROM accounting_map_status WHERE company_id = $1',
            [tenant.companyId],
          );

          return {
            declarados: body.asignaciones.length,
            faltantes: estado.rows[0]!.roles_faltantes,
            alcance:
              'Los asientos ya registrados **no cambian**: el mapeo dice qué se propone de ' +
              'acá en adelante, no reescribe lo que alguien firmó.',
          };
        },
      );
    } catch (error) {
      throw traducirMapeo(error);
    }
  });

  /**
   * El asiento que este comprobante propone, recalculado ahora.
   *
   * No lo guarda y no lo registra: devuelve los renglones para que se carguen
   * por `POST /journal-entries`, que sigue siendo el único escritor del Diario.
   */
  app.get('/tax-transactions/:taxTransactionId/asiento-propuesto', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const { taxTransactionId } = z
      .object({ taxTransactionId: z.string().uuid() })
      .parse(request.params);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<{
          direction: 'VENTAS' | 'COMPRAS';
          cbte_tipo: number;
          clase: ClaseComprobante | null;
          neto: string;
          iva: string;
          total: string;
          no_gravado: string;
          exento: string;
          percepciones: string;
          party_id: string | null;
          cbte_fecha: string;
          punto_venta: number;
          cbte_numero: string;
          razon_social: string | null;
          entry_id: string | null;
        }>(
          // El asiento del comprobante se busca por los **dos** vínculos: el
          // que la operación fiscal guarda y el que el asiento declara como
          // origen. Mirar uno solo diría «no tiene» sobre uno que sí tiene, y
          // ahí la consola invitaría a cargarlo de nuevo.
          //
          // La clase sale del catálogo de ARCA **por la fecha del comprobante**,
          // igual que en `tax/subdiario.ts`. Contra `now()` diría qué es hoy la
          // 991 y no qué era cuando se emitió, y de eso depende para qué lado va
          // el asiento.
          `SELECT t.direction, t.cbte_tipo, ct.clase,
                  t.neto::text, t.iva::text, t.total::text,
                  t.no_gravado::text, t.exento::text, t.percepciones::text,
                  t.party_id, t.cbte_fecha::text, t.punto_venta, t.cbte_numero::text,
                  t.razon_social,
                  coalesce(
                    t.entry_id,
                    (SELECT e.id FROM journal_entries e
                      WHERE e.company_id = t.company_id
                        AND e.source_type = 'INVOICE' AND e.source_id = t.id
                        AND e.status <> 'ANULADO'
                      ORDER BY e.created_at LIMIT 1)
                  )                                       AS entry_id
             FROM tax_transactions t
             LEFT JOIN arca_comprobante_types ct
                    ON ct.codigo = t.cbte_tipo
                   AND (ct.valid_from IS NULL OR ct.valid_from <= t.cbte_fecha)
                   AND (ct.valid_to   IS NULL OR ct.valid_to   >= t.cbte_fecha)
            WHERE t.id = $1 AND t.company_id = $2`,
          [taxTransactionId, tenant.companyId],
        );
        if (r.rowCount === 0) throw notFound('Operación fiscal no encontrada');
        const o = r.rows[0]!;

        const { mapeo, inutilizables } = await leerMapeo(tx, tenant.companyId);
        const detalle = await leerDetalle(tx, tenant.companyId, taxTransactionId, o.direction);

        // La descripción nombra lo que el comprobante es, no la dirección de la
        // operación. «Venta 1-0001» en el renglón de una nota de crédito se lee
        // en el Diario dentro de tres años y dice otra cosa que la que pasó.
        const descripcion =
          `${NOMBRE_DEL_COMPROBANTE[o.clase ?? 'DESCONOCIDO'](o.direction)} ` +
          `${o.punto_venta}-${o.cbte_numero}` +
          (o.razon_social === null ? '' : ` — ${o.razon_social}`);

        const construccion = armarRenglones(
          {
            direccion: o.direction,
            clase: o.clase,
            neto: moneyFromDecimalString(o.neto, 'ARS'),
            iva: moneyFromDecimalString(o.iva, 'ARS'),
            total: moneyFromDecimalString(o.total, 'ARS'),
            noGravado: moneyFromDecimalString(o.no_gravado, 'ARS'),
            exento: moneyFromDecimalString(o.exento, 'ARS'),
            percepciones: moneyFromDecimalString(o.percepciones, 'ARS'),
            terceroId: o.party_id,
            descripcion,
            lineas: detalle.lineas,
          },
          mapeo,
        );

        return {
          fecha: o.cbte_fecha,
          descripcion,
          renglones: construccion.renglones,
          motivoSinRenglones: construccion.motivo,
          rolesFaltantes: construccion.rolesFaltantes,
          // Configuraciones de producto que existen y no se pudieron usar. No
          // impiden la propuesta —el renglón cae en la genérica— y por eso hay
          // que decirlas: si no, el asiento sale bien y nadie se entera de que
          // la cuenta del producto quedó archivada.
          // Las del detalle y las del mapeo: las dos son configuraciones que
          // existen y no se pudieron usar, y para quien tiene que arreglarlas
          // son el mismo problema.
          advertenciasDeConfiguracion: [...inutilizables, ...detalle.advertencias],
          // §24: un asiento sin origen demostrable no se postea, y la propuesta
          // por sí sola no es un origen — es una cuenta que hizo el sistema.
          // Lo que funda el asiento es que una persona la haya mirado y la
          // cargue, y eso es lo que dice este texto. Se sugiere; quien lo manda
          // es quien lo firma.
          justificacionSugerida:
            construccion.renglones.length === 0
              ? null
              : `Asiento armado a partir del comprobante ${o.punto_venta}-${o.cbte_numero} ` +
                'y del mapeo contable declarado por la empresa, revisado y aceptado por ' +
                'quien lo carga.',
          // Si el comprobante ya tiene asiento, proponerlo otra vez sería
          // invitar a duplicarlo. Se dice, y la consola no ofrece cargarlo.
          asientoExistente: o.entry_id,
          alcance:
            'Una propuesta **no es** un asiento: no tiene número, no está en ningún libro ' +
            'y no afecta ningún saldo. Se carga por `POST /journal-entries` como cualquier ' +
            'otro, entra en borrador y la aprueba una persona.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirMapeo(error: unknown): unknown {
  const mensaje = (error as { message?: string }).message ?? '';

  if (mensaje.includes('E_MAPEO_TIPO')) {
    return unprocessable(
      'CUENTA_DEL_TIPO_EQUIVOCADO',
      'Esa cuenta no sirve para ese rol: deudores por ventas es del activo, proveedores del ' +
        'pasivo, ventas es un ingreso. Un asiento armado con la cuenta del tipo equivocado ' +
        'descuadra el balance en silencio.',
    );
  }
  if (mensaje.includes('E_MAPEO_NO_IMPUTABLE')) {
    return unprocessable(
      'CUENTA_NO_IMPUTABLE',
      'Esa cuenta es de agrupación y no recibe movimientos. Declará una imputable.',
    );
  }
  // La 0130. Va antes que nada del tipo porque una cuenta archivada puede ser
  // del tipo correcto, y decirle a alguien que el tipo está mal cuando el tipo
  // está bien lo manda a buscar el problema donde no está.
  if (mensaje.includes('E_MAPEO_ARCHIVADA')) {
    return unprocessable(
      'CUENTA_ARCHIVADA',
      'Esa cuenta está archivada: archivarla fue decir que ya no se usa. Declará otra, o ' +
        'reactivala si fue un error.',
    );
  }
  if (mensaje.includes('E_MAPEO_CUENTA_AJENA')) {
    return conflict('La cuenta no existe en esta empresa');
  }
  if ((error as { code?: string }).code === '23503') {
    return conflict('La cuenta no existe en esta empresa');
  }
  return error;
}
