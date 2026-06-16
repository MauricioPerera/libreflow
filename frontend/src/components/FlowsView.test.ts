import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import FlowsView from './FlowsView.vue';

const flows = [
  { id: 'w1', name: 'Sync', active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
  { id: 'w2', name: 'Backup', active: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
];

describe('FlowsView', () => {
  it('renderiza una fila por flujo con su estado', () => {
    const w = mount(FlowsView, { props: { workflows: flows, loaded: true } });
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('Sync');
    expect(w.text()).toContain('Activo');
    expect(w.text()).toContain('Inactivo');
  });

  it('muestra estado de carga y vacío', () => {
    expect(mount(FlowsView, { props: { workflows: [], loaded: false } }).text()).toContain('Cargando flujos');
    expect(mount(FlowsView, { props: { workflows: [], loaded: true } }).text()).toContain('No tienes flujos');
  });

  it('emite validate / create / edit / export / delete', async () => {
    const w = mount(FlowsView, { props: { workflows: flows, loaded: true } });
    await w.find('.btn-secondary').trigger('click'); // Validar coherencia (1er secondary del header)
    expect(w.emitted('validate')).toBeTruthy();
    await w.find('.btn-primary').trigger('click');
    expect(w.emitted('create')).toBeTruthy();

    const rowButtons = w.findAll('tbody .table-actions .btn'); // [Editar, Exportar, Eliminar]
    await rowButtons[0].trigger('click');
    expect(w.emitted('edit')![0]).toEqual(['w1']);
    await rowButtons[1].trigger('click');
    expect(w.emitted('export')![0]).toEqual(['w1']);
    await rowButtons[2].trigger('click');
    expect(w.emitted('delete')![0]).toEqual(['w1']);
  });

  it('el botón Importar de la cabecera emite import', async () => {
    const w = mount(FlowsView, { props: { workflows: flows, loaded: true } });
    await w.findAll('button').find((b) => b.text().includes('Importar'))!.trigger('click');
    expect(w.emitted('import')).toBeTruthy();
  });
});
