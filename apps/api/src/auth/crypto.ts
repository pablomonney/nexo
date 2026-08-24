/**
 * Primitivas de autenticación.
 *
 * SECURITY.md §2: contraseñas con Argon2id; tokens de sesión guardados como
 * hash; secreto TOTP cifrado en reposo.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { config } from '../config.js';

// `Algorithm` de @node-rs/argon2 se declara como `const enum`, y con
// `verbatimModuleSyntax` activado no puede importarse. Se fija el valor
// documentado (Argon2d = 0, Argon2i = 1, Argon2id = 2) en lugar de relajar la
// exigencia del compilador para todo el repositorio por una sola dependencia.
const ARGON2ID = 2;

// Parámetros de la referencia OWASP para Argon2id.
const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

export async function verifyPassword(stored: string, candidate: string): Promise<boolean> {
  try {
    return await argonVerify(stored, candidate);
  } catch {
    // Un hash corrupto en la base es un fallo de verificación, no una excepción
    // que tumbe el login de todos.
    return false;
  }
}

/** Token opaco de sesión. Lo que viaja al cliente; lo que se guarda es su hash. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Cifrado del secreto TOTP: AES-256-GCM con nonce por registro.
 *
 * En producción la clave viene del KMS. El formato `v1.<iv>.<tag>.<ct>` lleva
 * versión para poder rotar el esquema sin adivinar cómo se cifró cada fila.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.mfaEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload: string): string {
  const [version, ivPart, tagPart, ctPart] = payload.split('.');
  if (version !== 'v1' || ivPart === undefined || tagPart === undefined || ctPart === undefined) {
    throw new Error('Formato de secreto cifrado desconocido');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    config.mfaEncryptionKey,
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Códigos de recuperación de un solo uso. Se muestran una vez y se guardan hasheados. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
