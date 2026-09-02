/**
 * Límite de intentos en las rutas de autenticación.
 *
 * ## Qué protege, y qué ya estaba protegido
 *
 * El bloqueo de cuenta por intentos fallidos existe desde la FASE 2: cinco
 * errores y la cuenta queda bloquea quince minutos. Eso protege **a una
 * cuenta**. Lo que no protegía nada es el otro caso: un atacante que prueba una
 * contraseña común contra mil direcciones distintas nunca falla cinco veces
 * sobre la misma cuenta, así que el bloqueo no se dispara ni una vez.
 *
 * Este límite es por origen y por ruta, y ataja eso.
 *
 * ## Es por proceso, y eso hay que decirlo
 *
 * La ventana vive en memoria. Con varias réplicas, cada una cuenta lo suyo: el
 * límite efectivo se multiplica por la cantidad de réplicas. No es un descuido
 * —está en `docs/DESPLIEGUE.md`— y la alternativa, contar en la base, agregaría
 * una escritura por intento fallido en el camino más caliente del sistema.
 *
 * ## Cuenta los que fallan, no los que entran
 *
 * Un límite que consume presupuesto con cada pedido echa a la empresa que tiene
 * veinte personas entrando a las nueve de la mañana, y no le hace nada a quien
 * prueba contraseñas —que falla siempre—. Así que el que sale bien no cuenta.
 *
 * ## Un límite técnico no es un límite comercial
 *
 * Este número no dice cuántas veces «puede» entrar una empresa: dice cuántos
 * intentos por minuto tolera el servidor desde un mismo origen antes de
 * contestar 429. Se puede cambiar por variable de entorno, y el valor por
 * defecto es deliberadamente holgado: apretarlo de más echa a un usuario
 * legítimo que se equivocó tres veces con el teclado en otro idioma.
 */

interface Ventana {
  /** Cuándo empezó la ventana, en milisegundos. */
  desde: number;
  intentos: number;
}

const ventanas = new Map<string, Ventana>();

/** Cuántas claves se toleran antes de limpiar las vencidas. */
const LIMPIEZA_CADA = 10_000;

export interface Decision {
  readonly permitido: boolean;
  /** Segundos que faltan para que la ventana se reinicie. */
  readonly esperar: number;
}

/**
 * ¿Puede intentar de nuevo? No consume nada.
 *
 * Se pregunta **antes** de tocar la base: si el límite se comprobara después,
 * cada intento de fuerza bruta seguiría costando una consulta, que es
 * exactamente lo que el atacante quiere.
 */
export function puedeIntentar(
  clave: string,
  maximo: number,
  ventanaSegundos: number,
  ahora: number = Date.now(),
): Decision {
  const ventanaMs = ventanaSegundos * 1000;
  const actual = ventanas.get(clave);

  if (actual === undefined || ahora - actual.desde > ventanaMs) {
    return { permitido: true, esperar: 0 };
  }
  if (actual.intentos < maximo) return { permitido: true, esperar: 0 };

  return {
    permitido: false,
    esperar: Math.max(1, Math.ceil((actual.desde + ventanaMs - ahora) / 1000)),
  };
}

/**
 * Cuenta un intento **fallido**.
 *
 * Los que salen bien no consumen presupuesto, y eso no es una concesión: un
 * límite que castiga a quien acierta echa a la empresa que tiene veinte
 * personas entrando a las nueve de la mañana, y no molesta en absoluto a quien
 * prueba contraseñas —que falla siempre—.
 */
export function contarFallo(
  clave: string,
  ventanaSegundos: number,
  ahora: number = Date.now(),
): void {
  const ventanaMs = ventanaSegundos * 1000;

  // Limpieza perezosa. Un `setInterval` mantendría el proceso vivo y haría que
  // los tests tuvieran que acordarse de apagarlo.
  if (ventanas.size > LIMPIEZA_CADA) {
    for (const [k, v] of ventanas) {
      if (ahora - v.desde > ventanaMs) ventanas.delete(k);
    }
  }

  const actual = ventanas.get(clave);
  if (actual === undefined || ahora - actual.desde > ventanaMs) {
    ventanas.set(clave, { desde: ahora, intentos: 1 });
    return;
  }
  actual.intentos += 1;
}

/** Solo para los tests: deja las ventanas como al arrancar. */
export function reiniciarLimites(): void {
  ventanas.clear();
}
