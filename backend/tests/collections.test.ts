import { describe, it, expect } from 'vitest';
import {
  compareValues, filterItems, summarize, sortItems, limitItems, uniqueItems, getPath,
} from '../src/collections.js';
import { WorkflowEngine } from '../src/engine.js';

describe('collections: compareValues', () => {
  it('igualdad laxa y numérica', () => {
    expect(compareValues(5, 'equal', '5')).toBe(true);
    expect(compareValues('a', 'notEqual', 'b')).toBe(true);
    expect(compareValues(10, 'greaterThan', 2)).toBe(true);
    expect(compareValues(2, 'lessOrEqual', 2)).toBe(true);
    expect(compareValues('hola mundo', 'contains', 'mundo')).toBe(true);
    expect(compareValues('foo', 'startsWith', 'fo')).toBe(true);
    expect(compareValues('', 'isEmpty', null)).toBe(true);
    expect(compareValues([], 'isEmpty', null)).toBe(true);
    expect(compareValues('x', 'isNotEmpty', null)).toBe(true);
    expect(compareValues(true, 'isTrue', null)).toBe(true);
  });
});

describe('collections: getPath', () => {
  it('ruta con puntos y vacía', () => {
    expect(getPath({ a: { b: 7 } }, 'a.b')).toBe(7);
    expect(getPath({ a: 1 }, '')).toEqual({ a: 1 });
    expect(getPath(null, 'a.b')).toBeUndefined();
  });
});

describe('collections: filterItems', () => {
  const data = [{ s: 'active' }, { s: 'inactive' }, { s: 'active' }];
  it('filtra por campo', () => {
    const r = filterItems(data, { field: 's', operator: 'equal', value: 'active' });
    expect(r.kept).toBe(2);
    expect(r.removed).toBe(1);
    expect(r.total).toBe(3);
    expect(r.items).toEqual([{ s: 'active' }, { s: 'active' }]);
  });
  it('no-array → vacío', () => {
    expect(filterItems(null, { operator: 'equal', value: 1 }).items).toEqual([]);
  });
});

describe('collections: summarize', () => {
  const ventas = [
    { region: 'N', importe: 10 },
    { region: 'S', importe: 5 },
    { region: 'N', importe: 20 },
  ];
  it('group by + sum/avg/count', () => {
    const r = summarize(ventas, { groupBy: 'region', aggregations: [
      { fn: 'sum', field: 'importe', as: 'total' },
      { fn: 'count' },
    ] });
    const n = r.find((x: any) => x.region === 'N');
    const s = r.find((x: any) => x.region === 'S');
    expect(n.total).toBe(30);
    expect(n.count_all).toBe(2);
    expect(s.total).toBe(5);
  });
  it('sin groupBy resume todo', () => {
    const r = summarize(ventas, { aggregations: [{ fn: 'avg', field: 'importe', as: 'media' }] });
    expect(r).toHaveLength(1);
    expect(r[0].media).toBeCloseTo(35 / 3);
  });
});

describe('collections: sort / limit / unique', () => {
  it('ordena numérico asc/desc', () => {
    const data = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(sortItems(data, { field: 'n', dir: 'asc' }).map((x: any) => x.n)).toEqual([1, 2, 3]);
    expect(sortItems(data, { field: 'n', dir: 'desc' }).map((x: any) => x.n)).toEqual([3, 2, 1]);
    // no muta el original
    expect(data.map(x => x.n)).toEqual([3, 1, 2]);
  });
  it('limita', () => {
    expect(limitItems([1, 2, 3, 4, 5], 2)).toEqual([1, 2]);
  });
  it('quita duplicados por campo y por elemento entero', () => {
    expect(uniqueItems([{ id: 1 }, { id: 1 }, { id: 2 }], { field: 'id' })).toEqual([{ id: 1 }, { id: 2 }]);
    expect(uniqueItems([1, 1, 2, 2, 3], {})).toEqual([1, 2, 3]);
  });
});

describe('switch routing (motor)', () => {
  const engine = new WorkflowEngine();
  const make = () => ({
    id: 'wf-switch',
    nodes: [
      { id: 't', type: 'trigger', name: 'Start', parameters: {} },
      { id: 'sw', type: 'switch', name: 'Sw', parameters: {
        value1: '{{ $node.Start.output.payload.tipo }}',
        rules: '[{"operator":"equal","value2":"A","output":"0"},{"operator":"equal","value2":"B","output":"1"}]',
        fallbackOutput: 'default',
      } },
      { id: 'o0', type: 'set', name: 'OutA', parameters: { values: [{ key: 'r', value: 'es-A' }] } },
      { id: 'o1', type: 'set', name: 'OutB', parameters: { values: [{ key: 'r', value: 'es-B' }] } },
      { id: 'od', type: 'set', name: 'OutDef', parameters: { values: [{ key: 'r', value: 'es-def' }] } },
    ],
    connections: [
      { source: 't', target: 'sw' },
      { source: 'sw', target: 'o0', sourceHandle: '0' },
      { source: 'sw', target: 'o1', sourceHandle: '1' },
      { source: 'sw', target: 'od', sourceHandle: 'default' },
    ],
  });

  it('enruta a la rama que cumple y omite el resto', async () => {
    const r = await engine.execute(make() as any, { tipo: 'B' });
    expect(r.nodeResults['sw'].output.matched).toBe('1');
    expect(r.nodeResults['o1'].status).toBe('success');
    expect(r.nodeResults['o0'].status).toBe('skipped');
    expect(r.nodeResults['od'].status).toBe('skipped');
  });

  it('usa el fallback cuando ninguna regla cumple', async () => {
    const r = await engine.execute(make() as any, { tipo: 'Z' });
    expect(r.nodeResults['sw'].output.matched).toBe('default');
    expect(r.nodeResults['od'].status).toBe('success');
    expect(r.nodeResults['o0'].status).toBe('skipped');
    expect(r.nodeResults['o1'].status).toBe('skipped');
  });
});
