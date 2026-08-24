/**
 * TOTP — RFC 6238, para el segundo factor obligatorio de Administrador,
 * Contador y Auditor (SECURITY.md §2).
 *
 * Implementado acá y no con una dependencia porque son cuarenta líneas de
 * especificación cerrada sobre `node:crypto`, y una dependencia menos en el
 * camino de autenticación es una superficie de ataque menos.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpOptions {
  /** Segundos por paso. RFC 6238 recomienda 30. */
  readonly step?: number;
  readonly digits?: number;
  readonly algorithm?: 'sha1' | 'sha256' | 'sha512';
}

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new RangeError(`Carácter inválido en base32: ${JSON.stringify(char)}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** Código para un instante dado. `atMs` permite testear sin tocar el reloj. */
export function totp(secret: string, atMs: number, options: TotpOptions = {}): string {
  const step = options.step ?? 30;
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? 'sha1';

  const counter = Math.floor(atMs / 1000 / step);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Verifica un código admitiendo una ventana de tolerancia por deriva de reloj.
 *
 * `window = 1` acepta el paso anterior y el siguiente: es el valor habitual y
 * cubre relojes desfasados hasta 30 segundos. La comparación es de tiempo
 * constante para no filtrar información por el tiempo de respuesta.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number,
  options: TotpOptions & { window?: number } = {},
): boolean {
  const step = options.step ?? 30;
  const window = options.window ?? 1;
  const candidate = code.trim();
  if (!/^\d{6,8}$/.test(candidate)) return false;

  for (let drift = -window; drift <= window; drift += 1) {
    const expected = totp(secret, atMs + drift * step * 1000, options);
    if (expected.length !== candidate.length) continue;
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return true;
  }
  return false;
}

/** URI para el QR de la app autenticadora. */
export function otpauthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
