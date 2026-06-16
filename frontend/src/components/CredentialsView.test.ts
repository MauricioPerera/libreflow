import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CredentialsView from './CredentialsView.vue';

const creds = [
  { id: 'c1', name: 'Slack', type: 'oauth2', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
  { id: 'c2', name: 'API X', type: 'apiKey', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
];

describe('CredentialsView', () => {
  it('renderiza una fila por credencial con su etiqueta de tipo', () => {
    const w = mount(CredentialsView, { props: { credentials: creds, loaded: true } });
    expect(w.findAll('tbody tr')).toHaveLength(2);
    expect(w.text()).toContain('Slack');
    expect(w.text()).toContain('OAuth2 (token + refresh)');
    expect(w.text()).toContain('API Key (Token de Cabecera/Query)');
  });

  it('muestra estado de carga y vacío', () => {
    const loading = mount(CredentialsView, { props: { credentials: [], loaded: false } });
    expect(loading.text()).toContain('Cargando credenciales');

    const empty = mount(CredentialsView, { props: { credentials: [], loaded: true } });
    expect(empty.text()).toContain('No tienes credenciales guardadas');
  });

  it('emite create / edit / delete', async () => {
    const w = mount(CredentialsView, { props: { credentials: creds, loaded: true } });
    await w.find('.btn-primary').trigger('click');
    expect(w.emitted('create')).toBeTruthy();

    const rowButtons = w.findAll('tbody .table-actions .btn');
    await rowButtons[0].trigger('click'); // Editar de la 1ª fila
    expect(w.emitted('edit')![0]).toEqual(['c1']);
    await rowButtons[1].trigger('click'); // Eliminar de la 1ª fila
    expect(w.emitted('delete')![0]).toEqual(['c1']);
  });
});
