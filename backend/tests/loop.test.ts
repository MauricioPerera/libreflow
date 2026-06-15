import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine, Workflow } from '../src/engine.js';

vi.mock('../src/db.js', () => {
  return {
    getCredentialById: async () => null,
    getWorkflowById: async () => null
  };
});

describe('WorkflowEngine - Looping & Item Lists', () => {
  const engine = new WorkflowEngine();

  it('should skip loop body and execute done path directly if items is empty', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'loop', name: 'LoopNode', parameters: { items: '[]' } },
        { id: '3', type: 'log', name: 'LoopBody', parameters: { message: 'inside loop' } },
        { id: '4', type: 'log', name: 'DonePath', parameters: { message: 'loop finished' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3', sourceHandle: 'loop' },
        { source: '3', target: '2' }, // Feedback
        { source: '2', target: '4', sourceHandle: 'done' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].status).toBe('success');
    expect(report.nodeResults['2'].output.done).toBe(true);
    expect(report.nodeResults['2'].output.results).toEqual([]);
    expect(report.nodeResults['3'].status).toBe('skipped');
    expect(report.nodeResults['4'].status).toBe('success');
  });

  it('should execute loop body multiple times and accumulate results before executing done path', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'loop', name: 'LoopNode', parameters: { items: '["Alice", "Bob", "Charlie"]' } },
        { id: '3', type: 'jsCode', name: 'ProcessItem', parameters: { code: 'return { processed: "Hello " + $node.LoopNode.output.item };' } },
        { id: '4', type: 'log', name: 'DonePath', parameters: { message: 'Finished all!' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3', sourceHandle: 'loop' },
        { source: '3', target: '2' }, // Feedback
        { source: '2', target: '4', sourceHandle: 'done' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].status).toBe('success');
    expect(report.nodeResults['2'].output.done).toBe(true);
    expect(report.nodeResults['2'].output.results).toEqual([
      { processed: 'Hello Alice' },
      { processed: 'Hello Bob' },
      { processed: 'Hello Charlie' }
    ]);
    expect(report.nodeResults['3'].status).toBe('success');
    expect(report.nodeResults['4'].status).toBe('success');
  });

  it('should execute loop using expressions from preceding node outputs', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'set', name: 'PrepareList', parameters: { values: [{ key: 'names', value: ['X', 'Y'] }] } },
        { id: '3', type: 'loop', name: 'LoopNode', parameters: { items: '{{ $node.PrepareList.output.names }}' } },
        { id: '4', type: 'jsCode', name: 'ProcessItem', parameters: { code: 'return { val: $node.LoopNode.output.item + "!" };' } },
        { id: '5', type: 'log', name: 'DonePath', parameters: { message: 'Finished all expressions!' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3' },
        { source: '3', target: '4', sourceHandle: 'loop' },
        { source: '4', target: '3' }, // Feedback
        { source: '3', target: '5', sourceHandle: 'done' }
      ]
    };

    const report = await engine.execute(workflow, { names: ['X', 'Y'] });
    expect(report.success).toBe(true);
    expect(report.nodeResults['3'].status).toBe('success');
    expect(report.nodeResults['3'].output.done).toBe(true);
    expect(report.nodeResults['3'].output.results).toEqual([
      { val: 'X!' },
      { val: 'Y!' }
    ]);
    expect(report.nodeResults['4'].status).toBe('success');
    expect(report.nodeResults['5'].status).toBe('success');
  });
});
