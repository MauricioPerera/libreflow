import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import McpServerModal from './McpServerModal.vue';

const workflows = [
  { id: 'w1', name: 'Sync' },
  { id: 'w2', name: 'Backup' },
];

const base = (over: any = {}) => ({
  editingMcpServerId: null, name: 'Srv', workflows,
  selectedWorkflowIds: ['w1'], requireAuth: true, exposeSystem: false, ...over,
});

const mountModal = (props: any) =>
  mount(McpServerModal, { props, global: { directives: { 'focus-trap': {} } } });

describe('McpServerModal', () => {
  it('título crear/editar y un checkbox por flujo (marcado según selección)', () => {
    expect(mountModal(base()).text()).toContain('Crear Servidor MCP');
    expect(mountModal(base({ editingMcpServerId: 's1' })).text()).toContain('Editar Servidor MCP');

    const w = mountModal(base());
    const flowChecks = w.findAll('input[type="checkbox"]').slice(0, 2);
    expect((flowChecks[0].element as HTMLInputElement).checked).toBe(true);  // w1 seleccionado
    expect((flowChecks[1].element as HTMLInputElement).checked).toBe(false); // w2 no
  });

  it('Guardar deshabilitado sin nombre o sin flujos seleccionados', () => {
    const guardar = (w: any) => w.findAll('button').find((b: any) => b.text() === 'Guardar');
    expect(guardar(mountModal(base({ name: '' }))).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal(base({ selectedWorkflowIds: [] }))).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal(base())).attributes('disabled')).toBeUndefined();
  });

  it('emite toggle-workflow al marcar un flujo', async () => {
    const w = mountModal(base());
    await w.findAll('input[type="checkbox"]')[1].trigger('change'); // flujo w2
    expect(w.emitted('toggle-workflow')![0]).toEqual(['w2']);
  });

  it('v-model: emite update:name / update:requireAuth / update:exposeSystem', async () => {
    const w = mountModal(base());
    await w.find('input[type="text"], input.config-input').setValue('Nuevo');
    expect(w.emitted('update:name')![0]).toEqual(['Nuevo']);
    // los dos últimos checkboxes son requireAuth y exposeSystem
    const checks = w.findAll('input[type="checkbox"]');
    await checks[checks.length - 1].setValue(true); // exposeSystem
    expect(w.emitted('update:exposeSystem')).toBeTruthy();
  });

  it('emite close y save', async () => {
    const w = mountModal(base());
    await w.findAll('button').find((b) => b.text() === 'Cancelar')!.trigger('click');
    expect(w.emitted('close')).toBeTruthy();
    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    expect(w.emitted('save')).toBeTruthy();
  });
});
