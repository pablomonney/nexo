/**
 * El catálogo de preguntas que NEXO sabe contestar.
 *
 * ## Por qué un catálogo cerrado y no un modelo escribiendo SQL
 *
 * La tentación evidente es mandarle la pregunta y el esquema a un modelo y que
 * arme la consulta. No se hace, y no es por prudencia genérica: es que la
 * respuesta a «cuánto vendí en marzo» **ya está calculada** por un motor que
 * cuadra contra el Mayor, respeta el RLS y explica su metodología. Dejar que un
 * modelo arme otra consulta produciría un segundo número para la misma
 * pregunta, sin forma de saber cuál está bien.
 *
 * Entonces: el modelo —cuando hay— redacta. La cuenta la hace lo que ya existe.
 *
 * ## Qué contesta cada entrada
 *
 * No un número suelto. Cada respuesta trae:
 *
 *   - el **valor**, formateado por quien sabe formatearlo;
 *   - el **detalle** que lo compone, para poder abrirlo;
 *   - el **origen**: qué vista lo produjo, que es lo que permite rehacerlo;
 *   - la **metodología**: qué incluye y qué no.
 *
 * Es el mismo criterio que sostiene toda la analítica de este repositorio: un
 * total sin forma de abrirlo es una afirmación sin origen.
 *
 * ## Y qué pasa cuando no entiende
 *
 * Dice que no entendió y muestra lo que sí sabe contestar. No adivina la
 * pregunta más parecida: una respuesta correcta a una pregunta que nadie hizo
 * es peor que un «no sé», porque se lee como si fuera la respuesta.
 */

// `Tx` y no `PoolClient`: el catálogo consulta dentro de la transacción con la
// empresa en contexto, que es la única forma de que el RLS lo filtre. Recibir
// un cliente crudo dejaría abierta la puerta a consultar sin contexto.
import type { Tx } from '@aai/db';

export interface DatoDeRespuesta {
  readonly etiqueta: string;
  readonly valor: string;
  readonly origen: string;
}

export interface RespuestaDeterministica {
  readonly titulo: string;
  /** El número principal, ya formateado. `null` cuando no se puede afirmar. */
  readonly valor: string | null;
  readonly unidad: string;
  readonly periodo: string | null;
  readonly datos: readonly DatoDeRespuesta[];
  /** Las vistas de las que salió. Es lo que permite rehacer la cuenta. */
  readonly origen: readonly string[];
  readonly metodologia: string;
  /** Qué queda afuera. Vacío no significa «nada»: significa que no hay salvedad. */
  readonly noIncluye: string | null;
}

export interface PreguntaDelCatalogo {
  readonly id: string;
  /** Cómo la formularía una persona. Es la que se muestra en la pantalla. */
  readonly pregunta: string;
  /**
   * Las palabras que **solo** tienen sentido en esta pregunta. Sin al menos una
   * de estas, la pregunta no se considera entendida.
   *
   * La primera versión usaba una sola lista con todo mezclado, y «¿cuántos
   * empleados tengo en Rosario?» se contestaba con el disponible de caja: la
   * palabra «tengo» alcanzaba. Una palabra que aparece en media docena de
   * preguntas no identifica ninguna.
   */
  readonly nucleo: readonly string[];
  /** Palabras que acompañan y suman puntaje, pero no alcanzan solas. */
  readonly apoyo: readonly string[];
  readonly permisos: readonly string[];
  /** `true` si admite un mes en `AAAA-MM`; si no se pasa, usa el corriente. */
  readonly admiteMes: boolean;
  readonly responder: (
    tx: Tx,
    companyId: string,
    mes: string,
  ) => Promise<RespuestaDeterministica>;
}

