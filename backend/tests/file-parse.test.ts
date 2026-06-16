import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, getBinary } from '../src/db.js';
import { isBinaryRef, storeBinary } from '../src/binary.js';
import { WorkflowEngine } from '../src/engine.js';
import { detectFormat, parseFileBuffer, serializeToFile, parsePdfBuffer } from '../src/fileParse.js';

// PDF mínimo válido con el texto "Hola PDF" (un solo objeto de página).
const MINIMAL_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgoxMDAgNzAwIFRkCihIb2xhIFBERikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDUgMDAwMDAgbiAKMDAwMDAwMDMxNyAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjQxMQolJUVPRgo';
const MINIMAL_PDF = Buffer.from(MINIMAL_PDF_B64, 'base64');

describe('fileParse: detectFormat', () => {
  it('detecta por extensión y mime', () => {
    expect(detectFormat({ fileName: 'datos.xlsx' })).toBe('xlsx');
    expect(detectFormat({ fileName: 'datos.csv' })).toBe('csv');
    expect(detectFormat({ fileName: 'datos.json' })).toBe('json');
    expect(detectFormat({ fileName: 'notas.md' })).toBe('text');
    expect(detectFormat({ mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBe('xlsx');
    expect(detectFormat({ mimeType: 'text/csv' })).toBe('csv');
    expect(detectFormat({ mimeType: 'application/json' })).toBe('json');
    expect(detectFormat({})).toBe('text');
  });
});

describe('fileParse: parse/serialize puros', () => {
  it('JSON: parsea y descarta claves peligrosas', () => {
    const r = parseFileBuffer(Buffer.from('{"a":1,"__proto__":{"x":1},"nested":{"constructor":2,"ok":3}}', 'utf8'), { format: 'json' });
    expect(r.json).toEqual({ a: 1, nested: { ok: 3 } });
  });

  it('texto: devuelve el contenido tal cual', () => {
    const r = parseFileBuffer(Buffer.from('hola\nmundo', 'utf8'), { format: 'text' });
    expect(r.text).toBe('hola\nmundo');
  });

  it('CSV round-trip: objetos con cabecera y tipos nativos', () => {
    const { buffer, ext, mimeType } = serializeToFile({ format: 'csv', data: [{ nombre: 'Ada', edad: 36 }, { nombre: 'Alan', edad: 41 }] });
    expect(ext).toBe('csv');
    expect(mimeType).toBe('text/csv');
    const r = parseFileBuffer(buffer, { format: 'csv' });
    expect(r.rowCount).toBe(2);
    expect(r.rows).toEqual([{ nombre: 'Ada', edad: 36 }, { nombre: 'Alan', edad: 41 }]);
  });

  it('CSV sin cabecera: filas como arrays', () => {
    const r = parseFileBuffer(Buffer.from('a,b\n1,2', 'utf8'), { format: 'csv', hasHeader: false });
    expect(r.rows).toEqual([['a', 'b'], [1, 2]]);
  });

  it('XLSX round-trip: serializa y vuelve a leer', () => {
    const { buffer, ext } = serializeToFile({ format: 'xlsx', data: [{ id: 1, ok: true }, { id: 2, ok: false }], sheetName: 'Hoja' });
    expect(ext).toBe('xlsx');
    const r = parseFileBuffer(buffer, { format: 'xlsx' });
    expect(r.rows).toEqual([{ id: 1, ok: true }, { id: 2, ok: false }]);
  });

  it('XLSX respeta el nombre de hoja al leer', () => {
    const { buffer } = serializeToFile({ format: 'xlsx', data: [{ v: 9 }], sheetName: 'MiHoja' });
    const r = parseFileBuffer(buffer, { format: 'xlsx', sheetName: 'MiHoja' });
    expect(r.rows).toEqual([{ v: 9 }]);
  });

  it('JSON serialize: objeto suelto', () => {
    const { buffer, ext, mimeType } = serializeToFile({ format: 'json', data: { a: 1 } });
    expect(ext).toBe('json');
    expect(mimeType).toBe('application/json');
    expect(JSON.parse(buffer.toString('utf8'))).toEqual({ a: 1 });
  });

  it('detectFormat reconoce PDF', () => {
    expect(detectFormat({ fileName: 'doc.pdf' })).toBe('pdf');
    expect(detectFormat({ mimeType: 'application/pdf' })).toBe('pdf');
  });

  it('parsePdfBuffer extrae el texto', async () => {
    const r = await parsePdfBuffer(MINIMAL_PDF);
    expect(r.format).toBe('pdf');
    expect(r.pages).toBe(1);
    expect(r.text).toContain('Hola PDF');
  });
});

describe('Nodos extractFromFile / convertToFile (end-to-end por el motor + store)', () => {
  beforeAll(async () => { await initDatabase(); });
  const engine = new WorkflowEngine();

  it('convertToFile (xlsx) -> extractFromFile (auto) recupera las filas', async () => {
    const rows = [{ nombre: 'Ada', edad: 36 }, { nombre: 'Alan', edad: 41 }];
    const workflow = {
      id: 'wf-files',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'conv', type: 'convertToFile', name: 'Convert', parameters: {
          format: 'xlsx', data: '{{ $node.Start.output.payload.rows }}', fileName: 'datos',
        } },
        { id: 'ext', type: 'extractFromFile', name: 'Extract', parameters: {
          source: '{{ $node.Convert.output }}', format: 'auto',
        } },
      ],
      connections: [
        { source: 't', target: 'conv' },
        { source: 'conv', target: 'ext' },
      ],
    };

    const report = await engine.execute(workflow as any, { rows }, { executionId: 'exec-files' });
    expect(report.success).toBe(true);

    // convertToFile devuelve una referencia de binario válida (.xlsx).
    const ref = report.nodeResults['conv'].output;
    expect(isBinaryRef(ref)).toBe(true);
    expect(ref.fileName).toBe('datos.xlsx');
    const stored = await getBinary(ref._lfBinary);
    expect(stored).toBeTruthy();

    // extractFromFile recupera exactamente las filas originales.
    expect(report.nodeResults['ext'].output.rowCount).toBe(2);
    expect(report.nodeResults['ext'].output.rows).toEqual(rows);
  });

  it('extractFromFile (pdf/auto) extrae el texto de un PDF del store', async () => {
    const ref = await storeBinary(MINIMAL_PDF, { executionId: 'exec-pdf', fileName: 'doc.pdf', mimeType: 'application/pdf' });
    const workflow = {
      id: 'wf-pdf',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'ext', type: 'extractFromFile', name: 'Extract', parameters: { source: '{{ $node.Start.output.payload.ref }}', format: 'auto' } },
      ],
      connections: [{ source: 't', target: 'ext' }],
    };
    const report = await engine.execute(workflow as any, { ref }, { executionId: 'exec-pdf' });
    expect(report.success).toBe(true);
    expect(report.nodeResults['ext'].output.format).toBe('pdf');
    expect(report.nodeResults['ext'].output.text).toContain('Hola PDF');
  });

  it('extractFromFile falla claro si source no es un binario', async () => {
    const workflow = {
      id: 'wf-files-bad',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'ext', type: 'extractFromFile', name: 'Extract', parameters: { source: 'no-soy-binario', format: 'auto' } },
      ],
      connections: [{ source: 't', target: 'ext' }],
    };
    const report = await engine.execute(workflow as any, {}, { executionId: 'exec-files-bad' });
    expect(report.success).toBe(false);
    expect(report.nodeResults['ext'].status).toBe('failed');
    expect(report.nodeResults['ext'].error).toMatch(/referencia de binario/);
  });
});
