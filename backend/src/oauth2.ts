import crypto from 'node:crypto';
import { assertSafeUrl } from './security.js';
import { saveCredential, getCredentialById } from './db.js';

/**
 * OAuth2 para credenciales de tipo `oauth2`. Soporta tres grants:
 *  - `client_credentials` — machine-to-machine.
 *  - `refresh_token` — intercambia un refresh token por un access token.
 *  - `authorization_code` — flujo interactivo (navegador + consentimiento) con PKCE; la
 *    adquisición inicial pasa por buildAuthorizationUrl/handleOAuthCallback, y la renovación
 *    posterior reutiliza el refresh token (misma fontanería que `refresh_token`).
 *
 * El access token se cachea en memoria y se persiste en la credencial cifrada (sobrevive a
 * reinicios). Las peticiones de token concurrentes para la misma credencial se deduplican.
 */

interface TokenEntry { accessToken: string; expiresAt: number; }

const memCache = new Map<string, TokenEntry>();
const inflight = new Map<string, Promise<string>>();

// Margen de seguridad: renueva el token este tiempo ANTES de que expire de verdad, para
// que no caduque en mitad de una petición ya en vuelo.
const SKEW_MS = 60_000;
// TTL por defecto si el servidor no devuelve `expires_in`.
const DEFAULT_TTL_S = 3600;

/**
 * Devuelve un access token válido para la credencial OAuth2 dada (la `cred` ya cargada y
 * descifrada por getCredentialById). Lanza si no se puede obtener.
 */
