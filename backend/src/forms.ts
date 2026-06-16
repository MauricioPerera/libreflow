/**
 * Formularios web del trigger `form`: genera la página HTML pública del formulario y la
 * página de finalización, y normaliza la definición de campos. Las rutas viven en
 * server.ts (`GET/POST /form/:workflowId`); aquí solo está el render + el parseo, sin
 * estado ni acceso a DB (igual de testeable que binary.ts / oauth2.ts).
 */

export interface FormFieldDef {
  name: string;
  label: string;
  type: 'text' | 'email' | 'number' | 'date' | 'password' | 'textarea' | 'dropdown';
  required: boolean;
  placeholder?: string;
  options?: string[];
}

const ALLOWED_TYPES = new Set(['text', 'email', 'number', 'date', 'password', 'textarea', 'dropdown']);

/** Escapa texto para insertarlo de forma segura en HTML (atributos y contenido). */
export function escapeHtml(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** Normaliza la definición de campos (acepta string JSON o array). Descarta lo inválido. */
export function parseFormFields(raw: any): FormFieldDef[] {
  let arr: any = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw || '[]'); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out: FormFieldDef[] = [];
  for (const f of arr) {
    if (!f || typeof f.name !== 'string' || !f.name) continue;
    const type = ALLOWED_TYPES.has(f.type) ? f.type : 'text';
    out.push({
      name: f.name,
      label: typeof f.label === 'string' && f.label ? f.label : f.name,
      type,
      required: !!f.required,
      placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
      options: Array.isArray(f.options) ? f.options.map((o: any) => String(o)) : undefined,
    });
  }
  return out;
}

export interface FormPageOptions {
  title?: string;
  description?: string;
  buttonText?: string;
  fields: FormFieldDef[];
  values?: Record<string, any>;   // valores a rellenar (re-render tras error)
  errors?: string[];              // mensajes de error a mostrar
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f5f7; color: #1a1a2e; padding: 24px; }
  .card { width: 100%; max-width: 520px; background: #fff; border-radius: 14px; padding: 32px;
    box-shadow: 0 10px 40px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; margin: 0 0 6px; }
  p.desc { color: #555; margin: 0 0 20px; }
  label { display: block; font-weight: 600; font-size: .9rem; margin: 16px 0 6px; }
  .req { color: #d33; }
  input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid #cdd0d6; border-radius: 8px;
    font-size: 1rem; font-family: inherit; background: #fff; color: inherit; }
  textarea { min-height: 96px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #7033ff; box-shadow: 0 0 0 3px rgba(112,51,255,.15); }
  button { margin-top: 24px; width: 100%; padding: 12px; border: 0; border-radius: 8px; cursor: pointer;
    font-size: 1rem; font-weight: 600; color: #fff; background: linear-gradient(135deg, #7033ff, #00aaff); }
  button:hover { filter: brightness(1.05); }
  .errors { background: #fde8e8; color: #b42318; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: .9rem; }
  .errors ul { margin: 4px 0 0; padding-left: 18px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16161f; color: #e8e8ef; }
    .card { background: #1e1e2a; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
    p.desc { color: #a8a8b8; }
    input, textarea, select { background: #2a2a38; border-color: #3a3a4a; }
  }
`;

function renderField(f: FormFieldDef, value: any): string {
  const id = `f_${escapeHtml(f.name)}`;
  const req = f.required ? ' required' : '';
  const reqMark = f.required ? ' <span class="req">*</span>' : '';
  const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  const val = value !== undefined && value !== null ? escapeHtml(value) : '';
  let control: string;

  if (f.type === 'textarea') {
    control = `<textarea id="${id}" name="${escapeHtml(f.name)}"${ph}${req}>${val}</textarea>`;
  } else if (f.type === 'dropdown') {
    const opts = (f.options || []).map(o => {
      const sel = String(value) === o ? ' selected' : '';
      return `<option value="${escapeHtml(o)}"${sel}>${escapeHtml(o)}</option>`;
    }).join('');
    control = `<select id="${id}" name="${escapeHtml(f.name)}"${req}><option value="">—</option>${opts}</select>`;
  } else {
    control = `<input id="${id}" name="${escapeHtml(f.name)}" type="${escapeHtml(f.type)}" value="${val}"${ph}${req} />`;
  }

  return `<label for="${id}">${escapeHtml(f.label)}${reqMark}</label>${control}`;
}

/** Renderiza la página HTML del formulario. */
export function renderFormPage(opts: FormPageOptions): string {
  const title = escapeHtml(opts.title || 'Formulario');
  const desc = opts.description ? `<p class="desc">${escapeHtml(opts.description)}</p>` : '';
  const button = escapeHtml(opts.buttonText || 'Enviar');
  const values = opts.values || {};
  const errorBlock = (opts.errors && opts.errors.length)
    ? `<div class="errors">Revisa el formulario:<ul>${opts.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';
  const fields = opts.fields.map(f => renderField(f, values[f.name])).join('\n');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title><style>${PAGE_STYLE}</style></head>
<body><div class="card"><h1>${title}</h1>${desc}
<form method="POST" autocomplete="on">${errorBlock}${fields}
<button type="submit">${button}</button></form></div></body></html>`;
}

/** Renderiza la página de finalización por defecto (cuando no hay nodo `respond`). */
export function renderCompletionPage(message?: string): string {
  const msg = escapeHtml(message || '¡Formulario enviado correctamente!');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Enviado</title><style>${PAGE_STYLE}</style></head>
<body><div class="card"><h1>✓ Listo</h1><p class="desc">${msg}</p></div></body></html>`;
}

/**
 * Valida los valores recibidos contra la definición de campos. Devuelve los errores
 * (campos obligatorios vacíos) — vacío = válido.
 */
export function validateFormValues(fields: FormFieldDef[], values: Record<string, any>): string[] {
  const errors: string[] = [];
  for (const f of fields) {
    if (f.required) {
      const v = values[f.name];
      if (v === undefined || v === null || String(v).trim() === '') {
        errors.push(`"${f.label}" es obligatorio`);
      }
    }
  }
  return errors;
}
