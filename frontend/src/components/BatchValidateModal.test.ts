import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BatchValidateModal from './BatchValidateModal.vue';

const result = {
  summary: { total: 2, withErrors: 1, withWarnings: 0 },
  workflows: [
    { id: 'w1', name: 'Sync', ok: false, errors: 1, warnings: 0, issues: [{ level: 'error', message: 'Nodo huérfano' }] },
    { id: 'w2', name: 'OK', ok: true, errors: 0, warnings: 0, issues: [] },
  ],
};

const mountModal = (props: any) =>
  mount(BatchValidateModal, { props, global: { directives: { 'focus-trap': {} } } });

describe('BatchValidateModal', () => {
  it('botón Validar refleja el estado validating', () => {
    expect(mountModal({ contains: '', validating: false, result: null }).text()).toContain('Validar');
    const v = mountModal({ contains: '', validating: true, result: null });
    expect(v.text()).toContain('Validando…');
    expect(v.findAll('button').find((b) => b.text().includes('Validando'))!.attributes('disabled')).toBeDefined();
  });

  it('renderiza el resumen y los issues de cada flujo', () => {
    const w = mountModal({ contains: '', validating: false, result });
    expect(w.text()).toContain('2 flujo(s)');
    expect(w.text()).toContain('1 con errores');
    expect(w.text()).toContain('Sync');
    expect(w.text()).toContain('Nodo huérfano');
  });

  it('emite validate (botón y Enter), open-flow(id) y close', async () => {
    const w = mountModal({ contains: '', validating: false, result });
    await w.findAll('button').find((b) => b.text() === 'Validar')!.trigger('click');
    expect(w.emitted('validate')).toHaveLength(1);
    await w.find('input').trigger('keyup.enter');
    expect(w.emitted('validate')).toHaveLength(2);

    await w.find('.validation-banner-head strong').trigger('click');
    expect(w.emitted('open-flow')![0]).toEqual(['w1']);

    await w.findAll('button').find((b) => b.text() === 'Cerrar')!.trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('v-model:contains emite al escribir en el filtro', async () => {
    const w = mountModal({ contains: '', validating: false, result: null });
    await w.find('input').setValue('api.stripe.com');
    expect(w.emitted('update:contains')![0]).toEqual(['api.stripe.com']);
  });
});
