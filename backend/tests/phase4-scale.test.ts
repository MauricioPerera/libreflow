import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine, Workflow } from '../src/engine.js';

vi.mock('../src/db.js', () => ({
  getCredentialById: async () => null,
  getWorkflowById: async () => null,
}));

describe('Fase 4 (mitigación): loop por lotes (batchSize)', () => {
  const engine = new WorkflowEngine();

  it('itera en lotes: el cuerpo recibe el array del lote', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'loop', name: 'LoopNode', parameters: { items: '[1,2,3,4,5]', batchSize: '2' } },
        { id: '3', type: 'jsCode', name: 'Body', parameters: {
          code: 'return { size: $node.LoopNode.output.items.length, sum: $node.LoopNode.output.items.reduce((a,b)=>a+b,0) };',
        } },
        { id: '4', type: 'log', name: 'Done', parameters: { message: 'fin' } },
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3', sourceHandle: 'loop' },
        { source: '3', target: '2' },
        { source: '2', target: '4', sourceHandle: 'done' },
      ],
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    // 5 elementos en lotes de 2 → 3 iteraciones: [1,2],[3,4],[5]
    expect(report.nodeResults['2'].output.results).toEqual([
      { size: 2, sum: 3 },
      { size: 2, sum: 7 },
      { size: 1, sum: 5 },
    ]);
    expect(report.nodeResults['4'].status).toBe('success');
  });

  it('batchSize=1 mantiene el comportamiento clásico item-a-item', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'loop', name: 'LoopNode', parameters: { items: '["a","b"]', batchSize: '1' } },
        { id: '3', type: 'jsCode', name: 'Body', parameters: { code: 'return { v: $node.LoopNode.output.item };' } },
        { id: '4', type: 'log', name: 'Done', parameters: { message: 'fin' } },
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3', sourceHandle: 'loop' },
        { source: '3', target: '2' },
        { source: '2', target: '4', sourceHandle: 'done' },
      ],
    };
    const report = await engine.execute(workflow);
    expect(report.nodeResults['2'].output.results).toEqual([{ v: 'a' }, { v: 'b' }]);
  });
});

describe('Fase 4 (mitigación): límites de jsCode por nodo', () => {
  const engine = new WorkflowEngine();

  it('un timeout por nodo bajo corta un bucle infinito', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'jsCode', name: 'Heavy', parameters: { code: 'while(true){}', jsTimeoutMs: '100' } },
      ],
      connections: [{ source: '1', target: '2' }],
    };
    const report = await engine.execute(workflow);
    expect(report.success).toBe(false);
    expect(report.nodeResults['2'].status).toBe('failed');
    expect(report.nodeResults['2'].error).toMatch(/timed out/i);
  });

  it('sin límite por nodo, el código normal corre con el default', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'jsCode', name: 'Ok', parameters: { code: 'return { ok: 1 };' } },
      ],
      connections: [{ source: '1', target: '2' }],
    };
    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].output).toEqual({ ok: 1 });
  });
});
