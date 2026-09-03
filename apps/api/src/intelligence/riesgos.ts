/**
 * El radar de riesgos: lo transversal que ninguna pantalla mira sola.
 *
 * Cada módulo ya avisa lo suyo — la cartera avisa de la mora, el stock del
 * quiebre, las señales del desvío—. Lo que faltaba es la lectura cruzada: seis
 * frentes, cada uno con los hechos que lo componen y, cuando no se puede
 * evaluar, **qué falta declarar para poder hacerlo**.
 *
 * ## Un riesgo que no se puede evaluar no se informa como «sin riesgo»
 *
 * Es la misma regla que gobierna los umbrales: `null` no es cero. Una empresa
 * que no declaró plazos de pago no tiene «riesgo de liquidez bajo» — tiene un
 * riesgo de liquidez que el sistema no puede medir, y decirlo es lo único
 * honesto. Un tablero verde por falta de datos es peor que no tener tablero.
 *
 * ## Hechos y juicios, separados
 *
 * Cada frente distingue lo que **es** de lo que **supera un umbral declarado**.
 * Vender por debajo del costo es un hecho; que una concentración del 40 % sea
 * peligrosa es una política de la empresa. Los dos se informan, y nunca
 * mezclados: es el principio de la 0084 aplicado a toda la lectura.
 *
 * ## Y no inventa una nota global
 *
 * No hay un «riesgo total: 7,4». Sumar frentes que se miden en unidades
 * distintas —días, pesos, porcentajes— y presentarlo como un número exigiría
 * ponderarlos, y esa ponderación sería una opinión sin dueño.
 */

import type { Tx } from '@aai/db';

export interface Frente {
  readonly frente: string;
  readonly titulo: string;
  /** `false` cuando falta algo para poder medirlo. Nunca significa «está bien». */
  readonly evaluable: boolean;
  readonly hechos: readonly { readonly que: string; readonly valor: string }[];
  /** Señales encendidas contra un umbral que la empresa declaró. */
  readonly desviosDeclarados: readonly { readonly tipo: string; readonly detalle: string }[];
  readonly noSeEvalua: string | null;
  readonly origen: readonly string[];
}

export async function radarDeRiesgos(tx: Tx, companyId: string): Promise<Frente[]> {
  const [liquidez, cobranza, concentracion, margen, operativo, contable] = await Promise.all([
    frenteLiquidez(tx, companyId),
    frenteCobranza(tx, companyId),
    frenteConcentracion(tx, companyId),
    frenteMargen(tx, companyId),
    frenteOperativo(tx, companyId),
    frenteContable(tx, companyId),
  ]);
  return [liquidez, cobranza, concentracion, margen, operativo, contable];
}

/** Señales encendidas de un tipo, con su detalle. */
async function desvios(
  tx: Tx,
  companyId: string,
  tipos: readonly string[],
): Promise<{ tipo: string; detalle: string }[]> {
  const r = await tx.query<{ tipo: string; sujeto: string; valor: string; unidad: string; umbral: string | null }>(
    `SELECT tipo, sujeto, valor::text, unidad, umbral::text
       FROM analysis_signals
      WHERE company_id = $1 AND supera_umbral IS TRUE AND tipo = ANY ($2::text[])`,
    [companyId, tipos],
  );
  return r.rows.map((s) => ({
    tipo: s.tipo,
    detalle:
      `${s.sujeto}: ${s.valor}${s.unidad}` +
      (s.umbral === null
        ? ' (es un hecho, no un umbral declarado)'
        : ` contra un umbral declarado de ${s.umbral}${s.unidad}`),
  }));
}

/**
 * Liquidez: qué hay contra qué vence.
 *
 * No se evalúa sin vencimientos declarados. Comparar el disponible contra una
 * deuda sin fecha daría una cobertura que parece tranquilizadora y no significa
 * nada: la deuda podría vencer toda la semana que viene.
 */
