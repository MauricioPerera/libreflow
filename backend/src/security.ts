import dns from 'dns/promises';
import net from 'net';
import type { Request, Response, NextFunction } from 'express';

const IS_PROD = process.env.NODE_ENV === 'production';
// In production, private/loopback targets are blocked by default to prevent SSRF.
// In dev they are allowed so the bundled local MCP server (localhost) keeps working.
// Override explicitly with LF_ALLOW_PRIVATE_URLS=true|false.
const ALLOW_PRIVATE =
  process.env.LF_ALLOW_PRIVATE_URLS != null
    ? process.env.LF_ALLOW_PRIVATE_URLS === 'true'
    : !IS_PROD;

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** True if the property key is unsafe to write/traverse (prototype-pollution vector). */
export function isUnsafeKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Minimal dependency-free fixed-window rate limiter keyed by client IP.
 * Defaults: 300 requests / 60s. Tune via the args.
 */
export function rateLimit(opts: { windowMs?: number; max?: number } = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 300;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

/**
 * Rejects dangerously frequent cron expressions (6-field "per-second" crons),
 * unless explicitly allowed via LF_ALLOW_FAST_CRON=true. Returns an error string
 * if the expression should be rejected, or null if acceptable.
 */
export function cronTooFrequent(expr: string): string | null {
  if (process.env.LF_ALLOW_FAST_CRON === 'true') return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length >= 6) {
    const seconds = fields[0];
    if (seconds === '*' || /^\*\/\d+$/.test(seconds) || seconds.includes(',') || seconds.includes('-')) {
      return 'Per-second cron schedules are disabled. Set LF_ALLOW_FAST_CRON=true to allow.';
    }
  }
  return null;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    return false;
  }
  // IPv6: loopback, unique-local (fc00::/7), link-local (fe80::/10), and v4-mapped
  const addr = address.toLowerCase();
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) return true;
  if (addr.startsWith('::ffff:')) return isPrivateAddress(addr.slice(7));
  return false;
}

/**
 * Validates a user-supplied URL before the server makes an outbound request,
 * defending against SSRF. Resolves the hostname and rejects private/link-local
 * targets (unless explicitly allowed). Only http/https are permitted.
 * Returns the validated URL string.
 */
export async function assertSafeUrl(raw: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme "${u.protocol}". Only http and https are allowed.`);
  }

  if (ALLOW_PRIVATE) return u.toString();

  // Resolve all addresses and reject if any is private (defends against DNS rebinding).
  let records: { address: string }[];
  try {
    records = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${u.hostname}`);
  }
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new Error(`Blocked request to private/link-local address (${r.address}) for host ${u.hostname}.`);
    }
  }
  return u.toString();
}
