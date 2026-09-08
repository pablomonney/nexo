/**
 * El puerto de secretos, sin base y sin nube.
 *
 * Todo lo de acá es puro: los proveedores que no tocan nada, la identidad, y la
 * redacción. Es lo que permite ejercitar los bordes —el entorno vacío, la URL
 * con la clave en la query, el secreto por empresa donde no corresponde— sin
 * montar un escenario.
 *
 * Los valores de prueba se llaman `TEST_SECRET_ONLY` a propósito: un secreto de
 * test que se pueda confundir con uno real es un secreto real esperando a que
 * alguien lo copie.
 */

import { describe, expect, it } from 'vitest';
import {
  CENSURA,
  EnvSecretProvider,
  ErrorDeSecreto,
  InMemorySecretProvider,
  NullSecretProvider,
  describir,
  redactarTexto,
  redactarUrl,
  taparValor,
  type SecretRef,
} from './index.js';

const VALOR = 'TEST_SECRET_ONLY-3f9c1d2b4a6e8071';

const DEL_DESPLIEGUE: SecretRef = { companyId: null, scope: 'ai', name: 'api-key' };
const DE_UNA_EMPRESA: SecretRef = {
  companyId: '01a06000-0000-7000-8000-000000000001',
  scope: 'arca',
  name: 'clave-privada',
};

describe('La identidad de un secreto', () => {
  it('se escribe sin el valor, y por eso se puede poner en cualquier lado', () => {
    expect(describir(DEL_DESPLIEGUE)).toBe('despliegue/ai/api-key');
    expect(describir(DE_UNA_EMPRESA)).toContain('empresa/01a06000');
    expect(describir({ ...DEL_DESPLIEGUE, version: 3 })).toBe('despliegue/ai/api-key@3');
  });

  it('el error se arma con la identidad y nunca con el material', () => {
    // El constructor de `ErrorDeSecreto` no acepta el valor: no hay parámetro
    // donde pasarlo. Es la misma decisión que el schema del agente, que no
    // tiene dónde poner un importe.
    const error = new ErrorDeSecreto('SECRET_NOT_FOUND', DEL_DESPLIEGUE, 'no está declarado');
    expect(error.message).toContain('SECRET_NOT_FOUND');
    expect(error.message).toContain('despliegue/ai/api-key');
    expect(error.message).not.toContain(VALOR);
    expect(error.codigo).toBe('SECRET_NOT_FOUND');
  });
});

describe('Sin gestor de secretos', () => {
  it('falla con motivo, no con una cadena vacía', async () => {
    // Devolver `''` haría que el proveedor de turno lo tratara como credencial
    // inválida: el diagnóstico apuntaría al proveedor y el problema es local.
    const p = new NullSecretProvider();
    const error = await p.get(DEL_DESPLIEGUE).catch((e: unknown) => e as ErrorDeSecreto);

    expect(error).toBeInstanceOf(ErrorDeSecreto);
    expect((error as ErrorDeSecreto).codigo).toBe('SECRET_NOT_FOUND');
    expect((error as Error).message).toContain('modo de operación previsto');
  });

  it('`existe` contesta que no, sin fallar', async () => {
    // Una pantalla que pregunta si está configurado no debería recibir una
    // excepción: «no» es una respuesta.
    expect(await new NullSecretProvider().existe(DEL_DESPLIEGUE)).toBe(false);
  });
});

describe('Del entorno', () => {
  it('deriva el nombre de la variable del scope y el nombre', async () => {
    const p = new EnvSecretProvider({ AI_API_KEY: VALOR });
    const material = await p.get(DEL_DESPLIEGUE);

    expect(material.valor).toBe(VALOR);
    expect(material.backend).toBe('env');
  });

  it('con scope `env`, el nombre ES la variable', async () => {
    // Es lo que permite apuntar a una variable que no sigue la convención sin
    // renombrarla. Prefijar el scope daría `ENV_OTRA_VARIABLE`.
    const p = new EnvSecretProvider({ OTRA_VARIABLE: VALOR });
    const material = await p.get({ companyId: null, scope: 'env', name: 'OTRA_VARIABLE' });
    expect(material.valor).toBe(VALOR);
  });

  it('una variable vacía es una variable que no está', async () => {
    // `AI_API_KEY=` en un `.env` da la cadena vacía. Tratarla como valor haría
    // que el sistema mandara una credencial vacía al proveedor.
    const p = new EnvSecretProvider({ AI_API_KEY: '' });
    const error = await p.get(DEL_DESPLIEGUE).catch((e: unknown) => e as ErrorDeSecreto);
    expect((error as ErrorDeSecreto).codigo).toBe('SECRET_NOT_FOUND');
    expect(await p.existe(DEL_DESPLIEGUE)).toBe(false);
  });

  it('**se niega** a resolver un secreto de una empresa', async () => {
    // Es la mitad del aislamiento multiempresa: un secreto por empresa en una
    // variable de entorno obligaría a reiniciar para dar de alta un cliente, y
    // dejaría las credenciales de todas en el mismo lugar.
    const p = new EnvSecretProvider({ ARCA_CLAVE_PRIVADA: VALOR });
    const error = await p.get(DE_UNA_EMPRESA).catch((e: unknown) => e as ErrorDeSecreto);

    expect((error as ErrorDeSecreto).codigo).toBe('SECRET_CONFIGURATION_ERROR');
    expect((error as Error).message).toContain('no guarda secretos por empresa');
  });

  it('y `existe` de una empresa también contesta que no', async () => {
    const p = new EnvSecretProvider({ ARCA_CLAVE_PRIVADA: VALOR });
    expect(await p.existe(DE_UNA_EMPRESA)).toBe(false);
  });

  it('el error no lleva el valor de la variable', async () => {
    const p = new EnvSecretProvider({ AI_API_KEY: VALOR });
    const error = await p
      .get({ companyId: null, scope: 'ai', name: 'otra' })
      .catch((e: unknown) => e as ErrorDeSecreto);
    expect((error as Error).message).not.toContain(VALOR);
  });
});