/** Un importe como lo escribe una persona: 1.234.567,89 */
export function pesos(valor: string | number | null): string | null {
  if (valor === null) return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return String(valor);
  return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Sin acentos, en minúscula y sin signos: para comparar preguntas. */
export function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export const CATALOGO: readonly PreguntaDelCatalogo[] = [
  {
    id: 'VENTAS_DEL_MES',
    pregunta: '¿Cuánto vendí?',
    nucleo: ['vendi', 'ventas', 'facturacion', 'facture', 'vendimos', 'vendio'],
    apoyo: ['cuanto', 'mes'],
    permisos: ['analytics:read'],
    admiteMes: true,
    responder: async (tx, companyId, mes) => {
      const r = await tx.query<{
        neto: string; iva: string; total: string; comprobantes: number; terceros: number;
      }>(
        `SELECT coalesce(neto, 0)::text AS neto, coalesce(iva, 0)::text AS iva,
                coalesce(total, 0)::text AS total, coalesce(comprobantes, 0) AS comprobantes,
                coalesce(terceros, 0) AS terceros
           FROM analytics_operaciones_mensuales
          WHERE company_id = $1 AND direccion = 'VENTAS' AND mes = ($2 || '-01')::date`,
        [companyId, mes],
      );
      const f = r.rows[0];
      return {
        titulo: 'Ventas del mes',
        valor: pesos(f?.neto ?? '0'),
        unidad: '$ neto',
        periodo: mes,
        datos: [
          { etiqueta: 'Neto', valor: pesos(f?.neto ?? '0')!, origen: 'analytics_operaciones_mensuales' },
          { etiqueta: 'IVA', valor: pesos(f?.iva ?? '0')!, origen: 'analytics_operaciones_mensuales' },
          { etiqueta: 'Total facturado', valor: pesos(f?.total ?? '0')!, origen: 'analytics_operaciones_mensuales' },
          { etiqueta: 'Comprobantes', valor: String(f?.comprobantes ?? 0), origen: 'analytics_operaciones_mensuales' },
          { etiqueta: 'Clientes distintos', valor: String(f?.terceros ?? 0), origen: 'analytics_operaciones_mensuales' },
        ],
        origen: ['analytics_operaciones_mensuales'],
        metodologia:
          'Comprobantes de VENTAS por fecha de comprobante, no por fecha de cobro. El neto ' +
          'excluye el IVA; el total lo incluye.',
        noIncluye:
          f === undefined
            ? 'No hay comprobantes de venta cargados en ese mes.'
            : 'No descuenta las notas de crédito del mes siguiente que corrijan estas ventas.',
      };
    },
  },

  {
    id: 'COMPRAS_DEL_MES',
    pregunta: '¿Cuánto compré?',
    nucleo: ['compre', 'compras', 'compramos', 'gaste', 'gastamos'],
    apoyo: ['cuanto', 'mes'],
    permisos: ['analytics:read'],
    admiteMes: true,
    responder: async (tx, companyId, mes) => {
      const r = await tx.query<{ neto: string; total: string; comprobantes: number }>(
        `SELECT coalesce(neto, 0)::text AS neto, coalesce(total, 0)::text AS total,
                coalesce(comprobantes, 0) AS comprobantes
           FROM analytics_operaciones_mensuales
          WHERE company_id = $1 AND direccion = 'COMPRAS' AND mes = ($2 || '-01')::date`,
        [companyId, mes],
      );
      const f = r.rows[0];
      return {
        titulo: 'Compras del mes',
        valor: pesos(f?.neto ?? '0'),
        unidad: '$ neto',
        periodo: mes,
        datos: [
          { etiqueta: 'Neto', valor: pesos(f?.neto ?? '0')!, origen: 'analytics_operaciones_mensuales' },
          { etiqueta: 'Total', valor: pesos(f?.total ?? '0')!, origen: 'analytics_operaciones_mensuales' },
          { etiqueta: 'Comprobantes', valor: String(f?.comprobantes ?? 0), origen: 'analytics_operaciones_mensuales' },
        ],
        origen: ['analytics_operaciones_mensuales'],
        metodologia: 'Comprobantes de COMPRAS por fecha de comprobante, no por fecha de pago.',
        noIncluye: 'Un gasto sin comprobante cargado no está acá.',
      };
    },
  },

  {
    id: 'CUANTO_ME_DEBEN',
    pregunta: '¿Cuánto me deben?',
    nucleo: ['deben', 'debian', 'cobrar', 'cobranzas', 'incobrable'],
    apoyo: ['cuanto', 'me', 'clientes', 'deuda', 'total'],
    permisos: ['allocation:read', 'party:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{
        pendiente: string; vencido: string; comprobantes: number; mas_antiguo: number | null;
      }>(
        `SELECT coalesce(sum(pendiente), 0)::text AS pendiente,
                coalesce(sum(vencido), 0)::text AS vencido,
                coalesce(sum(comprobantes), 0)::int AS comprobantes,
                max(mas_antiguo) AS mas_antiguo
           FROM party_aging
          WHERE company_id = $1 AND direction = 'VENTAS'`,
        [companyId],
      );
      const f = r.rows[0]!;
      return {
        titulo: 'Lo que le deben a la empresa',
        valor: pesos(f.pendiente),
        unidad: '$',
        periodo: null,
        datos: [
          { etiqueta: 'Pendiente total', valor: pesos(f.pendiente)!, origen: 'party_aging' },
          { etiqueta: 'De eso, vencido', valor: pesos(f.vencido)!, origen: 'party_aging' },
          { etiqueta: 'Comprobantes abiertos', valor: String(f.comprobantes), origen: 'party_aging' },
          {
            etiqueta: 'El más viejo',
            valor: f.mas_antiguo === null ? 'sin dato' : `${f.mas_antiguo} días`,
            origen: 'party_aging',
          },
        ],
        origen: ['party_aging', 'invoice_settlement'],
        metodologia:
          'Total menos lo imputado, con las notas de crédito restando y las aplicadas ya ' +
          'trasladadas a la factura que corrigen.',
        noIncluye:
          '«Vencido» solo cuenta los comprobantes con plazo declarado: sin condición de pago ' +
          'el sistema no afirma mora.',
      };
    },
  },

  {
    id: 'CUANTO_DEBO',
    pregunta: '¿Cuánto debo?',
    nucleo: ['debo', 'debemos', 'pagar', 'proveedores'],
    apoyo: ['cuanto', 'deuda', 'total'],
    permisos: ['allocation:read', 'party:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{ pendiente: string; vencido: string; comprobantes: number }>(
        `SELECT coalesce(sum(pendiente), 0)::text AS pendiente,
                coalesce(sum(vencido), 0)::text AS vencido,
                coalesce(sum(comprobantes), 0)::int AS comprobantes
           FROM party_aging
          WHERE company_id = $1 AND direction = 'COMPRAS'`,
        [companyId],
      );
      const f = r.rows[0]!;
      const ordenes = await tx.query<{ cantidad: number; total: string }>(
        `SELECT count(*)::int AS cantidad, coalesce(sum(total), 0)::text AS total
           FROM payment_order_status
          WHERE company_id = $1 AND status = 'APROBADA'`,
        [companyId],
      );
      return {
        titulo: 'Lo que la empresa debe',
        valor: pesos(f.pendiente),
        unidad: '$',
        periodo: null,
        datos: [
          { etiqueta: 'Pendiente total', valor: pesos(f.pendiente)!, origen: 'party_aging' },
          { etiqueta: 'De eso, vencido', valor: pesos(f.vencido)!, origen: 'party_aging' },
          { etiqueta: 'Comprobantes abiertos', valor: String(f.comprobantes), origen: 'party_aging' },
          {
            etiqueta: 'Órdenes de pago aprobadas sin pagar',
            valor: `${ordenes.rows[0]!.cantidad} por ${pesos(ordenes.rows[0]!.total)}`,
            origen: 'payment_order_status',
          },
        ],
        origen: ['party_aging', 'payment_order_status'],
        metodologia:
          'Comprobantes de compras menos lo imputado. Las órdenes de pago aprobadas se ' +
          'informan aparte: no suman deuda nueva, eligen cuál de la que ya existe se cancela.',
        noIncluye: 'Compromisos sin comprobante —una orden de compra pendiente— no son deuda todavía.',
      };
    },
  },

  {
    id: 'CUANTO_TENGO',
    pregunta: '¿Cuánta plata tengo?',
    nucleo: ['plata', 'disponible', 'caja', 'banco', 'bancos', 'efectivo', 'liquidez'],
    apoyo: ['cuanta', 'cuanto', 'tengo', 'hay'],
    permisos: ['analytics:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{ fuente: string; saldo: string; metodologia: string }>(
        `SELECT fuente, saldo::text, metodologia FROM analytics_disponible
          WHERE company_id = $1 ORDER BY fuente`,
        [companyId],
      );
      // La suma la hace la base. Sumar los saldos en JavaScript sería
      // aritmética de plata en punto flotante, y `check:no-float` la rechaza
      // —con razón: dos saldos y un redondeo alcanzan para que no cierre—.
      const t = await tx.query<{ total: string }>(
        `SELECT coalesce(sum(saldo), 0)::text AS total FROM analytics_disponible
          WHERE company_id = $1`,
        [companyId],
      );
      return {
        titulo: 'Disponible',
        valor: pesos(t.rows[0]!.total),
        unidad: '$',
        periodo: null,
        datos: r.rows.map((fila) => ({
          etiqueta: fila.fuente,
          valor: pesos(fila.saldo)!,
          origen: 'analytics_disponible',
        })),
        origen: ['analytics_disponible'],
        metodologia:
          r.rows.map((f) => `${f.fuente}: ${f.metodologia}`).join(' · ') ||
          'No hay cajas ni cuentas bancarias con movimientos.',
        noIncluye:
          'Bancos es el saldo del Mayor, no el del extracto: la diferencia la resuelve la ' +
          'conciliación. Los cheques en cartera no están acá — todavía no son plata.',
      };
    },
  },

  {
    id: 'VALOR_DEL_STOCK',
    pregunta: '¿Cuánto vale mi stock?',
    nucleo: ['stock', 'existencias', 'inventario'],
    apoyo: ['cuanto', 'vale', 'valor', 'mercaderia'],
    permisos: ['stock:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{
        valuado: string; productos: number; sin_valuar: number; metodo: string | null;
      }>(
        `SELECT coalesce(sum(costo_total), 0)::text AS valuado,
                count(*) FILTER (WHERE costo_total IS NOT NULL)::int AS productos,
                count(*) FILTER (WHERE costo_total IS NULL AND cantidad <> 0)::int AS sin_valuar,
                max(metodo) AS metodo
           FROM stock_valuation WHERE company_id = $1`,
        [companyId],
      );
      const f = r.rows[0]!;
      const afirmable = f.metodo !== null;
      return {
        titulo: 'Valor de las existencias',
        valor: afirmable ? pesos(f.valuado) : null,
        unidad: '$',
        periodo: null,
        datos: [
          { etiqueta: 'Productos valuados', valor: String(f.productos), origen: 'stock_valuation' },
          { etiqueta: 'Productos con existencia sin valuar', valor: String(f.sin_valuar), origen: 'stock_valuation' },
          { etiqueta: 'Método declarado', valor: f.metodo ?? 'ninguno', origen: 'company_stock_valuation' },
        ],
        origen: ['stock_valuation'],
        metodologia: afirmable
          ? 'Promedio ponderado móvil sobre las entradas con costo declarado, calculado al ' +
            'escribir cada movimiento y comprobable contra el recorrido del libro.'
          : 'La empresa no declaró método de valuación: el costo de las existencias no se ' +
            'afirma. Es una decisión contable con norma detrás, no un valor por defecto.',
        noIncluye:
          f.sin_valuar > 0
            ? `${f.sin_valuar} producto(s) con existencia quedan afuera del total porque ` +
              'tienen entradas sin costo declarado.'
            : null,
      };
    },
  },

  {
    id: 'MARGEN',
    pregunta: '¿Cuál es mi margen?',
    nucleo: ['margen', 'rentabilidad', 'gano', 'ganancia', 'rinde'],
    apoyo: ['cuanto', 'cual'],
    permisos: ['analytics:read', 'stock:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{
        venta: string; costo: string; margen: string; pct: string | null; sin_afirmar: number;
      }>(
        `SELECT coalesce(sum(venta) FILTER (WHERE margen IS NOT NULL), 0)::text AS venta,
                coalesce(sum(costo) FILTER (WHERE margen IS NOT NULL), 0)::text AS costo,
                coalesce(sum(margen), 0)::text AS margen,
                round(sum(margen) * 100 / nullif(sum(venta) FILTER (WHERE margen IS NOT NULL), 0), 2)::text AS pct,
                count(*) FILTER (WHERE margen IS NULL)::int AS sin_afirmar
           FROM analytics_margen_por_producto
          WHERE company_id = $1
            AND mes >= date_trunc('month', current_date - interval '12 months')::date`,
        [companyId],
      );
      const f = r.rows[0]!;
      return {
        titulo: 'Margen de los últimos doce meses',
        valor: f.pct,
        unidad: '%',
        periodo: 'últimos 12 meses',
        datos: [
          { etiqueta: 'Venta afirmable', valor: pesos(f.venta)!, origen: 'analytics_margen_por_producto' },
          { etiqueta: 'Costo afirmable', valor: pesos(f.costo)!, origen: 'analytics_margen_por_producto' },
          { etiqueta: 'Margen', valor: pesos(f.margen)!, origen: 'analytics_margen_por_producto' },
          { etiqueta: 'Renglones sin margen afirmable', valor: String(f.sin_afirmar), origen: 'analytics_margen_por_producto' },
        ],
        origen: ['analytics_margen_por_producto'],
        metodologia:
          'Suma del margen afirmable sobre la venta de esos mismos renglones. Un producto ' +
          'entra solo si lo facturado coincide con lo que salió del depósito y su costo se ' +
          'pudo calcular.',
        noIncluye:
          f.sin_afirmar > 0
            ? `${f.sin_afirmar} renglón(es) quedan afuera de las dos puntas: contar su venta ` +
              'sin su costo daría un margen más alto que el real.'
            : null,
      };
    },
  },

  {
    id: 'COSTO_DE_LO_VENDIDO',
    pregunta: '¿Cuánto costó lo que vendí?',
    nucleo: ['cmv', 'costo de ventas', 'costo de lo vendido', 'costo'],
    apoyo: ['cuanto', 'vendido', 'mercaderia'],
    permisos: ['analytics:read', 'stock:read'],
    admiteMes: true,
    responder: async (tx, companyId, mes) => {
      const r = await tx.query<{
        costo: string | null; productos: number; incompleto: boolean; sin_metodo: boolean;
      }>(
        `SELECT costo::text, productos, incompleto, sin_metodo
           FROM cogs_por_mes
          WHERE company_id = $1 AND mes = ($2 || '-01')::date`,
        [companyId, mes],
      );
      const f = r.rows[0];
      return {
        titulo: 'Costo de la mercadería vendida',
        valor: f === undefined || f.sin_metodo ? null : pesos(f.costo),
        unidad: '$',
        periodo: mes,
        datos: [
          { etiqueta: 'Productos con salida por venta', valor: String(f?.productos ?? 0), origen: 'cogs_por_mes' },
        ],
        origen: ['cogs_por_mes', 'analytics_costo_de_ventas'],
        metodologia:
          'Salidas de stock citadas por un comprobante de venta, valuadas al promedio vigente ' +
          'al salir. Los ajustes no entran: una rotura no es una venta.',
        noIncluye:
          f === undefined
            ? 'No hay salidas por venta costeadas en ese mes.'
            : f.sin_metodo
              ? 'Sin método de valuación declarado no hay costo que afirmar.'
              : f.incompleto
                ? 'Hay salidas sin costear: el total es menor que el real.'
                : null,
      };
    },
  },

  {
    id: 'QUE_ESTA_EN_RIESGO',
    pregunta: '¿Qué está en riesgo?',
    nucleo: ['riesgo', 'riesgos', 'alerta', 'alertas', 'desvio', 'desvios', 'senales', 'senal'],
    apoyo: ['que', 'problema', 'preocupa'],
    permisos: ['analysis:read', 'report:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{
        tipo: string; sujeto: string; valor: string; unidad: string;
        umbral: string | null; metodologia: string;
      }>(
        `SELECT tipo, sujeto, valor::text, unidad, umbral::text, metodologia
           FROM analysis_signals
          WHERE company_id = $1 AND supera_umbral IS TRUE
          ORDER BY tipo`,
        [companyId],
      );
      const sinUmbral = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM analysis_signals
          WHERE company_id = $1 AND supera_umbral IS NULL`,
        [companyId],
      );
      return {
        titulo: 'Señales encendidas',
        valor: String(r.rowCount),
        unidad: 'señales',
        periodo: null,
        datos: r.rows.map((s) => ({
          etiqueta: `${s.tipo} · ${s.sujeto}`,
          valor: s.umbral === null
            ? `${s.valor}${s.unidad} (es un hecho, no un umbral declarado)`
            : `${s.valor}${s.unidad} contra un umbral de ${s.umbral}${s.unidad}`,
          origen: 'analysis_signals',
        })),
        origen: ['analysis_signals'],
        metodologia:
          'Una señal se enciende cuando cruza el umbral que la empresa declaró, o —cuando lo ' +
          'que la enciende es un hecho y no un juicio— por sí sola.',
        noIncluye:
          sinUmbral.rows[0]!.n > 0
            ? `${sinUmbral.rows[0]!.n} señal(es) se informan sin evaluar porque la empresa no ` +
              'declaró contra qué compararlas. No están apagadas: están sin umbral.'
            : null,
      };
    },
  },

  {
    id: 'QUE_ME_FALTA',
    pregunta: '¿Qué me falta hacer?',
    nucleo: ['falta', 'pendiente', 'pendientes', 'bandeja', 'tareas'],
    apoyo: ['que', 'me', 'hacer'],
    permisos: [],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{ categoria: string; n: number; bloquean: number }>(
        `SELECT categoria, count(*)::int AS n,
                count(*) FILTER (WHERE bloquea)::int AS bloquean
           FROM work_queue WHERE company_id = $1
          GROUP BY categoria ORDER BY count(*) DESC`,
        [companyId],
      );
      const total = r.rows.reduce((s, f) => s + f.n, 0);
      const bloquean = r.rows.reduce((s, f) => s + f.bloquean, 0);
      return {
        titulo: 'Trabajo pendiente',
        valor: String(total),
        unidad: 'ítems',
        periodo: null,
        datos: r.rows.map((f) => ({
          etiqueta: f.categoria,
          valor: f.bloquean > 0 ? `${f.n} (${f.bloquean} bloquean)` : String(f.n),
          origen: 'work_queue',
        })),
        origen: ['work_queue'],
        metodologia:
          'La bandeja es la unión de las vistas por dominio. Cada ítem sale de un hecho ' +
          'derivable, no de una lista que alguien mantiene.',
        noIncluye:
          bloquean === 0
            ? 'Ninguno bloquea: son avisos, y el trabajo puede seguir.'
            : `${bloquean} ítem(s) impiden avanzar hasta resolverlos.`,
      };
    },
  },

  {
    id: 'A_QUIEN_LE_COBRO',
    pregunta: '¿A quién le tengo que cobrar?',
    nucleo: ['vence', 'vencimientos', 'vencidas', 'quien me debe', 'a quien le cobro'],
    apoyo: ['quien', 'cobrar', 'cobro', 'urgente'],
    permisos: ['allocation:read', 'party:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{
        razon_social: string; pendiente: string; vencimiento: string | null; dias: number | null;
      }>(
        `SELECT razon_social, sum(pendiente)::text AS pendiente,
                min(vencimiento)::text AS vencimiento,
                max(dias_de_mora) AS dias
           FROM invoice_settlement
          WHERE company_id = $1 AND direction = 'VENTAS' AND pendiente > 0
          GROUP BY razon_social
          ORDER BY max(coalesce(dias_de_mora, 0)) DESC, sum(pendiente) DESC
          LIMIT 15`,
        [companyId],
      );
      // El total sale de la base y no de sumar las quince filas de arriba: son
      // las quince primeras, y sumarlas daría un total que no es el total.
      const t = await tx.query<{ total: string }>(
        `SELECT coalesce(sum(pendiente), 0)::text AS total FROM invoice_settlement
          WHERE company_id = $1 AND direction = 'VENTAS' AND pendiente > 0`,
        [companyId],
      );
      return {
        titulo: 'A quién cobrarle, por urgencia',
        valor: pesos(t.rows[0]!.total),
        unidad: '$',
        periodo: null,
        datos: r.rows.map((f) => ({
          etiqueta: f.razon_social,
          valor:
            `${pesos(f.pendiente)}` +
            (f.dias !== null && f.dias > 0
              ? ` · ${f.dias} días de mora`
              : f.vencimiento === null
                ? ' · sin plazo declarado'
                : ` · vence ${f.vencimiento}`),
          origen: 'invoice_settlement',
        })),
        origen: ['invoice_settlement'],
        metodologia:
          'Ordenado por mora y después por importe. La mora se afirma solo donde hay ' +
          'condición de pago declarada.',
        noIncluye: 'Los quince primeros. El listado completo está en la cuenta corriente del tercero.',
      };
    },
  },

  {
    id: 'COMO_VOY',
    pregunta: '¿Cómo viene el mes?',
    nucleo: ['como voy', 'como viene', 'resumen', 'panorama', 'situacion', 'como vamos'],
    apoyo: ['mes', 'general'],
    permisos: ['analytics:read'],
    admiteMes: false,
    responder: async (tx, companyId) => {
      const r = await tx.query<{
        ventas_mes: string; compras_mes: string; a_cobrar: string; vencido_a_cobrar: string;
        a_pagar: string; pendientes: number; pendientes_bloqueantes: number;
      }>(
        `SELECT coalesce(ventas_mes, 0)::text AS ventas_mes,
                coalesce(compras_mes, 0)::text AS compras_mes,
                coalesce(a_cobrar, 0)::text AS a_cobrar,
                coalesce(vencido_a_cobrar, 0)::text AS vencido_a_cobrar,
                coalesce(a_pagar, 0)::text AS a_pagar,
                coalesce(pendientes, 0) AS pendientes,
                coalesce(pendientes_bloqueantes, 0) AS pendientes_bloqueantes
           FROM analytics_resumen WHERE company_id = $1`,
        [companyId],
      );
      const f = r.rows[0];
      return {
        titulo: 'Cómo viene el mes',
        valor: pesos(f?.ventas_mes ?? '0'),
        unidad: '$ vendidos en el mes',
        periodo: new Date().toISOString().slice(0, 7),
        datos: [
          { etiqueta: 'Ventas del mes', valor: pesos(f?.ventas_mes ?? '0')!, origen: 'analytics_resumen' },
          { etiqueta: 'Compras del mes', valor: pesos(f?.compras_mes ?? '0')!, origen: 'analytics_resumen' },
          { etiqueta: 'A cobrar', valor: pesos(f?.a_cobrar ?? '0')!, origen: 'analytics_resumen' },
          { etiqueta: 'De eso, vencido', valor: pesos(f?.vencido_a_cobrar ?? '0')!, origen: 'analytics_resumen' },
          { etiqueta: 'A pagar', valor: pesos(f?.a_pagar ?? '0')!, origen: 'analytics_resumen' },
          { etiqueta: 'Pendientes en la bandeja', valor: String(f?.pendientes ?? 0), origen: 'work_queue' },
        ],
        origen: ['analytics_resumen'],
        metodologia:
          'Ventas y compras del mes corriente por fecha de comprobante; saldos a la fecha. ' +
          'No es un estado de resultados: no incluye costos ni gastos no facturados.',
        noIncluye: 'El resultado del ejercicio sale de los estados contables, no de este resumen.',
      };
    },
  },
];

export interface Coincidencia {
  readonly pregunta: PreguntaDelCatalogo;
  readonly puntaje: number;
}

/**
 * Qué entrada del catálogo corresponde a una pregunta escrita a mano.
 *
 * Cuenta cuántas de sus claves aparecen. No usa distancia de edición ni
 * sinónimos inventados: si nadie escribió la palabra, no hay razón para suponer
 * que la quiso decir.
 *
 * Devuelve **todas** las que empatan en el primer puesto. Elegir una entre dos
 * igual de plausibles sería adivinar, y una respuesta correcta a una pregunta
 * que nadie hizo se lee como si fuera la respuesta.
 */
export function coincidencias(
  texto: string,
  disponibles: readonly PreguntaDelCatalogo[] = CATALOGO,
): readonly Coincidencia[] {
  const normalizado = normalizar(texto);
  const palabras = new Set(normalizado.split(' ').filter((p) => p.length > 1));
  if (palabras.size === 0) return [];

  const aparece = (clave: string): boolean =>
    clave.includes(' ') ? normalizado.includes(clave) : palabras.has(clave);

  const puntuadas = disponibles
    .map((pregunta) => {
      const nucleo = pregunta.nucleo.filter(aparece).length;
      const apoyo = pregunta.apoyo.filter(aparece).length;
      // Sin una palabra del núcleo no hay pregunta reconocida, por más apoyo
      // que haya: «cuántos empleados tengo» comparte «cuánto» y «tengo» con
      // media docena de entradas y no es ninguna de ellas.
      return { pregunta, puntaje: nucleo === 0 ? 0 : nucleo * 10 + apoyo };
    })
    .filter((c) => c.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje);

  if (puntuadas.length === 0) return [];
  const mejor = puntuadas[0]!.puntaje;
  return puntuadas.filter((c) => c.puntaje === mejor);
}

/** El mes en `AAAA-MM` que menciona la pregunta, si menciona alguno. */
export function mesDe(texto: string): string | null {
  const iso = texto.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])\b/u);
  if (iso !== null) return `${iso[1]}-${iso[2]}`;

  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const normalizado = normalizar(texto);
  const indice = meses.findIndex((mes) => normalizado.includes(mes));
  if (indice === -1) return null;

  // Sin año escrito, el año en curso. Un mes que todavía no pasó se entiende
  // como el del año anterior: nadie pregunta por ventas del futuro.
  const anioEscrito = texto.match(/\b(20\d{2})\b/u);
  const hoy = new Date();
  const anio =
    anioEscrito !== null
      ? Number(anioEscrito[1])
      : indice + 1 > hoy.getUTCMonth() + 1
        ? hoy.getUTCFullYear() - 1
        : hoy.getUTCFullYear();
  return `${anio}-${String(indice + 1).padStart(2, '0')}`;
}

/**
 * Las preguntas que puede hacer quien tiene estos permisos.
 *
 * Misma regla que la bandeja: lista blanca. Una pregunta sin permisos
 * declarados la puede hacer cualquiera que haya entrado a la empresa; una con
 * permisos los exige **todos**, porque su respuesta cruza datos de los dos
 * módulos y mostrar la mitad sería mostrar un número que no cuadra con ninguna
 * pantalla.
 */
export function preguntasPara(
  permisos: ReadonlySet<string>,
  catalogo: readonly PreguntaDelCatalogo[] = CATALOGO,
): PreguntaDelCatalogo[] {
  return catalogo.filter((p) => p.permisos.every((permiso) => permisos.has(permiso)));
}
