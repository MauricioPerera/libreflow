import { assertSafeUrl } from './security.js';
import { saveCredential } from './db.js';

/**
 * OAuth2 (server-to-server) token acquisition for credentials of type `oauth2`.
 *
 * Soporta los dos grants headless:
 *  - `client_credentials` — machine-to-machine.
 *  - `refresh_token` — intercambia un refresh token por un access token (y rota el refresh
 *    si el servidor devuelve uno nuevo).
 *
 * NO implementa `authorization_code` (flujo interactivo con redirect/consentimiento del
 * navegador): eso requiere un endpoint de callback y queda fuera de esta primitiva.
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
  const grantType = d.grantType === 'refresh_token' ? 'refresh_token' : 'client_credentials';

  const tokenUrl = String(d.tokenUrl || '').trim();
  if (!tokenUrl) throw new Error('La credencial OAuth2 no tiene tokenUrl.');
  await assertSafeUrl(tokenUrl); // SSRF guard (bloquea IPs privadas en producción).

  const body = new URLSearchParams();
  body.set('grant_type', grantType);
  if (d.scope) body.set('scope', String(d.scope));
  if (grantType === 'refresh_token') {
    if (!d.refreshToken) throw new Error('El grant refresh_token requiere un refreshToken.');
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
