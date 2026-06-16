import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import NodeConfigPanel from './NodeConfigPanel.vue';

// Solo probamos el control de pin. Proveemos el inject mínimo (nodeTypesList) y un nodo `set`.
const nodeTypesList = ref([{ type: 'set', displayName: 'Set', icon: 'S', parameters: [] }]);

function mountPanel(node: any, result: any) {
  return mount(NodeConfigPanel, {
    props: { node, result },
    global: {
      provide: { nodeTypesList },
      directives: { 'focus-trap': {} },
    },
  });
}

const setNode = (pinData?: any) => ({
  id: 'n1', type: 'set',
  data: { name: 'Mapear', parameters: {}, ...(pinData !== undefined ? { pinData } : {}) },
});

describe('NodeConfigPanel — control de pin', () => {
  it('con salida y sin pin: muestra "Fijar" y emite set-pin con la salida', async () => {
    const w = mountPanel(setNode(), { status: 'success', output: { a: 1 } });
    const btn = w.findAll('button').find((b) => b.text().includes('Fijar esta salida'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    expect(w.emitted('set-pin')![0]).toEqual([{ a: 1 }]);
  });

  it('con pin activo: muestra "Quitar fijado" y emite set-pin null', async () => {
    const w = mountPanel(setNode({ a: 1 }), null);
    expect(w.text()).toContain('Salida fijada');
    const btn = w.findAll('button').find((b) => b.text().includes('Quitar fijado'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    expect(w.emitted('set-pin')![0]).toEqual([null]);
  });

  it('sin salida y sin pin: no muestra control de pin', () => {
    const w = mountPanel(setNode(), null);
    expect(w.text()).not.toContain('Fijar esta salida');
    expect(w.text()).not.toContain('Salida fijada');
  });
});
