import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, createUser, getUserByEmail, getUserById, listUsers, countUsers } from '../src/db.js';
import { hashPassword } from '../src/password.js';

describe('users db helpers (Fase 0 auth)', () => {
  beforeAll(async () => { await initDatabase(); });

  // Email único por ejecución: la SQLite del repo persiste entre runs.
  const email = `tester-${Math.random().toString(36).slice(2)}@ex.com`;

  it('createUser + getUserByEmail/getUserById', async () => {
    const before = await countUsers();
    const u = await createUser(email, hashPassword('pw'), 'user');
    expect(u.id).toMatch(/^user-/);
    expect(u.role).toBe('user');

    const byEmail = await getUserByEmail(email);
    expect(byEmail?.id).toBe(u.id);
    expect(byEmail?.password_hash).toContain('scrypt:');

    const byId = await getUserById(u.id);
    expect(byId?.email).toBe(email);

    expect(await countUsers()).toBe(before + 1);
  });

  it('email duplicado lanza error claro', async () => {
    await expect(createUser(email, hashPassword('otra'), 'user')).rejects.toThrow(/Ya existe un usuario/);
  });

  it('listUsers no expone el hash', async () => {
    const list = await listUsers();
    const me = list.find(u => u.email === email);
    expect(me).toBeTruthy();
    expect((me as any).password_hash).toBeUndefined();
  });
});
