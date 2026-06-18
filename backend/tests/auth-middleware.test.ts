import { describe, it, expect } from 'vitest';
import { requireAuth } from '../src/auth.js';
import { signToken } from '../src/jwt.js';

// LF_API_KEY no está definido en el entorno de test → path "dev" (auth deshabilitada),
// pero un JWT válido SIEMPRE se resuelve y adjunta el usuario.
function run(headers: Record<string, string>) {
  const req: any = { header: (k: string) => headers[k.toLowerCase()] };
  let nexted = false;
  let status = 0;
  const res: any = { status(c: number) { status = c; return this; }, json() { return this; } };
  requireAuth(req, res, () => { nexted = true; });
  return { nexted, status, user: req.user };
}

describe('requireAuth', () => {
  it('un JWT válido adjunta el usuario y pasa', () => {
    const token = signToken({ sub: 'user-42', email: 'a@b.com', role: 'admin' });
    const r = run({ authorization: `Bearer ${token}` });
    expect(r.nexted).toBe(true);
    expect(r.user).toEqual({ id: 'user-42', email: 'a@b.com', role: 'admin' });
  });

  it('en dev sin API key, pasa como admin implícito', () => {
    const r = run({});
    expect(r.nexted).toBe(true);
    expect(r.user.id).toBe('dev');
    expect(r.user.role).toBe('admin');
  });

  it('un JWT inválido en dev cae al path dev (no rompe)', () => {
    const r = run({ authorization: 'Bearer no.es.jwt' });
    expect(r.nexted).toBe(true);
    expect(r.user.id).toBe('dev');
  });
});