describe('En memoria', () => {
  it('sirve en desarrollo y **se niega en producción**', () => {
    // Pierde todo al reiniciar y lo lee cualquier parte del proceso: no es lo
    // que se quiere en un servidor real, y por eso no se puede construir ahí.
    expect(() => new InMemorySecretProvider({ esProduccion: true })).toThrow(/producción/u);
    expect(() => new InMemorySecretProvider({ esProduccion: false })).not.toThrow();
  });

  it('devuelve lo que se le puso, y falla tipado con lo que no', async () => {
    const p = new InMemorySecretProvider({ esProduccion: false });
    p.poner(DEL_DESPLIEGUE, VALOR);

    expect((await p.get(DEL_DESPLIEGUE)).valor).toBe(VALOR);
    expect(await p.existe(DEL_DESPLIEGUE)).toBe(true);

    const error = await p.get(DE_UNA_EMPRESA).catch((e: unknown) => e as ErrorDeSecreto);
    expect((error as ErrorDeSecreto).codigo).toBe('SECRET_NOT_FOUND');
  });

  it('un secreto de una empresa no lo devuelve otra', async () => {
    // El aislamiento no es solo del backend con base: la identidad lleva la
    // empresa, y dos empresas distintas son dos secretos distintos.
    const p = new InMemorySecretProvider({ esProduccion: false });
    p.poner(DE_UNA_EMPRESA, VALOR);

    const otraEmpresa: SecretRef = {
      ...DE_UNA_EMPRESA,
      companyId: '01a06000-0000-7000-8000-000000000002',
    };
    expect(await p.existe(otraEmpresa)).toBe(false);
  });
});

describe('Redacción de URLs', () => {
  it('tapa la clave en la query y deja el resto legible', () => {
    // Un log con la URL borrada entera no sirve para diagnosticar nada, y
    // entonces alguien la vuelve a poner.
    const url = `https://proveedor.example/v1/completions?model=x&api_key=${VALOR}&n=2`;
    const limpia = redactarUrl(url);

    expect(limpia).not.toContain(VALOR);
    expect(limpia).toContain('proveedor.example');
    expect(limpia).toContain('model=x');
    expect(limpia).toContain(CENSURA);
  });

  it('reconoce el nombre del parámetro sin importar cómo esté escrito', () => {
    for (const nombre of ['api_key', 'apiKey', 'API-KEY', 'access_token', 'Authorization']) {
      const limpia = redactarUrl(`https://x.example/a?${nombre}=${VALOR}`);
      expect(limpia, nombre).not.toContain(VALOR);
    }
  });

  it('tapa también la credencial en el usuario:contraseña de la URL', () => {
    // Es la otra forma de meter una credencial en una URL, y la que menos se
    // mira.
    const limpia = redactarUrl(`https://usuario:${VALOR}@proveedor.example/v1`);
    expect(limpia).not.toContain(VALOR);
    expect(limpia).toContain('proveedor.example');
  });

  it('deja pasar lo que no es sensible', () => {
    const url = 'https://proveedor.example/v1?model=gpt&temperature=0';
    expect(redactarUrl(url)).toContain('model=gpt');
    expect(redactarUrl(url)).not.toContain(CENSURA);
  });

  it('lo que no es una URL se devuelve tal cual', () => {
    // Inventar una redacción sobre algo que no se pudo interpretar daría una
    // falsa sensación de haber limpiado.
    expect(redactarUrl('esto no es una url')).toBe('esto no es una url');
  });

  it('en una frase, encuentra la URL y la limpia', () => {
    // Es la forma real en que aparece: no sola, sino adentro del mensaje de una
    // excepción de red.
    const mensaje = `connect ECONNREFUSED https://p.example/v1?token=${VALOR} after 3 tries`;
    const limpio = redactarTexto(mensaje);

    expect(limpio).not.toContain(VALOR);
    expect(limpio).toContain('ECONNREFUSED');
    expect(limpio).toContain('after 3 tries');
  });
});

describe('Tapar un valor conocido', () => {
  it('lo saca de donde esté', () => {
    // El caso: un proveedor que devuelve el pedido completo en el cuerpo del
    // error, con la cabecera de autorización adentro.
    const cuerpo = `{"error":"bad request","sent":{"authorization":"Bearer ${VALOR}"}}`;
    const limpio = taparValor(cuerpo, VALOR);

    expect(limpio).not.toContain(VALOR);
    expect(limpio).toContain('bad request');
  });

  it('no hace nada con un valor corto', () => {
    // Reemplazar cada aparición de un secreto de tres caracteres destruiría el
    // texto sin proteger nada que valga.
    expect(taparValor('el codigo es abc y abc', 'abc')).toBe('el codigo es abc y abc');
  });

  it('no hace nada sin valor', () => {
    expect(taparValor('texto', null)).toBe('texto');
    expect(taparValor('texto', undefined)).toBe('texto');
  });
});
