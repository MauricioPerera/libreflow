import { describe, it, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import LoginView from './LoginView.vue';

describe('LoginView', () => {
  it('emite logged-in con token y usuario tras un login correcto', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'jwt-1', user: { id: 'u1', email: 'a@b.c', role: 'user' } }),
    })));
    const w = mount(LoginView);
    await w.find('#login-email').setValue('a@b.c');
    await w.find('#login-password').setValue('pw');
    await w.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(w.emitted('logged-in')).toBeTruthy();
    expect(w.emitted('logged-in')![0][0]).toMatchObject({ token: 'jwt-1', user: { id: 'u1' } });
    vi.unstubAllGlobals();
  });

  it('muestra el error del servidor y NO emite si las credenciales fallan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Credenciales inválidas' }),
    })));
    const w = mount(LoginView);
    await w.find('#login-email').setValue('a@b.c');
    await w.find('#login-password').setValue('bad');
    await w.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(w.text()).toContain('Credenciales inválidas');
    expect(w.emitted('logged-in')).toBeFalsy();
    vi.unstubAllGlobals();
  });

  it('valida que email y contraseña sean obligatorios sin llamar a la API', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const w = mount(LoginView);
    await w.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(f).not.toHaveBeenCalled();
    expect(w.text()).toContain('Introduce email y contraseña');
    vi.unstubAllGlobals();
  });
});
