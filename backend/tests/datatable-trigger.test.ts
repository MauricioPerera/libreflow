import { describe, it, expect } from 'vitest';
import { dataTableBus, triggerContext, emitRowEvent, MAX_TRIGGER_DEPTH, RowEvent } from '../src/dataTableEvents.js';

function capture(fn: () => void): RowEvent[] {
  const events: RowEvent[] = [];
  const h = (e: RowEvent) => events.push(e);
  dataTableBus.on('row', h);
  try { fn(); } finally { dataTableBus.off('row', h); }
  return events;
}

describe('Data-table trigger — cascade depth guard', () => {
  it('emite el evento en profundidad 0 (escritura externa)', () => {
    const events = capture(() => emitRowEvent('t1', 'r1', 'insert', { a: 1 }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tableId: 't1', rowId: 'r1', event: 'insert', depth: 0 });
  });

  it('propaga la profundidad del contexto de trigger', () => {
    const events = capture(() => triggerContext.run({ depth: 1 }, () => emitRowEvent('t1', 'r1', 'update', { a: 1 })));
    expect(events[0].depth).toBe(1);
  });

  it('NO emite al alcanzar el tope (corta la cascada)', () => {
    const events = capture(() => triggerContext.run({ depth: MAX_TRIGGER_DEPTH }, () => emitRowEvent('t1', 'r1', 'insert', { a: 1 })));
    expect(events).toHaveLength(0);
  });

  it('la profundidad se propaga a través de awaits anidados', async () => {
    const events: RowEvent[] = [];
    const h = (e: RowEvent) => events.push(e);
    dataTableBus.on('row', h);
    await triggerContext.run({ depth: 2 }, async () => {
      await Promise.resolve();
      await new Promise(r => setTimeout(r, 0));
      emitRowEvent('t1', 'r1', 'insert', { a: 1 });
    });
    dataTableBus.off('row', h);
    expect(events[0].depth).toBe(2);
  });
});
