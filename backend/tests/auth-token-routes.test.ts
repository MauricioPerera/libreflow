import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { initDatabase, createUser } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { signToken } from '../src/jwt.js';
import { app } from '../src/server.js';

// Token de API por-usuario: ver (genera al primer acceso), persistir y regenerar.
describe('/api/auth/token', () => {
  let jwt = '', userId = '';
  beforeAll(async () => {
    await initDatabase();
    const u = await createUser(`atk-${Math.random().toString(36).slice(2)}@ex.com`, hashPassword('x'), 'user');
    userId = u.id;
    jwt = signToken({ sub: u.id, email: u.email, role: 'user' });
  });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('GET genera y devuelve un token (lf_...) y es estable', async () => {
    const a = await request(app).get('/api/auth/token').set(auth(jwt));
    expect(a.status).toBe(200);
    expect(a.body.token).toMatch(/^lf_/);
    const b = await request(app).get('/api/auth/token').set(auth(jwt));
    expect(b.body.token).toBe(a.body.token); // persistido
  });

  it('el token resuelve al usuario en una ruta protegida', async () => {
    const { body } = await request(app).get('/api/auth/token').set(auth(jwt));
    const me = await request(app).get('/api/auth/me').set(auth(body.token));
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(userId);
  });

  it('regenerar cambia el token y el anterior deja de resolver al usuario', async () => {
    const old = (await request(app).get('/api/auth/token').set(auth(jwt))).body.token;
    const regen = await request(app).post('/api/auth/token/regenerate').set(auth(jwt));
    expect(regen.status).toBe(200);
    expect(regen.body.token).not.toBe(old);
    // El token viejo ya no resuelve a este usuario (en dev cae al admin implícito, no al user).
    const meOld = await request(app).get('/api/auth/me').set(auth(old));
    expect(meOld.body.user.id).not.toBe(userId);
  });
});
