import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { initDatabase, createUser, upsertVectorFile } from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { signToken } from '../src/jwt.js';
import { app } from '../src/server.js';

// Las rutas /api/vector-stores listan/borran colecciones del dueño. Aislamiento por owner_id.
describe('/api/vector-stores (RAG, owner-scoped)', () => {
  let tokA = '', tokB = '';
  const sfx = Math.random().toString(36).slice(2);
  const colA = `colA-${sfx}`;

  beforeAll(async () => {
    await initDatabase();
    const a = await createUser(`vsa-${sfx}@ex.com`, hashPassword('x'), 'user');
    const b = await createUser(`vsb-${sfx}@ex.com`, hashPassword('x'), 'user');
    tokA = signToken({ sub: a.id, email: a.email, role: 'user' });
    tokB = signToken({ sub: b.id, email: b.email, role: 'user' });
    // Siembra una colección de A (dos "ficheros" de la colección).
    await upsertVectorFile(a.id, colA, `${colA}.bin`, Buffer.from([1, 2, 3]));
    await upsertVectorFile(a.id, colA, `${colA}.json`, Buffer.from('{}'));
  });
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('A ve su colección; B no la ve', async () => {
    const la = await request(app).get('/api/vector-stores').set(auth(tokA));
    expect(la.status).toBe(200);
    expect(la.body.find((c: any) => c.collection === colA)).toBeTruthy();
    expect(la.body.find((c: any) => c.collection === colA).files).toBe(2);
    const lb = await request(app).get('/api/vector-stores').set(auth(tokB));
    expect(lb.body.find((c: any) => c.collection === colA)).toBeUndefined();
  });

  it('B no puede borrar la colección de A (su DELETE no afecta a A)', async () => {
    const del = await request(app).delete(`/api/vector-stores/${colA}`).set(auth(tokB));
    expect(del.status).toBe(200); // borra en el espacio de B (no-op); no toca a A
    const la = await request(app).get('/api/vector-stores').set(auth(tokA));
    expect(la.body.find((c: any) => c.collection === colA)).toBeTruthy();
  });

  it('A borra su colección', async () => {
    const del = await request(app).delete(`/api/vector-stores/${colA}`).set(auth(tokA));
    expect(del.status).toBe(200);
    const la = await request(app).get('/api/vector-stores').set(auth(tokA));
    expect(la.body.find((c: any) => c.collection === colA)).toBeUndefined();
  });
});
