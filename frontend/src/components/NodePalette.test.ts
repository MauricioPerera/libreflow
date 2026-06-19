import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import NodePalette from './NodePalette.vue';

const nodeTypes = [
  { type: 'trigger', displayName: 'Disparador', icon: '⚡', ui: { gradient: 'red' } },
  { type: 'httpRequest', displayName: 'HTTP', icon: '🌐' },
];

describe('NodePalette', () => {
  it('renderiza un botón por tipo de nodo y emite add(type) al pulsar', async () => {
    const w = mount(NodePalette, { props: { nodeTypes, collapsed: false, previewMode: false } });
    const items = w.findAll('.node-drag-item');
    expect(items).toHaveLength(2);
    expect(w.text()).toContain('Disparador');
    await items[1].trigger('click');
    expect(w.emitted('add')![0]).toEqual(['httpRequest']);
  });

  it('colapsada marca la paleta con clase collapsed, muestra el toggle y emite update:collapsed(false) al reabrir', async () => {
    const w = mount(NodePalette, { props: { nodeTypes, collapsed: true, previewMode: false } });
    // La paleta sigue en el DOM (la oculta el CSS por la clase `collapsed`).
    expect(w.find('.node-selector').classes()).toContain('collapsed');
    const toggle = w.find('.floating-node-selector-toggle');
    expect(toggle.exists()).toBe(true);
    await toggle.trigger('click');
    expect(w.emitted('update:collapsed')![0]).toEqual([false]);
  });

  it('el botón ✕ emite update:collapsed(true)', async () => {
    const w = mount(NodePalette, { props: { nodeTypes, collapsed: false, previewMode: false } });
    await w.find('.sidebar-close-btn').trigger('click');
    expect(w.emitted('update:collapsed')![0]).toEqual([true]);
  });

  it('en preview no muestra ni la paleta ni el toggle', () => {
    const w = mount(NodePalette, { props: { nodeTypes, collapsed: false, previewMode: true } });
    expect(w.find('.node-selector').exists()).toBe(false);
    expect(w.find('.floating-node-selector-toggle').exists()).toBe(false);
  });
});
