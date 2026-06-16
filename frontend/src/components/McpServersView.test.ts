import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import McpServersView from './McpServersView.vue';

const servers = [
  { id: 's1', name: 'Ventas', workflow_ids: ['w1', 'w2'], require_auth: true, token: 'tok-123' },
  { id: 's2', name: 'Público', workflow_ids: [], require_auth: false, token: '' },
];

describe('McpServersView', () => {
  it('renderiza fila por servidor con URL, nº de flujos y acceso', () => {
    const w = mount(McpServersView, { props: { servers, loaded: true } });
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('Ventas');
    expect(w.text()).toContain('/mcp/s1');
    expect(w.text()).toContain('Token');
    expect(w.text()).toContain('Público');
  });

  it('el botón "Copiar token" solo aparece en servidores con auth', () => {
    const w = mount(McpServersView, { props: { servers, loaded: true } });
    const tokenBtns = w.findAll('button').filter((b) => b.text().includes('Copiar token'));
    expect(tokenBtns).toHaveLength(1);
  });

  it('muestra estado de carga y vacío', () => {
    expect(mount(McpServersView, { props: { servers: [], loaded: false } }).text()).toContain('Cargando servidores');
    expect(mount(McpServersView, { props: { servers: [], loaded: true } }).text()).toContain('No tienes servidores MCP');
  });

  it('emite create / edit(server) / delete(id) / copy(url)', async () => {
    const w = mount(McpServersView, { props: { servers, loaded: true } });
    await w.find('.btn-primary').trigger('click');
    expect(w.emitted('create')).toBeTruthy();

    const copyUrlBtns = w.findAll('button').filter((b) => b.text() === 'Copiar');
    await copyUrlBtns[0].trigger('click');
    expect(w.emitted('copy')![0][0]).toContain('/mcp/s1');

    const rowButtons = w.findAll('tbody .table-actions .btn');
    const editBtn = rowButtons.find((b) => b.text() === 'Editar')!;
    await editBtn.trigger('click');
    expect(w.emitted('edit')![0][0]).toMatchObject({ id: 's1' });
  });
});
