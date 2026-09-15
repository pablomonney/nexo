/**
 * El precio de lista de un plan, leído de donde vive.
 *
 * ## Por qué esto existe como módulo y no como una consulta suelta
 *
 * Porque hasta acá **nadie leía `plan_prices` para cobrar**. La tabla estaba
 * desde la 0096, el catálogo la mostraba, y el ciclo de facturación facturaba
 * contra `company_subscriptions.importe_acordado` — que es correcto, porque un
 * contrato puede diferir de la lista y lo pactado se congela al alta.
 *
 * El hueco estaba un paso antes: **quién pone ese `importe_acordado` la primera
 * vez**. La única función que lo escribe es `convertirPrueba`, y recibe el
 * importe por parámetro. Mientras esa función no tuvo quien la llamara, la
 * pregunta no se hacía. Al conectarle una ruta hay que contestarla, y hay dos
 * respuestas posibles:
 *
 *   · el importe lo manda quien convierte  → el administrador de una empresa
 *     cliente elige lo que paga;
 *   · el importe sale de la lista vigente  → esta función.
 *
 * La primera no es una opción. Por eso la ruta de conversión **no acepta un
 * importe en el cuerpo** y lo resuelve acá.
 *
 * ## Que un contrato pueda diferir de la lista sigue siendo cierto
 *
 * `convertirPrueba` conserva su parámetro. Lo que cambia es de dónde sale
 * cuando quien convierte es el cliente: de la lista. Un contrato distinto se
 * declara del lado del operador, que es donde vive todo lo que fija plata.
 *
 * ## Sin precio no se inventa cero
 *
 * `null` significa «nadie declaró el precio de este plan en esta moneda», y
 * quien llame tiene que decirlo con esas palabras. Convertir a cero sería
 * regalar el producto por una fila que falta, que es exactamente la confusión
 * que el catálogo evita al mostrar «sin precio declarado» en vez de «gratis».
 */

import type { Tx } from '@aai/db';
import { isCurrency, moneyFromDecimalString, type Money } from '@aai/shared';

export type Periodicidad = 'MENSUAL' | 'ANUAL';

export interface PrecioDeLista {
  readonly planId: string;
  readonly planNombre: string;
  /** Tal como está en `numeric(18,2)`: texto decimal, nunca un flotante. */
  readonly importe: string;
  /** El mismo importe en centavos, para lo que necesite aritmética. */
  readonly importeCentavos: bigint;
  readonly moneda: string;
  readonly periodicidad: Periodicidad;
  readonly incluyeImpuestos: boolean;
}

export type MotivoSinPrecio = 'PLAN_DESCONOCIDO' | 'SIN_PRECIO_VIGENTE' | 'MONEDA_DESCONOCIDA';

export type BusquedaDePrecio =
  | { readonly hay: true; readonly precio: PrecioDeLista }
  | { readonly hay: false; readonly motivo: MotivoSinPrecio; readonly detalle: string };

/**
 * El precio vigente hoy para un plan, una periodicidad y una moneda.
 *
 * `CURRENT_DATE` y no una fecha de JavaScript: Argentina es UTC−3, y después de
 * las nueve de la noche `new Date()` ya está en el día siguiente. Ese defecto
 * dejó a los cinco planes sin precio el 2026-09-09 a las 22:07 — está anotado en
 * `scripts/sembrar-comercial-b1.mjs` — y se repite en cuanto alguien vuelve a
 * comparar contra una fecha calculada acá. Se le pregunta a la base porque es la
 * base la que después compara.
 */
export async function precioVigenteDe(
  tx: Tx,
  entrada: {
    readonly planCode: string;
    readonly periodicidad: Periodicidad;
    readonly moneda: string;
  },
): Promise<BusquedaDePrecio> {
  if (!isCurrency(entrada.moneda)) {
    return {
      hay: false,
      motivo: 'MONEDA_DESCONOCIDA',
      detalle:
        `La moneda ${entrada.moneda} no está en el catálogo del sistema: no se sabe cuántos ` +
        'decimales tiene, así que no se puede convertir su importe a centavos.',
    };
  }

  const plan = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM subscription_plans WHERE code = $1 AND status = 'DISPONIBLE'`,
    [entrada.planCode],
  );
  const p = plan.rows[0];
  if (p === undefined) {
    return {
      hay: false,
      motivo: 'PLAN_DESCONOCIDO',
      detalle:
        `No hay un plan disponible con el código ${entrada.planCode}. Un plan discontinuado ` +
        'no se vuelve a poner a la venta: se crea uno nuevo.',
    };
  }

  const precio = await tx.query<{ importe: string; incluye_impuestos: boolean }>(
    `SELECT importe::text AS importe, incluye_impuestos
       FROM plan_prices
      WHERE plan_id = $1 AND periodicidad = $2 AND moneda = $3
        AND vigente_desde <= CURRENT_DATE
        AND (vigente_hasta IS NULL OR vigente_hasta > CURRENT_DATE)
      ORDER BY vigente_desde DESC
      LIMIT 1`,
    [p.id, entrada.periodicidad, entrada.moneda],
  );
  const fila = precio.rows[0];
  if (fila === undefined) {
    return {
      hay: false,
      motivo: 'SIN_PRECIO_VIGENTE',
      detalle:
        `El plan ${entrada.planCode} no tiene un precio ${entrada.periodicidad} vigente en ` +
        `${entrada.moneda}. Un plan sin precio no es un plan gratis: es un plan cuyo precio ` +
        'nadie declaró todavía.',
    };
  }

  const dinero: Money = moneyFromDecimalString(fila.importe, entrada.moneda);

  return {
    hay: true,
    precio: {
      planId: p.id,
      planNombre: p.name,
      importe: fila.importe,
      importeCentavos: dinero.amount,
      moneda: entrada.moneda,
      periodicidad: entrada.periodicidad,
      incluyeImpuestos: fila.incluye_impuestos,
    },
  };
}
