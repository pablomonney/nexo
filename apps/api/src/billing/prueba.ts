/**
 * La prueba de catorce días: empezarla, convertirla y vencerla.
 *
 * ## Una sola fuente de verdad, y ya existía
 *
 * La prueba **es** la suscripción, con `estado = 'PRUEBA'` y `vigencia_hasta`
 * en el día que termina. No hay una tabla de trials ni una columna
 * `trial_ends_at`: dos registros del mismo hecho se desincronizan y el día que
 * difieran no hay forma de saber cuál manda (ADR-022).
 *
 * El `CHECK` de la 0106 hace que una prueba sin fecha de fin sea imposible. Sin
 * él la regla viviría acá, y el primer alta por otro camino dejaría una prueba
 * eterna.
 *
 * ## Vencer no es cancelar
 *
 * Cuando la prueba llega a su fecha sin conversión, la suscripción pasa a
 * `SUSPENDIDA`. Cancelar es una decisión del cliente, y de `CANCELADA` no se
 * vuelve; quien dejó vencer una prueba no decidió nada. Suspender conserva
 * todo —los datos, la contabilidad, el historial— y se levanta contratando.
 *
 * ## Convertir es un `UPDATE`, no una suscripción nueva
 *
 * La vigencia sigue siendo la misma: cambia el estado y aparecen las
 * condiciones acordadas. Cerrar la prueba y abrir otra fila partiría en dos la
 * historia de un cliente que nunca se fue.
 */

import { recordAudit, type Tx } from '@aai/db';
import { puedeTransicionar, type EstadoDeSuscripcion } from '@aai/billing-engine';
import { addDays, parseCalendarDate, type CalendarDate } from '@aai/shared';

/**
 * Cuánto dura la prueba.
 *
 * Catorce días es la hipótesis comercial de B-1. Está acá y no en la base
 * porque es el valor por defecto de un alta, no una política que cambie por
 * empresa: quien quiera dar más días lo hace declarando la fecha de fin, que es
 * lo que la suscripción guarda.
 */
export const DIAS_DE_PRUEBA = 14;

/**
 * Cuántos días de prueba da un plan.
 *
 * Desde la 0121 la duración es **un dato del plan**, no una constante: quien
 * quiera dar treinta días en Completo y siete en Contable lo declara en la base
 * y no despliega nada.
 *
 * `dias_de_prueba IS NULL` significa «este plan no declaró nada», y entonces
 * vale `DIAS_DE_PRUEBA`. **No significa cero**: un cero acá le sacaría la
 * prueba a todo el que contrate ese plan, que es exactamente la confusión que
 * el sistema evita en los topes y en los precios.
 */
export function diasDePruebaDe(declarado: number | null | undefined): number {
  return declarado === null || declarado === undefined ? DIAS_DE_PRUEBA : declarado;
}

/** Cuántos días antes del fin se considera «por vencer». */
export const AVISO_ANTES_DE_VENCER = 3;

export interface PruebaIniciada {
  readonly subscriptionId: string;
  readonly desde: CalendarDate;
  readonly hasta: CalendarDate;
}

/**
 * Da de alta la prueba de una empresa.
 *
 * Falla si la empresa ya tuvo una: una prueba por empresa. Sin eso, cancelar y
 * volver a empezar sería producto gratis indefinido, y el `UNIQUE` de la 0073
 * —que impide dos suscripciones vigentes superpuestas— no lo alcanza, porque
 * una cancelada ya no está vigente.
 */
export async function iniciarPrueba(
  tx: Tx,
  entrada: {
    readonly companyId: string;
    readonly planCode: string;
    readonly desde: CalendarDate;
    readonly actorId: string;
  },
): Promise<
  | { readonly estado: 'INICIADA'; readonly prueba: PruebaIniciada }
  | { readonly estado: 'YA_TUVO_PRUEBA' }
  | { readonly estado: 'PLAN_DESCONOCIDO'; readonly detalle: string }
