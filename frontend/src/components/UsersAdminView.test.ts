import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UsersAdminView from './UsersAdminView.vue';

const usersList = [
  { id: 'u1', email: 'admin@x.com', role: 'admin', created_at: '2026-01-01' },
  { id: 'u2', email: 'bob@x.com', role: 'user', created_at: '2026-01-02' },
];

function mockFetch() {
  return vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET';
    if (url === '/api/users' && method === 'GET') return { ok: true, json: async () => usersList };
    if (url === '/api/users' && method === 'POST') return { ok: true, json: async () => ({ id: 'u3', email: 'new@x.com', role: 'user' }) };
    if (url.startsWith('/api/users/') && method === 'DELETE') return { ok: true, json: async () => ({ success: true }) };
    return { ok: false, json: async () => ({}) };
  });
}

describe('UsersAdminView', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lista usuarios y marca (tú) al usuario actual; sin botón borrar para uno mismo', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const w = mount(UsersAdminView, { props: { currentUserId: 'u1' } });
    await flushPromises();
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('admin@x.com');
    expect(w.text()).toContain('bob@x.com');
    expect(w.text()).toContain('(tú)');
    // El admin (uno mismo) no tiene botón Borrar; bob sí.
    expect(w.findAll('.user-del-btn')).toHaveLength(1);
  });

  it('crea un usuario (POST /api/users) y recarga la lista', async () => {
    const f = mockFetch();
    vi.stubGlobal('fetch', f);
    const w = mount(UsersAdminView, { props: { currentUserId: 'u1' } });
    await flushPromises();
    await w.find('input[type="email"]').setValue('new@x.com');
    await w.find('input[type="password"]').setValue('pw');
    await w.find('form').trigger('submit.prevent');
    await flushPromises();
    const postCall = f.mock.calls.find((c: any[]) => c[0] === '/api/users' && c[1]?.method === 'POST');
    expect(postCall).toBeTruthy();
  });

  it('muestra el error si la lista no se puede cargar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const w = mount(UsersAdminView, { props: { currentUserId: 'u1' } });
    await flushPromises();
    expect(w.text()).toContain('No se pudo cargar');
    vi.unstubAllGlobals();
  });
});
