import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AddRowModal from './AddRowModal.vue';

const columns = [
  { name: 'email', type: 'string' },
  { name: 'edad', type: 'number' },
  { name: 'activo', type: 'boolean' },
];

const mountModal = (props: any) =>
  mount(AddRowModal, { props, global: { directives: { 'focus-trap': {} } } });

describe('AddRowModal', () => {
  it('renderiza un campo por columna con el input adecuado al tipo', () => {
    const w = mountModal({ columns, rowData: {} });
    expect(w.text()).toContain('Añadir Fila');
    expect(w.find('input[type="number"]').exists()).toBe(true);
    expect(w.find('input[type="checkbox"]').exists()).toBe(true);
    expect(w.findAll('input[type="text"]')).toHaveLength(1);
  });

  it('v-model muta el objeto rowData compartido (texto, número coercido, booleano)', async () => {
    const rowData: Record<string, any> = {};
    const w = mountModal({ columns, rowData });
    await w.find('input[type="text"]').setValue('a@b.com');
    await w.find('input[type="number"]').setValue('42');
    await w.find('input[type="checkbox"]').setValue(true);
    expect(rowData.email).toBe('a@b.com');
    expect(rowData.edad).toBe(42); // .number coerciona a número
    expect(rowData.activo).toBe(true);
  });

  it('emite close (Cancelar + overlay) y save (Guardar)', async () => {
    const w = mountModal({ columns, rowData: {} });
    await w.findAll('button').find((b) => b.text() === 'Cancelar')!.trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
    await w.find('.modal-overlay').trigger('click');
    expect(w.emitted('close')).toHaveLength(2);
    await w.findAll('button').find((b) => b.text() === 'Guardar')!.trigger('click');
    expect(w.emitted('save')).toBeTruthy();
  });
});
