/**
 * Un secreto que llega al log es un secreto filtrado.
 *
 * La credencial del proveedor de modelo viaja en la cabecera `Authorization` de
 * cada llamada, y la cookie de sesión viaja en la de cada petición entrante. Un
 * logger con nivel de depuración en producción —que es lo primero que alguien
 * sube cuando está diagnosticando algo— dejaría las dos en disco.
 *
 * No alcanza con «no loguear headers»: pino serializa el pedido entero cuando
 * se le pide, y el día que alguien suba el nivel para ver qué está pasando, lo
 * va a hacer sin acordarse de esto. La redacción tiene que estar puesta en la
 * configuración del logger, no en la disciplina de quien escribe.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('S-27 — los secretos no llegan al log', () => {
  it('el logger redacta la autorización y la cookie', async () => {
    const server = await readFile(join(RAIZ, 'apps', 'api', 'src', 'server.ts'), 'utf8');

    // Se lee el archivo y no se levanta el servidor porque lo que se defiende
    // es la **configuración**: que exista `redact` con estos caminos. Un test
    // que capturara una línea de log probaría un caso; esto prueba la regla.
    expect(server, 'el logger tiene que declarar `redact`').toContain('redact');

    for (const camino of [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      '*.apiKey',
    ]) {
      expect(server, `falta el camino ${camino} en la redacción`).toContain(camino);
    }
  });

  it('el adaptador HTTP no arma sus errores con el cuerpo del proveedor', async () => {
    const http = await readFile(
      join(RAIZ, 'packages', 'ai-engine', 'src', 'providers-http.ts'),
      'utf8',
    );

    // El cuerpo de una respuesta de error puede traer el pedido completo, y el
    // pedido lleva la cabecera de autorización. El error se arma solo con el
    // código HTTP.
    expect(http).toContain('El cuerpo de la respuesta **no se lee acá**');

    // El mensaje de un error de red sí se conserva —descartarlo dejaba sin
    // diagnóstico— pero pasa por las dos limpiezas antes de propagarse:
    // `taparValor` saca la credencial concreta y `redactarTexto` saca cualquier
    // parámetro que parezca un secreto en cualquier URL del mensaje.
    expect(http).toContain('redactarTexto(taparValor(');
  });

  it('la credencial no se persiste en ninguna tabla de IA', async () => {
    // `ai_predictions` guarda `model_provider` y `model_id`, que son nombres, no
    // secretos. Si alguna vez alguien agregara la clave «para poder reproducir
    // la llamada», este barrido lo encuentra.
    for (const archivo of [
      join(RAIZ, 'apps', 'api', 'src', 'routes', 'predictions.ts'),
      join(RAIZ, 'apps', 'api', 'src', 'routes', 'intelligence.ts'),
    ]) {
      const texto = await readFile(archivo, 'utf8');
      expect(texto, `${archivo} no puede persistir la credencial`).not.toMatch(
        /config\.ai\.apiKey/u,
      );
    }
  });

  it('la credencial no se imprime en el arranque', async () => {
    const arranque = await readFile(join(RAIZ, 'apps', 'api', 'src', 'arranque.ts'), 'utf8');
    const index = await readFile(join(RAIZ, 'apps', 'api', 'src', 'index.ts'), 'utf8');

    for (const texto of [arranque, index]) {
      expect(texto).not.toMatch(/apiKey/u);
    }
  });

  /**
   * El banner, con **todo** conectado, no dice ninguna credencial.
   *
   * La comprobación de arriba mira el texto de dos archivos y busca la palabra
   * `apiKey`. Alcanzaba cuando el banner tenía cuatro filas y una sola
   * integración con credencial; hoy tiene ocho y cuatro —IA, correo, pagos y
   * métricas—, y una fila nueva que imprimiera un secreto con otro nombre
   * pasaría entera.
   *
   * Así que se arma el banner de verdad, con cada integración **configurada**
   * —que es el único estado donde hay algo que filtrar— y credenciales
   * sintéticas, y se busca cada una en la salida.
   */
  it('con todas las integraciones configuradas, el banner no dice ninguna credencial', async () => {
    const { modosDeOperacion } = await import('@aai/api/arranque');

    const CLAVE_IA = 'sk-TEST_SECRET_ONLY_ia_no_es_una_credencial';
    const CLAVE_CORREO = 're_TEST_SECRET_ONLY_correo_no_es_una_credencial';
    const TOKEN_PAGOS = 'APP_USR-TEST_SECRET_ONLY_pagos_no_es_una_credencial';
    const FIRMA_PAGOS = 'whsec_TEST_SECRET_ONLY_firma_no_es_una_credencial';

    const modos = modosDeOperacion({
      arca: { environment: 'produccion' },
      ai: {
        provider: 'http',
        // La referencia dice **dónde** está la clave. El banner puede nombrarla
        // sin filtrar nada; lo que no puede es imprimir el valor.
        apiKeyRef: `env:${CLAVE_IA}`,
        modelId: 'un-modelo',
        baseUrl: 'https://proveedor.example/v1',
        timeoutMs: 30_000,
        maxRetries: 2,
      },
      correo: {
        provider: 'resend',
        apiKeyRef: `env:${CLAVE_CORREO}`,
        from: 'NEXO <hola@ejemplo.invalid>',
        timeoutMs: 10_000,
        maxRetries: 2,
      },
      pagos: {
        provider: 'mercadopago',
        ambiente: 'production',
        accessTokenRef: `env:${TOKEN_PAGOS}`,
        webhookSecretRef: `env:${FIRMA_PAGOS}`,
        backUrl: 'https://ejemplo.invalid/volver',
        timeoutMs: 10_000,
        maxRetries: 2,
      },
      secrets: { provider: 'env' },
      documents: { ocrEngine: 'none' },
      isProduction: true,
    });

    const impreso = modos
      .map((m) => `${m.nombre} ${m.valor} ${m.detalle ?? ''}`)
      .join('\n');

    for (const credencial of [CLAVE_IA, CLAVE_CORREO, TOKEN_PAGOS, FIRMA_PAGOS]) {
      expect(impreso, `el banner imprime «${credencial}»`).not.toContain(credencial);
    }

    // Y el control positivo: el banner sí dice algo de cada integración. Sin
    // esto, un banner vacío pasaría la comprobación de arriba.
    expect(impreso).toContain('resend');
    expect(impreso).toContain('http');
    expect(impreso).toContain('mercadopago');
  });
});
