import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DashboardSidebar from './DashboardSidebar.vue';

const base = { activeSubView: 'workflows', isAdmin: false, userLabel: 'a@b.c', userEmail: 'a@b.c' };

describe('DashboardSidebar', () => {
  it('muestra las 6 subvistas base (sin Usuarios para no-admin) y marca la activa', () => {
    const w = mount(DashboardSidebar, { props: { ...base, activeSubView: 'credentials' } });
    const btns = w.findAll('.menu-btn');
    expect(btns).toHaveLength(6);
    const active = btns.find((b) => b.classes().includes('active'))!;
    expect(active.text()).toContain('Credenciales');
  });

  it('añade la entrada Usuarios cuando isAdmin', () => {
    const w = mount(DashboardSidebar, { props: { ...base, isAdmin: true } });
    expect(w.findAll('.menu-btn')).toHaveLength(7);
    expect(w.text()).toContain('Usuarios');
  });

  it('emite select(view) al pulsar una entrada', async () => {
    const w = mount(DashboardSidebar, { props: { ...base } });
    const exec = w.findAll('.menu-btn').find((b) => b.text().includes('Ejecuciones'))!;
    await exec.trigger('click');
    expect(w.emitted('select')![0]).toEqual(['executions']);
  });

  it('muestra el usuario y emite logout', async () => {
    const w = mount(DashboardSidebar, { props: { ...base, userLabel: 'mauricio@x.com' } });
    expect(w.text()).toContain('mauricio@x.com');
    await w.find('.logout-btn').trigger('click');
    expect(w.emitted('logout')).toBeTruthy();
  });
});
