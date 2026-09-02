/**
 * Puesta en marcha: qué le falta a esta empresa para poder trabajar.
 *
 * ## Por qué existe
 *
 * La auditoría integral lo puso como P0: una empresa nueva necesita plan de
 * cuentas, ejercicio, períodos y varias cosas más antes de registrar nada, y
 * eso se descubría pantalla por pantalla, chocando con un error por vez.
 *
 * ## Cinco estados, no dos
 *
 *   `COMPLETO`      está lo que hace falta
 *   `BLOQUEANTE`    falta, y sin eso no se puede operar
 *   `PENDIENTE`     falta, y habilita algo concreto sin impedir nada
 *   `NO_DECLARADO`  no es una fila que falte: es una declaración que nadie hizo
 *   `NO_APLICA`     no le corresponde a esta empresa, y se puede demostrar
 *
 * La diferencia entre los tres últimos es la que sostiene todo el sistema.
 * `PENDIENTE` es «todavía no lo cargaste»; `NO_DECLARADO` es «esto no se carga,
 * se declara, y nadie lo declaró»; `NO_APLICA` es «no te hace falta, y acá está
 * por qué». Convertir un `NO_DECLARADO` en `COMPLETO` sería suponer una
 * decisión, y convertirlo en `NO_APLICA` sería suponer dos.
 *
 * ## «No aplica» exige evidencia
 *
 * Solo dos pasos pueden llegar ahí, y los dos por algo que la empresa declaró:
 * el depósito no aplica si **todos** sus productos son servicios, y los puntos
 * de venta no aplican si no hay ninguna sucursal a la cual atribuirlos. Lo que
 * no se puede derivar queda pendiente.
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
  readonly productos_con_stock: number;
  readonly puntos_de_venta: number;
  readonly centros_de_costo: number;
  readonly roles_de_usuario: number;
}

export type EstadoDePaso =
  | 'COMPLETO'
  | 'BLOQUEANTE'
  | 'PENDIENTE'
  | 'NO_DECLARADO'
  | 'NO_APLICA';

interface Paso {
  readonly paso: string;
  readonly grupo: string;
  readonly titulo: string;
  readonly estado: EstadoDePaso;
  /** Qué deja de estar impedido cuando este paso está. */
  readonly habilita: string;
  /** Qué queda afectado mientras no esté. Vacío cuando no afecta nada. */
  readonly afecta: readonly string[];
  readonly bloquea: boolean;
  readonly hechos: number;
  readonly listo: boolean;
  /** Dónde se resuelve. Es una ruta de la API, la misma que usa la consola. */
  readonly donde: string;
  /** Por qué no aplica, cuando no aplica. `null` en cualquier otro caso. */
  readonly motivoNoAplica: string | null;
}

/**
 * Los pasos, en el orden en que dependen unos de otros.
 *
 * El orden no es de preferencia: sin cuentas no hay asiento, sin ejercicio no
 * hay períodos, sin períodos no hay dónde registrar, y sin mapeo el sistema no
 * propone nada. De ahí para abajo cada uno habilita un módulo.
 */
