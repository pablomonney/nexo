/**
 * Lo que comparten los scripts de la evaluación del asistente.
 *
 * ## Para qué sirve esta carpeta
 *
 * Probar el asistente con el modelo REAL, de punta a punta, sobre datos sintéticos y una base de **pruebas**. Se corre a mano, cuando se cambia el
 * prompt, las herramientas o el catálogo de preguntas: no es parte de `npm run verify` porque cuesta centavos de dólar y habla con un tercero.
 *
 * ## Qué garantiza (y se comprueba acá, no se supone)
 *
 *   · La base es LOCAL y su nombre termina en `_test`: se niega a correr contra cualquier otra.
 *   · Los datos son inventados (`scripts/sembrar-datos-visuales.mjs`): nada de clientes reales sale hacia el proveedor del modelo.
 *   · La clave (`ASSISTANT_API_KEY` del `.env` local) se usa por el servidor y nunca se imprime.
 *   · Pagos y correo quedan en «ninguno».
 *
 * Orden de uso: ver \`LEEME.md\`.
 */

import { join } from 'node:path';
import { opcionesDeConexion } from '../lib/zona.mjs';

export const RAIZ = join(import.meta.dirname, '..', '..');
export const CARPETA = import.meta.dirname;
export const PUERTO = 3002;
export const BASE = `http://127.0.0.1:${PUERTO}`;

/** La base de pruebas derivada de `DATABASE_URL`, y la compuerta que se niega a cualquier otra. */
export function baseDePruebas() {
  try {
    process.loadEnvFile(join(RAIZ, '.env'));
  } catch {
    /* sin .env: el entorno trae las variables */
  }
  const desarrollo = process.env.DATABASE_URL;
  if (!desarrollo) {
    console.error('Falta DATABASE_URL.');
    process.exit(2);
  }
  const pruebas = desarrollo.replace(/\/([^/?]+)(\?|$)/u, '/$1_test$2');
  const destino = new URL(pruebas);
  const nombre = destino.pathname.replace(/^\//u, '');
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(destino.hostname) || !nombre.endsWith('_test')) {
    console.error(`Me niego: «${nombre}» en «${destino.hostname}» no es una base local de pruebas (el nombre tiene que terminar en _test).`);
    process.exit(2);
  }
  return pruebas;
}

export const opcionesDeCliente = (url) => ({ connectionString: url, ...opcionesDeConexion() });
