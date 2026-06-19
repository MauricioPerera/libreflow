import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { initDatabase, createUser } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { signToken } from '../src/jwt.js';
import { app } from '../src/server.js';

// F4 backend — /api/users es admin-only; guards: no borrarte a ti mismo, no borrar el último admin.
describe('F4 — gestión de usuarios (admin)', () => {
  let adminTok = '', userTok = '', adminId = '';
  const sfx = Math.random().toString(36).slice(2);

  beforeAll(async () => {
    await initDatabase();
    const adm = await createUser(`f4adm-${sfx}@ex.com`, hashPassword('x'), 'admin');
    const usr = await createUser(`f4usr-${sfx}@ex.com`, hashPassword('x'), 'user');
    adminId = adm.id;
    adminTok = signToken({ sub: adm.id, email: adm.email, role: 'admin' });
    userTok = signToken({ sub: usr.id, email: usr.email, role: 'user' });
  });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('un usuario normal NO puede listar ni crear usuarios (403)', async () => {
    expect((await request(app).get('/api/users').set(auth(userTok))).status).toBe(403);
    expect((await request(app).post('/api/users').set(auth(userTok)).send({ email: 'x@y.z', password: 'p' })).status).toBe(403);
  });

  it('un admin crea, lista y borra usuarios', async () => {
    const email = `f4new-${sfx}@ex.com`;
    const created = await request(app).post('/api/users').set(auth(adminTok)).send({ email, password: 'secreto', role: 'user' });
    expect(created.status).toBe(200);
    expect(created.body.email).toBe(email);

    const list = await request(app).get('/api/users').set(auth(adminTok));
    expect(list.status).toBe(200);
    const row = list.body.find((u: any) => u.id === created.body.id);
    expect(row).toBeTruthy();
    expect(row.password_hash).toBeUndefined(); // nunca se expone el hash

    const del = await request(app).delete(`/api/users/${created.body.id}`).set(auth(adminTok));
    expect(del.status).toBe(200);
    const list2 = await request(app).get('/api/users').set(auth(adminTok));
    expect(list2.body.find((u: any) => u.id === created.body.id)).toBeUndefined();
  });

  it('email duplicado → 409', async () => {
    const email = `f4dup-${sfx}@ex.com`;
    await request(app).post('/api/users').set(auth(adminTok)).send({ email, password: 'p' });
    const dup = await request(app).post('/api/users').set(auth(adminTok)).send({ email, password: 'p' });
    expect(dup.status).toBe(409);
  });

  it('un admin no puede borrarse a sí mismo', async () => {
    const r = await request(app).delete(`/api/users/${adminId}`).set(auth(adminTok));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/propia cuenta/);
  });

  it('un usuario cambia su propia contraseña (verifica la actual)', async () => {
    const email = `f4pwd-${sfx}@ex.com`;
    const created = await request(app).post('/api/users').set(auth(adminTok)).send({ email, password: 'vieja' });
    const tok = signToken({ sub: created.body.id, email, role: 'user' });
    const wrong = await request(app).post('/api/auth/password').set(auth(tok)).send({ currentPassword: 'incorrecta', newPassword: 'nueva' });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post('/api/auth/password').set(auth(tok)).send({ currentPassword: 'vieja', newPassword: 'nueva' });
    expect(ok.status).toBe(200);
    // La nueva contraseña permite login.
    const login = await request(app).post('/api/auth/login').send({ email, password: 'nueva' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });
});
