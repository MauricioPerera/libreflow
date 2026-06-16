import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CredentialModal from './CredentialModal.vue';

// Mock de fetch por URL (redirect-uri en init, POST al guardar, GET al editar).
let posted: any[] = [];
function installFetch(creds: Record<string, any> = {}) {
  posted = [];
  (globalThis as any).fetch = vi.fn(async (url: string, opts: any = {}) => {
    if (url === '/api/oauth/redirect-uri') return { ok: true, json: async () => ({ redirectUri: 'http://app/oauth/callback' }) };
    if (url === '/api/credentials' && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ success: true }) }; }
    if (url.includes('/oauth/authorize') && opts.method === 'POST') return { ok: true, json: async () => ({ url: 'http://provider/auth' }) };
    if (url.startsWith('/api/credentials/') && (!opts.method || opts.method === 'GET')) {
      const id = url.split('/').pop()!;
      return { ok: true, json: async () => creds[id] };
    }
    return { ok: false, json: async () => ({}) };
  });
}

const mountModal = (props: any) =>
  mount(CredentialModal, { props, global: { directives: { 'focus-trap': {} } } });

beforeEach(() => installFetch());

describe('CredentialModal', () => {
  it('modo crear: título y campos de basicAuth por defecto', async () => {
    const w = mountModal({ editId: null });
    await flushPromises();
    expect(w.text()).toContain('Crear Credencial');
    expect(w.text()).toContain('USUARIO');
  });

  it('cambia los campos según el tipo de conexión', async () => {
    const w = mountModal({ editId: null });
    await flushPromises();
    const typeSelect = w.find('select');
    await typeSelect.setValue('apiKey');
    expect(w.text()).toContain('NOMBRE DEL PARÁMETRO / CABECERA');
    await typeSelect.setValue('oauth2');
    expect(w.text()).toContain('TIPO DE GRANT');
  });

  it('Guardar deshabilitado hasta completar (basicAuth)', async () => {
    const w = mountModal({ editId: null });
    await flushPromises();
    const guardar = () => w.findAll('button').find((b) => b.text() === 'Guardar')!;
    expect(guardar().attributes('disabled')).toBeDefined();
    await w.findAll('input').find((i) => i.attributes('placeholder')?.includes('Mi API'))!.setValue('Cred');
    const inputs = w.findAll('input');
    await inputs.find((i) => i.attributes('placeholder')?.includes('usuario'))!.setValue('u');
    await inputs.find((i) => i.attributes('placeholder')?.includes('Contraseña'))!.setValue('p');
    expect(guardar().attributes('disabled')).toBeUndefined();
  });

  it('guardar basicAuth: POST con el payload y emite saved + close', async () => {
    const w = mountModal({ editId: null });
    await flushPromises();
    await w.findAll('input').find((i) => i.attributes('placeholder')?.includes('Mi API'))!.setValue('Cred');
    const inputs = w.findAll('input');
    await inputs.find((i) => i.attributes('placeholder')?.includes('usuario'))!.setValue('u');
    await inputs.find((i) => i.attributes('placeholder')?.includes('Contraseña'))!.setValue('p');
    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    await flushPromises();
    expect(posted[0]).toMatchObject({ name: 'Cred', type: 'basicAuth', data: { user: 'u', password: 'p' } });
    expect(w.emitted('saved')).toBeTruthy();
    expect(w.emitted('close')).toBeTruthy();
  });

  it('oauth2 authorization_code: al guardar queda abierto (sin close) y aparece Conectar', async () => {
    const w = mountModal({ editId: null });
    await flushPromises();
    await w.find('select').setValue('oauth2');
    // grant = authorization_code (segundo select del bloque oauth)
    await w.findAll('select').find((s) => s.text().includes('Authorization Code'))!.setValue('authorization_code');
    await w.findAll('input').find((i) => i.attributes('placeholder')?.includes('Mi API'))!.setValue('OAuthCred');
    const inputs = w.findAll('input');
    await inputs.find((i) => i.attributes('placeholder')?.includes('accounts.ejemplo'))!.setValue('https://a/auth');
    await inputs.find((i) => i.attributes('placeholder')?.includes('auth.ejemplo'))!.setValue('https://a/token');
    await inputs.find((i) => i.attributes('placeholder')?.includes('ID de cliente'))!.setValue('cid');
    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    await flushPromises();
    expect(posted[0]).toMatchObject({ type: 'oauth2', data: { grantType: 'authorization_code', authUrl: 'https://a/auth' } });
    expect(w.emitted('saved')).toBeTruthy();
    expect(w.emitted('close')).toBeFalsy();           // se queda abierto
    expect(w.text()).toContain('Conectar');           // botón de conexión visible
  });

  it('modo editar: carga metadatos del backend', async () => {
    installFetch({ c1: { id: 'c1', name: 'Slack', type: 'apiKey', data: {} } });
    const w = mountModal({ editId: 'c1' });
    await flushPromises();
    expect(w.text()).toContain('Editar Credencial');
    expect((w.find('input').element as HTMLInputElement).value).toBe('Slack');
  });

  it('OAuth postMessage: ignora origen ajeno, acepta el del callback', async () => {
    installFetch({ ac: { id: 'ac', name: 'AC', type: 'oauth2', connected: false, data: { grantType: 'authorization_code', authUrl: 'https://a/auth', tokenUrl: 'https://a/token', clientId: 'cid' } } });
    (window as any).open = vi.fn(() => ({}));
    const w = mountModal({ editId: 'ac' });
    await flushPromises();
    await w.findAll('button').find((b) => b.text().includes('Conectar'))!.trigger('click');
    await flushPromises();

    // Mensaje de un origen ajeno -> ignorado (anti-spoofing).
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'libreflow-oauth', ok: true }, origin: 'http://evil.example' }));
    await flushPromises();
    expect(w.text()).not.toContain('Conectada');

    // Mensaje del origen del callback (redirect URI = http://app) -> aceptado.
    window.dispatchEvent(new MessageEvent('message', { data: { source: 'libreflow-oauth', ok: true }, origin: 'http://app' }));
    await flushPromises();
    expect(w.text()).toContain('Conectada');
  });

  it('emite close al cancelar', async () => {
    const w = mountModal({ editId: null });
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === 'Cancelar')!.trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });
});
