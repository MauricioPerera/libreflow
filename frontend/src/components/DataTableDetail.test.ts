import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DataTableDetail from './DataTableDetail.vue';

const table = { id: 't1', name: 'Usuarios', columns: [{ name: 'email', type: 'string' }, { name: 'edad', type: 'number' }] };
const rows = [{ id: 'r1', data: { email: 'a@b.com', edad: 30 } }];

const base = () => ({ table, rows, editingRowId: null as string | null, editingRowData: {} as Record<string, any> });

describe('DataTableDetail', () => {
  it('muestra los valores en modo lectura', () => {
    const w = mount(DataTableDetail, { props: base() });
    expect(w.text()).toContain('Usuarios');
    expect(w.text()).toContain('a@b.com');
    expect(w.find('input').exists()).toBe(false);
  });

  it('muestra inputs en la fila en edición', () => {
    const w = mount(DataTableDetail, { props: { ...base(), editingRowId: 'r1', editingRowData: { email: 'a@b.com', edad: 30 } } });
    expect(w.findAll('input')).toHaveLength(2);
  });

  it('estado vacío', () => {
    const w = mount(DataTableDetail, { props: { ...base(), rows: [] } });
    expect(w.text()).toContain('Esta tabla está vacía');
  });

  it('emite acciones de cabecera y de fila (lectura)', async () => {
    const w = mount(DataTableDetail, { props: base() });
    await w.findAll('button').find((b) => b.text().includes('Volver'))!.trigger('click');
    expect(w.emitted('back')).toBeTruthy();
    await w.findAll('button').find((b) => b.text().includes('Añadir Fila'))!.trigger('click');
    expect(w.emitted('add-row')).toBeTruthy();
    await w.findAll('button').find((b) => b.text().includes('Columnas'))!.trigger('click');
    expect(w.emitted('edit-schema')).toBeTruthy();

    await w.findAll('button').find((b) => b.text() === 'Editar')!.trigger('click');
    expect(w.emitted('start-edit')![0][0]).toMatchObject({ id: 'r1' });
    await w.findAll('button').find((b) => b.text() === 'Borrar')!.trigger('click');
    expect(w.emitted('delete-row')![0]).toEqual(['r1']);
  });

  it('emite save-edit / cancel-edit en modo edición', async () => {
    const w = mount(DataTableDetail, { props: { ...base(), editingRowId: 'r1', editingRowData: { email: 'a@b.com', edad: 30 } } });
    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    expect(w.emitted('save-edit')![0]).toEqual(['r1']);
    await w.findAll('button').find((b) => b.text() === 'Cancelar')!.trigger('click');
    expect(w.emitted('cancel-edit')).toBeTruthy();
  });

  it('el v-model de celda muta el objeto editingRowData compartido', async () => {
    const editingRowData: Record<string, any> = { email: 'a@b.com', edad: 30 };
    const w = mount(DataTableDetail, { props: { ...base(), editingRowId: 'r1', editingRowData } });
    await w.findAll('input')[0].setValue('nuevo@b.com');
    expect(editingRowData.email).toBe('nuevo@b.com');
  });
});
