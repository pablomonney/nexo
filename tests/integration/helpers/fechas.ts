/**
 * La fecha, tomada de donde después se la va a comparar.
 *
 * ## El defecto que esto arregla
 *
 * Las suites armaban «hoy» con `new Date().toISOString()`, que cuenta en UTC, y
 * la base compara contra `current_date`, que cuenta en la zona del servidor.
 * En Argentina son tres horas de diferencia: **después de las 21:00 los dos
 * relojes están en días distintos**.
 *
 * Dos tests se caían por eso y por nada más: un lote que vencía «ayer» —que a
 * las 21:30 era hoy para la base, y por lo tanto no estaba vencido— y un punto
 * de venta que se mudaba «hoy» y todavía no se había mudado.
 *
 * No es una rareza de estas dos pruebas: cualquier comparación entre una fecha
 * armada en el proceso y una calculada en la base tiene el mismo agujero, y
 * aparece solo en una franja horaria. Un `verify` que falla de noche y pasa de
 * mañana enseña a no creerle al `verify`.
 *
 * La regla, entonces: **si la base va a comparar la fecha, la fecha sale de la
 * base.**
 */

import type { Client } from './db.js';

/** El día de hoy según la base, en formato ISO. */
export async function hoyDeLaBase(db: Client): Promise<string> {
  const r = await db.query<{ hoy: string }>('SELECT current_date::text AS hoy');
  return r.rows[0]!.hoy;
}

/** Un día relativo al de la base: negativo hacia atrás, positivo hacia adelante. */
export async function diasDeLaBase(db: Client, dias: number): Promise<string> {
  const r = await db.query<{ dia: string }>(
    `SELECT (current_date + ($1 || ' days')::interval)::date::text AS dia`,
    [dias],
  );
  return r.rows[0]!.dia;
}