export function pasosDePuestaEnMarcha(r: Readiness): Paso[] {
  const armar = (
    paso: string,
    grupo: string,
    titulo: string,
    habilita: string,
    afecta: readonly string[],
    bloquea: boolean,
    hechos: number,
    donde: string,
    opciones: { readonly declaracion?: boolean; readonly noAplica?: string | null } = {},
  ): Paso => {
    const listo = hechos > 0;
    const noAplica = opciones.noAplica ?? null;

    // El orden importa: «no aplica» gana sobre «falta», porque un paso que no
    // le corresponde a esta empresa no está pendiente de nada.
    const estado: EstadoDePaso = listo
      ? 'COMPLETO'
      : noAplica !== null
        ? 'NO_APLICA'
        : bloquea
          ? 'BLOQUEANTE'
          : opciones.declaracion === true
            ? 'NO_DECLARADO'
            : 'PENDIENTE';

    return {
      paso,
      grupo,
      titulo,
      estado,
      habilita,
      afecta: listo || estado === 'NO_APLICA' ? [] : afecta,
      bloquea,
      hechos,
      listo,
      donde,
      motivoNoAplica: estado === 'NO_APLICA' ? noAplica : null,
    };
  };

  return [
    armar(
      'USUARIOS_Y_ROLES',
      'Empresa',
      'Tener usuarios con rol vigente en la empresa',
      'Que alguien pueda entrar y trabajar. Un usuario sin rol vigente no ve nada.',
      ['Todo: sin rol no se accede a la empresa'],
      false,
      r.roles_de_usuario,
      '/companies/current/users',
    ),
    armar(
      'PLAN_DE_CUENTAS',
      'Contabilidad',
      'Cargar el plan de cuentas',
      'Registrar cualquier asiento. Sin una cuenta imputable no entra ninguno.',
      ['Diario', 'Mayor', 'Estados contables', 'Cierre de ejercicio'],
      true,
      r.cuentas_imputables,
      '/accounts',
    ),
    armar(
      'EJERCICIO',
      'Contabilidad',
      'Abrir el ejercicio',
      'Tener períodos donde registrar. El ejercicio los crea.',
      ['Diario', 'Comprobantes', 'Cierre de ejercicio'],
      true,
      r.ejercicios,
      '/fiscal-years',
    ),
    armar(
      'PERIODO_ABIERTO',
      'Contabilidad',
      'Tener un período abierto que contenga hoy',
      'Registrar una operación con fecha de hoy.',
      ['Diario', 'Comprobantes'],
      true,
      r.periodos_abiertos_hoy,
      '/periods',
    ),
    armar(
      'MAPEO_CONTABLE',
      'Contabilidad',
      'Declarar el mapeo contable',
      'Que el sistema **proponga** el asiento de un comprobante en vez de que se ' +
        'escriba entero a mano. Sin esto se puede operar igual: a mano.',
      ['Propuesta de asiento a partir de un comprobante'],
      false,
      r.roles_mapeados,
      '/accounting-map',
      { declaracion: true },
    ),
    armar(
      'MARCO_DE_REPORTE',
      'Contabilidad',
      'Declarar el marco de reporte',
      'Emitir estados contables. Cuál corresponde depende del ente y no se supone.',
      ['Estados contables', 'Notas complementarias'],
      false,
      r.marcos_de_reporte,
      '/companies/current/reporting-framework',
      { declaracion: true },
    ),
    armar(
      'CENTROS_DE_COSTO',
      'Contabilidad',
      'Dar de alta centros de costo',
      'Atribuir gastos e ingresos a un proyecto o a una sucursal, y medir su resultado.',
      ['Rentabilidad por proyecto', 'Resultado por sucursal'],
      false,
      r.centros_de_costo,
      '/cost-centers',
    ),
    armar(
      'CREDENCIAL_ARCA',
      'Fiscal',
      'Cargar el certificado de ARCA',
      'Constatar comprobantes contra el organismo. Sin él se puede registrar igual, ' +
        'y la constatación queda declarada en vez de confirmada.',
      ['Constatación de comprobantes contra ARCA'],
      false,
      r.credenciales_arca,
      '/companies/current/arca/credentials',
    ),
    armar(
      'TERCEROS',
      'Comercial',
      'Cargar clientes y proveedores',
      'Facturar, comprar y llevar cuenta corriente.',
      ['Facturación', 'Cuenta corriente', 'Cobranzas y pagos'],
      false,
      r.terceros,
      '/parties',
    ),
    armar(
      'PRODUCTOS',
      'Comercial',
      'Cargar productos o servicios',
      'Detallar comprobantes y —si son productos— llevar existencias.',
      ['Detalle de comprobantes', 'Listas de precios', 'Existencias'],
      false,
      r.productos,
      '/products',
    ),
    armar(
      'SUCURSALES',
      'Comercial',
      'Dar de alta sucursales',
      'Medir cómo le va a cada boca por separado.',
      ['Ventas y resultado por sucursal'],
      false,
      r.sucursales,
      '/branches',
    ),
    armar(
      'PUNTOS_DE_VENTA',
      'Comercial',
      'Declarar los puntos de venta de cada sucursal',
      'Atribuir cada venta a la sucursal que la emitió, por el punto de venta que ' +
        'ya viaja en el comprobante.',
      ['Ventas por sucursal'],
      false,
      r.puntos_de_venta,
      '/branches',
      {
        declaracion: true,
        // Derivado, no supuesto: sin sucursales no hay a qué atribuir un punto
        // de venta. Si mañana se crea una, el paso vuelve a pedirse solo.
        noAplica:
          r.sucursales === 0
            ? 'Esta empresa no declaró ninguna sucursal: no hay a qué atribuir un punto ' +
              'de venta. Si se da de alta una, este paso vuelve a aparecer.'
            : null,
      },
    ),
    armar(
      'DEPOSITO',
      'Existencias',
      'Dar de alta un depósito',
      'Llevar stock: entradas, salidas, transferencias y recuento.',
      ['Existencias', 'Recuento físico', 'Salida de stock por comprobante'],
      false,
      r.depositos,
      '/warehouses',
      {
        // La evidencia es la declaración de los propios productos: si ninguno
        // lleva existencias, no hay nada que depositar.
        noAplica:
          r.productos > 0 && r.productos_con_stock === 0
            ? 'Todos los productos cargados son servicios y ninguno lleva existencias: no ' +
              'hay nada que depositar.'
            : null,
      },
    ),
    armar(
      'CAJA_O_BANCO',
      'Tesorería',
      'Dar de alta una caja o una cuenta bancaria',
      'Registrar cobros y pagos, arquear y conciliar.',
      ['Caja y arqueo', 'Conciliación bancaria', 'Flujo de fondos'],
      false,
      r.cajas + r.cuentas_bancarias,
      '/cash-boxes',
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
                  credenciales_arca, usuarios, comprobantes, asientos,
                  productos_con_stock, puntos_de_venta, centros_de_costo,
                  roles_de_usuario
             FROM company_readiness WHERE company_id = $1`,
          [tenant.companyId],
        );
        if (r.rowCount === 0) return { pasos: [], puedeOperar: false };

        const lista = pasosDePuestaEnMarcha(r.rows[0]!);
        const bloqueantes = lista.filter((p) => p.estado === 'BLOQUEANTE');
        const pendientes = lista.filter(
          (p) => p.estado === 'PENDIENTE' || p.estado === 'NO_DECLARADO',
        );

        return {
          pasos: lista,
          // «Puede operar» es exactamente eso y nada más: que no haya ningún
          // paso bloqueante pendiente. No dice que esté configurada del todo, y
          // por eso `pendientes` va al lado y no escondido.
          puedeOperar: bloqueantes.length === 0,
          bloqueantesPendientes: bloqueantes.map((p) => p.paso),
          pendientes: pendientes.map((p) => p.paso),
          // Lo que queda sin poder hacerse, dicho una vez y sin repetir.
          afectado: [...new Set(pendientes.flatMap((p) => p.afecta))].sort(),
          // Una empresa con asientos ya arrancó: mostrarle la puesta en marcha
          // en primer plano sería tratarla como nueva cada vez que entra.
          yaOpera: r.rows[0]!.asientos > 0,
          alcance:
            'Ningún paso se tilda: se cuenta lo que hay, así que la lista no puede decir ' +
            '«listo» sobre algo que no está. Cinco estados y no dos — `PENDIENTE` es ' +
            '«todavía no lo cargaste», `NO_DECLARADO` es «esto no se carga, se declara, y ' +
            'nadie lo declaró», y `NO_APLICA` es «no te hace falta, y acá está por qué». ' +
            'Solo tres pasos **bloquean**: cuentas, ejercicio y período abierto.',
        };
      },
    );
  });
}
