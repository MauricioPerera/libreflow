import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, assertOwnership, getOwnerOf, saveWorkflow } from '../src/db.js';

describe('assertOwnership (F2a, contrato assert-ownership)', () => {
  it('admin siempre autoriza', () => {
    expect(assertOwnership('user-B', 'user-A', true)).toBe(true);
  });
  it('mismo dueño autoriza', () => {
    expect(assertOwnership('user-A', 'user-A', false)).toBe(true);
  });
  it('dueño distinto niega', () => {
    expect(assertOwnership('user-B', 'user-A', false)).toBe(false);
  });
  it('huérfano (sin dueño) niega a no-admin, permite a admin', () => {
    expect(assertOwnership(null, 'user-A', false)).toBe(false);
    expect(assertOwnership('', 'user-A', false)).toBe(false);
    expect(assertOwnership(null, 'user-A', true)).toBe(true);
  });
});

describe('owner en create + getOwnerOf (F2a)', () => {
  beforeAll(async () => { await initDatabase(); });
  const id = `wf-own-${Math.random().toString(36).slice(2)}`;

  it('saveWorkflow fija owner_id en la creación', async () => {
    await saveWorkflow(id, 'Mío', [], [], undefined, null, 'user-A');
    expect(await getOwnerOf('workflows', id)).toBe('user-A');
  });

  it('un UPDATE posterior NO cambia el owner', async () => {
    await saveWorkflow(id, 'Mío editado', [{ id: 't', type: 'trigger', name: 'T', parameters: {} }], [], undefined, null, 'user-OTRO');
    expect(await getOwnerOf('workflows', id)).toBe('user-A');
  });

  it('getOwnerOf devuelve null para id inexistente', async () => {
    expect(await getOwnerOf('workflows', 'no-existe-xyz')).toBeNull();
  });
});
