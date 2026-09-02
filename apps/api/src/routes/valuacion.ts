/**
 * Valuación de existencias: el método se declara, el costo se calcula.
 *
 * ## La decisión sigue siendo de la empresa
 *
 * Qué método de valuación usa un ente es una decisión contable con norma
 * detrás, y este sistema no la toma. Lo que cambió con la 0077 es que hay dónde
 * declararla y que el método declarado se calcula de verdad.
 *
 * ## Se ofrece lo que se calcula
 *
 * El catálogo dice de cada método si está DISPONIBLE o PLANIFICADO, igual que
 * los proveedores de integración. Hoy solo el promedio ponderado móvil está
 * disponible: sale de los movimientos que ya existen. Declarar FIFO se rechaza
 * con el motivo escrito — ofrecerlo y no calcularlo dejaría a una empresa sin
 * valuación sin entender por qué.
 *
 * ## Y no escribe ningún asiento
 *
 * El costo de mercadería vendida es un asiento, y lo firma una persona. Acá se
 * calcula y se informa; llevarlo al Mayor es el paso siguiente y pasa por el
 * mismo camino que todo lo demás.
 */

import { recordAudit, withCompany } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, requireAuth, requireCompany, requirePermission } from '../http/context.js';
import { leerMapeo } from './mapeo-contable.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha ISO (YYYY-MM-DD)');

