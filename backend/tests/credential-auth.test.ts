import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db.js', () => ({
  getCredentialById: async (id: string) => {
    if (id === 'basic') return { id, type: 'basicAuth', data: { user: 'u', password: 'p' } };
    if (id === 'key-header') return { id, type: 'apiKey', data: { name: 'X-Api-Key', value: 'secret', in: 'header' } };
    if (id === 'key-query') return { id, type: 'apiKey', data: { name: 'api_key', value: 'secret', in: 'query' } };
    return null;
  },
}));

import { resolveCredentialAuth } from '../src/registry.js';

describe('resolveCredentialAuth (shared node auth helper)', () => {
  it('sin credencial -> vacío', async () => {
    expect(await resolveCredentialAuth()).toEqual({ headers: {}, query: {} });
  });

  it('basicAuth -> Authorization: Basic', async () => {
    const { headers, query } = await resolveCredentialAuth('basic');
    expect(headers['Authorization']).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
    expect(query).toEqual({});
  });

  it('apiKey en header', async () => {
    const { headers, query } = await resolveCredentialAuth('key-header');
    expect(headers).toEqual({ 'X-Api-Key': 'secret' });
    expect(query).toEqual({});
  });

  it('apiKey en query', async () => {
    const { headers, query } = await resolveCredentialAuth('key-query');
    expect(headers).toEqual({});
    expect(query).toEqual({ api_key: 'secret' });
  });

  it('credencial inexistente -> vacío', async () => {
    expect(await resolveCredentialAuth('nope')).toEqual({ headers: {}, query: {} });
  });
});