async function frenteLiquidez(tx: Tx, companyId: string): Promise<Frente> {
  const r = await tx.query<{
    disponible: string; a_pagar_30: string; a_cobrar_30: string;
    sin_fecha_pagar: string; con_fecha: number;
  }>(
    `SELECT (SELECT coalesce(sum(saldo), 0) FROM analytics_disponible
              WHERE company_id = $1)::text                                   AS disponible,
            (SELECT coalesce(sum(proximos_30 + vencido), 0)
               FROM analytics_flujo_de_fondos
              WHERE company_id = $1 AND sentido = 'SALIDA')::text            AS a_pagar_30,
            (SELECT coalesce(sum(proximos_30 + vencido), 0)
               FROM analytics_flujo_de_fondos
              WHERE company_id = $1 AND sentido = 'ENTRADA')::text           AS a_cobrar_30,
            (SELECT coalesce(sum(sin_fecha), 0)
               FROM analytics_flujo_de_fondos
              WHERE company_id = $1 AND sentido = 'SALIDA')::text            AS sin_fecha_pagar,
            (SELECT count(*)::int FROM invoice_settlement
              WHERE company_id = $1 AND pendiente <> 0 AND vencimiento_declarado) AS con_fecha`,
    [companyId],
  );
  const f = r.rows[0]!;
  const evaluable = f.con_fecha > 0;

  return {
    frente: 'LIQUIDEZ',
    titulo: 'Con qué se paga lo que vence',
    evaluable,
    hechos: [
      { que: 'Disponible hoy (caja y bancos del Mayor)', valor: f.disponible },
      { que: 'A pagar: vencido y próximos 30 días', valor: f.a_pagar_30 },
      { que: 'A cobrar: vencido y próximos 30 días', valor: f.a_cobrar_30 },
      { que: 'A pagar sin fecha de vencimiento', valor: f.sin_fecha_pagar },
    ],
    desviosDeclarados: [],
    noSeEvalua: evaluable
      ? null
      : 'Ningún comprobante pendiente tiene vencimiento declarado. Comparar el disponible ' +
        'contra una deuda sin fecha daría una cobertura que parece tranquilizadora y no ' +
        'significa nada: podría vencer toda la semana que viene.',
    origen: ['analytics_disponible', 'analytics_flujo_de_fondos', 'invoice_settlement'],
  };
}

/** Cobranza: cuánto está vencido y qué tan vieja es la cartera. */
async function frenteCobranza(tx: Tx, companyId: string): Promise<Frente> {
  const r = await tx.query<{
    pendiente: string; vencido: string; mas_antiguo: number | null; con_plazo: number;
    cheques_en_cartera: string;
  }>(
    `SELECT (SELECT coalesce(sum(pendiente), 0) FROM party_aging
              WHERE company_id = $1 AND direction = 'VENTAS')::text        AS pendiente,
            (SELECT coalesce(sum(vencido), 0) FROM party_aging
              WHERE company_id = $1 AND direction = 'VENTAS')::text        AS vencido,
            (SELECT max(mas_antiguo) FROM party_aging
              WHERE company_id = $1 AND direction = 'VENTAS')              AS mas_antiguo,
            (SELECT count(*)::int FROM invoice_settlement
              WHERE company_id = $1 AND direction = 'VENTAS'
                AND pendiente > 0 AND vencimiento_declarado)               AS con_plazo,
            (SELECT coalesce(sum(total), 0) FROM checks_en_cartera
              WHERE company_id = $1)::text                                  AS cheques_en_cartera`,
    [companyId],
  );
  const f = r.rows[0]!;

  return {
    frente: 'COBRANZA',
    titulo: 'Qué se le debe a la empresa y desde cuándo',
    evaluable: f.con_plazo > 0,
    hechos: [
      { que: 'Pendiente de cobro', valor: f.pendiente },
      { que: 'De eso, vencido', valor: f.vencido },
      {
        que: 'Comprobante abierto más antiguo',
        valor: f.mas_antiguo === null ? 'sin dato' : `${f.mas_antiguo} días`,
      },
      { que: 'Cheques en cartera', valor: f.cheques_en_cartera },
    ],
    desviosDeclarados: await desvios(tx, companyId, ['MORA_DE_CARTERA', 'RECHAZO_DE_CHEQUES']),
    noSeEvalua:
      f.con_plazo > 0
        ? null
        : 'Ningún comprobante de venta pendiente tiene plazo declarado: el sistema no afirma ' +
          'mora. Lo vencido que se informa es cero por eso, no porque esté todo al día.',
    origen: ['party_aging', 'invoice_settlement', 'checks_en_cartera'],
  };
}

/**
 * Concentración: de cuántos depende la empresa.
 *
 * De clientes ya existe como señal con umbral. De proveedores no existía, y es
 * la misma pregunta del otro lado: si el 70 % de las compras viene de uno, un
 * problema suyo es un problema de esta empresa.
 */
async function frenteConcentracion(tx: Tx, companyId: string): Promise<Frente> {
  const r = await tx.query<{
    direccion: string; razon_social: string; pct: string; terceros: number;
  }>(
    `WITH t AS (
       SELECT direccion, razon_social, neto,
              sum(neto) OVER (PARTITION BY direccion) AS total,
              count(*) OVER (PARTITION BY direccion) AS terceros,
              row_number() OVER (PARTITION BY direccion ORDER BY neto DESC) AS n
         FROM analytics_por_tercero
        WHERE company_id = $1 AND ultima >= (current_date - interval '1 year')::date
     )
     SELECT direccion, razon_social,
            round(neto * 100 / nullif(total, 0), 2)::text AS pct,
            terceros::int
       FROM t WHERE n = 1`,
    [companyId],
  );

  const hechos = r.rows.map((f) => ({
    que:
      f.direccion === 'VENTAS'
        ? `El cliente más grande (${f.razon_social}), sobre 12 meses`
        : `El proveedor más grande (${f.razon_social}), sobre 12 meses`,
    valor: `${f.pct} % de ${f.terceros} ${f.direccion === 'VENTAS' ? 'clientes' : 'proveedores'}`,
  }));

  return {
    frente: 'CONCENTRACION',
    titulo: 'De cuántos depende la empresa',
    evaluable: hechos.length > 0,
    hechos,
    desviosDeclarados: await desvios(tx, companyId, ['CONCENTRACION_DE_CLIENTES']),
    noSeEvalua:
      hechos.length > 0
        ? null
        : 'No hay operaciones resueltas contra el maestro de terceros en los últimos doce ' +
          'meses: sin eso no se sabe de quién depende la empresa.',
    origen: ['analytics_por_tercero', 'analysis_signals'],
  };
}

