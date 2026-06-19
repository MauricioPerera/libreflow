import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, saveWorkflow } from '../src/db.js';
import { dispatchMcpRpc } from '../src/mcp.js';

// F3 — un named server (y el toolset propio del aiAgent) solo expone flujos de SU dueño.
// resolveScopedWorkflows filtra por owner cuando el scope trae ownerId; sin ownerId no filtra.
describe('F3 — MCP por dueño (named server / toolset)', () => {
  const A = `ownerA-${Math.random().toString(36).slice(2)}`;
  const B = `ownerB-${Math.random().toString(36).slice(2)}`;
  const wfA = `f3wfA-${Math.random().toString(36).slice(2)}`;
  const wfB = `f3wfB-${Math.random().toString(36).slice(2)}`;
  const node = [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }];

  beforeAll(async () => {
    await initDatabase();
    await saveWorkflow(wfA, 'Flujo A', node, [], undefined, null, A);
    await saveWorkflow(wfB, 'Flujo B', node, [], undefined, null, B);
  });

  async function toolNames(scope: any): Promise<string[]> {
    const r = await dispatchMcpRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, scope);
    return (r.payload?.result?.tools || []).map((t: any) => t.name);
  }

  it('con ownerId=A solo aparece el flujo de A', async () => {
    const names = await toolNames({ workflowIds: [wfA, wfB], exposeSystemTools: false, ownerId: A, isAdmin: false });
    const txt = JSON.stringify(names);
    expect(txt).toContain('A');
    expect(txt).not.toContain('flujo_b');
    // Exactamente un tool de flujo (el de A).
    expect(names.length).toBe(1);
  });

  it('sin ownerId (single-tenant/back-compat) aparecen ambos', async () => {
    const names = await toolNames({ workflowIds: [wfA, wfB], exposeSystemTools: false });
    expect(names.length).toBe(2);
  });

  it('admin (isAdmin) ve ambos aunque pase un ownerId', async () => {
    const names = await toolNames({ workflowIds: [wfA, wfB], exposeSystemTools: false, ownerId: A, isAdmin: true });
    expect(names.length).toBe(2);
  });
});
