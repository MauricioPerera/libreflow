import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { NodeRegistry } from '../src/registry.js';

// Nodo con contador para PROBAR que un nodo fijado (pinData) no se ejecuta.
let runs = 0;
NodeRegistry.register({
  type: 'pinTest',
  displayName: 'Pin Test',
  category: 'Utility',
  icon: 'P',
  description: 'Cuenta ejecuciones (fixture de pin).',
  ui: { inputs: [{ id: 'main' }], outputs: [{ id: 'main' }] },
  parameters: [],
  execute: async () => { runs++; return { real: true, n: runs }; },
} as any);

const engine = new WorkflowEngine();

const wf = (pin?: any) => ({
  id: 'wf-pin',
  nodes: [
    { id: 't', type: 'trigger', name: 'Start', parameters: {} },
    { id: 'p', type: 'pinTest', name: 'Pinned', parameters: {}, ...(pin !== undefined ? { pinData: pin } : {}) },
    { id: 'out', type: 'set', name: 'Out', parameters: { values: [{ key: 'seen', value: '{{ $node.Pinned.output.real }}' }] } },
  ],
  connections: [
    { source: 't', target: 'p' },
    { source: 'p', target: 'out' },
  ],
});

describe('Engine pin data', () => {
  beforeEach(() => { runs = 0; });

  it('en run manual (usePinData) usa pinData y NO ejecuta el nodo', async () => {
    const r = await engine.execute(wf({ real: false, pinned: 'yes' }) as any, {}, { usePinData: true });
    expect(runs).toBe(0);
    expect(r.nodeResults['p'].pinned).toBe(true);
    expect(r.nodeResults['p'].output).toEqual({ real: false, pinned: 'yes' });
    expect(r.nodeResults['out'].output).toEqual({ seen: false }); // aguas abajo leyó la salida fijada
  });

  it('en producción (sin usePinData) ignora pinData y ejecuta el nodo', async () => {
    const r = await engine.execute(wf({ real: false }) as any, {}, {});
    expect(runs).toBe(1);
    expect(r.nodeResults['p'].pinned).toBeFalsy();
    expect(r.nodeResults['p'].output).toMatchObject({ real: true });
  });

  it('sin pinData ejecuta normal aunque usePinData esté activo', async () => {
    const r = await engine.execute(wf(undefined) as any, {}, { usePinData: true });
    expect(runs).toBe(1);
  });

  it('pin en un nodo if enruta según la salida fijada (solo la rama true)', async () => {
    const wfIf = {
      id: 'wf-if',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'if', type: 'if', name: 'Cond', parameters: {}, pinData: { result: true } },
        { id: 'a', type: 'set', name: 'A', parameters: { values: [{ key: 'b', value: 'A' }] } },
        { id: 'b', type: 'set', name: 'B', parameters: { values: [{ key: 'b', value: 'B' }] } },
      ],
      connections: [
        { source: 't', target: 'if' },
        { source: 'if', target: 'a', sourceHandle: 'true' },
        { source: 'if', target: 'b', sourceHandle: 'false' },
      ],
    };
    const r = await engine.execute(wfIf as any, {}, { usePinData: true });
    expect(r.nodeResults['if'].pinned).toBe(true);
    expect(r.nodeResults['a'].status).toBe('success');
    expect(r.nodeResults['b'].status).toBe('skipped');
  });
});
