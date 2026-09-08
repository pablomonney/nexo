/**
 * La fábrica de proveedores, y el estado que informa el arranque.
 *
 * El bug que estos tests fijan tenía forma de nombre. `AI_PROVIDER=openai`
 * hacía que el arranque informara **IA: openai, real** mientras la selección
 * devolvía el proveedor deshabilitado: el sistema decía tener una capacidad que
 * no tenía. No fallaba nada — simplemente las sugerencias no aparecían nunca, y
 * nadie iba a buscar por qué.
 *
 * Son tres afirmaciones distintas y conviene no mezclarlas:
 *
 *     conocido     el valor de `AI_PROVIDER` es uno de los tres.
 *     configurado  además tiene credencial, modelo y URL.
 *     conectado    una llamada volvió. **Esto no lo puede decir una variable
 *                  de entorno**, y por eso ningún estado de acá lo afirma.
 */

import { describe, expect, it } from 'vitest';
import { modoDeIa } from '@aai/api/arranque';
import {
  crearProveedor,
  estadoDelProveedor,
  faltantesDeHttp,
  verificarProveedor,
  type ConfiguracionDeIa,
} from '@aai/api/ai/proveedor';

const BASE: ConfiguracionDeIa = {
  provider: 'none',
  apiKeyRef: null,
  modelId: null,
  baseUrl: null,
  timeoutMs: 30_000,
  maxRetries: 2,
};

const COMPLETA: ConfiguracionDeIa = {
  ...BASE,
  provider: 'http',
  apiKeyRef: 'env:AI_API_KEY',
  modelId: 'modelo-x',
  baseUrl: 'https://proveedor.invalido/v1',
};

describe('Un proveedor desconocido no degrada en silencio', () => {
  it('acepta los tres valores conocidos', () => {
    for (const provider of ['none', 'mock', 'http']) {
      expect(verificarProveedor({ ...BASE, provider }), provider).toBeNull();
    }
  });

  it('rechaza un valor que no está implementado, y nombra los que sí', () => {
    // Es el caso exacto del bug: alguien pone el nombre de un proveedor real
    // creyendo que con eso alcanza.
    const error = verificarProveedor({ ...BASE, provider: 'openai' });

    expect(error).not.toBeNull();
    expect(error).toContain('openai');
    expect(error).toContain('none, mock, http');
  });

  it('rechaza un typo', () => {
    expect(verificarProveedor({ ...BASE, provider: 'mocK' })).not.toBeNull();
    expect(verificarProveedor({ ...BASE, provider: '' })).not.toBeNull();
  });

  it('crear el proveedor con un valor desconocido tira, no devuelve el nulo', () => {
    // La alternativa —devolver `NullLLMProvider` -- es justamente el fallback
    // silencioso que este archivo existe para impedir.
    expect(() => crearProveedor({ ...BASE, provider: 'openai' })).toThrow(/openai/u);
  });
});

describe('Los cuatro estados', () => {
  it('none es DESHABILITADO, y es un modo de operación', () => {
    expect(estadoDelProveedor(BASE)).toBe('DESHABILITADO');
    expect(crearProveedor(BASE).id).toBe('none');
  });

  it('mock es SIMULADO', () => {
    expect(estadoDelProveedor({ ...BASE, provider: 'mock' })).toBe('SIMULADO');
    expect(crearProveedor({ ...BASE, provider: 'mock' }).id).toBe('mock');
  });

  it('http sin credencial es PREPARADO, y dice qué falta', () => {
    const sinNada: ConfiguracionDeIa = { ...BASE, provider: 'http' };
    expect(estadoDelProveedor(sinNada)).toBe('PREPARADO');
    expect(faltantesDeHttp(sinNada)).toEqual(['AI_API_KEY', 'AI_MODEL_ID', 'AI_BASE_URL']);
  });

  it('http al que le falta una sola cosa sigue siendo PREPARADO, y nombra esa', () => {
    const sinClave = { ...COMPLETA, apiKeyRef: null };
    expect(estadoDelProveedor(sinClave)).toBe('PREPARADO');
    expect(faltantesDeHttp(sinClave)).toEqual(['AI_API_KEY']);
  });

  it('http PREPARADO devuelve el proveedor deshabilitado, y nadie afirma otra cosa', () => {
    // No es un fallback silencioso: el arranque ya dijo qué falta y la
    // respuesta de la API contesta `SIN_PROVEEDOR` con su motivo.
    expect(crearProveedor({ ...COMPLETA, apiKeyRef: null }).id).toBe('none');
  });

  it('http completo es CONFIGURADO y devuelve el adaptador HTTP', () => {
    expect(estadoDelProveedor(COMPLETA)).toBe('CONFIGURADO');
    expect(crearProveedor(COMPLETA).id).toBe('http');
  });

  it('una cadena vacía cuenta como ausente', () => {
    // `AI_API_KEY=` en un `.env` da la cadena vacía, no `undefined`.
    expect(estadoDelProveedor({ ...COMPLETA, apiKeyRef: '' })).toBe('PREPARADO');
  });
});

describe('El banner del arranque dice el estado real', () => {
  it('un proveedor sin implementar NO se informa como real', () => {
    // El bug, fijado: antes esto daba `real: true`.
    const modo = modoDeIa({ ...BASE, provider: 'http' });
    expect(modo.real).toBe(false);
    expect(modo.detalle).toContain('preparado, no conectado');
    expect(modo.detalle).toContain('AI_API_KEY');
  });

  it('none se informa como modo de operación, no como falla', () => {
    const modo = modoDeIa(BASE);
    expect(modo.real).toBe(false);
    expect(modo.detalle).toContain('historia de la empresa');
  });

  it('mock avisa que se abstiene siempre', () => {
    // Un simulado que se confundiera con un modelo real produciría propuestas
    // que alguien aprobaría.
    const modo = modoDeIa({ ...BASE, provider: 'mock' });
    expect(modo.real).toBe(false);
    expect(modo.detalle).toContain('se abstiene siempre');
  });

  it('configurado dice real, y aclara que eso no es conectado', () => {
    const modo = modoDeIa(COMPLETA);
    expect(modo.real).toBe(true);
    expect(modo.valor).toContain('modelo-x');
    expect(modo.detalle).toContain('no prueba una conexión');
  });

  it('la configuración no tiene dónde guardar la credencial', () => {
    // Es más fuerte que «el banner no la imprime»: desde la 0095 `config.ai`
    // guarda **la referencia** —`env:AI_API_KEY`— y el material lo resuelve el
    // gestor de secretos por llamada. No hay campo donde el secreto entre, así
    // que no hay forma de que salga en un banner, en un error o en un volcado.
    expect(Object.keys(COMPLETA)).not.toContain('apiKey');
    expect(COMPLETA.apiKeyRef).toBe('env:AI_API_KEY');

    const modo = modoDeIa(COMPLETA);
    expect(JSON.stringify(modo)).not.toContain('AI_API_KEY');
  });
});
