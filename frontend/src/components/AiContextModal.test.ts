import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AiContextModal from './AiContextModal.vue';

const mountModal = (props: any) =>
  mount(AiContextModal, { props, global: { directives: { 'focus-trap': {} } } });

describe('AiContextModal', () => {
  it('muestra el cargando mientras loading=true (sin textarea)', () => {
    const w = mountModal({ loading: true, text: '', copied: false });
    expect(w.text()).toContain('Generando contexto');
    expect(w.find('textarea').exists()).toBe(false);
    expect(w.findAll('button').find((b) => b.text().includes('Copiar'))!.attributes('disabled')).toBeDefined();
  });

  it('muestra el texto del contexto cuando termina de cargar', () => {
    const w = mountModal({ loading: false, text: 'PROMPT...', copied: false });
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('PROMPT...');
  });

  it('el botón refleja el estado copiado', () => {
    expect(mountModal({ loading: false, text: 'x', copied: false }).text()).toContain('Copiar al portapapeles');
    expect(mountModal({ loading: false, text: 'x', copied: true }).text()).toContain('✓ Copiado');
  });

  it('emite copy y close', async () => {
    const w = mountModal({ loading: false, text: 'x', copied: false });
    await w.findAll('button').find((b) => b.text().includes('Copiar'))!.trigger('click');
    expect(w.emitted('copy')).toBeTruthy();
    await w.findAll('button').find((b) => b.text() === 'Cerrar')!.trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });
});
