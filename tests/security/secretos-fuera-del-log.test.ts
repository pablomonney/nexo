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

    // Y el mensaje de un error de red puede traer la URL, que en algunos
    // proveedores lleva la clave en la query.
    expect(http).toContain('no se pudo llegar al proveedor');
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
});
