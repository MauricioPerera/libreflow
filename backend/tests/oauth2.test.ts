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

import crypto from 'node:crypto';
import { resolveCredentialAuth } from '../src/registry.js';
import { clearOAuth2Cache, buildAuthorizationUrl, handleOAuthCallback, clearPendingAuth } from '../src/oauth2.js';

// Mock de fetch configurable por test.
let fetchMock: ReturnType<typeof vi.fn>;
function mockTokenResponse(body: any, ok = true, status = 200) {
  fetchMock = vi.fn(async () => ({
    ok, status,
    headers: { get: () => null }, // safeFetch comprueba 'location'; sin redirect
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
  (globalThis as any).fetch = fetchMock;
}

beforeEach(() => {
  clearOAuth2Cache();
  clearPendingAuth();
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

describe('OAuth2 authorization_code (flujo interactivo + PKCE)', () => {
  const acCred = () => ({
    id: 'ac', name: 'AC', type: 'oauth2', data: {
      grantType: 'authorization_code',
      authUrl: 'https://accounts.example.com/auth',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'cid', clientSecret: 'csec', scope: 'email profile',
      usePkce: true, offlineAccess: true,
    },
  });

  it('buildAuthorizationUrl arma todos los parámetros (PKCE S256 + offline)', () => {
    const url = new URL(buildAuthorizationUrl(acCred(), 'https://app.local/oauth/callback'));
    expect(url.origin + url.pathname).toBe('https://accounts.example.com/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.local/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('email profile');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
  });

  it('sin PKCE no incluye code_challenge', () => {
    const cred = acCred(); cred.data.usePkce = false;
    const url = new URL(buildAuthorizationUrl(cred, 'https://app.local/oauth/callback'));
    expect(url.searchParams.get('code_challenge')).toBeNull();
  });

  it('handleOAuthCallback intercambia el código, verifica PKCE y persiste tokens', async () => {
    creds['ac'] = acCred();
    const url = new URL(buildAuthorizationUrl(creds['ac'], 'https://app.local/oauth/callback'));
    const state = url.searchParams.get('state')!;
    const challenge = url.searchParams.get('code_challenge')!;
    mockTokenResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });

    const r = await handleOAuthCallback(state, 'AUTH_CODE');
    expect(r.credentialId).toBe('ac');

    // El cuerpo enviado al token endpoint usa grant_type=authorization_code + el code.
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('AUTH_CODE');
    expect(params.get('redirect_uri')).toBe('https://app.local/oauth/callback');

    // El code_verifier enviado corresponde al code_challenge publicado (PKCE correcto).
    const verifier = params.get('code_verifier')!;
    const recomputed = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(recomputed).toBe(challenge);

    // Tokens persistidos.
    const savedData = saveCredential.mock.calls.at(-1)![3];
    expect(savedData.accessToken).toBe('AT');
    expect(savedData.refreshToken).toBe('RT');
  });

  it('state es de un solo uso', async () => {
    creds['ac'] = acCred();
    const url = new URL(buildAuthorizationUrl(creds['ac'], 'https://app.local/oauth/callback'));
    const state = url.searchParams.get('state')!;
    mockTokenResponse({ access_token: 'AT', expires_in: 3600 });

    await handleOAuthCallback(state, 'CODE1');
    await expect(handleOAuthCallback(state, 'CODE2')).rejects.toThrow(/state/i);
  });

  it('state desconocido -> lanza', async () => {
    mockTokenResponse({ access_token: 'AT' });
    await expect(handleOAuthCallback('inexistente', 'CODE')).rejects.toThrow(/state/i);
  });

  it('renueva un credential authorization_code vía refresh_token', async () => {
    creds['ac'] = {
      id: 'ac', name: 'AC', type: 'oauth2', data: {
        grantType: 'authorization_code', tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid', clientSecret: 'csec', refreshToken: 'STORED_RT',
        accessToken: 'OLD', expiresAt: Date.now() - 1000, // expirado
      },
    };
    mockTokenResponse({ access_token: 'RENEWED', expires_in: 3600 });

    const { headers } = await resolveCredentialAuth('ac');
    expect(headers['Authorization']).toBe('Bearer RENEWED');
    const params = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('STORED_RT');
  });

  it('authorization_code expirado sin refresh token -> pide reconectar', async () => {
    creds['ac'] = {
      id: 'ac', name: 'AC', type: 'oauth2', data: {
        grantType: 'authorization_code', tokenUrl: 'https://auth.example.com/token',
        clientId: 'cid', clientSecret: 'csec',
        accessToken: 'OLD', expiresAt: Date.now() - 1000,
      },
    };
    mockTokenResponse({ access_token: 'x' });
    await expect(resolveCredentialAuth('ac')).rejects.toThrow(/conect/i);
  });
});
