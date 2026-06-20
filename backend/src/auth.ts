import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { verifyToken } from './jwt.js';
import { getUserByApiToken } from './db.js';

/** Usuario resuelto por requireAuth y adjuntado a la request (lo consume el enforcement F2). */
export interface AuthUser { id: string; email?: string; role: string }

/** Genera un token de API por-usuario (Bearer) para clientes MCP/agentes. */
export function generateApiToken(): string {
  return 'lf_' + crypto.randomBytes(24).toString('hex');
}

const API_KEY = process.env.LF_API_KEY;
const IS_PROD = process.env.NODE_ENV === 'production';

// Fail fast: in production an API key is mandatory.
if (IS_PROD && !API_KEY) {
  throw new Error('[Auth] LF_API_KEY must be set in production. Refusing to start without authentication.');
}
if (!API_KEY) {
  console.warn('[Auth] WARNING: LF_API_KEY is not set. API authentication is DISABLED (dev mode only).');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Constant-time string comparison, exported for per-resource token checks (e.g. MCP servers). */
export function constantTimeEqual(a: string, b: string): boolean {
  return safeEqual(a, b);
}

/**
 * Express middleware enforcing an API key on protected routes.
 * Accepts the key via `x-api-key` header or `Authorization: Bearer <key>`.
 * When LF_API_KEY is unset (dev only) the guard is a no-op.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const headerKey = req.header('x-api-key');
    const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '');

    if (bearer) {
      // 1) JWT de usuario (multi-usuario): si verifica, adjunta el usuario y pasa.
      const payload = verifyToken(bearer);
      if (payload && payload.sub) {
        (req as any).user = { id: payload.sub, email: payload.email, role: payload.role || 'user' } as AuthUser;
        return next();
      }
      // 2) Token de API por-usuario (Bearer lf_...): resuelve al usuario dueño del token.
      const tokenUser = await getUserByApiToken(bearer);
      if (tokenUser) {
        (req as any).user = { id: tokenUser.id, email: tokenUser.email, role: tokenUser.role } as AuthUser;
        return next();
      }
    }

    // 3) Dev sin API key: auth deshabilitada → admin implícito.
    if (!API_KEY) {
      (req as any).user = { id: 'dev', role: 'admin' } as AuthUser;
      return next();
    }

    // 4) API key global = admin break-glass (compatibilidad hacia atrás).
    const provided = headerKey || bearer;
    if (provided && safeEqual(provided, API_KEY)) {
      (req as any).user = { id: 'apikey-admin', role: 'admin' } as AuthUser;
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    return res.status(500).json({ error: 'Auth error' });
  }
}

const WEBHOOK_SECRET = process.env.LF_WEBHOOK_SECRET;
if (IS_PROD && !WEBHOOK_SECRET) {
  throw new Error('[Auth] LF_WEBHOOK_SECRET must be set in production to verify webhook signatures.');
}

/**
 * Verifies an inbound webhook HMAC signature (`x-libreflow-signature: sha256=<hex>`)
 * over the raw request body. When LF_WEBHOOK_SECRET is unset (dev only) it allows the request.
 * Returns true if the request may proceed.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true; // dev: signature checking disabled

  if (!signatureHeader) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody ?? Buffer.alloc(0)).digest('hex');
  return safeEqual(signatureHeader, expected);
}
