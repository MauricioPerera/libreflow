import { describe, it, expect, beforeAll } from 'vitest';
import { requireAuth } from '../src/auth.js';
import { signToken } from '../src/jwt.js';
import { initDatabase, createUser, setUserApiToken } from '../src/db.js';
import { hashPassword } from '../src/password.js';

// LF_API_KEY no está definido en el entorno de test → path "dev" (auth deshabilitada),
// pero un JWT válido o un token de usuario SIEMPRE se resuelven y adjuntan el usuario.
async function run(headers: Record<string, string>) {
  const req: any = { header: (k: string) => headers[k.toLowerCase()] };
  let nexted = false;
  let status = 0;
  const res: any = { status(c: number) { status = c; return this; }, json() { return this; } };
  await requireAuth(req, res, () => { nexted = true; });
  return { nexted, status, user: req.user };
}

describe('requireAuth', () => {
  beforeAll(async () => { await initDatabase(); });

  it('un JWT válido adjunta el usuario y pasa', async () => {
    const token = signToken({ sub: 'user-42', email: 'a@b.com', role: 'admin' });
    const r = await run({ authorization: `Bearer ${token}` });
    expect(r.nexted).toBe(true);
    expect(r.user).toEqual({ id: 'user-42', email: 'a@b.com', role: 'admin' });
  });

  it('un token de API por-usuario resuelve a su dueño', async () => {
    const u = await createUser(`tok-${Math.random().toString(36).slice(2)}@ex.com`, hashPassword('x'), 'user');
    const tok = 'lf_test_' + Math.random().toString(36).slice(2);
    await setUserApiToken(u.id, tok);
    const r = await run({ authorization: `Bearer ${tok}` });
    expect(r.nexted).toBe(true);
    expect(r.user.id).toBe(u.id);
    expect(r.user.role).toBe('user');
  });

  it('en dev sin API key, pasa como admin implícito', async () => {
    const r = await run({});
    expect(r.nexted).toBe(true);
    expect(r.user.id).toBe('dev');
    expect(r.user.role).toBe('admin');
  });

  it('un bearer que no es ni JWT ni token de usuario cae al path dev', async () => {
    const r = await run({ authorization: 'Bearer no.es.jwt' });
    expect(r.nexted).toBe(true);
    expect(r.user.id).toBe('dev');
  });
});
