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

  it('muestra la tarjeta del servidor MCP global (URL /api/mcp, auth y system tools) y copia su URL', async () => {
    const w = mount(McpServersView, { props: { servers, loaded: true } });
    const card = w.find('.mcp-global-card');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain('/api/mcp');
    expect(card.text()).toContain('Bearer');
    expect(card.text()).toContain('save_workflow');
    await card.find('button').trigger('click'); // botón Copiar de la tarjeta global
    expect(w.emitted('copy')![0][0]).toContain('/api/mcp');
  });

  it('tarjeta global: con userToken muestra el token (oculto), lo revela, copia y regenera', async () => {
    const w = mount(McpServersView, { props: { servers, loaded: true, userToken: 'lf_secret_123' } });
    const card = w.find('.mcp-global-card');
    // oculto por defecto: no muestra el valor en claro
    expect(card.text()).not.toContain('lf_secret_123');
    const btn = (label: string) => card.findAll('button').find((b) => b.text() === label)!;
    await btn('Mostrar').trigger('click');
    expect(card.text()).toContain('lf_secret_123');
    // hay 2 "Copiar" en la card (URL y token); el del token es el último
    const copyBtns = card.findAll('button').filter((b) => b.text() === 'Copiar');
    await copyBtns[copyBtns.length - 1].trigger('click');
    expect(w.emitted('copy')!.at(-1)![0]).toBe('lf_secret_123');
    await btn('Regenerar').trigger('click');
    expect(w.emitted('regenerate-token')).toBeTruthy();
  });

  it('tarjeta global: sin userToken muestra el aviso de dev', () => {
    const w = mount(McpServersView, { props: { servers, loaded: true, userToken: null } });
    expect(w.find('.mcp-global-card').text()).toContain('Inicia sesión como usuario real');
  });

  it('muestra estado de carga y vacío', () => {
    expect(mount(McpServersView, { props: { servers: [], loaded: false } }).text()).toContain('Cargando servidores');
    expect(mount(McpServersView, { props: { servers: [], loaded: true } }).text()).toContain('No tienes servidores MCP');
  });

  it('emite create / edit(server) / delete(id) / copy(url)', async () => {
    const w = mount(McpServersView, { props: { servers, loaded: true } });
    await w.find('.btn-primary').trigger('click');
    expect(w.emitted('create')).toBeTruthy();

    const copyUrlBtns = w.findAll('tbody button').filter((b) => b.text() === 'Copiar');
    await copyUrlBtns[0].trigger('click');
    expect(w.emitted('copy')![0][0]).toContain('/mcp/s1');

    const rowButtons = w.findAll('tbody .table-actions .btn');
    const editBtn = rowButtons.find((b) => b.text() === 'Editar')!;
    await editBtn.trigger('click');
    expect(w.emitted('edit')![0][0]).toMatchObject({ id: 's1' });
  });
});
