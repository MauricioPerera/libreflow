import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  StreamTriggerManager,
  parseSseEvent,
  parseMaybeJson,
  type StreamTriggerConfig,
} from '../src/streamTriggers.js';

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const baseCfg: StreamTriggerConfig = {
  workflowId: 'wf1', workflowName: 'WF', nodeId: 'n1', transport: 'sse',
};

describe('parsers', () => {
  it('parseMaybeJson devuelve objeto si es JSON, string si no', () => {
    expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseMaybeJson('hola')).toBe('hola');
  });

  it('parseSseEvent junta líneas data y lee event', () => {
    expect(parseSseEvent('event: ping\ndata: {"x":1}')).toEqual({ event: 'ping', data: '{"x":1}' });
    expect(parseSseEvent('data: a\ndata: b')).toEqual({ event: undefined, data: 'a\nb' });
    expect(parseSseEvent(': comentario\ndata: x')).toEqual({ event: undefined, data: 'x' });
    expect(parseSseEvent(': solo comentario')).toBeNull();
  });
});

describe('StreamTriggerManager (transporte falso)', () => {
  it('dispara el flujo por cada mensaje con el payload correcto', async () => {
    const fired: any[] = [];
    const fakeTransport = (_cfg: any, onMessage: any) => {
      setTimeout(() => onMessage({ hello: 'world' }), 0);
      return { close: () => {} };
    };
    const mgr = new StreamTriggerManager({
      transports: { sse: fakeTransport as any },
      fire: (cfg, msg) => { fired.push({ cfg, msg }); },
    });
    mgr.start(baseCfg);
    await waitFor(() => fired.length > 0);
    expect(fired[0].msg).toEqual({ hello: 'world' });
    expect(fired[0].cfg.workflowId).toBe('wf1');
    mgr.stopAll();
  });

  it('reconecta con backoff cuando la conexión cae', async () => {
    let connects = 0;
    const flaky = (_cfg: any, _onMessage: any, onClosed: any) => {
      connects++;
      setTimeout(() => onClosed(new Error('drop')), 0);
      return { close: () => {} };
    };
    const mgr = new StreamTriggerManager({
      transports: { sse: flaky as any },
      fire: () => {},
      backoff: { baseMs: 5, maxMs: 20 },
    });
    mgr.start(baseCfg);
    await waitFor(() => connects >= 3, 1500);
    expect(connects).toBeGreaterThanOrEqual(3);
    mgr.stopAll();
  });

  it('stopWorkflow cierra la conexión y no reconecta', async () => {
    let connects = 0;
    const closeSpy = vi.fn();
    const transport = (_cfg: any, _onMessage: any, onClosed: any) => {
      connects++;
      // Cierra tras 30ms para provocar reconexión si no se ha parado.
      setTimeout(() => onClosed(), 30);
      return { close: closeSpy };
    };
    const mgr = new StreamTriggerManager({
      transports: { sse: transport as any },
      fire: () => {},
      backoff: { baseMs: 5, maxMs: 10 },
    });
    mgr.start(baseCfg);
    await waitFor(() => connects >= 1);
    expect(mgr.activeCount()).toBe(1);
    mgr.stopWorkflow('wf1');
    expect(closeSpy).toHaveBeenCalled();
    expect(mgr.activeCount()).toBe(0);
    const after = connects;
    await new Promise((r) => setTimeout(r, 50));
    expect(connects).toBe(after); // no más reconexiones tras stop
  });
});

describe('Adaptador SSE (servidor real)', () => {
  it('lee eventos SSE de un servidor y dispara el flujo', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: tick\ndata: {"n":1}\n\n');
      res.write(': comentario\n\n');
      res.write('data: texto plano\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;

    const fired: any[] = [];
    const mgr = new StreamTriggerManager({ fire: (_cfg, msg) => { fired.push(msg); } });
    mgr.start({ ...baseCfg, transport: 'sse', url: `http://127.0.0.1:${port}/` });

    try {
      await waitFor(() => fired.length >= 2, 3000);
      expect(fired[0]).toEqual({ event: 'tick', data: { n: 1 } });
      expect(fired[1]).toEqual({ event: undefined, data: 'texto plano' });
    } finally {
      mgr.stopAll();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('Adaptador WebSocket (servidor real)', () => {
  it('recibe mensajes WS y dispara el flujo', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ msg: 'hi' }));
      ws.send('plain');
    });
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const port = (wss.address() as any).port;

    const fired: any[] = [];
    const mgr = new StreamTriggerManager({ fire: (_cfg, msg) => { fired.push(msg); } });
    mgr.start({ ...baseCfg, transport: 'websocket', url: `ws://127.0.0.1:${port}/` });

    try {
      await waitFor(() => fired.length >= 2, 3000);
      expect(fired[0]).toEqual({ msg: 'hi' });
      expect(fired[1]).toBe('plain');
    } finally {
      mgr.stopAll();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
