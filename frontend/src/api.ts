// Helper central de GET: verifica res.ok para que un 4xx/5xx nunca se parsee como dato válido.
// (El Authorization: Bearer lo inyecta installFetchAuth en auth.ts; aquí no se duplica.)
export const apiGetJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${url}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
};
