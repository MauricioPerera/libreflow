import { describe, it, expect, vi, beforeEach } from 'vitest';

// Credenciales OAuth2 de prueba + spy sobre saveCredential (persistencia de la caché).
// vi.hoisted: la factoría de vi.mock se eleva al inicio del archivo, así que estas vars
// deben crearse también de forma elevada para estar disponibles dentro del mock.
const { creds, saveCredential } = vi.hoisted(() => {
  const creds: Record<string, any> = {};
  const saveCredential = vi.fn(async (id: string, name: string, type: string, data: any) => {
    creds[id] = { id, name, type, data };
  });
  return { creds, saveCredential };
});

vi.mock('../src/db.js', () => ({
  getCredentialById: async (id: string) => creds[id] || null,
  saveCredential,
}));

import { resolveCredentialAuth } from '../src/registry.js';
import { clearOAuth2Cache } from '../src/oauth2.js';

// Mock de fetch configurable por test.
let fetchMock: ReturnType<typeof vi.fn>;
function mockTokenResponse(body: any, ok = true, status = 200) {
  fetchMock = vi.fn(async () => ({
    ok, status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
  (globalThis as any).fetch = fetchMock;
}

beforeEach(() => {
  clearOAuth2Cache();
  for (const k of Object.keys(creds)) delete creds[k];
  saveCredential.mockClear();
});

describe('OAuth2 credential (resolveCredentialAuth)', () => {
  it('client_credentials -> Authorization: Bearer + Basic al token endpoint', async () => {
    creds['cc'] = { id: 'cc', name: 'CC', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid', clientSecret: 'csec', scope: 'read write',
    } };
    mockTokenResponse({ access_token: 'AT1', expires_in: 3600 });

    const { headers } = await resolveCredentialAuth('cc');
    expect(headers['Authorization']).toBe('Bearer AT1');

    // Verifica cómo se pidió el token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.example.com/token');
    expect(opts.headers['Authorization']).toBe('Basic ' + Buffer.from('cid:csec').toString('base64'));
    const params = new URLSearchParams(opts.body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe('read write');
  });

  it('cachea el token: la 2ª llamada no vuelve a pedirlo', async () => {
    creds['cc'] = { id: 'cc', name: 'CC', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'csec',
    } };
    mockTokenResponse({ access_token: 'AT1', expires_in: 3600 });

    const a = await resolveCredentialAuth('cc');
    const b = await resolveCredentialAuth('cc');
    expect(a.headers['Authorization']).toBe('Bearer AT1');
    expect(b.headers['Authorization']).toBe('Bearer AT1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persiste la caché del token (saveCredential)', async () => {
    creds['cc'] = { id: 'cc', name: 'CC', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'csec',
    } };
    mockTokenResponse({ access_token: 'AT1', expires_in: 3600 });

    await resolveCredentialAuth('cc');
    expect(saveCredential).toHaveBeenCalledTimes(1);
    const savedData = saveCredential.mock.calls[0][3];
    expect(savedData.accessToken).toBe('AT1');
    expect(typeof savedData.expiresAt).toBe('number');
  });

  it('usa el token persistido válido sin pedir uno nuevo', async () => {
    creds['cc'] = { id: 'cc', name: 'CC', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'csec',
      accessToken: 'PERSISTED', expiresAt: Date.now() + 1_000_000,
    } };
    mockTokenResponse({ access_token: 'NEW', expires_in: 3600 });

    const { headers } = await resolveCredentialAuth('cc');
    expect(headers['Authorization']).toBe('Bearer PERSISTED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetcha cuando el token persistido ya expiró', async () => {
    creds['cc'] = { id: 'cc', name: 'CC', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'csec',
      accessToken: 'OLD', expiresAt: Date.now() - 1000,
    } };
    mockTokenResponse({ access_token: 'FRESH', expires_in: 3600 });

    const { headers } = await resolveCredentialAuth('cc');
    expect(headers['Authorization']).toBe('Bearer FRESH');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refresh_token: envía el grant correcto y rota el refresh token', async () => {
    creds['rt'] = { id: 'rt', name: 'RT', type: 'oauth2', data: {
      grantType: 'refresh_token', tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid', clientSecret: 'csec', refreshToken: 'OLD_RT',
    } };
    mockTokenResponse({ access_token: 'AT2', expires_in: 3600, refresh_token: 'NEW_RT' });

    const { headers } = await resolveCredentialAuth('rt');
    expect(headers['Authorization']).toBe('Bearer AT2');

    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('OLD_RT');

    // El refresh token rotado se persiste.
    const savedData = saveCredential.mock.calls[0][3];
    expect(savedData.refreshToken).toBe('NEW_RT');
  });

  it('clientAuth=body -> client_id/client_secret en el cuerpo, sin cabecera Basic', async () => {
    creds['cb'] = { id: 'cb', name: 'CB', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid', clientSecret: 'csec', clientAuth: 'body',
    } };
    mockTokenResponse({ access_token: 'AT3', expires_in: 3600 });

    await resolveCredentialAuth('cb');
    const opts = fetchMock.mock.calls[0][1];
    expect(opts.headers['Authorization']).toBeUndefined();
    const params = new URLSearchParams(opts.body);
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('client_secret')).toBe('csec');
  });

  it('error del token endpoint -> lanza', async () => {
    creds['err'] = { id: 'err', name: 'E', type: 'oauth2', data: {
      grantType: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'csec',
    } };
    mockTokenResponse('invalid_client', false, 401);

    await expect(resolveCredentialAuth('err')).rejects.toThrow(/401/);
  });

  it('refresh_token sin refreshToken -> lanza', async () => {
    creds['bad'] = { id: 'bad', name: 'B', type: 'oauth2', data: {
      grantType: 'refresh_token', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'csec',
    } };
    mockTokenResponse({ access_token: 'x' });

    await expect(resolveCredentialAuth('bad')).rejects.toThrow(/refresh_token/i);
  });
});
