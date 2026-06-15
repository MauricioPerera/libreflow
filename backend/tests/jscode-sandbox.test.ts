import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';

// El nodo jsCode corre en isolated-vm: sin acceso al host (require/process/fs/red),
// con memoria y tiempo acotados. Estos tests prueban el aislamiento real.
const engine = new WorkflowEngine();

async function runCode(code: string, extra: any[] = []) {
  const workflow = {
    id: 'wf-js',
    nodes: [
      { id: 't', type: 'trigger', name: 'Start', parameters: {} },
      ...extra,
      { id: 'js', type: 'jsCode', name: 'Code', parameters: { code } },
    ],
    connections: [
      { source: 't', target: extra[0]?.id || 'js' },
      ...(extra.length ? [{ source: extra[extra.length - 1].id, target: 'js' }] : []),
    ],
  };
  return engine.execute(workflow as any);
}

describe('jsCode sandbox (isolated-vm)', () => {
  it('ejecuta código y devuelve el resultado', async () => {
    const r = await runCode('return { sum: [1,2,3].reduce((a,b)=>a+b,0) };');
    expect(r.nodeResults['js'].status).toBe('success');
    expect(r.nodeResults['js'].output).toEqual({ sum: 6 });
  });

  it('NO tiene acceso a process (host)', async () => {
    const r = await runCode('return { hasProcess: typeof process };');
    expect(r.nodeResults['js'].output).toEqual({ hasProcess: 'undefined' });
  });

  it('NO puede require módulos de Node', async () => {
    const r = await runCode('return { hasRequire: typeof require };');
    expect(r.nodeResults['js'].output).toEqual({ hasRequire: 'undefined' });
  });

  it('expone $node con las salidas previas (copia)', async () => {
    const r = await runCode(
      'return { msg: $node.SetValue.output.msg };',
      [{ id: 'sv', type: 'set', name: 'SetValue', parameters: { values: [{ key: 'msg', value: 'hola' }] } }],
    );
    expect(r.nodeResults['js'].output).toEqual({ msg: 'hola' });
  });

  it('corta por timeout un bucle infinito', async () => {
    const prev = process.env.LF_JS_TIMEOUT_MS;
    process.env.LF_JS_TIMEOUT_MS = '300';
    try {
      const r = await runCode('while (true) {}\nreturn {};');
      expect(r.nodeResults['js'].status).toBe('failed');
      expect(r.nodeResults['js'].error || '').toMatch(/timed out/i);
    } finally {
      if (prev === undefined) delete process.env.LF_JS_TIMEOUT_MS;
      else process.env.LF_JS_TIMEOUT_MS = prev;
    }
  });

  it('mutar el contexto inyectado no afecta el estado real (es copia)', async () => {
    // Si $node fuese una referencia viva, esto corrompería la salida de SetValue.
    const r = await runCode(
      '$node.SetValue.output.msg = "HACKED"; return { ok: true };',
      [{ id: 'sv', type: 'set', name: 'SetValue', parameters: { values: [{ key: 'msg', value: 'original' }] } }],
    );
    expect(r.nodeResults['js'].status).toBe('success');
    expect(r.nodeResults['sv'].output).toEqual({ msg: 'original' });
  });
});
