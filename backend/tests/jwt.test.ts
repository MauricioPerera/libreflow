import { describe, it, expect } from 'vitest';
import { signToken, verifyToken } from '../src/jwt.js';

describe('jwt (HS256 propio)', () => {
  it('firma y verifica un token válido', () => {
    const t = signToken({ sub: 'user-1', email: 'a@b.com', role: 'admin' });
    expect(t.split('.')).toHaveLength(3);
    const p = verifyToken(t);
    expect(p?.sub).toBe('user-1');
    expect(p?.email).toBe('a@b.com');
    expect(p?.role).toBe('admin');
    expect(p?.exp).toBeGreaterThan(p!.iat!);
  });

  it('rechaza firma manipulada', () => {
    const t = signToken({ sub: 'u' });
    const [h, p] = t.split('.');
    expect(verifyToken(`${h}.${p}.firmaFalsa`)).toBeNull();
  });

  it('rechaza payload alterado (firma deja de cuadrar)', () => {
    const t = signToken({ sub: 'u', role: 'user' });
    const [h, , s] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u', role: 'admin' })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifyToken(`${h}.${forged}.${s}`)).toBeNull();
  });

  it('rechaza token expirado', () => {
    const t = signToken({ sub: 'u' }, -10); // ya expirado
    expect(verifyToken(t)).toBeNull();
  });

  it('rechaza basura', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('a.b')).toBeNull();
    expect(verifyToken(null as any)).toBeNull();
  });
});
