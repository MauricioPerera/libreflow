import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { initDatabase, getBinary } from '../src/db.js';
import { isBinaryRef, storeBinary, MAX_BINARY_BYTES } from '../src/binary.js';
import { WorkflowEngine } from '../src/engine.js';

// Bytes binarios reales (cabecera PNG + bytes no-UTF8) para probar fidelidad.
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255, 254, 250]);

let server: http.Server;
let port = 0;
let lastUploadBody: Buffer | null = null;

beforeAll(async () => {
  await initDatabase();
  server = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(BYTES);
    } else if (req.url === '/upload' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { lastUploadBody = Buffer.concat(chunks); res.writeHead(200); res.end('ok'); });
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Binary store', () => {
  it('isBinaryRef detecta referencias', () => {
    expect(isBinaryRef({ _lfBinary: 'x', size: 1 })).toBe(true);
    expect(isBinaryRef({ foo: 1 })).toBe(false);
    expect(isBinaryRef('str')).toBe(false);
    expect(isBinaryRef(null)).toBe(false);
  });

  it('storeBinary -> getBinary conserva los bytes y metadatos', async () => {
    const ref = await storeBinary(BYTES, { executionId: 'exec-test', fileName: 'a.png', mimeType: 'image/png' });
    expect(ref._lfBinary).toMatch(/^bin-/);
    expect(ref.size).toBe(BYTES.length);
    const got = await getBinary(ref._lfBinary);
    expect(got).toBeTruthy();
    expect(Buffer.from(got!.data).equals(BYTES)).toBe(true);
    expect(got!.mime_type).toBe('image/png');
    expect(got!.file_name).toBe('a.png');
  });

  it('storeBinary rechaza por encima del tope', async () => {
    const tooBig = Buffer.alloc(MAX_BINARY_BYTES + 1);
    await expect(storeBinary(tooBig)).rejects.toThrow(/tope/i);
  });
});

describe('httpRequest binario (descarga + subida) end-to-end', () => {
  const engine = new WorkflowEngine();

  it('descarga a una referencia y luego la sube intacta', async () => {
    lastUploadBody = null;
    const workflow = {
      id: 'wf-bin',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'dl', type: 'httpRequest', name: 'Download', parameters: {
          url: `http://127.0.0.1:${port}/file`, method: 'GET', responseFormat: 'binary',
        } },
        { id: 'up', type: 'httpRequest', name: 'Upload', parameters: {
          url: `http://127.0.0.1:${port}/upload`, method: 'POST', bodyType: 'binary',
          body: '{{ $node.Download.output.body }}',
        } },
      ],
      connections: [
        { source: 't', target: 'dl' },
        { source: 'dl', target: 'up' },
      ],
    };

    const report = await engine.execute(workflow as any, {}, { executionId: 'exec-bin' });
    expect(report.success).toBe(true);

    // La salida de Download es una referencia de binario.
    const ref = report.nodeResults['dl'].output.body;
    expect(isBinaryRef(ref)).toBe(true);
    expect(ref.mimeType).toBe('image/png');

    // Los bytes guardados coinciden con los servidos.
    const stored = await getBinary(ref._lfBinary);
    expect(Buffer.from(stored!.data).equals(BYTES)).toBe(true);

    // La subida envió exactamente esos bytes (no base64, no corrupción).
    expect(lastUploadBody).toBeTruthy();
    expect(lastUploadBody!.equals(BYTES)).toBe(true);
  });
});
