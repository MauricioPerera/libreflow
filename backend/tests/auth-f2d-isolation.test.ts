import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { initDatabase, createUser } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { signToken } from '../src/jwt.js';
import { app } from '../src/server.js';

// F2d — gate de aceptación del enforcement multi-usuario: A no ve/usa/borra nada de B (404),
// admin lo ve todo. Conduce el app real por HTTP (supertest) con JWTs de dos usuarios.
// requireAuth honra un JWT válido ANTES del path dev, así que A y B se resuelven de verdad.
describe('F2d — aislamiento cross-user por HTTP', () => {
  let tokenA = '', tokenB = '', tokenAdmin = '';
  const sfx = Math.random().toString(36).slice(2);

  beforeAll(async () => {
    await initDatabase();
    const a = await createUser(`a-${sfx}@ex.com`, hashPassword('x'), 'user');
    const b = await createUser(`b-${sfx}@ex.com`, hashPassword('x'), 'user');
    const adm = await createUser(`adm-${sfx}@ex.com`, hashPassword('x'), 'admin');
    tokenA = signToken({ sub: a.id, email: a.email, role: 'user' });
    tokenB = signToken({ sub: b.id, email: b.email, role: 'user' });
    tokenAdmin = signToken({ sub: adm.id, email: adm.email, role: 'admin' });
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('un flujo de A no es visible/borrable por B, sí por A y admin', async () => {
    const id = `wf-f2d-${sfx}`;
    const create = await request(app).post('/api/workflows').set(auth(tokenA))
      .send({ id, name: 'De A', nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }], connections: [] });
    expect(create.status).toBe(200);

    // A lo ve; B recibe 404; admin lo ve.
    expect((await request(app).get(`/api/workflows/${id}`).set(auth(tokenA))).status).toBe(200);
    expect((await request(app).get(`/api/workflows/${id}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).get(`/api/workflows/${id}`).set(auth(tokenAdmin))).status).toBe(200);

    // El listado de B no incluye el flujo de A; el de A sí.
    const listB = await request(app).get('/api/workflows').set(auth(tokenB));
    expect(listB.body.find((w: any) => w.id === id)).toBeUndefined();
    const listA = await request(app).get('/api/workflows').set(auth(tokenA));
    expect(listA.body.find((w: any) => w.id === id)).toBeTruthy();

    // B no puede borrarlo (404) y sigue existiendo para A.
    expect((await request(app).delete(`/api/workflows/${id}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).get(`/api/workflows/${id}`).set(auth(tokenA))).status).toBe(200);
  });

  it('una credencial de A no es visible por B (404); sí por A', async () => {
    const id = `cred-f2d-${sfx}`;
    const create = await request(app).post('/api/credentials').set(auth(tokenA))
      .send({ id, name: 'C de A', type: 'apiKey', data: { name: 'X-Key', value: 'secreto', in: 'header' } });
    expect(create.status).toBe(200);
    expect((await request(app).get(`/api/credentials/${id}`).set(auth(tokenA))).status).toBe(200);
    expect((await request(app).get(`/api/credentials/${id}`).set(auth(tokenB))).status).toBe(404);
    // El listado de B no la incluye.
    const listB = await request(app).get('/api/credentials').set(auth(tokenB));
    expect(listB.body.find((c: any) => c.id === id)).toBeUndefined();
  });

  it('B no puede sobrescribir un flujo de A (404, sin pisarlo)', async () => {
    const id = `wf-f2d2-${sfx}`;
    await request(app).post('/api/workflows').set(auth(tokenA)).send({ id, name: 'Orig A', nodes: [], connections: [] });
    const overwrite = await request(app).post('/api/workflows').set(auth(tokenB)).send({ id, name: 'Hackeado por B', nodes: [], connections: [] });
    expect(overwrite.status).toBe(404);
    const asA = await request(app).get(`/api/workflows/${id}`).set(auth(tokenA));
    expect(asA.body.name).toBe('Orig A');
  });
});
