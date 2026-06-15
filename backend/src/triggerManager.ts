import { schedule, validate, ScheduledTask } from 'node-cron';
import { getActiveWorkflows, getWorkflowById } from './db.js';
import { executeWorkflowAndRecord } from './executor.js';
import { cronTooFrequent } from './security.js';

class TriggerManager {
  private cronJobs: Map<string, ScheduledTask[]> = new Map();

  // Initialize all active triggers on server startup
  async init() {
    console.log('[TriggerManager] Initializing active background triggers...');
    try {
      const activeWorkflows = await getActiveWorkflows();
      for (const workflow of activeWorkflows) {
        await this.startTriggers(workflow);
      }
      console.log(`[TriggerManager] Loaded ${activeWorkflows.length} active workflows.`);
    } catch (err) {
      console.error('[TriggerManager] Error initializing active triggers:', err);
    }
  }

  // Start triggers for a specific workflow
  async startTriggers(workflow: any) {
    this.stopTriggers(workflow.id);

    const jobs: ScheduledTask[] = [];
    const triggerNodes = (workflow.nodes || []).filter((n: any) => n.type === 'trigger');

    for (const node of triggerNodes) {
      const { triggerMode = 'manual', cronExpression } = node.parameters || {};

      if (triggerMode === 'cron') {
        if (!cronExpression || !validate(cronExpression)) {
          console.warn(`[TriggerManager] Invalid cron expression "${cronExpression}" for workflow "${workflow.name}" (${workflow.id}). Skipping.`);
          continue;
        }

        const freqError = cronTooFrequent(cronExpression);
        if (freqError) {
          console.warn(`[TriggerManager] ${freqError} Skipping "${cronExpression}" for workflow "${workflow.name}" (${workflow.id}).`);
          continue;
        }

        console.log(`[TriggerManager] Scheduling cron job "${cronExpression}" for workflow "${workflow.name}" (${workflow.id})`);
        const job = schedule(cronExpression, async () => {
          console.log(`[TriggerManager] Running cron triggered workflow "${workflow.name}" (${workflow.id})`);
          try {
            const payload = {
              timestamp: new Date().toISOString(),
              source: 'cron',
              cronExpression
            };
            // Reload the latest definition so edits take effect without reactivation.
            const fresh = await getWorkflowById(workflow.id);
            if (!fresh || !fresh.active) {
              return; // workflow deleted or deactivated since scheduling
            }
            await executeWorkflowAndRecord(fresh, payload);
          } catch (execErr) {
            console.error(`[TriggerManager] Error running cron workflow ${workflow.id}:`, execErr);
          }
        });
        jobs.push(job);
      }
    }

    if (jobs.length > 0) {
      this.cronJobs.set(workflow.id, jobs);
    }
  }

  // Stop triggers for a specific workflow
  stopTriggers(workflowId: string) {
    const jobs = this.cronJobs.get(workflowId);
    if (jobs) {
      for (const job of jobs) {
        job.stop();
      }
      this.cronJobs.delete(workflowId);
      console.log(`[TriggerManager] Stopped active cron jobs for workflow ${workflowId}`);
    }
  }

  // Stop all active triggers across all workflows
  stopAll() {
    console.log('[TriggerManager] Stopping all active cron jobs...');
    for (const [workflowId, jobs] of this.cronJobs.entries()) {
      for (const job of jobs) {
        job.stop();
      }
      console.log(`[TriggerManager] Stopped active cron jobs for workflow ${workflowId}`);
    }
    this.cronJobs.clear();
  }
}

export const triggerManager = new TriggerManager();
