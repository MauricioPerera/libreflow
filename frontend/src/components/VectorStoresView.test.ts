import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import VectorStoresView from './VectorStoresView.vue';

const stores = [
  { collection: 'kb', files: 2, updated_at: '2026-01-01' },
  { collection: 'docs', files: 4, updated_at: '2026-01-02' },
];

describe('VectorStoresView', () => {
  it('renderiza una fila por colección', () => {
    const w = mount(VectorStoresView, { props: { stores, loaded: true } });
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('kb');
    expect(w.text()).toContain('docs');
  });

  it('muestra estado de carga y vacío', () => {
    expect(mount(VectorStoresView, { props: { stores: [], loaded: false } }).text()).toContain('Cargando');
    expect(mount(VectorStoresView, { props: { stores: [], loaded: true } }).text()).toContain('No tienes colecciones');
  });

  it('emite delete(collection) al pulsar Borrar', async () => {
    const w = mount(VectorStoresView, { props: { stores, loaded: true } });
    await w.findAll('.vs-del')[1].trigger('click');
    expect(w.emitted('delete')![0]).toEqual(['docs']);
  });
});
