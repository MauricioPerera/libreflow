import * as XLSX from 'xlsx';
import { isUnsafeKey } from './security.js';

/**
 * Parseo y serialización de CONTENIDO de ficheros (el hueco que la fase 2 cierra: los bytes
 * del store no llegan a jsCode). Funciones puras (sin DB): los nodos `extractFromFile` /
 * `convertToFile` en registry.ts hacen el puente con el binary store. SheetJS cubre CSV y
 * XLSX en ambos sentidos; JSON/texto son JS puro.
 *
 * Seguridad: al volcar filas tabulares a objetos se descartan claves peligrosas
 * (`__proto__`, etc.) — mitiga el prototype-pollution conocido de SheetJS 0.18.x.
 */

export type FileFormat = 'csv' | 'xlsx' | 'json' | 'text';

/** Deriva el formato desde el mimeType / nombre de fichero (modo "auto"). */
export function detectFormat(opts: { mimeType?: string; fileName?: string }): FileFormat {
  const n = (opts.fileName || '').toLowerCase();
  const m = (opts.mimeType || '').toLowerCase();
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

export interface ParseOptions {
  format: FileFormat;
  hasHeader?: boolean;   // tabular: true → filas como objetos (cabecera = claves); false → arrays
  sheetName?: string;    // xlsx: hoja a leer (por defecto la primera)
  delimiter?: string;    // csv: separador (por defecto ',')
}

export interface ParseResult {
  format: FileFormat;
  rows?: any[];          // csv/xlsx
  rowCount?: number;     // csv/xlsx
  json?: any;            // json
  text?: string;         // text
}

/** Parsea un Buffer al formato indicado y devuelve datos estructurados. */
export function parseFileBuffer(buf: Buffer, opts: ParseOptions): ParseResult {
  switch (opts.format) {
    case 'json':
      return { format: 'json', json: sanitizeKeys(JSON.parse(buf.toString('utf8'))) };

    case 'text':
      return { format: 'text', text: buf.toString('utf8') };

    case 'csv':
    case 'xlsx': {
      const readOpts: XLSX.ParsingOptions = { type: 'buffer' };
      if (opts.format === 'csv' && opts.delimiter) (readOpts as any).FS = opts.delimiter;
      const wb = XLSX.read(buf, readOpts);
      const sheetName = (opts.sheetName && wb.Sheets[opts.sheetName]) ? opts.sheetName : wb.SheetNames[0];
      const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
      if (!sheet) return { format: opts.format, rows: [], rowCount: 0 };
      const hasHeader = opts.hasHeader !== false;
      const rowsRaw = XLSX.utils.sheet_to_json(sheet, {
        header: hasHeader ? undefined : 1,
        defval: null,
        raw: true, // conserva tipos nativos (números como números, no strings)
      });
      const rows = sanitizeKeys(rowsRaw);
      return { format: opts.format, rows, rowCount: rows.length };
    }

    default:
      throw new Error(`Formato de fichero no soportado: ${opts.format}`);
  }
}

export interface SerializeResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/** Convierte datos JS a un Buffer del formato indicado (para guardar como binario). */
export function serializeToFile(opts: { format: FileFormat; data: any; sheetName?: string }): SerializeResult {
  const { format, data } = opts;

  if (format === 'json') {
    return { buffer: Buffer.from(JSON.stringify(data, null, 2), 'utf8'), mimeType: 'application/json', ext: 'json' };
  }

  if (format === 'text') {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return { buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain', ext: 'txt' };
  }

  // csv / xlsx esperan filas: un array de objetos (o de arrays). Un objeto suelto se envuelve.
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
  const ws = XLSX.utils.json_to_sheet(rows);

  if (format === 'csv') {
    return { buffer: Buffer.from(XLSX.utils.sheet_to_csv(ws), 'utf8'), mimeType: 'text/csv', ext: 'csv' };
  }

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, opts.sheetName || 'Sheet1');
    const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return {
      buffer: out,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ext: 'xlsx',
    };
  }

  throw new Error(`Formato de salida no soportado: ${format}`);
}
