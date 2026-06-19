import { describe, it, expect, vi, afterEach } from 'vitest';
import { useDataTables } from './useDataTables';

describe('useDataTables', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rellena la lista tras fetchDataTables', async () => {
    const tables = [{ id: 't1', name: 'Clientes' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => tables })));
    const { dataTablesList, fetchDataTables } = useDataTables();
    expect(dataTablesList.value).toEqual([]);
    await fetchDataTables();
    expect(dataTablesList.value).toEqual(tables);
  });

  it('ante error HTTP no rompe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dataTablesList, fetchDataTables } = useDataTables();
    await fetchDataTables();
    expect(dataTablesList.value).toEqual([]);
    errSpy.mockRestore();
  });
});
