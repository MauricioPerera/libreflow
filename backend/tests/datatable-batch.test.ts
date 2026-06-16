import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDatabase, saveDataTable, deleteDataTable,
  getDataTableRows, countDataTableRows, batchDataTableRows, upsertDataTableRow,
} from '../src/db.js';

describe('Data table batch (transacción atómica todo-o-nada)', () => {
  const tableId = `tbl-batch-${Date.now()}`;

  beforeAll(async () => {
    await initDatabase();
    await saveDataTable(tableId, `Batch_${Date.now()}`, [
      { name: 'email', type: 'string' },
      { name: 'saldo', type: 'number' },
      { name: 'visitas', type: 'number' },
    ], 'email');
  });

  afterAll(async () => { try { await deleteDataTable(tableId); } catch {} });

  it('aplica varias ops mixtas en una sola transacción', async () => {
    const res = await batchDataTableRows(tableId, [
      { op: 'upsert', data: { email: 'a@x.com', saldo: 10 } },
      { op: 'upsert', data: { email: 'b@x.com', saldo: 20 } },
      { op: 'increment', key: 'a@x.com', field: 'visitas', amount: 3 },
    ]);
    expect(res).toHaveLength(3);

    const rows = await getDataTableRows(tableId);
    const a = rows.find(r => r.data.email === 'a@x.com')!;
    const b = rows.find(r => r.data.email === 'b@x.com')!;
    expect(a.data.saldo).toBe(10);
    expect(a.data.visitas).toBe(3);
    expect(b.data.saldo).toBe(20);
  });

  it('rollback completo si una op falla (clave duplicada en append)', async () => {
    const before = await countDataTableRows(tableId);
    await expect(batchDataTableRows(tableId, [
      { op: 'append', data: { email: 'c@x.com', saldo: 1 } }, // válido…
      { op: 'append', data: { email: 'a@x.com', saldo: 1 } }, // …pero a@x.com ya existe → revienta
    ])).rejects.toThrow(/clave duplicada|rollback/i);

    const after = await countDataTableRows(tableId);
    expect(after).toBe(before); // nada se insertó: ni siquiera c@x.com
    const rows = await getDataTableRows(tableId);
    expect(rows.find(r => r.data.email === 'c@x.com')).toBeUndefined();
  });

  it('rollback si una op intermedia es inválida (update sin rowId)', async () => {
    const before = await countDataTableRows(tableId);
    await expect(batchDataTableRows(tableId, [
      { op: 'append', data: { email: 'd@x.com' } },
      { op: 'update', data: { email: 'd@x.com', saldo: 5 } }, // falta rowId → error
    ])).rejects.toThrow(/requiere rowId/);
    expect(await countDataTableRows(tableId)).toBe(before); // d@x.com NO quedó insertado
  });

  it('update y delete por rowId dentro del lote', async () => {
    const seed = await upsertDataTableRow(tableId, { email: 'e@x.com', saldo: 1 });
    const res = await batchDataTableRows(tableId, [
      { op: 'update', rowId: seed.id, data: { email: 'e@x.com', saldo: 99 } },
    ]);
    expect(res[0].id).toBe(seed.id);
    let rows = await getDataTableRows(tableId);
    expect(rows.find(r => r.id === seed.id)!.data.saldo).toBe(99);

    await batchDataTableRows(tableId, [{ op: 'delete', rowId: seed.id }]);
    rows = await getDataTableRows(tableId);
    expect(rows.find(r => r.id === seed.id)).toBeUndefined();
  });

  it('operación desconocida revienta el lote', async () => {
    await expect(batchDataTableRows(tableId, [{ op: 'frobnicate' as any }]))
      .rejects.toThrow(/no soportada/);
  });
});
