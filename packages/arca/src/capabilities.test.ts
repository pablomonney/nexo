/**
 * Tests del relevamiento de habilitaciones.
 *
 * Todo el archivo gira alrededor de una distinción: **no está delegado no es lo
 * mismo que no se pudo averiguar**. El primer `describe` es esa frase.
 */

import { describe, expect, it } from 'vitest';
import {
  SERVICIOS_DEL_PRODUCTO,
  clasificarIntento,
  esPersistible,
  leerHabilitacion,
  permiteIntentar,
  resumirRelevamiento,
  type IntentoDeLogin,
} from './index.js';

const AHORA = '2026-08-26T10:00:00.000Z';

function intento(overrides: Partial<IntentoDeLogin> = {}): IntentoDeLogin {
  return {
    service: 'wscdc',
    ok: true,
    respuesta: null,
    fallaDeTransporte: false,
    sinCredencial: false,
    ...overrides,
  };
}

describe('una caída del organismo no se registra como falta de habilitación', () => {
  it('un fallo de transporte da NO_VERIFICABLE, sin fecha', () => {
    const resultado = clasificarIntento(
      intento({ ok: false, fallaDeTransporte: true, respuesta: 'ETIMEDOUT' }),
      AHORA,
    );

    expect(resultado.estado).toBe('NO_VERIFICABLE');
    expect(resultado.verificadoEl).toBeNull();
    expect(resultado.detalle).toMatch(/NO se registra como no habilitado/);
  });

  it('y NO_VERIFICABLE no es persistible: no hay camino para escribirlo como negativa', () => {
    // Es el candado del módulo. Sin esto, una caída de veinte minutos deja el
    // sistema creyendo para siempre que el estudio no tiene el padrón.
    expect(esPersistible('NO_VERIFICABLE')).toBe(false);
    expect(esPersistible('SIN_CREDENCIAL')).toBe(false);
    expect(esPersistible('VENCIDO')).toBe(false);
    expect(esPersistible('NO_RELEVADO')).toBe(false);
    expect(esPersistible('HABILITADO')).toBe(true);
    expect(esPersistible('NO_DELEGADO')).toBe(true);
  });

  it('el transporte gana sobre cualquier otra lectura', () => {
    // Un timeout con `ok: false` podría leerse como rechazo. No lo es: un
    // timeout no dice nada sobre las delegaciones del CUIT.
    const resultado = clasificarIntento(
      intento({ ok: false, fallaDeTransporte: true, respuesta: 'ECONNREFUSED' }),
      AHORA,
    );

    expect(resultado.estado).toBe('NO_VERIFICABLE');
  });

  it('un rechazo real de WSAA sí es NO_DELEGADO, con fecha y con qué hacer', () => {
    const resultado = clasificarIntento(
      intento({ ok: false, respuesta: 'ns1:cms.cert.untrusted' }),
      AHORA,
    );

    expect(resultado.estado).toBe('NO_DELEGADO');
    expect(resultado.verificadoEl).toBe(AHORA);
    expect(resultado.detalle).toMatch(/delegarlo al certificado desde el portal/);
  });

  it('sin certificado no se pregunta nada', () => {
    const resultado = clasificarIntento(intento({ ok: false, sinCredencial: true }), AHORA);

    expect(resultado.estado).toBe('SIN_CREDENCIAL');
    expect(resultado.detalle).toMatch(/No se preguntó nada al organismo/);
  });

  it('un login exitoso queda con fecha', () => {
    const resultado = clasificarIntento(intento(), AHORA);

    expect(resultado.estado).toBe('HABILITADO');
    expect(resultado.verificadoEl).toBe(AHORA);
  });
});

