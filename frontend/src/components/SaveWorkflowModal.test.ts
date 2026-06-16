import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SaveWorkflowModal from './SaveWorkflowModal.vue';

// v-focus-trap es una directiva global (registrada en main.ts); la stubeamos al montar.
const mountModal = (props: any) =>
  mount(SaveWorkflowModal, { props, global: { directives: { 'focus-trap': {} } } });

describe('SaveWorkflowModal', () => {
  it('renderiza el título y el nombre actual', () => {
    const w = mountModal({ name: 'Mi Flujo', description: 'desc' });
    expect(w.text()).toContain('Guardar Flujo');
    expect((w.find('input').element as HTMLInputElement).value).toBe('Mi Flujo');
  });

  it('deshabilita Guardar si el nombre está vacío o en blanco', () => {
    const guardar = (w: any) => w.findAll('button').find((b: any) => b.text() === 'Guardar');
    expect(guardar(mountModal({ name: '', description: '' })).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal({ name: '   ', description: '' })).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal({ name: 'X', description: '' })).attributes('disabled')).toBeUndefined();
  });

  it('v-model: emite update:name / update:description al escribir', async () => {
    const w = mountModal({ name: '', description: '' });
    await w.find('input').setValue('Nuevo');
    expect(w.emitted('update:name')![0]).toEqual(['Nuevo']);
    await w.find('textarea').setValue('Una descripción');
    expect(w.emitted('update:description')![0]).toEqual(['Una descripción']);
  });

  it('emite close (Cancelar y click en overlay) y save (Guardar)', async () => {
    const w = mountModal({ name: 'X', description: '' });
    await w.findAll('button').find((b) => b.text() === 'Cancelar')!.trigger('click');
    expect(w.emitted('close')).toHaveLength(1);

    await w.find('.modal-overlay').trigger('click'); // click.self en el overlay
    expect(w.emitted('close')).toHaveLength(2);

    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    expect(w.emitted('save')).toBeTruthy();
  });
});
