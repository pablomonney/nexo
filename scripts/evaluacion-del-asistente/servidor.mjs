#!/usr/bin/env node
/**
 * La API contra la base de PRUEBAS, con el asistente conectado al modelo REAL. Puerto 3002 (el que espera `sembrar-datos-visuales.mjs`).
 *
 *   node scripts/evaluacion-del-asistente/servidor.mjs
 *
 * Es lo contrario de `servir-contra-pruebas.mjs`, que corta todo lo que habla con el exterior: acá se deja pasar SÓLO el asistente, porque es lo
 * que se evalúa. Sigue sin pagos ni correo, y sigue negándose a cualquier base que no sea local y `_test`.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { RAIZ, PUERTO, baseDePruebas } from './comun.mjs';

const base = baseDePruebas();
if (!process.env.ASSISTANT_API_KEY) {
  console.error('Falta ASSISTANT_API_KEY en el .env local: sin ella no hay modelo con el que evaluar. No se levantó nada.');
  process.exit(2);
}

const hijo = spawn(process.execPath, [join(RAIZ, 'apps', 'api', 'dist', 'index.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: base,
    PORT: String(PUERTO),
    HOST: '127.0.0.1',
    PAYMENTS_PROVIDER: 'none',
    EMAIL_PROVIDER: 'none',
    AI_PROVIDER: 'none',
    ASSISTANT_PROVIDER: 'anthropic',
    // Una evaluación hace muchas preguntas seguidas: el tope técnico por minuto la cortaría.
    ASSISTANT_MENSAJES_POR_MINUTO: '1000',
    ASSISTANT_MAX_TOKENS: '2048',
  },
});
hijo.on('exit', (codigo) => process.exit(codigo ?? 0));
