import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine, descendantsOf, buildRerunResume } from '../src/engine.js';
import { NodeRegistry } from '../src/registry.js';

// Nodo contador (por etiqueta) para probar qué nodos se re-ejecutan en un re-run.
const counters: Record<string, number> = {};
NodeRegistry.register({
  type: 'rerunCounter',
  displayName: 'Rerun Counter',
  category: 'Utility',
  icon: 'C',
  description: 'Cuenta ejecuciones por etiqueta (fixture de re-run).',
  ui: { inputs: [{ id: 'main' }], outputs: [{ id: 'main' }] },
  parameters: [],
  execute: async (params: any) => { const t = params.tag; counters[t] = (counters[t] || 0) + 1; return { n: counters[t], tag: t }; },
} as any);

const engine = new WorkflowEngine();

const chain = {
  id: 'wf-rerun',
  nodes: [
    { id: 't', type: 'trigger', name: 'Start', parameters: {} },
    { id: 'a', type: 'rerunCounter', name: 'A', parameters: { tag: 'a' } },
    { id: 'b', type: 'rerunCounter', name: 'B', parameters: { tag: 'b' } },
    { id: 'c', type: 'rerunCounter', name: 'C', parameters: { tag: 'c' } },
  ],
  connections: [
    { source: 't', target: 'a' },
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

describe('descendantsOf', () => {
  it('incluye el nodo y todo lo de aguas abajo', () => {
    expect(descendantsOf(chain as any, 'b')).toEqual(new Set(['b', 'c']));
    expect(descendantsOf(chain as any, 'a')).toEqual(new Set(['a', 'b', 'c']));
    expect(descendantsOf(chain as any, 'c')).toEqual(new Set(['c']));
  });
});

describe('Engine re-run desde un nodo', () => {
  beforeEach(() => { for (const k of Object.keys(counters)) delete counters[k]; });

  it('re-ejecuta el nodo + descendientes y reusa el resto', async () => {
    const r1 = await engine.execute(chain as any, {}, {});
    expect(counters).toEqual({ a: 1, b: 1, c: 1 });

    const resume = buildRerunResume(chain as any, 'b', r1.nodeResults);
    const r2 = await engine.execute(chain as any, {}, {}, resume);

    // a reusado (no se re-ejecuta); b y c sí.
    expect(counters).toEqual({ a: 1, b: 2, c: 2 });
    expect(r2.nodeResults['a'].output).toEqual(r1.nodeResults['a'].output); // misma salida cacheada
    expect(r2.nodeResults['b'].output.n).toBe(2);
    expect(r2.nodeResults['c'].output.n).toBe(2);
    expect(r2.success).toBe(true);
  });

  it('re-ejecutar desde el primer nodo re-corre todo', async () => {
    const r1 = await engine.execute(chain as any, {}, {});
    const resume = buildRerunResume(chain as any, 'a', r1.nodeResults);
    await engine.execute(chain as any, {}, {}, resume);
    expect(counters).toEqual({ a: 2, b: 2, c: 2 });
  });
});
