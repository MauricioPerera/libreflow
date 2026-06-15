import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDatabase,
  saveDataTable,
  deleteDataTable,
  addDataTableRow,
  queryDataTableRows,
} from '../src/db.js';

describe('Data table rich queries (operators, sort, limit)', () => {
  const tableId = `tbl-query-${Date.now()}`;

  beforeAll(async () => {
    await initDatabase();
    await saveDataTable(tableId, `Query_${Date.now()}`, [
      { name: 'name', type: 'string' },
      { name: 'score', type: 'number' },
      { name: 'status', type: 'string' },
    ]);
    const rows = [
      { name: 'ana', score: 10, status: 'active' },
      { name: 'beto', score: 80, status: 'pending' },
      { name: 'carla', score: 55, status: 'active' },
      { name: 'dora', score: 90, status: 'inactive' },
    ];
    for (const [i, r] of rows.entries()) {
      await addDataTableRow(tableId, `q-${i}-${Date.now()}`, r);
    }
  });

  afterAll(async () => {
    try { await deleteDataTable(tableId); } catch {}
  });

  it('gt: score > 50', async () => {
    const rows = await queryDataTableRows(tableId, [{ column: 'score', op: 'gt', value: 50 }]);
    expect(rows.map(r => r.data.name).sort()).toEqual(['beto', 'carla', 'dora']);
  });

  it('eq: status = active', async () => {
    const rows = await queryDataTableRows(tableId, [{ column: 'status', op: 'eq', value: 'active' }]);
    expect(rows.map(r => r.data.name).sort()).toEqual(['ana', 'carla']);
  });

  it('contains: name contains "ar"', async () => {
    const rows = await queryDataTableRows(tableId, [{ column: 'name', op: 'contains', value: 'ar' }]);
    expect(rows.map(r => r.data.name)).toEqual(['carla']);
  });

  it('in: status in [active, pending]', async () => {
    const rows = await queryDataTableRows(tableId, [{ column: 'status', op: 'in', value: ['active', 'pending'] }]);
    expect(rows.map(r => r.data.name).sort()).toEqual(['ana', 'beto', 'carla']);
  });

  it('combina filtros + orden desc + límite', async () => {
    const rows = await queryDataTableRows(
      tableId,
      [{ column: 'score', op: 'gte', value: 50 }],
      { sort: { column: 'score', dir: 'desc' }, limit: 2 }
    );
    expect(rows.map(r => r.data.name)).toEqual(['dora', 'beto']); // 90, 80 (carla 55 cae por límite)
  });
});
