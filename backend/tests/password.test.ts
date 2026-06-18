import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password (scrypt)', () => {
  it('hash + verify correcto', () => {
    const h = hashPassword('s3cr3t-Pa$$');
    expect(h.startsWith('scrypt:')).toBe(true);
    expect(verifyPassword('s3cr3t-Pa$$', h)).toBe(true);
  });

  it('rechaza contraseña incorrecta', () => {
    const h = hashPassword('correcta');
    expect(verifyPassword('incorrecta', h)).toBe(false);
  });

  it('cada hash usa un salt distinto', () => {
    expect(hashPassword('misma')).not.toBe(hashPassword('misma'));
  });

  it('rechaza hashes con formato inválido', () => {
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'bcrypt:aa:bb')).toBe(false);
    expect(verifyPassword('x', 'scrypt:solosalt')).toBe(false);
    expect(verifyPassword('x', null as any)).toBe(false);
  });
});
