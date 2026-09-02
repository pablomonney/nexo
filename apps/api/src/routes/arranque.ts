/**
 * Puesta en marcha: qué le falta a esta empresa para poder trabajar.
 *
 * ## Por qué existe
 *
 * La auditoría integral lo puso como P0: una empresa nueva necesita plan de
 * cuentas, ejercicio, períodos y varias cosas más antes de registrar nada, y
 * eso se descubría pantalla por pantalla, chocando con un error por vez.
 *
 * ## Lo que bloquea y lo que no
 *
 * Tres pasos impiden trabajar; el resto **habilita** algo concreto y no le hace
 * falta a todo el mundo. Un checklist que le reclama depósitos a un estudio
 * contable enseña a ignorar los checklists, así que cada paso dice qué habilita
 * y solo tres dicen que bloquean.
 *
 * ## No hay tildes
 *
 * Ningún paso se marca como hecho: se cuenta lo que hay. Un tilde es una
 * segunda verdad que puede decir «listo» sobre una empresa sin período abierto.
 */

import { withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireCompany, requirePermission } from '../http/context.js';

interface Readiness {
  readonly cuentas_imputables: number;
  readonly ejercicios: number;
  readonly periodos_abiertos_hoy: number;
  readonly roles_mapeados: number;
  readonly marcos_de_reporte: number;
  readonly terceros: number;
  readonly productos: number;
  readonly depositos: number;
  readonly cajas: number;
  readonly cuentas_bancarias: number;
  readonly sucursales: number;
  readonly credenciales_arca: number;
  readonly usuarios: number;
  readonly comprobantes: number;
  readonly asientos: number;
}

interface Paso {
  readonly paso: string;
  readonly titulo: string;
  /** Qué deja de estar impedido cuando este paso está. */
  readonly habilita: string;
  readonly bloquea: boolean;
  readonly hechos: number;
  readonly listo: boolean;
  readonly donde: string;
}

/**
 * Los pasos, en el orden en que dependen unos de otros.
 *
 * El orden no es de preferencia: sin cuentas no hay asiento, sin ejercicio no
 * hay períodos, sin períodos no hay dónde registrar, y sin mapeo el sistema no
 * propone nada. De ahí para abajo cada uno habilita un módulo y ninguno es
 * obligatorio para todos.
 */
function pasos(r: Readiness): Paso[] {
  const paso = (
    p: string,
    titulo: string,
    habilita: string,
    bloquea: boolean,
    hechos: number,
    donde: string,
  ): Paso => ({ paso: p, titulo, habilita, bloquea, hechos, listo: hechos > 0, donde });

  return [
    paso(
      'PLAN_DE_CUENTAS',
      'Cargar el plan de cuentas',
      'Registrar cualquier asiento. Sin una cuenta imputable no entra ninguno.',
      true,
      r.cuentas_imputables,
      '/accounts',
    ),
    paso(
      'EJERCICIO',
      'Abrir el ejercicio',
      'Tener períodos donde registrar. El ejercicio los crea.',
      true,
      r.ejercicios,
      '/fiscal-years',
    ),
    paso(
      'PERIODO_ABIERTO',
      'Tener un período abierto que contenga hoy',
      'Registrar una operación con fecha de hoy.',
      true,
      r.periodos_abiertos_hoy,
      '/periods',
    ),
    paso(
      'MAPEO_CONTABLE',
      'Declarar el mapeo contable',
      'Que el sistema **proponga** el asiento de un comprobante en vez de que ' +
        'se escriba entero a mano. Sin esto se puede operar igual: a mano.',
      false,
      r.roles_mapeados,
      '/accounting-map',
    ),
    paso(
      'MARCO_DE_REPORTE',
      'Declarar el marco de reporte',
      'Emitir estados contables. Cuál corresponde depende del ente y no se supone.',
      false,
      r.marcos_de_reporte,
      '/companies/current/reporting-framework',
    ),
    paso(
      'TERCEROS',
      'Cargar clientes y proveedores',
      'Facturar, comprar y llevar cuenta corriente.',
      false,
      r.terceros,
      '/parties',
    ),
    paso(
      'PRODUCTOS',
      'Cargar productos o servicios',
      'Detallar comprobantes y —si son productos— llevar existencias.',
      false,
      r.productos,
      '/products',
    ),
    paso(
      'DEPOSITO',
      'Dar de alta un depósito',
      'Llevar stock. Una empresa de servicios no lo necesita.',
      false,
      r.depositos,
      '/warehouses',
    ),
    paso(
      'CAJA_O_BANCO',
      'Dar de alta una caja o una cuenta bancaria',
      'Registrar cobros y pagos, arquear y conciliar.',
      false,
      r.cajas + r.cuentas_bancarias,
      '/cash-boxes',
    ),
    paso(
      'CREDENCIAL_ARCA',
      'Cargar el certificado de ARCA',
      'Constatar comprobantes contra el organismo. Sin él se puede registrar ' +
        'igual, y la constatación queda declarada en vez de confirmada.',
      false,
      r.credenciales_arca,
      '/companies/current/arca/credentials',
    ),
  ];
}

export async function arranqueRoutes(app: FastifyInstance): Promise<void> {
  app.get('/onboarding', async (request) => {
    const tenant = await requireCompany(request);
    // Lo que se muestra son cuentas de filas de la propia empresa; el permiso
    // más chico que ya existe y significa «puede mirar la configuración».
    requirePermission(tenant, 'company:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query<Readiness>(
          `SELECT cuentas_imputables, ejercicios, periodos_abiertos_hoy,
                  roles_mapeados, marcos_de_reporte, terceros, productos,
                  depositos, cajas, cuentas_bancarias, sucursales,
                  credenciales_arca, usuarios, comprobantes, asientos
             FROM company_readiness WHERE company_id = $1`,
          [tenant.companyId],
        );
        if (r.rowCount === 0) return { pasos: [], puedeOperar: false };

        const lista = pasos(r.rows[0]!);
        const bloqueantes = lista.filter((p) => p.bloquea && !p.listo);

        return {
          pasos: lista,
          // «Puede operar» es exactamente eso y nada más: que no haya ningún
          // paso bloqueante pendiente. No dice que esté configurada del todo.
          puedeOperar: bloqueantes.length === 0,
          bloqueantesPendientes: bloqueantes.map((p) => p.paso),
          // Una empresa con asientos ya arrancó: mostrarle la puesta en marcha
          // en primer plano sería tratarla como nueva cada vez que entra.
          yaOpera: r.rows[0]!.asientos > 0,
          alcance:
            'Ningún paso se tilda: se cuenta lo que hay, así que la lista no puede decir ' +
            '«listo» sobre algo que no está. Solo tres pasos **bloquean** —cuentas, ' +
            'ejercicio y período abierto—; los demás habilitan un módulo y no le hacen ' +
            'falta a toda empresa: reclamarle depósitos a un estudio contable enseña a ' +
            'ignorar la lista.',
        };
      },
    );
  });
}