/** Margen: lo que se vende por debajo del costo, y el margen general. */
async function frenteMargen(tx: Tx, companyId: string): Promise<Frente> {
  const r = await tx.query<{
    bajo_costo: number; afirmables: number; margen_pct: string | null; sin_afirmar: string;
  }>(
    `SELECT count(*) FILTER (WHERE margen < 0)::int                        AS bajo_costo,
            count(*) FILTER (WHERE margen IS NOT NULL)::int                AS afirmables,
            round(sum(margen) * 100
                  / nullif(sum(venta) FILTER (WHERE margen IS NOT NULL), 0), 2)::text
                                                                           AS margen_pct,
            coalesce(sum(venta) FILTER (WHERE margen IS NULL), 0)::text    AS sin_afirmar
       FROM analytics_margen_por_producto
      WHERE company_id = $1
        AND mes >= date_trunc('month', current_date - interval '12 months')::date`,
    [companyId],
  );
  const f = r.rows[0]!;

  return {
    frente: 'MARGEN',
    titulo: 'Si lo que se vende deja plata',
    evaluable: f.afirmables > 0,
    hechos: [
      { que: 'Renglones vendidos por debajo del costo', valor: String(f.bajo_costo) },
      { que: 'Margen general de doce meses', valor: f.margen_pct === null ? 'no se afirma' : `${f.margen_pct} %` },
      { que: 'Venta sin margen afirmable', valor: f.sin_afirmar },
    ],
    desviosDeclarados: await desvios(tx, companyId, ['VENTA_BAJO_COSTO', 'MARGEN_INSUFICIENTE']),
    noSeEvalua:
      f.afirmables > 0
        ? null
        : 'Ningún renglón tiene margen afirmable: falta declarar el método de valuación, o ' +
          'las salidas de stock no coinciden con lo facturado. Sin eso no se puede decir si ' +
          'lo que se vende deja plata.',
    origen: ['analytics_margen_por_producto', 'analysis_signals'],
  };
}

/** Operativo: lo que puede frenar la operación. */
async function frenteOperativo(tx: Tx, companyId: string): Promise<Frente> {
  const r = await tx.query<{ rama: string; n: number }>(
    `SELECT rama, count(*)::int AS n FROM work_queue
      WHERE company_id = $1
        AND rama IN ('STOCK_BAJO_MINIMO', 'STOCK_NEGATIVO', 'LOTE_VENCIDO',
                     'ENTRADA_SIN_COSTO', 'SIN_METODO_DE_VALUACION',
                     'ORDEN_DE_PAGO_SIN_PAGAR', 'SOLICITUD_SIN_RESPONDER')
      GROUP BY rama ORDER BY rama`,
    [companyId],
  );

  return {
    frente: 'OPERATIVO',
    titulo: 'Lo que puede frenar la operación',
    evaluable: true,
    hechos:
      r.rowCount === 0
        ? [{ que: 'Avisos operativos abiertos', valor: '0' }]
        : r.rows.map((f) => ({ que: f.rama, valor: String(f.n) })),
    desviosDeclarados: [],
    // Este frente sí se puede afirmar vacío: la bandeja se deriva de hechos, y
    // ninguno abierto significa ninguno, no falta de datos.
    noSeEvalua: null,
    origen: ['work_queue'],
  };
}

/** Contable: lo que impide cerrar o lo que no cuadra. */
async function frenteContable(tx: Tx, companyId: string): Promise<Frente> {
  const r = await tx.query<{ bloqueantes: number; total: number; sin_periodo: number }>(
    `SELECT count(*) FILTER (WHERE bloquea)::int                     AS bloqueantes,
            count(*)::int                                            AS total,
            (SELECT count(*)::int FROM periods
              WHERE company_id = $1 AND status = 'ABIERTO'
                AND end_date < current_date - 60)                    AS sin_periodo
       FROM work_queue WHERE company_id = $1`,
    [companyId],
  );
  const f = r.rows[0]!;

  return {
    frente: 'CONTABLE',
    titulo: 'Lo que impide cerrar',
    evaluable: true,
    hechos: [
      { que: 'Ítems que bloquean', valor: String(f.bloqueantes) },
      { que: 'Ítems en la bandeja', valor: String(f.total) },
      { que: 'Períodos abiertos con más de 60 días', valor: String(f.sin_periodo) },
    ],
    desviosDeclarados: [],
    noSeEvalua: null,
    origen: ['work_queue', 'periods'],
  };
}
