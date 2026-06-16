import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ExecutionsView from './ExecutionsView.vue';

const execs = [
  { id: 'e1', workflow_id: 'w1', workflow_name: 'Sync', status: 'success', executed_at: '2026-01-01T00:00:00Z' },
  { id: 'e2', workflow_id: 'w2', workflow_name: 'Backup', status: 'failed', executed_at: '2026-01-02T00:00:00Z' },
];

describe('ExecutionsView', () => {
  it('renderiza una fila por ejecución con su estado traducido', () => {
    const w = mount(ExecutionsView, { props: { executions: execs, loaded: true } });
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('Sync');
    expect(w.text()).toContain('Éxito');
    expect(w.text()).toContain('Fallo');
  });

  it('el botón Contexto IA solo aparece en ejecuciones fallidas', () => {
    const w = mount(ExecutionsView, { props: { executions: execs, loaded: true } });
    const aiButtons = w.findAll('button').filter((b) => b.text().includes('Contexto IA'));
    expect(aiButtons).toHaveLength(1);
  });

  it('muestra estado de carga y vacío', () => {
    expect(mount(ExecutionsView, { props: { executions: [], loaded: false } }).text()).toContain('Cargando ejecuciones');
    expect(mount(ExecutionsView, { props: { executions: [], loaded: true } }).text()).toContain('No hay ejecuciones');
  });

  it('emite open (id, workflowId) y ai-context (id)', async () => {
    const w = mount(ExecutionsView, { props: { executions: execs, loaded: true } });
    const aiBtn = w.findAll('button').find((b) => b.text().includes('Contexto IA'))!;
    await aiBtn.trigger('click');
    expect(w.emitted('ai-context')![0]).toEqual(['e2']);

    const verBtns = w.findAll('button').filter((b) => b.text().includes('Ver Ejecución'));
    await verBtns[0].trigger('click');
    expect(w.emitted('open')![0]).toEqual(['e1', 'w1']);
  });
});
