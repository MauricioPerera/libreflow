import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DataTableModal from './DataTableModal.vue';

const mountModal = (props: any) =>
  mount(DataTableModal, { props, global: { directives: { 'focus-trap': {} } } });

const cols = () => [{ name: 'email', type: 'string' }, { name: 'edad', type: 'number' }];

describe('DataTableModal', () => {
  it('título según crear/editar; nombre deshabilitado al editar', () => {
    const crear = mountModal({ editingTableId: null, name: '', columns: cols(), keyColumn: '' });
    expect(crear.text()).toContain('Crear Tabla de Datos');
    expect((crear.find('input').element as HTMLInputElement).disabled).toBe(false);

    const editar = mountModal({ editingTableId: 't1', name: 'Users', columns: cols(), keyColumn: '' });
    expect(editar.text()).toContain('Editar Columnas');
    expect((editar.find('input').element as HTMLInputElement).disabled).toBe(true);
  });

  it('lista las columnas y ofrece cada una como posible clave', () => {
    const w = mountModal({ editingTableId: null, name: 'X', columns: cols(), keyColumn: '' });
    expect(w.findAll('select')).toHaveLength(3); // 2 tipos de columna + 1 columna clave
    const keySelect = w.findAll('select')[2];
    expect(keySelect.text()).toContain('email');
    expect(keySelect.text()).toContain('edad');
  });

  it('Guardar deshabilitado si falta nombre, no hay columnas, o una columna sin nombre', () => {
    const guardar = (w: any) => w.findAll('button').find((b: any) => b.text() === 'Guardar');
    expect(guardar(mountModal({ editingTableId: null, name: '', columns: cols(), keyColumn: '' })).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal({ editingTableId: null, name: 'X', columns: [], keyColumn: '' })).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal({ editingTableId: null, name: 'X', columns: [{ name: '', type: 'string' }], keyColumn: '' })).attributes('disabled')).toBeDefined();
    expect(guardar(mountModal({ editingTableId: null, name: 'X', columns: cols(), keyColumn: '' })).attributes('disabled')).toBeUndefined();
  });

  it('emite add-column / remove-column / close / save', async () => {
    const w = mountModal({ editingTableId: null, name: 'X', columns: cols(), keyColumn: '' });
    await w.findAll('button').find((b) => b.text().includes('Añadir Columna'))!.trigger('click');
    expect(w.emitted('add-column')).toBeTruthy();
    await w.findAll('button').find((b) => b.text() === '✕')!.trigger('click');
    expect(w.emitted('remove-column')![0]).toEqual([0]);
    await w.findAll('button').find((b) => b.text() === 'Cancelar')!.trigger('click');
    expect(w.emitted('close')).toBeTruthy();
    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    expect(w.emitted('save')).toBeTruthy();
  });

  it('v-model:name muta vía emit y el v-model de celda muta el objeto columna', async () => {
    const columns = cols();
    const w = mountModal({ editingTableId: null, name: '', columns, keyColumn: '' });
    await w.find('input').setValue('Clientes');
    expect(w.emitted('update:name')![0]).toEqual(['Clientes']);
    // primer input de columna (flex-grow) es el segundo input del modal
    const colInputs = w.findAll('input').filter((i) => i.attributes('placeholder') === 'Nombre de columna');
    await colInputs[0].setValue('correo');
    expect(columns[0].name).toBe('correo');
  });
});
