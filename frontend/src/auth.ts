// Sesión de usuario en el frontend: token JWT en localStorage + interceptor global de fetch
// que añade `Authorization: Bearer` a las llamadas a la API y reacciona a un 401 (sesión
// caducada). Centralizar aquí evita tener que tocar las decenas de `fetch('/api/...')` de App.vue.

const TOKEN_KEY = 'lf_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Bus de eventos para que App.vue reaccione a un 401 (vuelve a la pantalla de login).
export const authEvents = new EventTarget();

/** ¿La URL es una llamada a la API protegida (misma-origen)? */
function isApiUrl(url: string): boolean {
  return url.startsWith('/api') || url.startsWith('api/');
}

/**
 * Envuelve `window.fetch` una sola vez: inyecta el Bearer en las llamadas a /api y, ante un
 * 401, descarta el token y emite `unauthorized`. La ruta de login se excluye del manejo de 401
 * (un 401 ahí significa "credenciales incorrectas", no "sesión caducada").
 */
export function installFetchAuth(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const api = isApiUrl(url);
    const isLogin = url.includes('/api/auth/login');
    const token = getToken();

    if (api && token) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      init = { ...init, headers };
    }

    const res = await original(input as any, init);

    if (api && !isLogin && res.status === 401) {
      clearToken();
      authEvents.dispatchEvent(new Event('unauthorized'));
    }
    return res;
  };
}
