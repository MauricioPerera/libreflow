import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine, Workflow } from '../src/engine.js';

vi.mock('../src/db.js', () => {
  return {
    getCredentialById: async () => null,
    getWorkflowById: async (id: string) => {
      if (id === 'sub-workflow-1') {
        return {
          id: 'sub-workflow-1',
          name: 'SubWorkflow',
          nodes: [
            { id: 'sub-start', type: 'trigger', name: 'Start', parameters: {} },
            { id: 'sub-set', type: 'set', name: 'SubSet', parameters: { values: [{ key: 'msg', value: 'hello from sub-workflow' }] } }
          ],
          connections: [
            { source: 'sub-start', target: 'sub-set' }
          ]
        };
      }
      return null;
    },
    getDataTables: async () => [
      { id: 'table-1', name: 'Leads', columns: [{ name: 'email', type: 'string' }] }
    ],
    getDataTableRows: async (tableId: string) => [
      { id: 'row-1', table_id: tableId, data: { email: 'test@example.com' } }
    ],
    addDataTableRow: async () => {},
    updateDataTableRow: async () => {},
    deleteDataTableRow: async () => {},
    upsertDataTableRow: async () => ({}),
    incrementDataTableRow: async () => ({}),
    getOrCreateDataTableRow: async () => ({}),
    queryDataTableRows: async () => []
  };
});

