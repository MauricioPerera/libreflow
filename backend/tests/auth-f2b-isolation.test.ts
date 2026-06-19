import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, saveCredential } from '../src/db.js';
import { resolveCredentialAuth } from '../src/registry.js';

// F2b: un flujo solo puede usar credenciales de su propio dueño. resolveCredentialAuth es el
// kernel (lo invocan httpRequest/mcpToolCall/aiAgent/streamTriggers con el ownerId del flujo).
describe('F2b — aislamiento de credenciales por dueño', () => {
  const A = `userA-${Math.random().toString(36).slice(2)}`;
  const B = `userB-${Math.random().toString(36).slice(2)}`;
  const credA = `credA-${Math.random().toString(36).slice(2)}`;
  const credB = `credB-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    await initDatabase();
    await saveCredential(credA, 'A', 'basicAuth', { user: 'ua', password: 'pa' }, A);
    await saveCredential(credB, 'B', 'basicAuth', { user: 'ub', password: 'pb' }, B);
  });

  it('el dueño resuelve su propia credencial', async () => {
    const auth = await resolveCredentialAuth(credA, A);
    expect(auth.headers['Authorization']).toMatch(/^Basic /);
  });

  it('un flujo de A NO puede usar una credencial de B (lanza)', async () => {
    await expect(resolveCredentialAuth(credB, A)).rejects.toThrow(/no pertenece al dueño/);
  });

  it('admin puede usar cualquier credencial', async () => {
    const auth = await resolveCredentialAuth(credB, A, true);
    expect(auth.headers['Authorization']).toMatch(/^Basic /);
  });

  it('flujo sin dueño (single-tenant/legacy) no se enforza — compatibilidad', async () => {
    const auth = await resolveCredentialAuth(credB, null);
    expect(auth.headers['Authorization']).toMatch(/^Basic /);
  });

  it('sin credentialId devuelve auth vacía', async () => {
    expect(await resolveCredentialAuth(undefined, A)).toEqual({ headers: {}, query: {} });
  });
});
