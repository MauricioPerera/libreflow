import crypto from 'node:crypto';

/**
 * JWT HS256 propio (sin dependencias), coherente con la cripto del resto del repo. Firma y
 * verifica tokens de sesión: header.payload.signature en base64url, HMAC-SHA256, verificación
 * en tiempo constante y chequeo de `exp`. Stateless: el logout es descartar el token en el
 * cliente (sin lista de revocación; por eso la expiración es acotada).
 */

const IS_PROD = process.env.NODE_ENV === 'production';
let warned = false;

/** Secreto de firma. En producción es obligatorio; en dev cae a un valor inseguro con aviso. */
function secret(): string {
  const s = process.env.LF_JWT_SECRET;
  if (s) return s;
  if (IS_PROD) throw new Error('[JWT] LF_JWT_SECRET debe estar definido en producción para usar auth con JWT.');
  if (!warned) { console.warn('[JWT] WARNING: LF_JWT_SECRET no está definido. Usando un secreto de desarrollo (inseguro).'); warned = true; }
  return 'dev-insecure-jwt-secret';
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj: any): string => b64url(Buffer.from(JSON.stringify(obj)));
const fromB64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface JwtPayload {
  sub: string;
  email?: string;
  role?: string;
  iat?: number;
  exp?: number;
  [k: string]: any;
}

/** Firma un payload. `expiresInSec` por defecto 8h. */
export function signToken(payload: Record<string, any>, expiresInSec = 8 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const data = b64urlJson({ alg: 'HS256', typ: 'JWT' }) + '.' + b64urlJson(body);
  const sig = b64url(crypto.createHmac('sha256', secret()).update(data).digest());
  return data + '.' + sig;
}

/** Verifica un token: firma (constant-time) + expiración. Devuelve el payload o null. */
export function verifyToken(token: string): JwtPayload | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(`${h}.${p}`).digest());
  const sb = Buffer.from(s);
  const eb = Buffer.from(expected);
  if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
  let payload: JwtPayload;
  try {
    payload = JSON.parse(fromB64url(p).toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}