export async function valuacionRoutes(app: FastifyInstance): Promise<void> {
  /** Qué métodos existen y cuáles se calculan. */
  app.get('/stock-valuation/methods', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT code AS codigo, name AS nombre, descripcion, estado, por_que AS "porQue"
             FROM stock_valuation_methods ORDER BY estado, code`,
        );

        return {
          metodos: r.rows,
          alcance:
            'Un método **PLANIFICADO** no se puede declarar: ofrecerlo y no calcularlo ' +
            'dejaría a la empresa sin valuación sin entender por qué. Cada uno dice qué le ' +
            'falta para estar disponible.',
        };
      },
    );
  });

  /** Qué declaró la empresa y cuánto valen sus existencias. */
  app.get('/stock-valuation', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    const auth = requireAuth(request);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const declarado = await tx.query(
          `SELECT v.metodo, m.name AS nombre,
                  v.vigencia_desde::text AS "vigenciaDesde",
                  v.vigencia_hasta::text AS "vigenciaHasta",
                  v.motivo, v.declarado_por AS "declaradoPor"
             FROM company_stock_valuation v
             JOIN stock_valuation_methods m ON m.code = v.metodo
            WHERE v.company_id = $1
            ORDER BY v.vigencia_desde DESC`,
          [tenant.companyId],
        );

        const productos = await tx.query(
          `SELECT producto_codigo AS codigo, producto_nombre AS nombre, metodo,
                  cantidad::text, costo_total::text AS "costoTotal",
                  costo_unitario::text AS "costoUnitario",
                  entradas_sin_costo AS "entradasSinCosto", metodologia
             FROM stock_valuation WHERE company_id = $1
            ORDER BY producto_codigo`,
          [tenant.companyId],
        );

        // El total se suma en `numeric`, del lado de la base, y **solo** sobre
        // lo que se pudo valuar. Lo que no, se cuenta aparte: sumarlo como cero
        // diría que esa mercadería no vale nada.
        const total = await tx.query<{ valuado: string; sin_valuar: number }>(
          `SELECT coalesce(sum(costo_total), 0)::text AS valuado,
                  count(*) FILTER (WHERE costo_total IS NULL AND cantidad > 0)::int
                    AS sin_valuar
             FROM stock_valuation WHERE company_id = $1`,
          [tenant.companyId],
        );

        const vigente = declarado.rows.find(
          (f) => (f as { vigenciaHasta: string | null }).vigenciaHasta === null,
        );

        return {
          metodoVigente: vigente ?? null,
          historial: declarado.rows,
          productos: productos.rows,
          totalValuado: total.rows[0]!.valuado,
          productosSinValuar: total.rows[0]!.sin_valuar,
          alcance:
            'Sin método declarado el costo es `null` y se dice por qué: es una decisión ' +
            'contable con norma detrás, no un valor por defecto. Con método declarado, un ' +
            'producto con **entradas sin costo** tampoco se valúa — un promedio que las ' +
            'ignora no es un promedio, es un número más chico. ' +
            'Las transferencias entre depósitos propios no mueven el promedio: no cambian ' +
            'ni la cantidad ni el costo de la empresa.',
        };
      },
    );
  });

  /**
   * Declarar el método, con su vigencia y su motivo.
   *
   * Cambiar de método es un cambio de política contable: la norma exige
   * exponerlo, y por eso el motivo es obligatorio y queda en la bitácora.
   */
  app.put('/stock-valuation', async (request) => {
    const tenant = await requireCompany(request);
    // Es una política contable, no una operación de depósito: va con el mismo
    // permiso que tocar el plan de cuentas.
    requirePermission(tenant, 'account:write');
    const auth = requireAuth(request);
    const body = z
      .object({
        metodo: z.string().min(1).max(40),
        vigenciaDesde: fecha,
        vigenciaHasta: fecha.nullish(),
        motivo: z.string().min(3).max(500),
      })
      .parse(request.body);

    try {
      return await withCompany(
        { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
        async (tx) => {
          const metodo = await tx.query<{ estado: string; por_que: string; name: string }>(
            'SELECT estado, por_que, name FROM stock_valuation_methods WHERE code = $1',
            [body.metodo],
          );
          if (metodo.rowCount === 0) throw notFound(`No existe el método ${body.metodo}`);

          if (metodo.rows[0]!.estado !== 'DISPONIBLE') {
            throw unprocessable(
              'METODO_NO_DISPONIBLE',
              `${metodo.rows[0]!.name} todavía no se calcula: ${metodo.rows[0]!.por_que} ` +
                'Declararlo dejaría a la empresa sin valuación sin entender por qué.',
            );
          }

          const r = await tx.query<{ id: string }>(
            `INSERT INTO company_stock_valuation
               (company_id, metodo, vigencia_desde, vigencia_hasta, motivo, declarado_por)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              tenant.companyId, body.metodo, body.vigenciaDesde,
              body.vigenciaHasta ?? null, body.motivo, `user:${auth.user.userId}`,
            ],
          );

          await recordAudit(tx, tenant.companyId, {
            actorType: 'USER',
            actorId: `user:${auth.user.userId}`,
            action: 'DECLARAR_METODO_DE_VALUACION',
            objectType: 'company_stock_valuation',
            objectId: r.rows[0]!.id,
            newValue: body,
            motivo: body.motivo,
            ip: clientIp(request),
            userAgent: request.headers['user-agent'] ?? null,
          });

          return {
            id: r.rows[0]!.id,
            metodo: body.metodo,
            alcance:
              'Desde la fecha declarada las existencias se valúan así. Los movimientos ' +
              'anteriores **no se revalúan**: el histórico queda como se valuó cuando se ' +
              'registró, que es lo que la norma pide exponer al cambiar de método.',
          };
        },
      );
    } catch (error) {
      throw traducirValuacion(error);
    }
  });

  /** El costo de lo que salió por venta, mes a mes. */
  app.get('/analysis/costo-de-ventas', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);
    const query = z.object({ desde: fecha.optional(), hasta: fecha.optional() }).parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT mes::text, producto_codigo AS codigo, producto_nombre AS nombre,
                  unidades::text, costo::text, salidas_sin_costo AS "salidasSinCosto",
                  metodo
             FROM analytics_costo_de_ventas
            WHERE company_id = $1
              AND ($2::date IS NULL OR mes >= date_trunc('month', $2::date))
              AND ($3::date IS NULL OR mes <= $3::date)
            ORDER BY mes DESC, producto_codigo`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        const total = await tx.query<{ costo: string; sin_costo: number }>(
          `SELECT coalesce(sum(costo), 0)::text AS costo,
                  coalesce(sum(salidas_sin_costo), 0)::int AS sin_costo
             FROM analytics_costo_de_ventas
            WHERE company_id = $1
              AND ($2::date IS NULL OR mes >= date_trunc('month', $2::date))
              AND ($3::date IS NULL OR mes <= $3::date)`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        return {
          porMes: r.rows,
          costoTotal: total.rows[0]!.costo,
          salidasSinCosto: total.rows[0]!.sin_costo,
          alcance:
            'El costo de cada salida es el promedio vigente **en el momento de salir**, no ' +
            'el de hoy. Las salidas sin costo —porque el producto tenía entradas sin ' +
            'costear— se cuentan aparte en vez de sumar cero: cero diría que esa mercadería ' +
            'salió gratis. ' +
            'Este número **no genera ningún asiento**: el asiento de costo de mercadería ' +
            'vendida lo firma una persona, por el camino de siempre.',
        };
      },
    );
  });

  /**
   * Cuánto dejó cada producto.
   *
   * Es la primera vez que la venta y su costo se miran juntos, y por eso lo
   * importante de esta ruta no es el número sino cuándo **no** lo da: un margen
   * calculado sobre menos unidades de las que se facturaron es más grande que el
   * real, y es el error más peligroso de los dos.
   */
  app.get('/analysis/margen', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    requirePermission(tenant, 'analysis:read');
    const auth = requireAuth(request);
    const query = z
      .object({ desde: fecha.optional(), hasta: fecha.optional() })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const r = await tx.query(
          `SELECT mes::text, producto_codigo AS codigo, producto_nombre AS nombre,
                  lleva_stock AS "llevaStock",
                  unidades_vendidas::text AS "unidadesVendidas",
                  unidades_salidas::text AS "unidadesSalidas",
                  venta::text, costo::text, margen::text,
                  margen_pct::text AS "margenPct",
                  salidas_sin_costo AS "salidasSinCosto",
                  renglones_de_credito AS "renglonesDeCredito",
                  metodologia
             FROM analytics_margen_por_producto
            WHERE company_id = $1
              AND ($2::date IS NULL OR mes >= date_trunc('month', $2::date))
              AND ($3::date IS NULL OR mes <= $3::date)
            ORDER BY mes DESC, margen DESC NULLS LAST, producto_codigo`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        // Los totales se suman del lado de la base y **solo** sobre lo
        // afirmable. Lo demás se cuenta aparte: un total que mezcla márgenes
        // afirmados con ventas sin costo es un margen inflado.
        const total = await tx.query<{
          venta: string; costo: string; margen: string; sin_afirmar: number;
        }>(
          `SELECT coalesce(sum(venta) FILTER (WHERE margen IS NOT NULL), 0)::text AS venta,
                  coalesce(sum(costo) FILTER (WHERE margen IS NOT NULL), 0)::text AS costo,
                  coalesce(sum(margen), 0)::text                                  AS margen,
                  count(*) FILTER (WHERE margen IS NULL)::int                     AS sin_afirmar
             FROM analytics_margen_por_producto
            WHERE company_id = $1
              AND ($2::date IS NULL OR mes >= date_trunc('month', $2::date))
              AND ($3::date IS NULL OR mes <= $3::date)`,
          [tenant.companyId, query.desde ?? null, query.hasta ?? null],
        );

        return {
          porProducto: r.rows,
          totalAfirmable: total.rows[0],
          alcance:
            'El margen se afirma **solo** cuando las dos puntas están completas: hay costo, ' +
            'no hay salidas sin costear, y lo facturado coincide con lo que salió del ' +
            'depósito. Si se facturaron diez unidades y salieron seis, el margen sobre esas ' +
            'seis sería más grande que el real — el error más peligroso de los dos, porque ' +
            'parece bueno. ' +
            'Un servicio no tiene costo de mercadería y su margen no se informa como 100 %: ' +
            'eso sería afirmar que no costó nada producirlo. ' +
            'Las notas de crédito descuentan de la venta, con el signo del catálogo de ARCA.',
        };
      },
    );
  });

  /**
   * El asiento que el costo del mes propone.
   *
   * ## No lo registra
   *
   * Devuelve los renglones para que se carguen por `POST /journal-entries`,
   * igual que la propuesta de un comprobante (0074). Automatizarlo exigiría
   * decidir cuándo se asienta —por cada venta, por mes, al cierre— y esa es una
   * política contable que nadie declaró. Proponerlo por el mes que se consulta
   * deja esa elección en quien pide la propuesta.
   *
   * ## Y no propone lo que no se puede afirmar
   *
   * Sin método de valuación, con salidas sin costear o sin las dos cuentas
   * declaradas, no hay propuesta. Un asiento de costo armado sobre un promedio
   * incompleto **cuadra igual** y dice una cifra que no es.
   */
  app.get('/analysis/costo-de-ventas/asiento-propuesto', async (request) => {
    const tenant = await requireCompany(request);
    requirePermission(tenant, 'stock:read');
    requirePermission(tenant, 'journal_entry:read');
    const auth = requireAuth(request);
    const query = z.object({ mes: z.string().regex(/^\d{4}-\d{2}$/, 'Mes AAAA-MM') })
      .parse(request.query);

    return withCompany(
      { companyId: tenant.companyId, actorId: `user:${auth.user.userId}` },
      async (tx) => {
        const mes = `${query.mes}-01`;

        const r = await tx.query<{
          costo: string | null;
          salidas_sin_costo: number;
          productos: number;
          metodo: string | null;
          incompleto: boolean;
          sin_metodo: boolean;
        }>(
          `SELECT costo::text, salidas_sin_costo, productos, metodo, incompleto, sin_metodo
             FROM cogs_por_mes WHERE company_id = $1 AND mes = $2::date`,
          [tenant.companyId, mes],
        );

        const mapeo = await leerMapeo(tx, tenant.companyId);
        const faltan = (['COSTO_DE_VENTAS', 'MERCADERIA'] as const).filter(
          (rol) => !mapeo.has(rol),
        );

        const vacia = (motivo: string, rolesFaltantes: readonly string[] = []) => ({
          mes: query.mes,
          renglones: [] as unknown[],
          motivoSinRenglones: motivo,
          rolesFaltantes,
          justificacionSugerida: null,
          alcance:
            'Una propuesta no es un asiento: no tiene número, no está en ningún libro y no ' +
            'afecta ningún saldo. Se carga por `POST /journal-entries`, entra en borrador y ' +
            'la aprueba una persona.',
        });

        if (r.rowCount === 0) {
          return vacia(
            `No hubo salidas por venta en ${query.mes}: no hay costo que asentar.`,
          );
        }
        const f = r.rows[0]!;

        if (f.sin_metodo) {
          return vacia(
            'La empresa no declaró método de valuación para ese período: el costo no se ' +
              'afirma, así que tampoco se propone su asiento.',
          );
        }
        if (f.incompleto) {
          return vacia(
            `Hay ${f.salidas_sin_costo} salida(s) sin costear en el mes, porque su producto ` +
              'tiene entradas sin costo declarado. Un asiento armado con lo que sí tiene ' +
              'costo cuadra igual y dice una cifra más chica que la real.',
          );
        }
        if (faltan.length > 0) {
          return vacia(
            'Falta declarar a qué cuenta va: ' +
              faltan.join(', ') +
              '. Sin eso el sistema no elige ninguna: elegirla sería inventar la ' +
              'contabilidad de esta empresa.',
            faltan,
          );
        }

        const costo = f.costo ?? '0';
        if (costo === '0' || Number(costo) === 0) {
          return vacia(`El costo de ${query.mes} es cero: no hay asiento que proponer.`);
        }

        const descripcion = `Costo de mercadería vendida — ${query.mes}`;

        return {
          mes: query.mes,
          // Un renglón por lado. Abrirlo por producto daría un asiento de
          // doscientas líneas por mes que no lee nadie, y el detalle ya está en
          // `GET /analysis/costo-de-ventas` con su trazabilidad.
          renglones: [
            {
              accountCode: mapeo.get('COSTO_DE_VENTAS')!.codigo,
              debit: costo,
              credit: '0',
              descripcion,
            },
            {
              accountCode: mapeo.get('MERCADERIA')!.codigo,
              debit: '0',
              credit: costo,
              descripcion,
            },
          ],
          motivoSinRenglones: null,
          rolesFaltantes: [] as string[],
          costo,
          productos: f.productos,
          metodo: f.metodo,
          // §24: la propuesta sola no funda el asiento. Lo funda que una persona
          // la haya mirado y la cargue, y eso es lo que dice este texto.
          justificacionSugerida:
            `Costo de mercadería vendida de ${query.mes}, calculado por ${f.metodo} sobre ` +
            `${f.productos} producto(s) con costo declarado, revisado y aceptado por quien ` +
            'lo carga.',
          alcance:
            'El costo sale del promedio vigente **en el momento de cada salida**, no del de ' +
            'hoy. La propuesta no registra nada: se carga por `POST /journal-entries`, ' +
            'entra en borrador y la firma una persona.',
        };
      },
    );
  });
}

/** Del candado al error del dominio. Por código, no por prosa. */
function traducirValuacion(error: unknown): unknown {
  const mensaje = (error as { message?: string }).message ?? '';

  if (mensaje.includes('E_VAL_METODO_SUPERPUESTO')) {
    return conflict(
      'Ya hay un método de valuación vigente en esas fechas. Con dos, el mismo producto ' +
        'tendría dos costos y el balance dependería de cuál se leyó primero: cerrá el ' +
        'anterior y declará el nuevo desde el día siguiente.',
    );
  }
  return error;
}
