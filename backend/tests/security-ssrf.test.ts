import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Forzamos modo "bloquear privadas" ANTES de importar security (ALLOW_PRIVATE se evalúa al
// cargar el módulo). Usamos IPs literales para que dns.lookup no haga red (las resuelve sola).
process.env.LF_ALLOW_PRIVATE_URLS = 'false';
let safeFetch: (url: string, init?: any, opts?: any) => Promise<any>;

const redirectTo = (loc: string) => ({
  status: 302,
  headers: { get: (n: string) => (n.toLowerCase() === 'location' ? loc : null) },
  arrayBuffer: async () => new ArrayBuffer(0),
});
const ok = () => ({ status: 200, headers: { get: () => null } });

const realFetch = globalThis.fetch;

beforeEach(async () => {
  ({ safeFetch } = await import('../src/security.js'));
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('safeFetch (SSRF redirect guard)', () => {
  it('bloquea un redirect a una dirección privada/metadata', async () => {
    globalThis.fetch = vi.fn(async () => redirectTo('http://127.0.0.1:9/meta')) as any;
    await expect(safeFetch('http://8.8.8.8/')).rejects.toThrow(/private|link-local|Blocked/i);
  });

  it('bloquea un redirect a 169.254.169.254 (metadata cloud)', async () => {
    globalThis.fetch = vi.fn(async () => redirectTo('http://169.254.169.254/latest/meta-data/')) as any;
    await expect(safeFetch('http://8.8.8.8/')).rejects.toThrow(/private|link-local|Blocked/i);
  });

  it('sigue un redirect a un destino público y devuelve la respuesta final', async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => (n++ === 0 ? redirectTo('http://8.8.4.4/next') : ok())) as any;
    const res = await safeFetch('http://8.8.8.8/');
    expect(res.status).toBe(200);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(2);
  });

  it('corta cadenas de redirect demasiado largas', async () => {
    globalThis.fetch = vi.fn(async () => redirectTo('http://8.8.4.4/loop')) as any;
    await expect(safeFetch('http://8.8.8.8/')).rejects.toThrow(/redirect/i);
  });

  it('usa redirect:manual (no deja que fetch siga los redirects sin validar)', async () => {
    globalThis.fetch = vi.fn(async () => ok()) as any;
    await safeFetch('http://8.8.8.8/', { method: 'POST' });
    expect((globalThis.fetch as any).mock.calls[0][1].redirect).toBe('manual');
  });
});
