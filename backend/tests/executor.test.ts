import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWorkflowAndRecord } from '../src/executor.js';
import { getWorkflowById, saveExecution } from '../src/db.js';

// Mock the db module
vi.mock('../src/db.js', () => {
  return {
    getWorkflowById: vi.fn(),
    saveExecution: vi.fn(),
    pruneOldExecutions: vi.fn(),
  };
});

describe('executeWorkflowAndRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes concurrent executions of the same workflow id', async () => {
    const order: string[] = [];
    vi.mocked(saveExecution).mockImplementation(async (_id, _wf, status) => {
      order.push(status as string);
    });

    const workflow = {
      id: 'flow-serial',
      name: 'Serial Flow',
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'set', type: 'set', name: 'S', parameters: { values: [{ key: 'x', value: 1 }] } }
      ],
      connections: [{ source: 'start', target: 'set' }]
    };

    // Fire two runs concurrently for the same id.
    await Promise.all([
      executeWorkflowAndRecord(workflow),
      executeWorkflowAndRecord(workflow)
    ]);

    // Serialized => first run fully completes (running, success) before the second starts.
    expect(order).toEqual(['running', 'success', 'running', 'success']);
  });

  it('should run a successful workflow and save execution as success', async () => {
    const workflow = {
      id: 'flow-1',
      name: 'Successful Flow',
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'set', type: 'set', name: 'SetVal', parameters: { values: [{ key: 'x', value: 10 }] } }
      ],
      connections: [
        { source: 'start', target: 'set' }
      ]
    };

    const report = await executeWorkflowAndRecord(workflow);
    expect(report.success).toBe(true);
    // Two saves: a 'running' record up-front, then the final 'success' report.
    expect(saveExecution).toHaveBeenCalledTimes(2);
    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'flow-1',
      'running',
      expect.any(Object)
    );
    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'flow-1',
      'success',
      report
    );
  });

  it('should run a failing workflow and save execution as failed without error workflow', async () => {
    const workflow = {
      id: 'flow-2',
      name: 'Failing Flow',
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'js', type: 'jsCode', name: 'FailJS', parameters: { code: 'throw new Error("test error");' } }
      ],
      connections: [
        { source: 'start', target: 'js' }
      ]
    };

    const report = await executeWorkflowAndRecord(workflow);
    expect(report.success).toBe(false);
    // 'running' record up-front, then the final 'failed' report.
    expect(saveExecution).toHaveBeenCalledTimes(2);
    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'flow-2',
      'failed',
      report
    );
  });

  it('should run a failing workflow and trigger the configured error workflow', async () => {
    const failedWorkflow = {
      id: 'flow-3',
      name: 'Failing Flow With Error Trigger',
      onErrorWorkflowId: 'error-flow-id',
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'js', type: 'jsCode', name: 'FailJS', parameters: { code: 'throw new Error("fatal failure");' } }
      ],
      connections: [
        { source: 'start', target: 'js' }
      ]
    };

    const errorWorkflow = {
      id: 'error-flow-id',
      name: 'Global Error Handler',
      nodes: [
        { id: 'err-start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'err-log', type: 'log', name: 'LogErr', parameters: { message: 'Handled error' } }
      ],
      connections: [
        { source: 'err-start', target: 'err-log' }
      ]
    };

    // Stub getWorkflowById
    vi.mocked(getWorkflowById).mockResolvedValue(errorWorkflow as any);

    const report = await executeWorkflowAndRecord(failedWorkflow);
    expect(report.success).toBe(false);

    // Wait a tiny bit since triggerErrorWorkflow runs asynchronously in the background
    await new Promise(resolve => setTimeout(resolve, 50));

    // 4 saves: running+final for the main workflow, running+final for the error handler.
    expect(saveExecution).toHaveBeenCalledTimes(4);

    // Final state of main workflow (failed)
    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'flow-3',
      'failed',
      report
    );

    // Final state of error handler (success)
    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'error-flow-id',
      'success',
      expect.any(Object)
    );
  });

  it('should prevent self-referencing loops (onErrorWorkflowId points to self)', async () => {
    const workflow = {
      id: 'flow-loop',
      name: 'Self Loop Flow',
      onErrorWorkflowId: 'flow-loop',
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'js', type: 'jsCode', name: 'FailJS', parameters: { code: 'throw new Error("loop error");' } }
      ],
      connections: [
        { source: 'start', target: 'js' }
      ]
    };

    const report = await executeWorkflowAndRecord(workflow);
    expect(report.success).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 50));

    // running + final only (2). No extra error-handler run because self-reference is prevented.
    expect(saveExecution).toHaveBeenCalledTimes(2);
    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'flow-loop',
      'failed',
      report
    );
  });

  it('should prevent recursive cascading error triggers if error workflow itself fails', async () => {
    const failedWorkflow = {
      id: 'flow-failing',
      name: 'Failing Flow',
      onErrorWorkflowId: 'error-flow-failing',
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'js', type: 'jsCode', name: 'FailJS', parameters: { code: 'throw new Error("fatal");' } }
      ],
      connections: [
        { source: 'start', target: 'js' }
      ]
    };

    const errorWorkflow = {
      id: 'error-flow-failing',
      name: 'Failing Global Error Handler',
      onErrorWorkflowId: 'another-error-flow', // points somewhere else but should not trigger because it has isErrorWorkflowRun: true
      nodes: [
        { id: 'err-start', type: 'trigger', name: 'Start', parameters: {} },
        { id: 'err-js', type: 'jsCode', name: 'FailJS', parameters: { code: 'throw new Error("error handler failed");' } }
      ],
      connections: [
        { source: 'err-start', target: 'err-js' }
      ]
    };

    vi.mocked(getWorkflowById).mockResolvedValue(errorWorkflow as any);

    const report = await executeWorkflowAndRecord(failedWorkflow);
    expect(report.success).toBe(false);

    await new Promise(resolve => setTimeout(resolve, 50));

    // 4 saves: running+final for failedWorkflow, running+final for errorWorkflow.
    // No further cascade because recursion is blocked by the isErrorWorkflowRun flag.
    expect(saveExecution).toHaveBeenCalledTimes(4);

    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'flow-failing',
      'failed',
      report
    );

    expect(saveExecution).toHaveBeenCalledWith(
      expect.stringContaining('exec-'),
      'error-flow-failing',
      'failed',
      expect.any(Object)
    );
  });
});