> {
  const plan = await tx.query<{ id: string; name: string; dias_de_prueba: number | null }>(
    `SELECT id, name, dias_de_prueba FROM subscription_plans
      WHERE code = $1 AND status = 'DISPONIBLE'`,
    [entrada.planCode],
  );
  if (plan.rows[0] === undefined) {
    return {
      estado: 'PLAN_DESCONOCIDO',
      detalle: `No hay un plan disponible con el código ${entrada.planCode}.`,
    };
  }

  const previa = await tx.query(
    'SELECT 1 FROM company_subscriptions WHERE company_id = $1',
    [entrada.companyId],
  );
  if (previa.rowCount !== null && previa.rowCount > 0) {
    return { estado: 'YA_TUVO_PRUEBA' };
  }

  // El día de alta cuenta, así que catorce días son `desde + 13`. Sumar catorce
  // daría quince días de prueba, que es el error clásico de un intervalo
  // cerrado contado como abierto.
  const dias = diasDePruebaDe(plan.rows[0].dias_de_prueba);
  const hasta = addDays(entrada.desde, dias - 1);

  const r = await tx.query<{ id: string }>(
    `INSERT INTO company_subscriptions
       (company_id, plan_id, estado, vigencia_desde, vigencia_hasta, created_by)
     VALUES ($1, $2, 'PRUEBA', $3::date, $4::date, $5)
     RETURNING id`,
    [entrada.companyId, plan.rows[0].id, entrada.desde, hasta, entrada.actorId],
  );

  await recordAudit(tx, entrada.companyId, {
    actorType: 'SYSTEM',
    actorId: entrada.actorId,
    action: 'INICIAR_PRUEBA',
    objectType: 'company_subscription',
    objectId: r.rows[0]!.id,
    // `dias` es el que se usó de verdad, no la constante: si el plan declaró
    // otra duración, la bitácora tiene que decir la que se le dio a esta
    // empresa y no la que suele darse.
    newValue: { plan: entrada.planCode, desde: entrada.desde, hasta, dias },
  });

  return {
    estado: 'INICIADA',
    prueba: { subscriptionId: r.rows[0]!.id, desde: entrada.desde, hasta },
  };
}

export type SituacionDePrueba = 'EN_CURSO' | 'POR_VENCER' | 'VENCIDA' | 'NO_ES_PRUEBA';

export interface EstadoDePrueba {
  readonly subscriptionId: string;
  readonly plan: string;
  readonly planCode: string;
  readonly empezo: CalendarDate;
  readonly termina: CalendarDate;
  readonly diasRestantes: number;
  readonly situacion: SituacionDePrueba;
}

/** En qué anda la prueba de esta empresa, o `null` si no está en prueba. */
export async function pruebaDe(tx: Tx, companyId: string): Promise<EstadoDePrueba | null> {
  const { rows } = await tx.query<{
    subscription_id: string;
    plan: string;
    plan_code: string;
    empezo: string;
    termina: string;
    dias_restantes: number;
    situacion: SituacionDePrueba;
  }>(
    `SELECT subscription_id, plan, plan_code, empezo::text, termina::text,
            dias_restantes, situacion
       FROM trial_status WHERE company_id = $1`,
    [companyId],
  );
  const t = rows[0];
  if (t === undefined) return null;

  return {
    subscriptionId: t.subscription_id,
    plan: t.plan,
    planCode: t.plan_code,
    empezo: parseCalendarDate(t.empezo),
    termina: parseCalendarDate(t.termina),
    diasRestantes: Number(t.dias_restantes),
    situacion: t.situacion,
  };
}

/**
 * Convierte una prueba en una suscripción paga.
 *
 * El importe lo trae quien convierte, no se deduce del precio de lista: un
 * contrato puede diferir de la lista, y congelarlo acá es lo que hace que
 * declarar una lista nueva no altere lo pactado con quien ya está.
 */
export async function convertirPrueba(
  tx: Tx,
  entrada: {
    readonly companyId: string;
    readonly planCode: string;
    readonly periodicidad: 'MENSUAL' | 'ANUAL';
    readonly moneda: string;
    readonly importe: string;
    readonly desde: CalendarDate;
    readonly actorId: string;
  },
): Promise<
  | { readonly estado: 'CONVERTIDA'; readonly subscriptionId: string }
  | { readonly estado: 'NO_HAY_PRUEBA' }
  | { readonly estado: 'NO_SE_PUEDE'; readonly detalle: string }
