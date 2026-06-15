import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkflowEngine, WorkflowExecutionReport } from './engine.js';
import { getWorkflowById, saveExecution, pruneOldExecutions } from './db.js';

export interface ExecuteOptions {
  executionId?: string;
}

// Per-workflow serialization: chains executions of the same workflow id so concurrent
// triggers (webhook/cron/manual) don't overlap and clobber shared state. (DATA-15)
const workflowLocks = new Map<string, Promise<unknown>>();

/**
 * Set of workflow ids currently executing in this async context. Lets us detect a
 * RE-ENTRANT call to a workflow already running in the same chain — e.g. an aiAgent whose
 * MCP toolset includes its own workflow, which would otherwise await its own per-id lock
 * and deadlock. Reactive triggers run detached (see triggerManager) so legitimate
 * self-feeding cascades are unaffected (they're bounded by the trigger depth guard).
 */
export const execStack = new AsyncLocalStorage<Set<string>>();

// Prune old executions only every Nth run per workflow instead of on every execution
// (the prune DELETE is comparatively expensive). Retention overshoots by at most N rows.
const PRUNE_EVERY = 20;
const runsSincePrune = new Map<string, number>();

export async function executeWorkflowAndRecord(
  workflow: any,
  payload: any = {},
  options: ExecuteOptions = {}
): Promise<WorkflowExecutionReport> {
  // Workflows without an id (ad-hoc test runs) don't need serialization.
  if (!workflow.id) {
    return runWorkflowAndRecord(workflow, payload, options);
  }

  const id: string = workflow.id;
  const stack = execStack.getStore();
  if (stack?.has(id)) {
    throw new Error(`Re-entrant execution of workflow "${id}" detected (a tool or sub-flow tried to run the workflow that is already running). Aborted to avoid a deadlock.`);
  }
  const prev = workflowLocks.get(id) || Promise.resolve();
  // Wait for any in-flight run of this id, then run. (errors don't break the chain)
  const run = prev.catch(() => {}).then(() => {
    const nextStack = new Set(stack);
    nextStack.add(id);
    return execStack.run(nextStack, () => runWorkflowAndRecord(workflow, payload, options));
  });
  workflowLocks.set(id, run.catch(() => {}));
  return run;
}

/**
 * Executes a workflow, saves its execution report to the database,
 * and triggers the global error workflow if the execution fails.
 */
async function runWorkflowAndRecord(
  workflow: any,
  payload: any = {},
  options: ExecuteOptions = {}
): Promise<WorkflowExecutionReport> {
  const executionId =
    options.executionId || `exec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

  // Persist a 'running' record up-front so a crash mid-execution leaves a trace
  // instead of a phantom (untracked) execution.
  if (workflow.id) {
    try {
      await saveExecution(executionId, workflow.id, 'running', { running: true, startTime: new Date().toISOString() });
    } catch (dbErr) {
      console.error('[Executor] Error persisting running state:', dbErr);
    }
  }

  const engine = new WorkflowEngine();
  const report = await engine.execute(workflow, payload);

  if (workflow.id) {
    try {
      await saveExecution(
        executionId,
        workflow.id,
        report.success ? 'success' : 'failed',
        report
      );

      // Trigger error workflow if this run failed and it's not already an error handler run
      if (!report.success && workflow.onErrorWorkflowId && !payload?.isErrorWorkflowRun) {
        if (workflow.onErrorWorkflowId === workflow.id) {
          console.warn(`[Executor] Prevented self-referencing error workflow loop for "${workflow.name}" (${workflow.id})`);
        } else {
          // Trigger error workflow asynchronously in background
          triggerErrorWorkflow(workflow, executionId, report);
        }
      }

      // Enforce retention so executions don't grow without bound — throttled.
      const since = (runsSincePrune.get(workflow.id) || 0) + 1;
      if (since >= PRUNE_EVERY) {
        runsSincePrune.set(workflow.id, 0);
        await pruneOldExecutions(workflow.id);
      } else {
        runsSincePrune.set(workflow.id, since);
      }
    } catch (dbErr) {
      console.error('[Executor] Error saving execution:', dbErr);
    }
  }

  return report;
}

/**
 * Resolves the configured error workflow and executes it in background.
 */
async function triggerErrorWorkflow(
  failedWorkflow: any,
  failedExecutionId: string,
  failedReport: WorkflowExecutionReport
) {
  try {
    const errorWorkflow = await getWorkflowById(failedWorkflow.onErrorWorkflowId);
    if (!errorWorkflow) {
      console.warn(`[Executor] Error workflow with ID "${failedWorkflow.onErrorWorkflowId}" not found.`);
      return;
    }

    const failedNodeResult = Object.values(failedReport.nodeResults).find(r => r.status === 'failed');
    const failedNodeName = failedNodeResult ? failedNodeResult.nodeName : 'Unknown Node';
    const errorMessage = failedNodeResult?.error || 'Unknown execution error';

    const errorPayload = {
      executionId: failedExecutionId,
      workflowId: failedWorkflow.id,
      workflowName: failedWorkflow.name,
      error: errorMessage,
      failedNodeName,
      isErrorWorkflowRun: true // flag to prevent recursion
    };

    console.log(`[Executor] Triggering error workflow "${errorWorkflow.name}" (${errorWorkflow.id}) for failed workflow "${failedWorkflow.name}"`);
    
    // Execute the error workflow in background
    executeWorkflowAndRecord(errorWorkflow, errorPayload).catch(err => {
      console.error(`[Executor] Error running error workflow "${errorWorkflow.name}":`, err);
    });
  } catch (err) {
    console.error('[Executor] Failed to trigger error workflow:', err);
  }
}
