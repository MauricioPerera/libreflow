import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDatabase,
  saveDataTable,
  deleteDataTable,
  addDataTableRow,
  getDataTableRows,
  upsertDataTableRow,
  incrementDataTableRow,
  getOrCreateDataTableRow,
} from '../src/db.js';

describe('Data table state engine (key + atomic ops + idempotency)', () => {
  const tableId = `tbl-state-${Date.now()}`;

  beforeAll(async () => {
    await initDatabase();
    await saveDataTable(tableId, `State_${Date.now()}`, [
      { name: 'email', type: 'string' },
      { name: 'count', type: 'number' },
    ], 'email');
  });

  afterAll(async () => {
    try { await deleteDataTable(tableId); } catch {}
  });

  it('upsert inserta y luego actualiza por clave (idempotente)', async () => {
    const a = await upsertDataTableRow(tableId, { email: 'a@x.com', count: 1 });
    expect(a.key).toBe('a@x.com');
    const b = await upsertDataTableRow(tableId, { email: 'a@x.com', count: 9 });
    expect(b.id).toBe(a.id); // misma fila
    const rows = await getDataTableRows(tableId);
    expect(rows.filter(r => r.data.email === 'a@x.com')).toHaveLength(1);
    expect(rows.find(r => r.data.email === 'a@x.com')!.data.count).toBe(9);
  });

  it('append con clave duplicada falla (idempotencia dura)', async () => {
    await expect(addDataTableRow(tableId, `row-dup-${Date.now()}`, { email: 'a@x.com' })).rejects.toThrow(/already exists/i);
  });

  it('increment crea el contador y lo incrementa atómicamente', async () => {
    const r1 = await incrementDataTableRow(tableId, 'counter-1', 'count', 5);
    expect(r1.data.count).toBe(5);
    const r2 = await incrementDataTableRow(tableId, 'counter-1', 'count', 3);
    expect(r2.data.count).toBe(8);
    expect(r2.id).toBe(r1.id);
  });

  it('increment concurrente no pierde actualizaciones (sin races)', async () => {
    await Promise.all(Array.from({ length: 20 }, () => incrementDataTableRow(tableId, 'concurrent', 'count', 1)));
    const rows = await getDataTableRows(tableId);
    expect(rows.find(r => r.data.email === 'concurrent')!.data.count).toBe(20);
  });

  it('getOrCreate devuelve la fila o la crea desde defaults', async () => {
    const created = await getOrCreateDataTableRow(tableId, 'nuevo@x.com', { count: 0, status: 'pending' });
    expect(created.created).toBe(true);
    expect(created.data.email).toBe('nuevo@x.com');
    expect(created.data.status).toBe('pending');
    const again = await getOrCreateDataTableRow(tableId, 'nuevo@x.com', { count: 999 });
    expect(again.created).toBe(false);
    expect(again.data.count).toBe(0); // no se sobreescribe
  });
});