> {
  const actual = await tx.query<{ id: string; estado: EstadoDeSuscripcion }>(
    `SELECT id, estado FROM company_subscriptions
      WHERE company_id = $1 AND estado IN ('PRUEBA', 'SUSPENDIDA')
      ORDER BY vigencia_desde DESC LIMIT 1`,
    [entrada.companyId],
  );
  const s = actual.rows[0];
  if (s === undefined) return { estado: 'NO_HAY_PRUEBA' };

  // Se pregunta antes de intentar. Una prueba vencida ya está SUSPENDIDA, y de
  // ahí también se convierte: es exactamente el cliente que se decidió tarde.
  if (!puedeTransicionar(s.estado, 'ACTIVA')) {
    return {
      estado: 'NO_SE_PUEDE',
      detalle: `La suscripción está ${s.estado} y de ahí no se pasa a ACTIVA.`,
    };
  }

  const plan = await tx.query<{ id: string }>(
    `SELECT id FROM subscription_plans WHERE code = $1 AND status = 'DISPONIBLE'`,
    [entrada.planCode],
  );
  if (plan.rows[0] === undefined) {
    return { estado: 'NO_SE_PUEDE', detalle: `No hay un plan disponible ${entrada.planCode}.` };
  }

  await tx.query(
    `UPDATE company_subscriptions
        SET estado = 'ACTIVA',
            plan_id = $2,
            -- La vigencia deja de tener fin: la prueba terminaba, la
            -- suscripción no. Dejar la fecha vieja la vencería de nuevo.
            vigencia_hasta = NULL,
            motivo = NULL,
            suspendida_el = NULL,
            periodicidad = $3,
            moneda = $4,
            importe_acordado = $5::numeric,
            proxima_facturacion = $6::date
      WHERE id = $1`,
    [
      s.id,
      plan.rows[0].id,
      entrada.periodicidad,
      entrada.moneda,
      entrada.importe,
      entrada.desde,
    ],
  );

  await recordAudit(tx, entrada.companyId, {
    actorType: 'SYSTEM',
    actorId: entrada.actorId,
    action: 'CONVERTIR_PRUEBA',
    objectType: 'company_subscription',
    objectId: s.id,
    oldValue: { estado: s.estado },
    newValue: {
      estado: 'ACTIVA',
      plan: entrada.planCode,
      periodicidad: entrada.periodicidad,
      moneda: entrada.moneda,
      importe: entrada.importe,
      desde: entrada.desde,
    },
  });

  return { estado: 'CONVERTIDA', subscriptionId: s.id };
}

export interface InformeDePruebas {
  readonly vencidas: readonly { companyId: string; subscriptionId: string }[];
  /** Las que están por vencer, para que alguien las mire. */
  readonly porVencer: readonly { companyId: string; diasRestantes: number }[];
}

/**
 * Vence las pruebas que llegaron a su fecha sin convertirse.
 *
 * Corre desde el ciclo de facturación, con el `Tx` de quien lo llama y **sin
 * empresa en contexto**: recorre todas. Por eso lo llama el operador y no una
 * ruta — una ruta que venciera pruebas correría con la empresa de quien la
 * llama y solo podría vencer la suya.
 *
 * Correrlo dos veces el mismo día es inocuo: la segunda no encuentra ninguna en
 * `PRUEBA`.
 *
 * ## No hay nada que sincronizar con la pasarela, y se puede demostrar
 *
 * Vencer una prueba no pausa ninguna suscripción del proveedor porque **una
 * prueba no puede estar conectada a ninguno**: `conectarConLaPasarela` exige
 * `ACTIVA`, que es el estado al que se llega convirtiendo. No es que se decidió
 * no avisarle: no hay a quién.
 */
export async function vencerPruebas(
  tx: Tx,
  hoy: CalendarDate,
  actorId: string,
): Promise<InformeDePruebas> {
  const { rows } = await tx.query<{ id: string; company_id: string; termina: string }>(
    `SELECT id, company_id, vigencia_hasta::text AS termina
       FROM company_subscriptions
      WHERE estado = 'PRUEBA' AND vigencia_hasta < $1::date
      ORDER BY vigencia_hasta`,
    [hoy],
  );

  const vencidas: { companyId: string; subscriptionId: string }[] = [];
  for (const s of rows) {
    await tx.query(
      `UPDATE company_subscriptions
          SET estado = 'SUSPENDIDA', suspendida_el = $2::date,
              motivo = 'La prueba terminó sin contratación'
        WHERE id = $1`,
      [s.id, hoy],
    );
    await recordAudit(tx, s.company_id, {
      actorType: 'SYSTEM',
      actorId,
      action: 'VENCER_PRUEBA',
      objectType: 'company_subscription',
      objectId: s.id,
      motivo: `La prueba terminaba el ${s.termina} y no se contrató ningún plan`,
      oldValue: { estado: 'PRUEBA' },
      newValue: { estado: 'SUSPENDIDA', termino: s.termina },
    });
    vencidas.push({ companyId: s.company_id, subscriptionId: s.id });
  }

  const proximas = await tx.query<{ company_id: string; dias_restantes: number }>(
    `SELECT company_id, dias_restantes FROM trial_status
      WHERE situacion = 'POR_VENCER' ORDER BY dias_restantes`,
  );

  return {
    vencidas,
    porVencer: proximas.rows.map((p) => ({
      companyId: p.company_id,
      diasRestantes: Number(p.dias_restantes),
    })),
  };
}
