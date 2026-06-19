import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import EditorHeader from './EditorHeader.vue';

const base = {
  workflowName: 'Mi Flujo',
  workflowId: 'wf-1',
  active: false,
  previewMode: false,
  running: false,
  previewedVersion: null as number | null,
};

describe('EditorHeader', () => {
  it('muestra el nombre y emite exit / save / run', async () => {
    const w = mount(EditorHeader, { props: { ...base } });
    expect((w.find('.editor-title-input').element as HTMLInputElement).value).toBe('Mi Flujo');
    await w.find('.brand-section .btn').trigger('click'); // ← Volver
    expect(w.emitted('exit')).toBeTruthy();
    const actions = w.findAll('.action-buttons .btn');
    await actions[0].trigger('click'); // Guardar
    await actions[1].trigger('click'); // Ejecutar
    expect(w.emitted('save')).toBeTruthy();
    expect(w.emitted('run')).toBeTruthy();
  });

  it('editar el nombre emite update:workflowName', async () => {
    const w = mount(EditorHeader, { props: { ...base } });
    await w.find('.editor-title-input').setValue('Nuevo');
    expect(w.emitted('update:workflowName')![0]).toEqual(['Nuevo']);
  });

  it('el toggle de activo solo aparece con workflowId y emite update:active + toggle-active', async () => {
    const sin = mount(EditorHeader, { props: { ...base, workflowId: null } });
    expect(sin.find('.workflow-active-toggle-container').exists()).toBe(false);

    const w = mount(EditorHeader, { props: { ...base } });
    await w.find('.switch input').setValue(true);
    expect(w.emitted('update:active')![0]).toEqual([true]);
    expect(w.emitted('toggle-active')).toBeTruthy();
  });

  it('en preview muestra el banner; restore emite la versión y cancel-preview', async () => {
    const w = mount(EditorHeader, { props: { ...base, previewMode: true, previewedVersion: 7 } });
    expect(w.find('.preview-mode-banner').exists()).toBe(true);
    expect(w.text()).toContain('#7');
    const btns = w.findAll('.preview-mode-banner .btn');
    await btns[0].trigger('click'); // Restaurar
    expect(w.emitted('restore')![0]).toEqual([7]);
    await btns[1].trigger('click'); // Volver al editor
    expect(w.emitted('cancel-preview')).toBeTruthy();
  });

  it('sin preview no hay banner', () => {
    const w = mount(EditorHeader, { props: { ...base } });
    expect(w.find('.preview-mode-banner').exists()).toBe(false);
  });
});
