/**
 * Identificadores únicos para los datos de prueba.
 *
 * ## El defecto que esto reemplaza
 *
 * Las suites armaban su sufijo así:
 *
 * ```ts
 * const stamp = `${process.pid}${Date.now()}`.replace(/\D/g, '').slice(-8);
 * ```
 *
 * El `process.pid` está ahí **para dar unicidad, y `slice(-8)` lo descarta**: la
 * cadena mide más de ocho caracteres, así que lo único que sobrevive son los
 * últimos ocho dígitos de `Date.now()`. Tres procesos distintos en el mismo
 * milisegundo producen el mismo sufijo.
 *
 * Con ese sufijo se arma el CUIT del estudio —`withCheckDigit('30' + stamp)`— y
 * el prefijo `30` es el mismo en las cinco suites. Dos suites que arrancan en el
 * mismo milisegundo, corriendo en paralelo, chocan contra
 * `organizations_tax_id_key`. Eso es exactamente lo que falló el 2026-08-27.
 *
 * Había un segundo modo, más lento y peor: ocho dígitos de milisegundos se
 * repiten cada 27,8 horas, y las filas **nunca se borran**. Dos corridas
 * separadas por poco más de un día colisionaban aunque nada corriera en
 * paralelo.
 *
 * ## Por qué una secuencia y no más entropía
 *
 * Ocho dígitos al azar parecen suficientes hasta que se hace la cuenta: con
 * filas que se acumulan para siempre, a las diez mil la probabilidad de colisión
 * por cumpleaños ronda el 50%. Aumentar la aleatoriedad hace el fallo más raro y
 * más difícil de reproducir, que es la peor combinación.
 *
 * `nextval()` de PostgreSQL es único por construcción, entre procesos y entre
 * corridas, sin coordinación. La secuencia vive en la base de tests —la crea
 * `npm run test:db`— y no en las migraciones: el esquema de producción no tiene
 * por qué cargar con infraestructura de pruebas.
 */

import type pg from 'pg';

/**
 * Ocho dígitos únicos, para componer CUIT y correos de prueba.
 *
 * Se devuelve como texto y no como número porque su destino es concatenarse:
 * `30${sufijo}` tiene que conservar los ceros a la izquierda si los hubiera.
 */
export async function sufijoUnico(client: pg.Client): Promise<string> {
  const r = await client.query<{ v: string }>("SELECT nextval('fixture_ids')::text AS v");
  const valor = r.rows[0]?.v;
  if (valor === undefined) {
    throw new Error('La secuencia fixture_ids no devolvió valor. ¿Corriste `npm run test:db`?');
  }
  return valor.padStart(8, '0');
}

/**
 * La fórmula vieja, conservada **solo** para que el test pueda demostrar que
 * colisiona. No se usa en ninguna suite.
 *
 * Recibe `pid` y `ahora` en vez de leerlos del proceso para poder fijarlos: un
 * test que dependa del reloj real no prueba nada de forma determinística.
 */
export function sufijoLegadoQueColisiona(pid: number, ahora: number): string {
  return `${pid}${ahora}`.replace(/\D/g, '').slice(-8);
}
