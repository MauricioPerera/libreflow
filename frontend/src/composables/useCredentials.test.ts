import { describe, it, expect, vi, afterEach } from 'vitest';
import { useCredentials } from './useCredentials';

describe('useCredentials', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('arranca con lista vacía y la rellena tras fetchCredentials', async () => {
    const rows = [{ id: 'c1', name: 'Cred', type: 'apiKey' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => rows })));
    const { credentialsList, fetchCredentials } = useCredentials();
    expect(credentialsList.value).toEqual([]);
    await fetchCredentials();
    expect(credentialsList.value).toEqual(rows);
  });

  it('ante un error HTTP no rompe y deja la lista intacta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { credentialsList, fetchCredentials } = useCredentials();
    await fetchCredentials();
    expect(credentialsList.value).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
