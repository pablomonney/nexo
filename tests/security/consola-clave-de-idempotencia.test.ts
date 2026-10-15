/**
 * La consola manda una `Idempotency-Key` por intención en cada operación que crea un movimiento.
 *
 * Qué se defiende (docs/DISENO_IDEMPOTENCIA.md §3 y §8):
 *
 *   1. LA REGLA DE LA CLAVE se ejecuta de verdad (se extrae el bloque de `consola.html` y se corre aparte):
 *      se REUTILIZA mientras la operación y sus datos sean los mismos y no haya salido bien; se RENUEVA al salir bien y
 *      cuando cambian los datos. Una consola que genera una clave nueva en cada reintento no protege de nada; una que
 *      nunca la renueva rechazaría el segundo movimiento igual al primero.
 *   2. LOS CINCO LLAMADORES la usan: ninguna operación que crea un movimiento puede volver a `api()` a secas, porque la
 *      API la rechaza con 400.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const consola = readFileSync(join(RAIZ, 'apps', 'web', 'consola.html'), 'utf8');

/** El bloque que implementa la regla, desde su constante hasta justo antes de `api()`. */
function bloqueDeClaves(): string {
  const desde = consola.indexOf('const clavesPendientes = new Map();');
  const hasta = consola.indexOf('/** Único punto de contacto con la API.');
  expect(desde, 'no encuentro el bloque de claves de idempotencia en consola.html').toBeGreaterThan(0);
  expect(hasta).toBeGreaterThan(desde);
  return consola.slice(desde, hasta);
}

interface Llamada {
  method: string;
  url: string;
  cuerpo: unknown;
  clave: string | undefined;
}

/** Corre el bloque con una `api()` de mentira que anota lo que recibe y contesta lo que se le indique. */
function armar(respuestas: Array<{ ok: boolean; status?: number }>) {
  const llamadas: Llamada[] = [];
  let n = 0;
  let uuid = 0;
  const contexto: Record<string, unknown> = {
    window: { crypto: { randomUUID: () => `clave-${(uuid += 1)}-${'x'.repeat(16)}` } },
    api: async (method: string, url: string, cuerpo: unknown, _esForma: boolean, clave: string | undefined) => {
      llamadas.push({ method, url, cuerpo, clave });
      return respuestas[Math.min(n++, respuestas.length - 1)]!;
    },
  };
  vm.createContext(contexto);
  vm.runInContext(`${bloqueDeClaves()}\nthis.apiIdempotente = apiIdempotente;`, contexto);
  return { llamadas, apiIdempotente: contexto['apiIdempotente'] as (m: string, u: string, c: unknown, i: string) => Promise<{ ok: boolean; repetida?: boolean }> };
}

describe('la regla de la clave de idempotencia de la consola', () => {
  it('el reintento tras un fallo REUTILIZA la clave', async () => {
    const { llamadas, apiIdempotente } = armar([{ ok: false }, { ok: false }, { ok: true }]);
    const datos = { importe: '10.00' };
    await apiIdempotente('POST', '/x', datos, 'caja-mov:1');
    await apiIdempotente('POST', '/x', datos, 'caja-mov:1');
    await apiIdempotente('POST', '/x', datos, 'caja-mov:1');
    expect(new Set(llamadas.map((l) => l.clave)).size, 'cada reintento generó una clave nueva').toBe(1);
    expect(llamadas[0]!.clave).toBeTruthy();
  });

  it('después de salir bien, la próxima operación (aunque tenga los mismos datos) lleva OTRA clave', async () => {
    const { llamadas, apiIdempotente } = armar([{ ok: true }, { ok: true }]);
    const datos = { importe: '10.00' };
    await apiIdempotente('POST', '/x', datos, 'caja-mov:1');
    await apiIdempotente('POST', '/x', datos, 'caja-mov:1');
    expect(llamadas[0]!.clave).not.toBe(llamadas[1]!.clave);
  });

  it('si cambian los datos es otra operación: clave nueva, aunque la anterior haya fallado', async () => {
    const { llamadas, apiIdempotente } = armar([{ ok: false }, { ok: true }]);
    await apiIdempotente('POST', '/x', { importe: '10.00' }, 'caja-mov:1');
    await apiIdempotente('POST', '/x', { importe: '11.00' }, 'caja-mov:1');
    expect(llamadas[0]!.clave).not.toBe(llamadas[1]!.clave);
  });

  it('intenciones distintas no comparten clave', async () => {
    const { llamadas, apiIdempotente } = armar([{ ok: false }]);
    await apiIdempotente('POST', '/a', { x: 1 }, 'stock-ajuste');
    await apiIdempotente('POST', '/b', { x: 1 }, 'stock-salida');
    expect(llamadas[0]!.clave).not.toBe(llamadas[1]!.clave);
  });
});

describe('una repetición se muestra como tal', () => {
  it('un 200 de una operación que normalmente responde 201 es «ya estaba registrado»; un 201 y un error, no', async () => {
    const { apiIdempotente } = armar([{ ok: true, status: 200 }, { ok: true, status: 201 }, { ok: false, status: 422 }]);
    expect((await apiIdempotente('POST', '/x', { a: 1 }, 'i1')).repetida).toBe(true);
    expect((await apiIdempotente('POST', '/x', { a: 2 }, 'i2')).repetida).toBe(false);
    expect((await apiIdempotente('POST', '/x', { a: 3 }, 'i3')).repetida).toBe(false);
  });

  it('la pantalla lo dice con palabras, en lugar de repetir «Movimiento registrado»', () => {
    expect(consola).toMatch(/resultado\.repetida\s*\?\s*'Ya estaba registrado/u);
  });
});

describe('quién usa la clave', () => {
  const sinClave = [
    "api('POST', '/cash-sessions'",
    "api('POST', '/cash-sessions/' + estado.sesionCaja + '/movimientos'",
    "api('POST', '/stock-movements/salida'",
    "api('POST', '/stock-movements/ajuste'",
    "api('POST', '/stock-movements/transferencia'",
    "api('POST', '/tax-transactions/' + item.entityId + '/salida'",
  ];

  it.each(sinClave)('%s no se llama a secas: la API lo rechazaría con 400', (llamada) => {
    expect(consola.includes(llamada), `${llamada} sigue llamándose sin Idempotency-Key`).toBe(false);
  });

  it('api() manda el encabezado cuando recibe una clave', () => {
    expect(consola).toMatch(/if \(claveDeIdempotencia\) cab\['idempotency-key'\] = claveDeIdempotencia;/u);
  });

  it('apiIdempotente solo renueva la clave cuando la operación salió bien', () => {
    expect(consola).toMatch(/if \(r\.ok\) operacionTerminada\(intencion\);/u);
  });

  it.each([
    ["apiIdempotente('POST', '/cash-sessions', {"],
    ["apiIdempotente('POST', '/cash-sessions/' + estado.sesionCaja + '/movimientos'"],
    ["apiIdempotente('POST', '/stock-movements/salida'"],
    ["apiIdempotente('POST', '/stock-movements/ajuste'"],
    ["apiIdempotente('POST', '/stock-movements/transferencia'"],
    ["apiIdempotente('POST', '/tax-transactions/' + item.entityId + '/salida'"],
  ])('existe el llamador %s', (llamador) => {
    expect(consola.includes(llamador)).toBe(true);
  });
});
