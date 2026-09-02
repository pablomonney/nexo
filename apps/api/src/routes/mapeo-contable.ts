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
import { moneyFromDecimalString } from '@aai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  armarRenglones,
  type CuentaDelRol,
  type RolContable,
} from '../contabilidad/armar-renglones.js';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const ROLES = [
  'CLIENTES',
  'PROVEEDORES',
  'IVA_DEBITO',
  'IVA_CREDITO',
  'VENTAS',
  'COMPRAS',
  // Agregados por la 0079: son los que permiten proponer el asiento de costo
  // de mercadería vendida, que hasta entonces se calculaba y no llegaba al
  // Mayor.
  'MERCADERIA',
  'COSTO_DE_VENTAS',
] as const;

/** Para qué se usa cada rol, dicho una vez y en un solo lugar. */
const PARA_QUE: Readonly<Record<RolContable, string>> = {
  CLIENTES: 'La contrapartida de una venta en cuenta corriente',
  PROVEEDORES: 'La contrapartida de una compra en cuenta corriente',
  IVA_DEBITO: 'El IVA que se le cobra al cliente y se le debe al fisco',
  IVA_CREDITO: 'El IVA que paga la empresa y computa contra el débito',
  VENTAS: 'El neto gravado de una venta, cuando el comprobante no tiene renglones con cuenta propia',
  COMPRAS: 'El neto gravado de una compra, cuando el comprobante no tiene renglones con cuenta propia',
  MERCADERIA: 'El activo que se da de baja al vender: lo que la empresa tiene hasta que lo vende',
  COSTO_DE_VENTAS: 'El resultado negativo que se reconoce cuando la mercadería sale por venta',
};

/**
 * Los dos roles que solo hacen falta con existencias.
 *
 * `accounting_map_status` —y con ella la rama de la bandeja— cuenta **solo los
 * seis primeros** a propósito: una empresa de servicios no tiene mercadería, y
 * decirle que le falta declarar dónde va su costo sería reclamarle algo que no
 * le corresponde.
 */
const DE_COSTO = new Set<RolContable>(['MERCADERIA', 'COSTO_DE_VENTAS']);

interface FilaMapeo {
  readonly rol: RolContable;
  readonly codigo: string;
  readonly nombre: string;
  readonly exige_tercero: boolean;
}

/** Lee el mapeo declarado como el diccionario que espera el armador. */
export async function leerMapeo(
  tx: Tx,
  companyId: string,
): Promise<Map<RolContable, CuentaDelRol>> {
  const r = await tx.query<FilaMapeo>(
    `SELECT m.rol, a.code AS codigo, a.name AS nombre,
            a.requires_third_party AS exige_tercero
       FROM company_account_map m
       JOIN accounts a ON a.id = m.account_id AND a.company_id = m.company_id
      WHERE m.company_id = $1`,
    [companyId],
  );

  return new Map(
    r.rows.map((f) => [f.rol, { rol: f.rol, codigo: f.codigo, exigeTercero: f.exige_tercero }]),
  );
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
          `SELECT t.direction, t.neto::text, t.iva::text, t.total::text,
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
             FROM tax_transactions t WHERE t.id = $1 AND t.company_id = $2`,
          [taxTransactionId, tenant.companyId],
        );
        if (r.rowCount === 0) throw notFound('Operación fiscal no encontrada');
        const o = r.rows[0]!;

        const mapeo = await leerMapeo(tx, tenant.companyId);
        const descripcion =
          `${o.direction === 'VENTAS' ? 'Venta' : 'Compra'} ` +
          `${o.punto_venta}-${o.cbte_numero}` +
          (o.razon_social === null ? '' : ` — ${o.razon_social}`);

        const construccion = armarRenglones(
          {
            direccion: o.direction,
            neto: moneyFromDecimalString(o.neto, 'ARS'),
            iva: moneyFromDecimalString(o.iva, 'ARS'),
            total: moneyFromDecimalString(o.total, 'ARS'),
            noGravado: moneyFromDecimalString(o.no_gravado, 'ARS'),
            exento: moneyFromDecimalString(o.exento, 'ARS'),
            percepciones: moneyFromDecimalString(o.percepciones, 'ARS'),
            terceroId: o.party_id,
            descripcion,
          },
          mapeo,
        );

        return {
          fecha: o.cbte_fecha,
          descripcion,
          renglones: construccion.renglones,
          motivoSinRenglones: construccion.motivo,
          rolesFaltantes: construccion.rolesFaltantes,
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
  if ((error as { code?: string }).code === '23503') {
    return conflict('La cuenta no existe en esta empresa');
  }
  return error;
}
