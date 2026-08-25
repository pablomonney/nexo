import { createHash } from 'node:crypto';

/** SHA-256 en hexadecimal minúscula. Es la identidad del archivo en todo el sistema. */
export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