describe('una habilitación tiene fecha de vencimiento', () => {
  const hoy = new Date('2026-08-26T10:00:00.000Z');

  it('un relevamiento reciente vale', () => {
    const resultado = leerHabilitacion(
      { service: 'wscdc', enabled: true, verifiedAt: '2026-08-10T00:00:00.000Z', notes: null },
      hoy,
    );

    expect(resultado.estado).toBe('HABILITADO');
  });

  it('uno de hace seis meses no es evidencia sobre hoy', () => {
    const resultado = leerHabilitacion(
      { service: 'wscdc', enabled: true, verifiedAt: '2026-02-01T00:00:00.000Z', notes: null },
      hoy,
    );

    expect(resultado.estado).toBe('VENCIDO');
    expect(resultado.detalle).toMatch(/VENCIDO no es NO_DELEGADO/);
  });

  it('un vencido de una habilitación negativa también es VENCIDO, no NO_DELEGADO', () => {
    // La delegación puede haberse otorgado desde entonces. Seguir diciendo que
    // no está habilitado sería tratar un dato viejo como actual.
    const resultado = leerHabilitacion(
      { service: 'padronA13', enabled: false, verifiedAt: '2025-01-01T00:00:00.000Z', notes: null },
      hoy,
    );

    expect(resultado.estado).toBe('VENCIDO');
  });

  it('sin fila y sin fecha, NO_RELEVADO', () => {
    expect(leerHabilitacion(undefined, hoy).estado).toBe('NO_RELEVADO');
    expect(
      leerHabilitacion({ service: 'wscdc', enabled: true, verifiedAt: null, notes: null }, hoy)
        .estado,
    ).toBe('NO_RELEVADO');
  });
});

describe('cuándo vale la pena intentar la llamada', () => {
  it('no saber no es motivo para no intentar', () => {
    // En los tres el sistema no sabe, y lo que produce el intento es justamente
    // el dato que falta.
    expect(permiteIntentar('VENCIDO')).toBe(true);
    expect(permiteIntentar('NO_RELEVADO')).toBe(true);
    expect(permiteIntentar('NO_VERIFICABLE')).toBe(true);
    expect(permiteIntentar('HABILITADO')).toBe(true);
  });

  it('saber que va a fallar sí lo es', () => {
    // Insistir contra un servicio no delegado es cómo un CUIT termina bloqueado.
    expect(permiteIntentar('NO_DELEGADO')).toBe(false);
    expect(permiteIntentar('SIN_CREDENCIAL')).toBe(false);
  });
});

describe('el resumen dice qué deja de funcionar, no qué servicio falta', () => {
  it('traduce cada servicio ausente a una consecuencia del producto', () => {
    const resumen = resumirRelevamiento('homologacion', [
      clasificarIntento(intento({ service: 'wscdc' }), AHORA),
      clasificarIntento(intento({ service: 'ws_sr_padron_a13', ok: false }), AHORA),
      clasificarIntento(
        intento({ service: 'ws_sr_padron_a100', ok: false, fallaDeTransporte: true }),
        AHORA,
      ),
      clasificarIntento(intento({ service: 'wsfe' }), AHORA),
    ]);

    expect(resumen.habilitados).toBe(2);
    expect(resumen.noDelegados).toBe(1);
    expect(resumen.noVerificables).toBe(1);
    // Lo que el usuario quiere saber no es "falta el A13": es qué no va a poder
    // hacer.
    expect(resumen.consecuencias.join(' ')).toMatch(/condición del emisor frente al IVA/);
    expect(resumen.consecuencias.join(' ')).toMatch(/catálogos de parámetros no se sincronizan/);
    expect(resumen.consecuencias).toHaveLength(2);
  });

  it('con todo habilitado no hay consecuencias que informar', () => {
    const resumen = resumirRelevamiento(
      'produccion',
      SERVICIOS_DEL_PRODUCTO.map((service) => clasificarIntento(intento({ service }), AHORA)),
    );

    expect(resumen.consecuencias).toEqual([]);
    expect(resumen.habilitados).toBe(SERVICIOS_DEL_PRODUCTO.length);
  });

  it('los cuatro servicios del producto están enumerados', () => {
    expect([...SERVICIOS_DEL_PRODUCTO].sort()).toEqual([
      'ws_sr_padron_a100',
      'ws_sr_padron_a13',
      'wscdc',
      'wsfe',
    ]);
  });
});
