import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import CustomNode from './CustomNode.vue';

// Handle de Vue Flow necesita el contexto de VueFlow; lo stubeamos. Inyectamos los refs.
const provide = {
  nodeTypesList: ref([{ type: 'set', displayName: 'Set', icon: 'S' }]),
  nodeStatuses: ref<Record<string, string>>({}),
};
const stubs = { Handle: { template: '<div />' } };

const mountNode = (data: any) =>
  mount(CustomNode, { props: { id: 'n1', type: 'set', data }, global: { provide, stubs } });

describe('CustomNode — badge de pin', () => {
  it('muestra 📌 cuando el nodo tiene pinData', () => {
    const w = mountNode({ name: 'Mapear', parameters: {}, pinData: { a: 1 } });
    expect(w.text()).toContain('📌');
  });

  it('no muestra el badge sin pinData', () => {
    const w = mountNode({ name: 'Mapear', parameters: {} });
    expect(w.text()).not.toContain('📌');
  });
});