export async function getOAuth2AccessToken(cred: any): Promise<string> {
  const id: string = cred.id;
  const now = Date.now();

  const mem = memCache.get(id);
  if (mem && mem.expiresAt - SKEW_MS > now) return mem.accessToken;

  // Caché persistida en la credencial (sobrevive a reinicios del proceso).
  const d = cred.data || {};
  if (d.accessToken && typeof d.expiresAt === 'number' && d.expiresAt - SKEW_MS > now) {
    memCache.set(id, { accessToken: d.accessToken, expiresAt: d.expiresAt });
    return d.accessToken;
  }

  // Deduplica fetches concurrentes para la misma credencial.
  let p = inflight.get(id);
  if (!p) {
    p = fetchToken(cred).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

async function fetchToken(cred: any): Promise<string> {
  const d = cred.data || {};
  // Grant de RENOVACIÓN (distinto del de adquisición inicial): client_credentials se renueva
  // igual; refresh_token y authorization_code se renuevan ambos vía refresh_token.
  const renewGrant = d.grantType === 'client_credentials' ? 'client_credentials' : 'refresh_token';

  const tokenUrl = String(d.tokenUrl || '').trim();
  if (!tokenUrl) throw new Error('La credencial OAuth2 no tiene tokenUrl.');
  await assertSafeUrl(tokenUrl); // SSRF guard (bloquea IPs privadas en producción).

  const body = new URLSearchParams();
  body.set('grant_type', renewGrant);
  if (d.scope) body.set('scope', String(d.scope));
  if (renewGrant === 'refresh_token') {
    if (!d.refreshToken) {
      throw new Error(d.grantType === 'authorization_code'
        ? 'La credencial OAuth2 no está conectada o su sesión expiró. Vuelve a conectarla.'
        : 'El grant refresh_token requiere un refreshToken.');
    }
    body.set('refresh_token', String(d.refreshToken));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };
  const clientId = String(d.clientId || '');
  const clientSecret = String(d.clientSecret || '');
  // Autenticación del cliente: por defecto HTTP Basic (recomendado por RFC 6749);
  // opcionalmente en el cuerpo si el servidor lo exige.
  if (d.clientAuth === 'body') {
    if (clientId) body.set('client_id', clientId);
    if (clientSecret) body.set('client_secret', clientSecret);
  } else if (clientId) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  let res: Response;
  try {
    res = await fetch(tokenUrl, { method: 'POST', headers, body: body.toString() });
  } catch (err: any) {
    throw new Error(`Error de red pidiendo el token OAuth2: ${err?.message || String(err)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`La petición de token OAuth2 falló (${res.status}): ${text.slice(0, 200)}`);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('La respuesta del token OAuth2 no es JSON.');
  }

  const accessToken = json.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('La respuesta del token OAuth2 no contiene access_token.');
  }
  const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : DEFAULT_TTL_S;
  const expiresAt = Date.now() + expiresIn * 1000;

  memCache.set(cred.id, { accessToken, expiresAt });

  // Persiste la caché (y el refresh token rotado) en la credencial cifrada. Best-effort:
  // si falla, el token igualmente sirve para esta ejecución.
  try {
    const newData = { ...d, accessToken, expiresAt };
    if (json.refresh_token) newData.refreshToken = json.refresh_token;
    await saveCredential(cred.id, cred.name, cred.type, newData);
  } catch (err: any) {
    console.warn(`[OAuth2] No se pudo persistir la caché del token: ${err?.message || err}`);
  }

  return accessToken;
}

/** Limpia la caché en memoria (uso en tests). */
export function clearOAuth2Cache(): void {
  memCache.clear();
  inflight.clear();
}

// ---------------------------------------------------------------------------
// Flujo interactivo authorization_code (+ PKCE)
// ---------------------------------------------------------------------------

interface PendingAuth {
  credentialId: string;
  codeVerifier?: string;
  redirectUri: string;
  exp: number;
}

// state -> autorización pendiente. En memoria (mono-proceso): si el server reinicia a mitad
// del consentimiento, el `state` se pierde y el usuario reintenta. TTL corto + uso único.
const pendingAuth = new Map<string, PendingAuth>();
const STATE_TTL_MS = 10 * 60 * 1000;

function prunePending(): void {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (v.exp < now) pendingAuth.delete(k);
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const genState = () => b64url(crypto.randomBytes(24));
const genVerifier = () => b64url(crypto.randomBytes(32)); // 43 chars (RFC 7636)
const challengeOf = (verifier: string) => b64url(crypto.createHash('sha256').update(verifier).digest());

/**
 * Construye la URL de autorización del proveedor (con `state` y, por defecto, PKCE S256) y
 * registra el `state` pendiente. Devuelve la URL a la que abrir el navegador del usuario.
 */
export function buildAuthorizationUrl(cred: any, redirectUri: string): string {
  prunePending();
  const d = cred.data || {};
  const authUrl = String(d.authUrl || '').trim();
  if (!authUrl) throw new Error('La credencial OAuth2 (authorization_code) no tiene authUrl.');

  const state = genState();
  const usePkce = d.usePkce !== false;
  const codeVerifier = usePkce ? genVerifier() : undefined;
  pendingAuth.set(state, { credentialId: cred.id, codeVerifier, redirectUri, exp: Date.now() + STATE_TTL_MS });

  const u = new URL(authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', String(d.clientId || ''));
  u.searchParams.set('redirect_uri', redirectUri);
  if (d.scope) u.searchParams.set('scope', String(d.scope));
  u.searchParams.set('state', state);
  if (usePkce && codeVerifier) {
    u.searchParams.set('code_challenge', challengeOf(codeVerifier));
    u.searchParams.set('code_challenge_method', 'S256');
  }
  // access_type=offline + prompt=consent hacen que proveedores como Google devuelvan un
  // refresh token (necesario para renovar sin re-consentir). Activado por defecto.
  if (d.offlineAccess !== false) {
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
  }
  return u.toString();
}

/**
 * Procesa el callback del proveedor: valida el `state` (uso único), intercambia el `code` por
 * tokens y los persiste en la credencial. Devuelve datos mínimos de la credencial conectada.
 */
export async function handleOAuthCallback(state: string, code: string): Promise<{ credentialId: string; credentialName: string }> {
  prunePending();
  const pending = pendingAuth.get(state);
  if (!pending) throw new Error('State de OAuth desconocido o expirado.');
  pendingAuth.delete(state); // uso único (anti-CSRF / anti-replay)

  const cred = await getCredentialById(pending.credentialId);
  if (!cred || cred.type !== 'oauth2') throw new Error('Credencial OAuth2 no encontrada.');

  await exchangeCodeForToken(cred, code, pending.codeVerifier, pending.redirectUri);
  return { credentialId: cred.id, credentialName: cred.name };
}

/** Intercambia un authorization code por tokens y los persiste en la credencial cifrada. */
async function exchangeCodeForToken(cred: any, code: string, codeVerifier: string | undefined, redirectUri: string): Promise<void> {
  const d = cred.data || {};
  const tokenUrl = String(d.tokenUrl || '').trim();
  if (!tokenUrl) throw new Error('La credencial OAuth2 no tiene tokenUrl.');
  await assertSafeUrl(tokenUrl);

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  if (codeVerifier) body.set('code_verifier', codeVerifier);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };
  const clientId = String(d.clientId || '');
  const clientSecret = String(d.clientSecret || '');
  if (d.clientAuth === 'body') {
    if (clientId) body.set('client_id', clientId);
    if (clientSecret) body.set('client_secret', clientSecret);
  } else if (clientId) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  let res: Response;
  try {
    res = await fetch(tokenUrl, { method: 'POST', headers, body: body.toString() });
  } catch (err: any) {
    throw new Error(`Error de red intercambiando el código OAuth2: ${err?.message || String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`El intercambio de código OAuth2 falló (${res.status}): ${text.slice(0, 200)}`);

  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error('La respuesta del token OAuth2 no es JSON.'); }
  const accessToken = json.access_token;
  if (!accessToken || typeof accessToken !== 'string') throw new Error('La respuesta del token OAuth2 no contiene access_token.');

  const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : DEFAULT_TTL_S;
  const expiresAt = Date.now() + expiresIn * 1000;

  memCache.set(cred.id, { accessToken, expiresAt });

  const newData = { ...d, accessToken, expiresAt };
  if (json.refresh_token) newData.refreshToken = json.refresh_token;
  await saveCredential(cred.id, cred.name, cred.type, newData);
}

/** Limpia los states pendientes (uso en tests). */
export function clearPendingAuth(): void {
  pendingAuth.clear();
}
