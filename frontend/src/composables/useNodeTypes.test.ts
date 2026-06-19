import { describe, it, expect, vi, afterEach } from 'vitest';
import { useNodeTypes } from './useNodeTypes';

describe('useNodeTypes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rellena el catálogo tras fetchNodeTypes', async () => {
    const types = [{ type: 'trigger' }, { type: 'httpRequest' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => types })));
    const { nodeTypesList, fetchNodeTypes } = useNodeTypes();
    expect(nodeTypesList.value).toEqual([]);
    await fetchNodeTypes();
    expect(nodeTypesList.value).toEqual(types);
  });

  it('ante error HTTP no rompe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { nodeTypesList, fetchNodeTypes } = useNodeTypes();
    await fetchNodeTypes();
    expect(nodeTypesList.value).toEqual([]);
    errSpy.mockRestore();
  });
});
