import ExcelJS from 'exceljs';
import { isUnsafeKey } from './security.js';

/**
 * Parseo y serialización de CONTENIDO de ficheros (el hueco que la fase 2 cierra: los bytes
 * del store no llegan a jsCode). Funciones puras (sin DB): los nodos `extractFromFile` /
 * `convertToFile` en registry.ts hacen el puente con el binary store.
 *
 * CSV: parser/serializador propios (sin dependencias). XLSX: `exceljs` (mantenido). PDF:
 * `pdf-parse` (extracción de texto). Se reemplazó SheetJS (`xlsx`) por su advisory high sin
 * fix upstream (prototype-pollution + ReDoS), relevante al ingerir ficheros no confiables.
 *
 * Seguridad: al volcar filas tabulares a objetos se descartan claves peligrosas (`__proto__`…).
 */

export type FileFormat = 'csv' | 'xlsx' | 'json' | 'text' | 'pdf';

/** Deriva el formato desde el mimeType / nombre de fichero (modo "auto"). */
export function detectFormat(opts: { mimeType?: string; fileName?: string }): FileFormat {
  const n = (opts.fileName || '').toLowerCase();
  const m = (opts.mimeType || '').toLowerCase();
  if (n.endsWith('.pdf') || m.includes('pdf')) return 'pdf';
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || m.includes('spreadsheet') || m.includes('ms-excel')) return 'xlsx';
  if (n.endsWith('.csv') || m.includes('csv')) return 'csv';
  if (n.endsWith('.json') || m.includes('json')) return 'json';
  return 'text';
}

/** Elimina recursivamente claves peligrosas de objetos/arrays planos. */
function sanitizeKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isUnsafeKey(k)) out[k] = sanitizeKeys(v);
    }
    return out;
  }
  return value;
}

/** Convierte un escalar de celda CSV (siempre string) a número/booleano/null nativo. */
function coerceScalar(s: any): any {
  if (typeof s !== 'string') return s;
  if (s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.trim() !== '' && !isNaN(Number(s))) return Number(s);
  return s;
}

/** Parser CSV propio (RFC-4180: comillas, comillas escapadas "", saltos dentro de comillas). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true; sawAny = true;
    } else if (c === delimiter) {
      row.push(field); field = ''; sawAny = true;
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; sawAny = false;
    } else if (c === '\r') {
      /* parte de \r\n: se ignora */
    } else {
      field += c; sawAny = true;
    }
  }
  if (sawAny || field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Convierte una matriz (filas de celdas) a filas-objeto (con cabecera) o filas-array. */
function matrixToRows(matrix: any[][], hasHeader: boolean, coerce: boolean): any[] {
  const cell = (v: any) => (coerce ? coerceScalar(v) : v);
  if (!hasHeader) return matrix.map(r => r.map(cell));
  if (matrix.length === 0) return [];
  const header = matrix[0].map((h: any) => String(h ?? ''));
  return matrix.slice(1).map(r => {
    const o: Record<string, any> = {};
    header.forEach((h, idx) => { if (h && !isUnsafeKey(h)) o[h] = cell(r[idx] ?? null); });
    return o;
  });
}

export interface ParseOptions {
  format: FileFormat;
  hasHeader?: boolean;
  sheetName?: string;
  delimiter?: string;
}

export interface ParseResult {
  format: FileFormat;
  rows?: any[];
  rowCount?: number;
  json?: any;
  text?: string;
}

/** Parsea un Buffer (formatos SÍNCRONOS: csv/json/text). XLSX/PDF tienen su función async. */
export function parseFileBuffer(buf: Buffer, opts: ParseOptions): ParseResult {
  switch (opts.format) {
    case 'json':
      return { format: 'json', json: sanitizeKeys(JSON.parse(buf.toString('utf8'))) };

    case 'text':
      return { format: 'text', text: buf.toString('utf8') };

    case 'csv': {
      const matrix = parseCsv(buf.toString('utf8'), opts.delimiter || ',');
      const rows = matrixToRows(matrix, opts.hasHeader !== false, true);
      return { format: 'csv', rows, rowCount: rows.length };
    }

    default:
      throw new Error(`parseFileBuffer no soporta "${opts.format}" (usa parseXlsxBuffer/parsePdfBuffer).`);
  }
}

/** Normaliza un valor de celda de exceljs (fechas, fórmulas, rich text, hyperlinks) a escalar. */
function excelCell(v: any): any {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('text' in v) return v.text;            // hyperlink / rich text simple
    if ('result' in v) return v.result;        // fórmula → su resultado
    if ('richText' in v) return v.richText.map((t: any) => t.text).join('');
    return v;
  }
  return v;
}

