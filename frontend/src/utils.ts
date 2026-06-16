/**
 * Helpers puros extraídos de App.vue (sin estado reactivo) — testeables de forma aislada.
 * Primer paso para trocear el monolito: la lógica pura sale aquí con su red de tests antes
 * de extraer componentes mayores.
 */

/** Claves bloqueadas al escribir rutas anidadas (anti prototype-pollution). */
export const UNSAFE_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Etiqueta legible para el estado de una ejecución. */
export function statusLabel(status: string): string {
  return ({
    success: 'Éxito',
    failed: 'Fallo',
    running: 'En curso',
    waiting: 'En espera',
  } as Record<string, string>)[status] || status;
}

/** URL pública del servidor MCP nombrado, derivada del origen actual del navegador. */
export function mcpServerUrl(id: string): string {
  return `${window.location.origin}/mcp/${id}`;
}

/** Etiqueta legible para el tipo de una credencial. */
export function credentialTypeLabel(type: string): string {
  return ({
    basicAuth: 'Basic Auth (Usuario/Contraseña)',
    oauth2: 'OAuth2 (token + refresh)',
    apiKey: 'API Key (Token de Cabecera/Query)',
  } as Record<string, string>)[type] || 'API Key (Token de Cabecera/Query)';
}

/** Formatea una fecha ISO a "dd/mm/aaaa hh:mm:ss" local; devuelve la entrada si no parsea. */
export function formatFullDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
  } catch {
    return dateStr;
  }
}

/**
 * Escribe `value` en `obj` siguiendo una ruta con puntos, creando objetos/arrays intermedios.
 * Bloquea rutas con claves peligrosas. Muta `obj` (igual que el original).
 */
export function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  if (parts.some(p => UNSAFE_PATH_KEYS.has(p))) {
    console.warn('[LibreFlow] Blocked unsafe parameter path:', path);
    return;
  }
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    if (current[part] === undefined) {
      current[part] = isNaN(Number(nextPart)) ? {} : [];
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/** Normaliza la definición de columnas (acepta string JSON o array). */
export function parseJsonColumns(cols: any): any[] {
  if (typeof cols === 'string') {
    try {
      return JSON.parse(cols);
    } catch {
      return [];
    }
  }
  return cols || [];
}

/** Convierte los valores de una fila al tipo declarado por sus columnas (number/boolean). */
export function coerceRowByColumns(data: Record<string, any>, columns: any[]): Record<string, any> {
  const out: Record<string, any> = { ...data };
  for (const col of columns || []) {
    const v = out[col.name];
    if (v === undefined || v === null) continue;
    if (col.type === 'number') {
      out[col.name] = v === '' ? null : Number(v);
    } else if (col.type === 'boolean') {
      out[col.name] = v === true || v === 'true' || v === 1 || v === '1';
    }
  }
  return out;
}
