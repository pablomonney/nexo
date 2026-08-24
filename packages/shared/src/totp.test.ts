import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, otpauthUri, totp, verifyTotp } from './totp.js';

// Secreto de los vectores de prueba del RFC 6238: los 20 bytes ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('ida y vuelta', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(original)).equals(original)).toBe(true);
  });

  it('rechaza caracteres fuera del alfabeto', () => {
    expect(() => base32Decode('ABC1')).toThrow(/base32/);
  });
});

describe('TOTP — vectores del RFC 6238 (SHA-1, 8 dígitos)', () => {
  const vectors: Array<[seconds: number, expected: string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
  ];

  for (const [seconds, expected] of vectors) {
    it(`T = ${seconds} → ${expected}`, () => {
      expect(totp(RFC_SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
    });
  }
});

describe('verificación', () => {
  const now = 1_700_000_000_000;

  it('acepta el código del paso actual', () => {
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), now)).toBe(true);
  });

  it('tolera una deriva de reloj de un paso en cada sentido', () => {
    const previous = totp(RFC_SECRET, now - 30_000);
    const next = totp(RFC_SECRET, now + 30_000);
    expect(verifyTotp(RFC_SECRET, previous, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, next, now)).toBe(true);
  });

  it('rechaza fuera de la ventana', () => {
    const old = totp(RFC_SECRET, now - 300_000);
    expect(verifyTotp(RFC_SECRET, old, now)).toBe(false);
  });

  it('rechaza códigos con formato inválido sin calcular nada', () => {
    for (const bad of ['', '12345', 'abcdef', '12345a', '1234567890']) {
      expect(verifyTotp(RFC_SECRET, bad, now)).toBe(false);
    }
  });

  it('rechaza el código de otro secreto', () => {
    const other = generateSecret();
    expect(verifyTotp(RFC_SECRET, totp(other, now), now)).toBe(false);
  });
});

describe('generateSecret', () => {
  it('produce secretos distintos y decodificables', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20);
  });
});

describe('otpauthUri', () => {
  it('arma la URI para el QR', () => {
    const uri = otpauthUri({
      secret: RFC_SECRET,
      accountName: 'contador@estudio.com.ar',
      issuer: 'Contabilidad AI',
    });
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('period=30');
  });
});
