import { describe, it, expect, vi, afterEach } from 'vitest';
import { useVectorStores } from './useVectorStores';

describe('useVectorStores', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rellena la lista tras fetch', async () => {
    const cols = [{ collection: 'kb', files: 2, updated_at: '2026-01-01' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => cols })));
    const { vectorStoresList, fetchVectorStores } = useVectorStores();
    expect(vectorStoresList.value).toEqual([]);
    await fetchVectorStores();
    expect(vectorStoresList.value).toEqual(cols);
  });

  it('ante error HTTP no rompe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { vectorStoresList, fetchVectorStores } = useVectorStores();
    await fetchVectorStores();
    expect(vectorStoresList.value).toEqual([]);
    errSpy.mockRestore();
  });
});
