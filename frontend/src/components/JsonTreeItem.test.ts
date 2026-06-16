import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import JsonTreeItem from './JsonTreeItem.vue';

// Smoke test que valida que el harness monta SFCs de Vue correctamente.
describe('JsonTreeItem', () => {
  it('renderiza una hoja (clave + valor)', () => {
    const w = mount(JsonTreeItem, { props: { label: 'edad', value: 36, path: 'edad', nodeName: 'X', depth: 0 } });
    const txt = w.text();
    expect(txt).toContain('edad');
    expect(txt).toContain('36');
  });

  it('muestra un binario con enlace de descarga', () => {
    const w = mount(JsonTreeItem, {
      props: {
        label: 'fichero',
        value: { _lfBinary: 'bin-1', fileName: 'doc.pdf', size: 1024 },
        path: 'fichero', nodeName: 'X', depth: 0,
      },
    });
    expect(w.text()).toContain('doc.pdf');
    const link = w.find('a');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('/api/binaries/bin-1');
  });
});
