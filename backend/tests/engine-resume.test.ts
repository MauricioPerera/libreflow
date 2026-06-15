import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { NodeRegistry } from '../src/registry.js';

// A node with a side effect (increments a counter). Lets us prove that resuming a
// suspended run does NOT re-execute nodes that already ran before the wait.
let sideEffectRuns = 0;
NodeRegistry.register({
  type: 'testSideEffect',
  displayName: 'Side Effect',
  category: 'Utility',
  icon: 'S',
  description: 'Increments a counter (test fixture for resume).',
  ui: { inputs: [{ id: 'main' }], outputs: [{ id: 'main' }] },
  parameters: [],
  execute: async () => { sideEffectRuns++; return { n: sideEffectRuns }; },
} as any);

const wf = {
  id: 'wf-wait',
  nodes: [
    { id: 't', type: 'trigger', name: 'Start', parameters: {} },
    { id: 'se', type: 'testSideEffect', name: 'SideEffect', parameters: {} },
    { id: 'w', type: 'wait', name: 'Wait', parameters: { resumeMode: 'webhook' } },
    { id: 'out', type: 'set', name: 'Out', parameters: { values: [
      { key: 'approved', value: '{{ $node.Wait.output.approved }}' },
      { key: 'seen', value: '{{ $node.SideEffect.output.n }}' },
    ] } },
  ],
  connections: [
    { source: 't', target: 'se' },
    { source: 'se', target: 'w' },
    { source: 'w', target: 'out' },
  ],
};

describe('Engine suspend/resume (wait node)', () => {
  const engine = new WorkflowEngine();

  it('suspends at the wait node and returns a resume token (continuation not run yet)', async () => {
    sideEffectRuns = 0;
    const r1 = await engine.execute(wf as any);
    expect(r1.suspended).toBe(true);
    expect(r1.resumeToken).toMatch(/^rsm-/);
    expect(r1.waitNodeId).toBe('w');
    expect(r1.nodeResults['se'].status).toBe('success');
    expect(r1.nodeResults['out']).toBeUndefined();
    expect(sideEffectRuns).toBe(1);
  });

  it('resumes from cached outputs without re-running prior side effects', async () => {
    sideEffectRuns = 0;
    const r1 = await engine.execute(wf as any);
    expect(sideEffectRuns).toBe(1);

    const r2 = await engine.execute(wf as any, {}, {}, {
      waitNodeId: 'w', resumePayload: { approved: true }, priorResults: r1.nodeResults,
    });
    expect(r2.success).toBe(true);
    expect(r2.suspended).toBeFalsy();
    expect(sideEffectRuns).toBe(1); // SideEffect NOT re-executed on resume
    expect(r2.nodeResults['out'].output).toEqual({ approved: true, seen: 1 });
    expect(r2.nodeResults['w'].output).toEqual({ approved: true });
  });

  it('rejects a wait node placed inside a loop', async () => {
    const bad = {
      id: 'wf-bad',
      nodes: [
        { id: 't', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'l', type: 'loop', name: 'Loop', parameters: { items: '[1]' } },
        { id: 'w', type: 'wait', name: 'Wait', parameters: {} },
      ],
      connections: [
        { source: 't', target: 'l' },
        { source: 'l', target: 'w', sourceHandle: 'loop' },
        { source: 'w', target: 'l' },
      ],
    };
    await expect(engine.execute(bad as any)).rejects.toThrow(/cannot be placed inside a loop/);
  });
});
