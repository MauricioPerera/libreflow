import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, saveDataTable, getWorkflowById, getExecutionById } from '../src/db.js';
import { dispatchMcpRpc } from '../src/mcp.js';

// Optimizaciones de "Agentic DX": query_data (lectura unificada), batch_rows (escrituras en
// lote), save_workflow auto-validado y alias workflowId retrocompatible.
const scope = { workflowIds: null, exposeSystemTools: true } as any;
let nid = 1;
async function call(name: string, args: any) {
  const r = await dispatchMcpRpc({ jsonrpc: '2.0', id: nid++, method: 'tools/call', params: { name, arguments: args } }, scope);
  const text = r.payload?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : r.payload;
}

const sfx = Math.random().toString(36).slice(2, 7);
const tableId = `dx-${sfx}`;

describe('MCP Agentic DX', () => {
  beforeAll(async () => {
    await initDatabase();
    await saveDataTable(tableId, tableId, [{ name: 'name', type: 'string' }, { name: 'score', type: 'number' }], 'name');
  });

  it('batch_rows: inserta varias filas en una sola llamada atómica', async () => {
    const res = await call('libreflow_batch_rows', { tableId, ops: [
      { op: 'upsert', data: { name: 'alice', score: 10 } },
      { op: 'upsert', data: { name: 'bob', score: 20 } },
      { op: 'upsert', data: { name: 'carol', score: 30 } },
    ] });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(3);
  });

  it('query_data: modo list (sin filtros) devuelve total', async () => {
    const r = await call('libreflow_query_data', { tableId });
    expect(r.mode).toBe('list');
    expect(r.total).toBe(3);
    expect(r.rows.length).toBe(3);
  });

  it('query_data: modo query (filters por operador)', async () => {
    const r = await call('libreflow_query_data', { tableId, filters: [{ column: 'score', op: 'gte', value: 20 }] });
    expect(r.mode).toBe('query');
    expect(r.rows.map((x: any) => x.data.name).sort()).toEqual(['bob', 'carol']);
  });

  it('query_data: modo get (por key)', async () => {
    const r = await call('libreflow_query_data', { tableId, key: 'alice' });
    expect(r.mode).toBe('get');
    expect(r.row.data.score).toBe(10);
  });

  it('save_workflow: aborta y devuelve issues si el flujo es inválido', async () => {
    // Sin trigger → error estructural (debe abortar el guardado).
    const wId = `wf-bad-${sfx}`;
    const r = await call('libreflow_save_workflow', { workflowId: wId, name: 'malo', nodes: [{ id: 'a', type: 'log', name: 'L', parameters: {} }], connections: [] });
    expect(r.saved).toBe(false);
    expect(r.valid).toBe(false);
    expect(Array.isArray(r.issues)).toBe(true);
    expect(await getWorkflowById(wId)).toBeFalsy(); // no se guardó
  });

  it('save_workflow: guarda si es válido y devuelve saved:true', async () => {
    const wId = `wf-ok-${sfx}`;
    const nodes = [
      { id: 't', type: 'trigger', name: 'Start', parameters: {} },
      { id: 'l', type: 'log', name: 'Log', parameters: { message: 'hi' } },
    ];
    const r = await call('libreflow_save_workflow', { workflowId: wId, name: 'bueno', nodes, connections: [{ source: 't', target: 'l' }] });
    expect(r.saved).toBe(true);
    expect(await getWorkflowById(wId)).not.toBeNull();
  });

  it('run_workflow wait:false devuelve executionId+pending y la ejecución termina en background', async () => {
    const wId = `wf-async-${sfx}`;
    await call('libreflow_save_workflow', { workflowId: wId, name: 'async', nodes: [
      { id: 't', type: 'trigger', name: 'Start', parameters: {} },
      { id: 'l', type: 'log', name: 'Log', parameters: { message: 'hola' } },
    ], connections: [{ source: 't', target: 'l' }] });

    const r = await call('libreflow_run_workflow', { workflowId: wId, wait: false });
    expect(r.status).toBe('pending');
    expect(typeof r.executionId).toBe('string');

    // Polling hasta que el run detached termine.
    let status = 'running';
    for (let i = 0; i < 40 && status === 'running'; i++) {
      await new Promise(res => setTimeout(res, 50));
      const exec = await getExecutionById(r.executionId);
      status = exec?.status ?? 'running';
    }
    expect(status).toBe('success');
  });

  it('alias workflowId: get_workflow acepta el "id" legacy', async () => {
    const wId = `wf-alias-${sfx}`;
    await call('libreflow_save_workflow', { workflowId: wId, name: 'alias', nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }], connections: [] });
    const byLegacy = await call('libreflow_get_workflow', { id: wId });   // alias legacy
    const byNew = await call('libreflow_get_workflow', { workflowId: wId }); // estándar
    expect(byLegacy.id).toBe(wId);
    expect(byNew.id).toBe(wId);
  });
});
