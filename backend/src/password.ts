import crypto from 'node:crypto';

/**
 * Hash de contraseñas con scrypt (algoritmo de derivación con coste de memoria, resistente a
 * GPU/ASIC). Sin dependencias: usa `node:crypto`. Formato almacenado: `scrypt:salt:hash` (hex).
 * Verificación en tiempo constante. Coherente con el resto del repo (cripto propia, sin libs).
 */

const KEYLEN = 64;
const SCRYPT: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 };

/** Deriva el hash de una contraseña con un salt aleatorio. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, KEYLEN, SCRYPT);
  return `scrypt:${salt.toString('hex')}:${dk.toString('hex')}`;
}

/** Verifica una contraseña contra un hash almacenado (constant-time). */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const dk = crypto.scryptSync(password, salt, expected.length, SCRYPT);
  return crypto.timingSafeEqual(dk, expected);
}
