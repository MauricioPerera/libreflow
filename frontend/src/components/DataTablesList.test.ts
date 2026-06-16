import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DataTablesList from './DataTablesList.vue';

const tables = [
  { id: 't1', name: 'Usuarios', columns: '[{"name":"email","type":"string"},{"name":"edad","type":"number"}]', created_at: '2026-01-01T00:00:00Z' },
  { id: 't2', name: 'Logs', columns: [{ name: 'msg', type: 'string' }], created_at: '2026-01-02T00:00:00Z' },
];

describe('DataTablesList', () => {
  it('renderiza una fila por tabla y sus columnas (acepta JSON string o array)', () => {
    const w = mount(DataTablesList, { props: { tables, loaded: true } });
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('Usuarios');
    expect(w.text()).toContain('email (string)');
    expect(w.text()).toContain('msg (string)');
  });

  it('muestra estado de carga y vacío', () => {
    expect(mount(DataTablesList, { props: { tables: [], loaded: false } }).text()).toContain('Cargando tablas');
    expect(mount(DataTablesList, { props: { tables: [], loaded: true } }).text()).toContain('No tienes tablas de datos');
  });

  it('emite create / select(table) / delete(id)', async () => {
    const w = mount(DataTablesList, { props: { tables, loaded: true } });
    await w.find('.btn-primary').trigger('click');
    expect(w.emitted('create')).toBeTruthy();

    const rowButtons = w.findAll('tbody .table-actions .btn');
    await rowButtons[0].trigger('click'); // Ver Datos de la 1ª fila
    expect(w.emitted('select')![0][0]).toMatchObject({ id: 't1' });
    await rowButtons[1].trigger('click'); // Eliminar de la 1ª fila
    expect(w.emitted('delete')![0]).toEqual(['t1']);
  });
});
