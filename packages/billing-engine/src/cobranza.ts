/**
 * Qué pasa cuando un pago falla.
 *
 * ## La política no está acá
 *
 * Cuántas veces reintentar, cada cuántos días y cuánta gracia dar **es una
 * decisión comercial**, no una constante de un motor. Una empresa que cobra
 * $8.000 por mes y una que cobra $800.000 no toleran lo mismo, y el día que
 * alguien quiera cambiarlo no debería tener que tocar código.
 *
 * Estas funciones reciben la política y devuelven el calendario que sale de
 * ella. Sin política declarada no hay calendario: un fallo de pago se registra
 * y no dispara nada. **Eso no es «cero reintentos»**, es que nadie dijo cuántos
 * — la misma distinción que el sistema hace en los cupos de IA y en los topes
 * de plan, y por el mismo motivo: un valor por defecto inventado se ve igual que
 * uno decidido, y el día que suspenda a un cliente nadie va a saber de dónde
 * salió.
 *
 * ## Suspender no es cancelar
 *
 * Suspender corta el acceso y **conserva todo**: los datos, la contabilidad, el
 * historial y la suscripción. Es reversible con un pago. Cancelar es la baja, y
 * es una decisión de la empresa cliente, no una consecuencia automática de no
 * haber pagado. Ninguna función de acá produce una cancelación.
 */

import { addDays, compareDates, type CalendarDate } from '@aai/shared';

/**
 * La política declarada.
 *
 * `reintentosEnDias` son días **desde el fallo original**, no desde el
 * reintento anterior: acumular offsets relativos hace que agregar un reintento
 * en el medio corra todos los siguientes, y el calendario de un cliente que ya
 * estaba en curso cambiaría de forma retroactiva.
 */
export interface PoliticaDeCobranza {
  readonly reintentosEnDias: readonly number[];
  /** Días desde el fallo hasta la suspensión. Debe ser posterior al último reintento. */
  readonly diasDeGracia: number;
  /** Días desde el fallo en que se avisa que se viene la suspensión. */
  readonly avisoEnDias: number;
}

export type TipoDePaso = 'REINTENTO' | 'AVISO' | 'SUSPENSION';

export interface PasoDeCobranza {
  readonly tipo: TipoDePaso;
  readonly el: CalendarDate;
  /** Solo en los reintentos: 1, 2, 3… Sirve para no repetir uno ya hecho. */
  readonly numero?: number;
}

export type MotivoDePoliticaInvalida =
  | 'GRACIA_ANTES_DEL_ULTIMO_REINTENTO'
  | 'AVISO_DESPUES_DE_LA_SUSPENSION'
  | 'DIAS_NEGATIVOS'
  | 'REINTENTOS_DESORDENADOS';

/**
 * Comprueba que la política pueda ejecutarse.
 *
 * Devuelve los motivos, no lanza: quien la declara tiene que poder ver **todos**
 * los problemas de una vez y corregirlos juntos, no descubrir el segundo después
 * de arreglar el primero.
 */
export function revisarPolitica(
  politica: PoliticaDeCobranza,
): readonly MotivoDePoliticaInvalida[] {
  const motivos: MotivoDePoliticaInvalida[] = [];

  if (
    politica.diasDeGracia < 0 ||
    politica.avisoEnDias < 0 ||
    politica.reintentosEnDias.some((d) => d < 0)
  ) {
    motivos.push('DIAS_NEGATIVOS');
  }

  const ordenados = politica.reintentosEnDias.every(
    (d, i) => i === 0 || d > politica.reintentosEnDias[i - 1]!,
  );
  if (!ordenados) motivos.push('REINTENTOS_DESORDENADOS');

  const ultimo = politica.reintentosEnDias.at(-1) ?? 0;
  // Suspender antes del último reintento haría que el reintento corriera sobre
  // una suscripción ya suspendida: cobraría bien y el cliente seguiría afuera.
  if (politica.diasDeGracia < ultimo) motivos.push('GRACIA_ANTES_DEL_ULTIMO_REINTENTO');

  if (politica.avisoEnDias > politica.diasDeGracia) motivos.push('AVISO_DESPUES_DE_LA_SUSPENSION');

  return motivos;
}

/**
 * El calendario completo que dispara un fallo de pago, en orden cronológico.
 *
 * Se calcula entero de una vez y no paso a paso porque así se lo puede mostrar:
 * un cliente que ve «reintentamos el 5 y el 12, y el 20 se suspende» entiende
 * qué le va a pasar. Un sistema que decide el paso siguiente cada vez sabe lo
 * mismo y no lo puede decir.
 */
export function planDeCobranza(
  falloEl: CalendarDate,
  politica: PoliticaDeCobranza,
): readonly PasoDeCobranza[] {
  const problemas = revisarPolitica(politica);
  if (problemas.length > 0) {
    throw new RangeError(`Política de cobranza inconsistente: ${problemas.join(', ')}`);
  }

  const pasos: PasoDeCobranza[] = politica.reintentosEnDias.map((dias, i) => ({
    tipo: 'REINTENTO' as const,
    el: addDays(falloEl, dias),
    numero: i + 1,
  }));

  pasos.push({ tipo: 'AVISO', el: addDays(falloEl, politica.avisoEnDias) });
  pasos.push({ tipo: 'SUSPENSION', el: addDays(falloEl, politica.diasDeGracia) });

  // Estable por fecha, y a igual fecha en el orden en que se generaron: primero
  // los reintentos, después el aviso, después la suspensión. Un aviso que cae el
  // mismo día que el último reintento tiene que salir después de intentarlo, no
  // antes — avisar de una suspensión que el reintento va a evitar es peor que no
  // avisar.
  return pasos
    .map((paso, orden) => ({ paso, orden }))
    .sort((a, b) => {
      const c = compareDates(a.paso.el, b.paso.el);
      return c !== 0 ? c : a.orden - b.orden;
    })
    .map(({ paso }) => paso);
}

/**
 * El paso que corresponde ejecutar hoy, o `null` si no hay ninguno pendiente.
 *
 * `yaHechos` son los pasos que ya se ejecutaron. Se pasa la lista en vez de un
 * contador porque el ciclo puede correr tarde —una máquina apagada un fin de
 * semana largo— y entonces hay varios vencidos a la vez: hay que ejecutar el
 * más viejo que falte, no saltar al de hoy. Saltar dejaría al cliente
 * suspendido sin que se hubiera intentado cobrarle.
 */
export function pasoPendiente(
  plan: readonly PasoDeCobranza[],
  yaHechos: readonly PasoDeCobranza[],
  hoy: CalendarDate,
): PasoDeCobranza | null {
  const hecho = (p: PasoDeCobranza): boolean =>
    yaHechos.some((h) => h.tipo === p.tipo && h.numero === p.numero);

  return plan.find((p) => !hecho(p) && compareDates(p.el, hoy) <= 0) ?? null;
}
