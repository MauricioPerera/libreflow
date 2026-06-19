import { describe, it, expect, vi, afterEach } from 'vitest';
import { useMcpServers } from './useMcpServers';

describe('useMcpServers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rellena la lista tras fetchMcpServers', async () => {
    const servers = [{ id: 's1', name: 'Ventas' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => servers })));
    const { mcpServersList, fetchMcpServers } = useMcpServers();
    expect(mcpServersList.value).toEqual([]);
    await fetchMcpServers();
    expect(mcpServersList.value).toEqual(servers);
  });

  it('ante error HTTP no rompe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { mcpServersList, fetchMcpServers } = useMcpServers();
    await fetchMcpServers();
    expect(mcpServersList.value).toEqual([]);
    errSpy.mockRestore();
  });
});
