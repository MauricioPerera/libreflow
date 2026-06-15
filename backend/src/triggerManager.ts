import { schedule, validate, ScheduledTask } from 'node-cron';
import { getActiveWorkflows, getWorkflowById } from './db.js';
import { executeWorkflowAndRecord, execStack } from './executor.js';
import { cronTooFrequent } from './security.js';
import { dataTableBus, triggerContext, RowEvent, subscribedTables } from './dataTableEvents.js';
import { streamTriggerManager, StreamTransport } from './streamTriggers.js';

interface DataTableSub { workflowId: string; event: string }

class TriggerManager {
  private cronJobs: Map<string, ScheduledTask[]> = new Map();
  // tableId -> subscriptions (which active workflows react to writes on that table).
  private dataTableSubs: Map<string, DataTableSub[]> = new Map();
  private busWired = false;

  // Initialize all active triggers on server startup
  async init() {
    console.log('[TriggerManager] Initializing active background triggers...');
    // Wire the data-table event bus exactly once.
    if (!this.busWired) {
      dataTableBus.on('row', (evt: RowEvent) => this.handleRowEvent(evt));
      this.busWired = true;
    }
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

  /** Runs every active workflow subscribed to a row event, bounded by the depth guard. */
  private handleRowEvent(evt: RowEvent) {
    const subs = this.dataTableSubs.get(evt.tableId);
    if (!subs || subs.length === 0) return;

    for (const sub of subs) {
      if (sub.event !== 'any' && sub.event !== evt.event) continue;
      // Fire-and-forget: never block the write that produced the event.
      (async () => {
        try {
          const workflow = await getWorkflowById(sub.workflowId);
          if (!workflow || !workflow.active) return;
          const payload = {
            source: 'dataTable',
            tableId: evt.tableId,
            rowId: evt.rowId,
            event: evt.event,
            row: evt.data,
            timestamp: new Date().toISOString(),
          };
          // Run detached (fresh execStack — a reactive run is a new root, not nested) and
          // one trigger-hop deeper so the cascade depth guard can cap the chain.
          await execStack.run(new Set(), () =>
            triggerContext.run({ depth: evt.depth + 1 }, () => executeWorkflowAndRecord(workflow, payload))
          );
        } catch (err) {
          console.error(`[DataTableTrigger] Error running workflow ${sub.workflowId} for table ${evt.tableId}:`, err);
        }
      })();
    }
  }

  // Start triggers for a specific workflow
  async startTriggers(workflow: any) {
    this.stopTriggers(workflow.id);

    const jobs: ScheduledTask[] = [];
    const triggerNodes = (workflow.nodes || []).filter((n: any) => n.type === 'trigger');

    for (const node of triggerNodes) {
      const p = node.parameters || {};
      const { triggerMode = 'manual', cronExpression, tableId, tableEvent = 'any' } = p;

      if (triggerMode === 'stream') {
        const transport = p.streamTransport as StreamTransport;
        if (!transport) {
          console.warn(`[TriggerManager] stream trigger sin transporte en "${workflow.name}" (${workflow.id}). Skipping.`);
          continue;
        }
        streamTriggerManager.start({
          workflowId: workflow.id,
          workflowName: workflow.name,
          nodeId: node.id,
          transport,
          url: p.streamUrl,
          topic: p.mqttTopic,
          mailbox: p.imapMailbox,
          host: p.imapHost,
          port: p.imapPort ? Number(p.imapPort) : undefined,
          secure: p.imapSecure !== false,
          credentialId: p.credentialId,
        });
        continue;
      }

      if (triggerMode === 'dataTable') {
        if (!tableId) {
          console.warn(`[TriggerManager] dataTable trigger without tableId in "${workflow.name}" (${workflow.id}). Skipping.`);
          continue;
        }
        const subs = this.dataTableSubs.get(tableId) || [];
        subs.push({ workflowId: workflow.id, event: tableEvent });
        this.dataTableSubs.set(tableId, subs);
        subscribedTables.add(tableId);
        console.log(`[TriggerManager] Subscribed workflow "${workflow.name}" (${workflow.id}) to table ${tableId} [${tableEvent}]`);
        continue;
      }

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
    // Close any persistent streaming connections (SSE/WS/MQTT/IMAP).
    streamTriggerManager.stopWorkflow(workflowId);

    const jobs = this.cronJobs.get(workflowId);
    if (jobs) {
      for (const job of jobs) {
        job.stop();
      }
      this.cronJobs.delete(workflowId);
      console.log(`[TriggerManager] Stopped active cron jobs for workflow ${workflowId}`);
    }

    // Remove this workflow's data-table subscriptions.
    for (const [tableId, subs] of this.dataTableSubs.entries()) {
      const remaining = subs.filter(s => s.workflowId !== workflowId);
      if (remaining.length === 0) {
        this.dataTableSubs.delete(tableId);
        subscribedTables.delete(tableId);
      } else if (remaining.length !== subs.length) {
        this.dataTableSubs.set(tableId, remaining);
      }
    }
  }

  // Stop all active triggers across all workflows
  stopAll() {
    console.log('[TriggerManager] Stopping all active cron jobs...');
    streamTriggerManager.stopAll();
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
