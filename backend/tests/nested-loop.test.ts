import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine, Workflow } from '../src/engine.js';

vi.mock('../src/db.js', () => {
  return {
    getCredentialById: async () => null,
    getWorkflowById: async () => null
  };
});

describe('WorkflowEngine - Nested loops & merge edge cases', () => {
  const engine = new WorkflowEngine();

  it('re-runs an inner loop with fresh state on every outer iteration', async () => {
    // The inner result depends on BOTH loop items, so a stale (non-reset) inner loop
    // would produce wrong values on the 2nd outer iteration.
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'loop', name: 'Outer', parameters: { items: '["A","B"]' } },
        { id: '3', type: 'loop', name: 'Inner', parameters: { items: '["1","2"]' } },
        {
          id: '4',
          type: 'jsCode',
          name: 'Combine',
          parameters: { code: 'return { combo: $node.Outer.output.item + $node.Inner.output.item };' }
        },
        {
          id: '5',
          type: 'jsCode',
          name: 'CollectInner',
          parameters: { code: 'return { innerResults: $node.Inner.output.results };' }
        },
        { id: '6', type: 'log', name: 'Done', parameters: { message: 'all done' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3', sourceHandle: 'loop' }, // outer -> inner
        { source: '3', target: '4', sourceHandle: 'loop' }, // inner -> body
        { source: '4', target: '3' },                       // inner feedback
        { source: '3', target: '5', sourceHandle: 'done' }, // inner done -> collect
        { source: '5', target: '2' },                       // outer feedback
        { source: '2', target: '6', sourceHandle: 'done' }  // outer done -> end
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].output.done).toBe(true);

    // One entry per outer item, each holding the FRESH inner results for that item.
    expect(report.nodeResults['2'].output.results).toEqual([
      { innerResults: [{ combo: 'A1' }, { combo: 'A2' }] },
      { innerResults: [{ combo: 'B1' }, { combo: 'B2' }] }
    ]);
    expect(report.nodeResults['6'].status).toBe('success');
  });

  it('aborts a runaway execution via the step guard rather than hanging', async () => {
    process.env.LF_MAX_EXECUTION_STEPS = '50';
    try {
      // A normal loop with more iterations than the step cap must abort cleanly.
      const items = JSON.stringify(Array.from({ length: 100 }, (_, i) => i));
      const workflow: Workflow = {
        nodes: [
          { id: '1', type: 'trigger', name: 'Start', parameters: {} },
          { id: '2', type: 'loop', name: 'L', parameters: { items } },
          { id: '3', type: 'log', name: 'B', parameters: { message: 'x' } },
          { id: '4', type: 'log', name: 'D', parameters: { message: 'done' } }
        ],
        connections: [
          { source: '1', target: '2' },
          { source: '2', target: '3', sourceHandle: 'loop' },
          { source: '3', target: '2' },
          { source: '2', target: '4', sourceHandle: 'done' }
        ]
      };
      await expect(engine.execute(workflow)).rejects.toThrow(/maximum step limit/);
    } finally {
      delete process.env.LF_MAX_EXECUTION_STEPS;
    }
  });

  it('does not silently drop branches when two connections target the same merge handle', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'a', type: 'set', name: 'A', parameters: { values: [{ key: 'v', value: 'a' }] } },
        { id: 'b', type: 'set', name: 'B', parameters: { values: [{ key: 'v', value: 'b' }] } },
        { id: 'm', type: 'merge', name: 'M', parameters: { mode: 'append' } }
      ],
      connections: [
        { source: '1', target: 'a' },
        { source: '1', target: 'b' },
        // Both into the same (default) handle — must not overwrite each other.
        { source: 'a', target: 'm', targetHandle: 'input1' },
        { source: 'b', target: 'm', targetHandle: 'input1' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    // append mode flattens; both branch outputs must be present.
    const out = report.nodeResults['m'].output;
    expect(out).toEqual(expect.arrayContaining([{ v: 'a' }, { v: 'b' }]));
    expect(out.length).toBe(2);
  });
});
