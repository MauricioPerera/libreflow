import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Reactive data-table triggers. Write functions in db.ts emit row events here; the
 * triggerManager subscribes and runs the matching workflows. Decoupled via an event
 * bus so db.ts never imports the executor (avoids a layering cycle).
 */
export const dataTableBus = new EventEmitter();

/**
 * Carries the current trigger-chain depth across async calls (auto-propagated). A write
 * performed inside a trigger-fired workflow runs with depth N; once depth reaches the
 * cap, further writes stop emitting — this is the cascade / infinite-loop guard.
 */
export const triggerContext = new AsyncLocalStorage<{ depth: number }>();

export const MAX_TRIGGER_DEPTH = 3;

/**
 * Tables that have at least one active workflow subscribed to their writes. Maintained by
 * the triggerManager. Lets db.ts skip event-only work (and the existence SELECT in
 * upsert/increment) for the common case where nobody is watching the table.
 */
export const subscribedTables = new Set<string>();

/** Whether a specific table has any reactive subscriber. */
export function hasRowSubscribers(tableId: string): boolean {
  return subscribedTables.has(tableId);
}

/** Whether any table at all has a reactive subscriber (cheap global short-circuit). */
export function anyRowSubscribers(): boolean {
  return subscribedTables.size > 0;
}

export interface RowEvent {
  tableId: string;
  rowId: string;
  event: 'insert' | 'update';
  data: any;
  depth: number;
}

/**
 * Emits a row event, unless: nobody subscribes to the table (no work to do), or the
 * trigger-chain depth has hit the cap (cascade guard).
 */
export function emitRowEvent(tableId: string, rowId: string, event: 'insert' | 'update', data: any) {
  if (!subscribedTables.has(tableId)) return;
  const depth = triggerContext.getStore()?.depth ?? 0;
  if (depth >= MAX_TRIGGER_DEPTH) {
    console.warn(`[DataTableTrigger] Max depth (${MAX_TRIGGER_DEPTH}) reached — not emitting "${event}" on table ${tableId}.`);
    return;
  }
  dataTableBus.emit('row', { tableId, rowId, event, data, depth } as RowEvent);
}