describe('WorkflowEngine', () => {
  const engine = new WorkflowEngine();

  it('should run a simple sequential workflow', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'set', name: 'SetValue', parameters: { values: [{ key: 'msg', value: 'hello' }] } },
        { id: '3', type: 'jsCode', name: 'Transform', parameters: { code: 'return { result: $node.SetValue.output.msg.toUpperCase() };' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['1'].status).toBe('success');
    expect(report.nodeResults['2'].status).toBe('success');
    expect(report.nodeResults['3'].status).toBe('success');
    expect(report.nodeResults['2'].output).toEqual({ msg: 'hello' });
    expect(report.nodeResults['3'].output).toEqual({ result: 'HELLO' });
  });

  it('should execute IF branching and skip appropriate paths', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'if', name: 'Check', parameters: { value1: 'yes', operator: 'equal', value2: 'yes' } },
        { id: '3', type: 'log', name: 'LogTrue', parameters: { message: 'Passed' } },
        { id: '4', type: 'log', name: 'LogFalse', parameters: { message: 'Failed' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3', sourceHandle: 'true' },
        { source: '2', target: '4', sourceHandle: 'false' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].output.result).toBe(true);
    expect(report.nodeResults['3'].status).toBe('success');
    expect(report.nodeResults['4'].status).toBe('skipped');
  });

  it('should detect cycles and report them as failed', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'jsCode', name: 'A', parameters: {} },
        { id: '3', type: 'jsCode', name: 'B', parameters: {} }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3' },
        { source: '3', target: '2' } // Cycle
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(false);
    expect(report.nodeResults['1'].status).toBe('success');
    expect(report.nodeResults['2'].status).toBe('failed');
    expect(report.nodeResults['2'].error).toContain('cyclic dependency');
  });

  it('should execute a Merge node with different modes', async () => {
    // Mode: combine
    const workflowCombine: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'set', name: 'BranchA', parameters: { values: [{ key: 'a', value: 1 }] } },
        { id: '3', type: 'set', name: 'BranchB', parameters: { values: [{ key: 'b', value: 2 }] } },
        { id: '4', type: 'merge', name: 'MergeNode', parameters: { mode: 'combine' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '1', target: '3' },
        { source: '2', target: '4', targetHandle: 'input1' },
        { source: '3', target: '4', targetHandle: 'input2' }
      ]
    };

    const reportCombine = await engine.execute(workflowCombine);
    expect(reportCombine.success).toBe(true);
    expect(reportCombine.nodeResults['4'].status).toBe('success');
    expect(reportCombine.nodeResults['4'].output).toEqual({ a: 1, b: 2 });

    // Mode: wait
    const workflowWait: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'set', name: 'BranchA', parameters: { values: [{ key: 'a', value: 1 }] } },
        { id: '3', type: 'set', name: 'BranchB', parameters: { values: [{ key: 'b', value: 2 }] } },
        { id: '4', type: 'merge', name: 'MergeNode', parameters: { mode: 'wait' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '1', target: '3' },
        { source: '2', target: '4', targetHandle: 'input1' },
        { source: '3', target: '4', targetHandle: 'input2' }
      ]
    };

    const reportWait = await engine.execute(workflowWait);
    expect(reportWait.success).toBe(true);
    expect(reportWait.nodeResults['4'].status).toBe('success');
    expect(reportWait.nodeResults['4'].output).toEqual({
      input1: { a: 1 },
      input2: { b: 2 }
    });

    // Mode: append
    const workflowAppend: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'jsCode', name: 'BranchA', parameters: { code: 'return [1, 2];' } },
        { id: '3', type: 'jsCode', name: 'BranchB', parameters: { code: 'return [3, 4];' } },
        { id: '4', type: 'merge', name: 'MergeNode', parameters: { mode: 'append' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '1', target: '3' },
        { source: '2', target: '4', targetHandle: 'input1' },
        { source: '3', target: '4', targetHandle: 'input2' }
      ]
    };

    const reportAppend = await engine.execute(workflowAppend);
    expect(reportAppend.success).toBe(true);
    expect(reportAppend.nodeResults['4'].status).toBe('success');
    expect(reportAppend.nodeResults['4'].output).toEqual([1, 2, 3, 4]);
  });

  it('should execute a Sub-workflow using executeWorkflow node', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { id: '2', type: 'executeWorkflow', name: 'SubCall', parameters: { targetWorkflowId: 'sub-workflow-1', payload: { foo: 'bar' } } },
        { id: '3', type: 'jsCode', name: 'CheckSubOutput', parameters: { code: 'return { result: $node.SubCall.output.nodeResults[\'sub-set\'].output.msg };' } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].status).toBe('success');
    expect(report.nodeResults['2'].output.success).toBe(true);
    expect(report.nodeResults['2'].output.nodeResults['sub-set'].output).toEqual({ msg: 'hello from sub-workflow' });
    expect(report.nodeResults['3'].output).toEqual({ result: 'hello from sub-workflow' });
  });

  it('should continue execution on node failure when continueOnFail is true', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'jsCode', 
          name: 'FailingNode', 
          parameters: { 
            code: 'throw new Error("Temporary DB Connection Failure");',
            settings: { continueOnFail: true }
          } 
        },
        { id: '3', type: 'set', name: 'SuccessNode', parameters: { values: [{ key: 'status', value: 'workflow continued' }] } }
      ],
      connections: [
        { source: '1', target: '2' },
        { source: '2', target: '3' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].status).toBe('success');
    expect(report.nodeResults['2'].output.success).toBe(false);
    expect(report.nodeResults['2'].output.error).toContain('Temporary DB Connection Failure');
    expect(report.nodeResults['3'].status).toBe('success');
    expect(report.nodeResults['3'].output).toEqual({ status: 'workflow continued' });
  });

  it('should retry execution on node failure when retryOnFail is true', async () => {
    const fs = require('fs');
    if (fs.existsSync('counter.txt')) {
      fs.unlinkSync('counter.txt');
    }
    
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'jsCode', 
          name: 'RetryNode', 
          parameters: { 
            code: `
              const fs = require('fs');
              let count = 0;
              if (fs.existsSync('counter.txt')) {
                count = parseInt(fs.readFileSync('counter.txt', 'utf8')) || 0;
              }
              count++;
              fs.writeFileSync('counter.txt', count.toString());
              if (count < 3) {
                throw new Error("Try again");
              }
              return { attempts: count };
            `,
            settings: { retryOnFail: true, maxRetries: 3, retryDelayMs: 100 }
          } 
        }
      ],
      connections: [
        { source: '1', target: '2' }
      ]
    };

    const report = await engine.execute(workflow);
    expect(report.success).toBe(true);
    expect(report.nodeResults['2'].status).toBe('success');
    expect(report.nodeResults['2'].output.attempts).toBe(3);

    if (fs.existsSync('counter.txt')) {
      fs.unlinkSync('counter.txt');
    }
  });

  it('should terminate execution on infinite loop in jsCode node due to timeout', async () => {
    const workflow: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'jsCode', 
          name: 'InfiniteLoopNode', 
          parameters: { 
            code: 'while(true) {}'
          } 
        }
      ],
      connections: [
        { source: '1', target: '2' }
      ]
    };

    const startTime = Date.now();
    const report = await engine.execute(workflow);
    const duration = Date.now() - startTime;

    expect(report.success).toBe(false);
    expect(report.nodeResults['2'].status).toBe('failed');
    expect(report.nodeResults['2'].error).toContain('timed out');
    expect(duration).toBeGreaterThanOrEqual(4800); // Should take around 5 seconds
    expect(duration).toBeLessThan(7000); // But terminate soon after
  }, 12000);

  it('should execute a dataTable node in a workflow (append, search, update, delete)', async () => {
    // 1. Append
    const workflowAppend: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'dataTable', 
          name: 'AppendRow', 
          parameters: { 
            operation: 'append', 
            tableId: 'table-1', 
            fields: [
              { key: 'email', value: 'new@example.com' }
            ] 
          } 
        }
      ],
      connections: [
        { source: '1', target: '2' }
      ]
    };
    const reportAppend = await engine.execute(workflowAppend);
    expect(reportAppend.success).toBe(true);
    expect(reportAppend.nodeResults['2'].status).toBe('success');
    expect(reportAppend.nodeResults['2'].output.data.email).toBe('new@example.com');

    // 2. Search
    const workflowSearch: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'dataTable', 
          name: 'SearchRows', 
          parameters: { 
            operation: 'search', 
            tableId: 'table-1', 
            filters: [
              { key: 'email', value: 'test@example.com' }
            ] 
          } 
        }
      ],
      connections: [
        { source: '1', target: '2' }
      ]
    };
    const reportSearch = await engine.execute(workflowSearch);
    expect(reportSearch.success).toBe(true);
    expect(reportSearch.nodeResults['2'].status).toBe('success');
    expect(reportSearch.nodeResults['2'].output).toHaveLength(1);
    expect(reportSearch.nodeResults['2'].output[0].data.email).toBe('test@example.com');

    // 3. Update
    const workflowUpdate: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'dataTable', 
          name: 'UpdateRow', 
          parameters: { 
            operation: 'update', 
            tableId: 'table-1', 
            rowId: 'row-1',
            fields: [
              { key: 'email', value: 'updated@example.com' }
            ] 
          } 
        }
      ],
      connections: [
        { source: '1', target: '2' }
      ]
    };
    const reportUpdate = await engine.execute(workflowUpdate);
    expect(reportUpdate.success).toBe(true);
    expect(reportUpdate.nodeResults['2'].status).toBe('success');
    expect(reportUpdate.nodeResults['2'].output.success).toBe(true);

    // 4. Delete
    const workflowDelete: Workflow = {
      nodes: [
        { id: '1', type: 'trigger', name: 'Start', parameters: {} },
        { 
          id: '2', 
          type: 'dataTable', 
          name: 'DeleteRow', 
          parameters: { 
            operation: 'delete', 
            tableId: 'table-1', 
            rowId: 'row-1'
          } 
        }
      ],
      connections: [
        { source: '1', target: '2' }
      ]
    };
    const reportDelete = await engine.execute(workflowDelete);
    expect(reportDelete.success).toBe(true);
    expect(reportDelete.nodeResults['2'].status).toBe('success');
    expect(reportDelete.nodeResults['2'].output.success).toBe(true);
  });
});

