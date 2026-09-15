/**
 * La traducción de lo que dice una pasarela a lo que significa para NEXO.
 *
 * Vive acá adentro del paquete —y no en `tests/`— por el mismo motivo que el de
 * `tax-engine/src/emision.test.ts`: desde afuera se importa `@aai/billing-engine`,
 * que resuelve a `dist`, y la cobertura del código fuente quedaría en cero
 * mientras los tests pasan.
 *
 * Lo que se ejercita son los estados que en producción aparecen una vez cada mil
 * cobros. Esa es toda la razón de que esta lógica sea pura: una tarjeta dada de
 * baja en la app del banco no se puede provocar a pedido, y lo que pasa cuando
 * ocurre es exactamente lo que hay que tener bien.
 */

import { describe, expect, it } from 'vitest';
import {
  consecuenciaDeSuscripcion,
  estadoDePagoDesde,
  esProblemaDeConfiguracion,
  reintentable,
  reintentableEnEscritura,
  type CodigoDeFalloDePago,
  type EstadoExternoDePago,
  type EstadoExternoDeSuscripcion,
} from './pasarela.js';
import { puedeTransicionar, puedeTransicionarPago } from './estados.js';

const SUSCRIPCION: readonly EstadoExternoDeSuscripcion[] = [
  'PENDIENTE',
  'AUTORIZADA',
  'PAUSADA',
  'CANCELADA',
];

const PAGO: readonly EstadoExternoDePago[] = [
  'APROBADO',
  'AUTORIZADO',
  'PENDIENTE',
  'EN_PROCESO',
  'RECHAZADO',
  'CANCELADO',
  'DEVUELTO',
  'CONTRACARGO',
];

const FALLOS: readonly CodigoDeFalloDePago[] = [
  'TIMEOUT',
  'CREDENCIAL_RECHAZADA',
  'NO_ENCONTRADO',
  'CONFLICTO',
  'LIMITE_DE_TASA',
  'PEDIDO_INVALIDO',
  'PROVEEDOR_CAIDO',
  'RESPUESTA_ILEGIBLE',
  'RED',
  'SIN_PASARELA',
];

describe('de un estado de la pasarela a una consecuencia comercial', () => {
  it('una suscripción cancelada del otro lado NO cancela la de NEXO', () => {
    // **El caso más importante de este archivo.**
    //
    // La traducción obvia —`cancelled` → `CANCELADA`— es incorrecta y además
    // es irreversible: de `CANCELADA` no se vuelve. Una tarjeta vencida daría
    // de baja al cliente sin que el cliente haya decidido nada, y recuperarlo
    // exigiría crear una suscripción nueva con una vigencia nueva.
    const c = consecuenciaDeSuscripcion('CANCELADA');
    expect(c.tipo).toBe('TRANSICION');
    expect(c.tipo === 'TRANSICION' && c.hacia).toBe('SUSPENDIDA');
    expect(c.motivo).toContain('no se cancela');
  });

  it('pausada también suspende, y desde SUSPENDIDA se puede volver', () => {
    const c = consecuenciaDeSuscripcion('PAUSADA');
    expect(c.tipo === 'TRANSICION' && c.hacia).toBe('SUSPENDIDA');
    // Lo que hace que suspender sea la respuesta correcta y cancelar no: el
    // camino de vuelta existe en la máquina de estados.
    expect(puedeTransicionar('SUSPENDIDA', 'ACTIVA')).toBe(true);
    expect(puedeTransicionar('CANCELADA', 'ACTIVA')).toBe(false);
  });

  it('autorizada activa', () => {
    const c = consecuenciaDeSuscripcion('AUTORIZADA');
    expect(c.tipo === 'TRANSICION' && c.hacia).toBe('ACTIVA');
  });

  it('pendiente no mueve nada', () => {
    // Un trámite a mitad de camino. Moverlo en cualquier dirección sería
    // inventar: darle acceso a quien no completó el alta, o quitárselo a quien
    // está por completarla.
    expect(consecuenciaDeSuscripcion('PENDIENTE').tipo).toBe('SIN_CAMBIO');
  });

  it('ningún estado externo lleva a CANCELADA', () => {
    // La regla entera, dicha una vez sobre los cuatro estados: cancelar es una
    // decisión del cliente y ninguna pasarela la puede tomar por él.
    for (const externo of SUSCRIPCION) {
      const c = consecuenciaDeSuscripcion(externo);
      expect(c.tipo === 'TRANSICION' && c.hacia, `${externo} cancela`).not.toBe('CANCELADA');
    }
  });

  it('toda transición propuesta es alcanzable desde algún estado real', () => {
    // Sin esto, una consecuencia podría proponer un destino al que la máquina de
    // estados nunca deja llegar: el código compilaría, el webhook diría
    // «aplicado» y la fila no cambiaría.
    for (const externo of SUSCRIPCION) {
      const c = consecuenciaDeSuscripcion(externo);
      if (c.tipo !== 'TRANSICION') continue;
      const alcanzable = (['PRUEBA', 'ACTIVA', 'SUSPENDIDA'] as const).some((desde) =>
        puedeTransicionar(desde, c.hacia),
      );
      expect(alcanzable, `a ${c.hacia} no se llega desde ningún estado`).toBe(true);
    }
  });

  it('cada motivo explica por qué, no solo qué', () => {
    // El motivo va a `company_subscriptions.motivo`, que es lo que el cliente ve
    // cuando su servicio se suspende. «SUSPENDIDA» a secas no le dice nada.
    for (const externo of SUSCRIPCION) {
      expect(consecuenciaDeSuscripcion(externo).motivo.length).toBeGreaterThan(40);
    }
  });
});

