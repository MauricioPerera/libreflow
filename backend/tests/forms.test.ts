import { describe, it, expect } from 'vitest';
import {
  parseFormFields, validateFormValues, renderFormPage, renderCompletionPage, escapeHtml,
} from '../src/forms.js';

describe('forms: parseFormFields', () => {
  it('acepta string JSON y normaliza valores por defecto', () => {
    const fields = parseFormFields('[{"name":"email","label":"Email","type":"email","required":true}]');
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({ name: 'email', label: 'Email', type: 'email', required: true, placeholder: undefined, options: undefined });
  });

  it('acepta array directamente', () => {
    const fields = parseFormFields([{ name: 'n' }]);
    expect(fields[0].label).toBe('n');      // label cae al name
    expect(fields[0].type).toBe('text');     // type por defecto
    expect(fields[0].required).toBe(false);
  });

  it('descarta entradas inválidas y tipos no permitidos', () => {
    const fields = parseFormFields([
      { name: 'ok', type: 'number' },
      { label: 'sin name' },         // sin name → fuera
      { name: '', type: 'text' },    // name vacío → fuera
      { name: 'raro', type: 'rocket' }, // type inválido → text
    ]);
    expect(fields.map(f => f.name)).toEqual(['ok', 'raro']);
    expect(fields[0].type).toBe('number');
    expect(fields[1].type).toBe('text');
  });

  it('JSON malformado o no-array → []', () => {
    expect(parseFormFields('{ malformado')).toEqual([]);
    expect(parseFormFields('{"a":1}')).toEqual([]);
    expect(parseFormFields(null)).toEqual([]);
  });

  it('dropdown conserva options como strings', () => {
    const [f] = parseFormFields([{ name: 'c', type: 'dropdown', options: ['a', 2, 'c'] }]);
    expect(f.options).toEqual(['a', '2', 'c']);
  });
});

describe('forms: validateFormValues', () => {
  const fields = parseFormFields([
    { name: 'email', label: 'Email', required: true },
    { name: 'nota', label: 'Nota' },
  ]);

  it('marca obligatorios vacíos', () => {
    expect(validateFormValues(fields, {})).toEqual(['"Email" es obligatorio']);
    expect(validateFormValues(fields, { email: '  ' })).toHaveLength(1);
  });

  it('válido cuando el obligatorio está presente', () => {
    expect(validateFormValues(fields, { email: 'a@b.com' })).toEqual([]);
  });
});

describe('forms: escapeHtml', () => {
  it('escapa caracteres peligrosos', () => {
    expect(escapeHtml('<script>"&\'')).toBe('&lt;script&gt;&quot;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
  });
});

describe('forms: renderFormPage', () => {
  const fields = parseFormFields([
    { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'tu@correo' },
    { name: 'msg', label: 'Mensaje', type: 'textarea' },
    { name: 'plan', label: 'Plan', type: 'dropdown', options: ['free', 'pro'] },
  ]);

  it('incluye título, método POST y los controles esperados', () => {
    const html = renderFormPage({ title: 'Contacto', fields, buttonText: 'Mandar' });
    expect(html).toContain('<title>Contacto</title>');
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
    expect(html).toContain('<textarea');
    expect(html).toContain('<select');
    expect(html).toContain('<option value="pro">pro</option>');
    expect(html).toContain('>Mandar<');
    expect(html).toContain('required');
  });

  it('rellena valores y muestra errores en re-render', () => {
    const html = renderFormPage({ fields, values: { email: 'a@b.com', plan: 'pro' }, errors: ['"Email" es obligatorio'] });
    expect(html).toContain('value="a@b.com"');
    expect(html).toContain('<option value="pro" selected>pro</option>');
    expect(html).toContain('class="errors"');
    expect(html).toContain('es obligatorio');
  });

  it('escapa valores para evitar inyección', () => {
    const html = renderFormPage({ fields, values: { email: '"><img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('forms: renderCompletionPage', () => {
  it('usa el mensaje por defecto y el personalizado', () => {
    expect(renderCompletionPage()).toContain('Formulario enviado');
    expect(renderCompletionPage('¡Gracias!')).toContain('¡Gracias!');
  });
});
