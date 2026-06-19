import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import EditorSidebar from './EditorSidebar.vue';

const base = {
  collapsed: false,
  activeTab: 'config' as const,
  selectedNode: null as any,
  panelUpdateKey: 0,
  nodeResult: null,
  workflowId: 'wf-1',
  credentialsList: [],
  workflowsList: [{ id: 'wf-2', name: 'Otro' }],
  readOnly: false,
  onErrorWorkflowId: '',
  executions: [{ id: 'ex-1', status: 'success', executed_at: '2026-01-01' }],
  activeExecutionId: null as string | null,
  versions: [{ id: 'v1', version: 3, created_at: '2026-01-01' }],
  previewedVersion: null as number | null,
};

// NodeConfigPanel se stubea: aquí solo probamos el contenedor (pestañas, ajustes, historial, versiones).
const opts = (props: any) => ({ props, global: { stubs: { NodeConfigPanel: true } } });

describe('EditorSidebar', () => {
  it('pestañas: historial/versiones deshabilitadas sin workflowId; emite change-tab', async () => {
    const w = mount(EditorSidebar, opts({ ...base, workflowId: null }));
    const tabs = w.findAll('.sidebar-tabs .tab-btn');
    expect(tabs).toHaveLength(3);
    expect((tabs[1].element as HTMLButtonElement).disabled).toBe(true);
    expect((tabs[2].element as HTMLButtonElement).disabled).toBe(true);
    await tabs[0].trigger('click');
    expect(w.emitted('change-tab')![0]).toEqual(['config']);
  });

  it('sin nodo seleccionado muestra Ajustes del Flujo y emite update:onErrorWorkflowId', async () => {
    const w = mount(EditorSidebar, opts({ ...base, selectedNode: null }));
    expect(w.text()).toContain('Ajustes del Flujo');
    const select = w.find('.config-select');
    await select.setValue('wf-2');
    expect(w.emitted('update:onErrorWorkflowId')![0]).toEqual(['wf-2']);
  });

  it('historial: renderiza ejecuciones y emite load-past-execution', async () => {
    const w = mount(EditorSidebar, opts({ ...base }));
    const item = w.find('.history-item');
    expect(item.exists()).toBe(true);
    await item.trigger('click');
    expect(w.emitted('load-past-execution')![0]).toEqual(['ex-1']);
  });

  it('versiones: previsualizar y restaurar emiten la versión', async () => {
    const w = mount(EditorSidebar, opts({ ...base }));
    const btns = w.findAll('.history-item .btn');
    const prev = btns.find((b) => b.text() === 'Previsualizar')!;
    await prev.trigger('click');
    expect(w.emitted('preview-version')![0]).toEqual([3]);
    const rest = btns.find((b) => b.text() === 'Restaurar')!;
    await rest.trigger('click');
    expect(w.emitted('restore-version')![0]).toEqual([3]);
  });

  it('el toggle emite update:collapsed', async () => {
    const w = mount(EditorSidebar, opts({ ...base }));
    await w.find('.sidebar-toggle-btn').trigger('click');
    expect(w.emitted('update:collapsed')![0]).toEqual([true]);
  });
});