describe('de un estado de cobro de la pasarela al del motor', () => {
  it('autorizado no es pagado', () => {
    // La plata está retenida y todavía no acreditada. Colapsarlos daría por
    // cobrado un importe que puede no acreditarse nunca.
    expect(estadoDePagoDesde('AUTORIZADO')).toBe('AUTORIZADO');
    expect(estadoDePagoDesde('APROBADO')).toBe('PAGADO');
    expect(puedeTransicionarPago('AUTORIZADO', 'PAGADO')).toBe(true);
  });

  it('rechazado y cancelado son lo mismo para el billing: no entró la plata', () => {
    expect(estadoDePagoDesde('RECHAZADO')).toBe('FALLIDO');
    expect(estadoDePagoDesde('CANCELADO')).toBe('FALLIDO');
  });

  it('en proceso es pendiente, no fallido', () => {
    // Tratar «en proceso» como fallido dispararía la política de cobranza sobre
    // un cobro que todavía puede entrar: el cliente recibiría un aviso de deuda
    // por algo que está pagando.
    expect(estadoDePagoDesde('EN_PROCESO')).toBe('PENDIENTE');
    expect(estadoDePagoDesde('PENDIENTE')).toBe('PENDIENTE');
  });

  it('devuelto y contracargo se distinguen', () => {
    // Un reembolso lo decide el comercio; un contracargo lo decide el banco del
    // cliente contra el comercio. El segundo tiene costo y consecuencias.
    expect(estadoDePagoDesde('DEVUELTO')).toBe('REEMBOLSADO');
    expect(estadoDePagoDesde('CONTRACARGO')).toBe('CONTRACARGO');
  });

  it('ningún estado externo se queda sin traducción', () => {
    for (const externo of PAGO) {
      expect(estadoDePagoDesde(externo), `${externo} no traduce`).toBeTruthy();
    }
  });
});

describe('qué se puede reintentar', () => {
  it('un TIMEOUT no se reintenta, ni leyendo ni escribiendo', () => {
    // La regla que sostiene todo lo demás: un timeout no dice que la operación
    // no haya ocurrido, dice que no se sabe. Repetir un cobro del que no se sabe
    // nada es cobrarle dos veces a alguien.
    expect(reintentable('TIMEOUT')).toBe(false);
    expect(reintentableEnEscritura('TIMEOUT')).toBe(false);
  });

  it('un 5xx se reintenta leyendo y NO escribiendo', () => {
    // La única diferencia entre las dos listas, y la que importa: un 500 al
    // crear una suscripción pudo ocurrir **después** de haberla creado.
    expect(reintentable('PROVEEDOR_CAIDO')).toBe(true);
    expect(reintentableEnEscritura('PROVEEDOR_CAIDO')).toBe(false);
  });

  it('429 y red se reintentan siempre: de los dos se puede afirmar que no pasó nada', () => {
    for (const codigo of ['LIMITE_DE_TASA', 'RED'] as const) {
      expect(reintentable(codigo)).toBe(true);
      expect(reintentableEnEscritura(codigo)).toBe(true);
    }
  });

  it('escribir nunca reintenta más que leer', () => {
    // La relación entre las dos listas, dicha como invariante y no como tres
    // casos: si alguien agrega un código a la de escritura sin agregarlo a la de
    // lectura, esto lo encuentra.
    for (const codigo of FALLOS) {
      if (reintentableEnEscritura(codigo)) {
        expect(reintentable(codigo), `${codigo} se reintenta al escribir y no al leer`).toBe(true);
      }
    }
  });

  it('nada irreversible se reintenta', () => {
    // Un 4xx sale igual mil veces, y una credencial rechazada no mejora sola.
    for (const codigo of [
      'CREDENCIAL_RECHAZADA',
      'NO_ENCONTRADO',
      'CONFLICTO',
      'PEDIDO_INVALIDO',
      'RESPUESTA_ILEGIBLE',
      'SIN_PASARELA',
    ] as const) {
      expect(reintentable(codigo), `${codigo} se reintenta y no debería`).toBe(false);
    }
  });
});

describe('de quién es el problema', () => {
  it('una credencial rechazada la arregla quien administra, no el cliente', () => {
    // Mandar a revisar una tarjeta cuando lo que caducó es el token de NEXO hace
    // perder el tiempo a la persona equivocada, y deja el problema real sin
    // tocar.
    expect(esProblemaDeConfiguracion('CREDENCIAL_RECHAZADA')).toBe(true);
    expect(esProblemaDeConfiguracion('SIN_PASARELA')).toBe(true);
  });

  it('un rechazo del pedido no es un problema de configuración', () => {
    for (const codigo of ['PEDIDO_INVALIDO', 'NO_ENCONTRADO', 'CONFLICTO', 'TIMEOUT'] as const) {
      expect(esProblemaDeConfiguracion(codigo)).toBe(false);
    }
  });
});
