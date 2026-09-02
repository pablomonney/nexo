/**
 * S-14 — El límite de intentos por origen.
 *
 * ## Qué protege que el bloqueo de cuenta no protegía
 *
 * El bloqueo por intentos fallidos existe desde la FASE 2 y protege **una**
 * cuenta: cinco errores y queda bloqueada quince minutos. Lo que no atajaba es
 * el caso inverso —una contraseña común probada contra mil direcciones
 * distintas—, que nunca falla cinco veces sobre la misma cuenta y por eso no
 * dispara el bloqueo ni una sola vez.
 *
 * Lo que este archivo defiende:
 *
 *   1. **Que corte después del máximo**, y diga cuánto esperar.
 *   2. **Que cuente los fallos y no los aciertos.** Un límite que consume
 *      presupuesto con cada pedido echa a la empresa que tiene veinte personas
 *      entrando a las nueve, y no le hace nada a quien prueba contraseñas.
 *   3. **Que cada origen y cada ruta cuenten por separado.**
 *   4. **Que la ventana se reinicie**: nadie queda afuera para siempre.
 *   5. **Que por HTTP devuelva 429 con `Retry-After`.**
 */

import { buildServer } from '@aai/api/server';
import { closePool, initPool } from '@aai/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  contarFallo,
  puedeIntentar,
  reiniciarLimites,
} from '../../apps/api/src/http/limite-de-intentos.js';
import { hasDatabase } from '../integration/helpers/db.js';

describe('S-14 — límite de intentos por origen', () => {
  it('deja pasar hasta el máximo y después corta', () => {
    reiniciarLimites();
    const ahora = 1_000_000;
    const clave = '1.2.3.4 /auth/login';

    for (let i = 1; i <= 5; i += 1) {
      expect(puedeIntentar(clave, 5, 60, ahora).permitido, `intento ${i}`).toBe(true);
      contarFallo(clave, 60, ahora);
    }

    const sexto = puedeIntentar(clave, 5, 60, ahora);
    expect(sexto.permitido).toBe(false);
    // Con cuánto esperar: un 429 sin ese dato obliga a adivinar.
    expect(sexto.esperar).toBeGreaterThan(0);
    expect(sexto.esperar).toBeLessThanOrEqual(60);
  });

  it('los intentos que salen bien no consumen presupuesto', () => {
    reiniciarLimites();
    const ahora = 1_500_000;
    const clave = '4.3.2.1 /auth/login';

    // Veinte entradas correctas: nadie cuenta un fallo, así que el límite ni se
    // entera. Es el caso de la empresa que arranca a las nueve de la mañana.
    for (let i = 0; i < 20; i += 1) {
      expect(puedeIntentar(clave, 5, 60, ahora).permitido).toBe(true);
    }
  });

  it('la ventana se reinicia: nadie queda afuera para siempre', () => {
    reiniciarLimites();
    const ahora = 2_000_000;
    const clave = '5.6.7.8 /auth/login';

    for (let i = 0; i < 6; i += 1) contarFallo(clave, 60, ahora);
    expect(puedeIntentar(clave, 5, 60, ahora).permitido).toBe(false);

    // Un minuto y un segundo después.
    expect(puedeIntentar(clave, 5, 60, ahora + 61_000).permitido).toBe(true);
  });

  it('cada origen y cada ruta cuentan por separado', () => {
    reiniciarLimites();
    const ahora = 3_000_000;

    for (let i = 0; i < 6; i += 1) contarFallo('9.9.9.9 /auth/login', 60, ahora);
    expect(puedeIntentar('9.9.9.9 /auth/login', 5, 60, ahora).permitido).toBe(false);

    // Otro origen no arrastra el castigo del primero: si contara global, un
    // atacante dejaría a toda la clientela afuera con un script.
    expect(puedeIntentar('8.8.8.8 /auth/login', 5, 60, ahora).permitido).toBe(true);

    // Y quedarse sin intentos de contraseña no puede impedir confirmar el
    // segundo factor a alguien que ya entró bien.
    expect(puedeIntentar('9.9.9.9 /auth/mfa/verify', 5, 60, ahora).permitido).toBe(true);
  });
});

/** El mismo control, por HTTP. Sin base no hay login que probar. */
const porHttp = hasDatabase ? describe : describe.skip;

porHttp('S-14 — el límite contesta 429 por HTTP', () => {
  let app: FastifyInstance;
  let limitePrevio: string | undefined;

  beforeAll(async () => {
    limitePrevio = process.env.LOGIN_RATE_PER_MINUTE;
    initPool(process.env.DATABASE_URL!);
    app = await buildServer();
    await app.ready();
    reiniciarLimites();
  });

  afterAll(async () => {
    await app?.close();
    await closePool();
    if (limitePrevio === undefined) delete process.env.LOGIN_RATE_PER_MINUTE;
    else process.env.LOGIN_RATE_PER_MINUTE = limitePrevio;
    reiniciarLimites();
  });

  it('tras muchos fallos desde el mismo origen, contesta 429 con Retry-After', async () => {
    const intentar = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nadie@ejemplo.test', password: 'una-contrasena-cualquiera-larga' },
      });

    let ultima = await intentar();
    let corto = false;

    // El máximo por defecto es holgado a propósito; se prueba que el corte
    // exista, no en qué número exacto ocurre.
    for (let i = 0; i < 60 && !corto; i += 1) {
      ultima = await intentar();
      corto = ultima.statusCode === 429;
    }

    expect(corto, 'el límite tiene que cortar en algún momento').toBe(true);
    expect(ultima.headers['retry-after']).toBeDefined();
    expect(ultima.json<{ error: string }>().error).toBe('TOO_MANY_REQUESTS');

    // Y la ruta de trabajo no queda limitada: castigar una lectura de la
    // bandeja sería castigar a la empresa que trabaja rápido.
    const bandeja = await app.inject({ method: 'GET', url: '/work-queue' });
    expect(bandeja.statusCode).not.toBe(429);
  });
});