/** Parsea un XLSX (async) vía exceljs. Devuelve filas-objeto (cabecera) o filas-array. */
export async function parseXlsxBuffer(buf: Buffer, opts: { hasHeader?: boolean; sheetName?: string } = {}): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = (opts.sheetName && wb.getWorksheet(opts.sheetName)) || wb.worksheets[0];
  if (!ws) return { format: 'xlsx', rows: [], rowCount: 0 };
  const matrix: any[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = (row.values as any[]).slice(1).map(excelCell); // values es 1-indexado
    matrix.push(vals);
  });
  const rows = matrixToRows(matrix, opts.hasHeader !== false, false); // exceljs ya da tipos nativos
  return { format: 'xlsx', rows, rowCount: rows.length };
}

export interface SerializeResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/** Escapa una celda para CSV (comillas si contiene separador, comilla o salto). */
function csvCell(v: any): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Serializa filas (array de objetos o de arrays) a texto CSV. */
export function toCsv(rows: any[]): string {
  if (!rows.length) return '';
  const isObjs = typeof rows[0] === 'object' && !Array.isArray(rows[0]);
  if (isObjs) {
    const headers = [...new Set(rows.flatMap(r => Object.keys(r || {})))];
    const lines = [headers.map(csvCell).join(',')];
    for (const r of rows) lines.push(headers.map(h => csvCell((r || {})[h])).join(','));
    return lines.join('\n');
  }
  return rows.map(r => (Array.isArray(r) ? r : [r]).map(csvCell).join(',')).join('\n');
}

/** Serializa datos a CSV/JSON/texto (SÍNCRONO). XLSX usa serializeXlsxFile (async). */
export function serializeToFile(opts: { format: Exclude<FileFormat, 'xlsx' | 'pdf'>; data: any }): SerializeResult {
  const { format, data } = opts;
  if (format === 'json') {
    return { buffer: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), mimeType: 'application/json', ext: 'json' };
  }
  if (format === 'text') {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return { buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain', ext: 'txt' };
  }
  if (format === 'csv') {
    const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
    return { buffer: Buffer.from(toCsv(rows), 'utf8'), mimeType: 'text/csv', ext: 'csv' };
  }
  throw new Error(`serializeToFile no soporta "${format}".`);
}

/** Serializa filas a un XLSX (async) vía exceljs. */
export async function serializeXlsxFile(data: any, sheetName = 'Sheet1'): Promise<SerializeResult> {
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  const headers = [...new Set(rows.flatMap((r: any) => Object.keys(r || {})))];
  if (headers.length) {
    ws.columns = headers.map(h => ({ header: h, key: h }));
    for (const r of rows) ws.addRow(r);
  }
  const out = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer: out, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
}

/**
 * Extrae el TEXTO de un PDF (async; pdf-parse v2 sobre pdf.js). Texto por páginas unido +
 * número de páginas. Solo extracción.
 */
export async function parsePdfBuffer(buf: Buffer): Promise<{ format: 'pdf'; text: string; pages: number }> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const r: any = await parser.getText();
    const text = Array.isArray(r.pages) ? r.pages.map((p: any) => p.text).join('\n\n') : (r.text || '');
    return { format: 'pdf', text, pages: r.total ?? (Array.isArray(r.pages) ? r.pages.length : 0) };
  } finally {
    try { await (parser as any).destroy?.(); } catch { /* noop */ }
  }
}
