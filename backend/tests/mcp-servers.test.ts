import { describe, it, expect, vi } from 'vitest';

// Mock db.ts with two workflows and a couple of named MCP servers.
vi.mock('../src/db.js', () => {
  const flowA = {
    id: 'flow-a',
    name: 'Flujo A',
    active: 1,
    nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }],
    connections: []
  };
  const flowB = {
    id: 'flow-b',
    name: 'Flujo B',
    active: 1,
    nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }],
    connections: []
  };
  // Two workflows whose names sanitize to the same string (collision case).
  const c1 = { id: 'c1', name: 'Flujo #1', nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }], connections: [] };
  const c2 = { id: 'c2', name: 'Flujo 1', nodes: [{ id: 't', type: 'trigger', name: 'Start', parameters: {} }], connections: [] };
  const byId: Record<string, any> = { 'flow-a': flowA, 'flow-b': flowB, 'c1': c1, 'c2': c2 };

  const servers: Record<string, any> = {
    'srv-auth': {
      id: 'srv-auth',
      name: 'Grupo protegido',
      workflow_ids: ['flow-a'],
      token: 'secret-token',
      require_auth: true,
      expose_system_tools: false
    },
    'srv-public': {
      id: 'srv-public',
      name: 'Grupo público',
      workflow_ids: ['flow-b'],
      token: 'unused',
      require_auth: false,
      expose_system_tools: false
    }
  };

  return {
    getActiveWorkflows: async () => [flowA, flowB],
    getWorkflowById: async (id: string) => byId[id] || null,
    getWorkflows: async () => [flowA, flowB],
    getAllExecutions: async () => [],
    getExecutionById: async () => null,
    getDataTables: async () => [],
    saveWorkflow: async () => {},
    saveDataTable: async () => {},
    getDataTableRows: async () => [
      { id: 'r1', data: { status: 'active', email: 'a@x.com' } },
      { id: 'r2', data: { status: 'inactive', email: 'b@x.com' } },
    ],
    addDataTableRow: async () => {},
    deleteWorkflow: async () => {},
    setWorkflowActiveState: async () => {},
    updateDataTableRow: async () => {},
    deleteDataTableRow: async () => {},
    deleteDataTable: async () => {},
    getMcpServerById: async (id: string) => servers[id] || null
  };
});

// Avoid touching real cron/trigger registration during set_workflow_active.
vi.mock('../src/triggerManager.js', () => ({
  triggerManager: { startTriggers: async () => {}, stopTriggers: () => {} },
}));

// Avoid real workflow execution if a tools/call happens to reach it.
vi.mock('../src/executor.js', () => ({
  executeWorkflowAndRecord: async () => ({
    success: true,
    nodeResults: { t: { nodeId: 't', nodeName: 'Start', status: 'success', output: { ok: true } } }
  })
}));

import { dispatchMcpRpc, publicMcpRouter, sanitizeMcpName } from '../src/mcp.js';

function getRoute(path: string) {
  const layer = (publicMcpRouter as any).stack.find((s: any) => s.route?.path === path);
  expect(layer).toBeDefined();
  return layer.route.stack[0].handle;
}

describe('Named MCP servers — scoping', () => {
  it('tools/list exposes only the workflows in the group and no system tools', async () => {
    const { status, payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { workflowIds: ['flow-a'], exposeSystemTools: false }
    );
    expect(status).toBe(200);
    const names = payload.result.tools.map((t: any) => t.name);
    expect(names).toEqual([sanitizeMcpName('Flujo A')]);
    expect(names).not.toContain(sanitizeMcpName('Flujo B'));
    expect(names.some((n: string) => n.startsWith('libreflow_'))).toBe(false);
  });

  it('tools/list includes system tools when the scope opts in', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { workflowIds: ['flow-a'], exposeSystemTools: true }
    );
    const names = payload.result.tools.map((t: any) => t.name);
    expect(names).toContain('libreflow_run_workflow');
  });

  it('tools/call rejects a workflow outside the group', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: sanitizeMcpName('Flujo B'), arguments: {} } },
      { workflowIds: ['flow-a'], exposeSystemTools: false }
    );
    expect(payload.error).toBeDefined();
    expect(payload.error.message).toContain('Tool not found');
  });

  it('tools/call rejects system tools when not exposed', async () => {
    const { status, payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'libreflow_run_workflow', arguments: {} } },
      { workflowIds: ['flow-a'], exposeSystemTools: false }
    );
    expect(status).toBe(404);
    expect(payload.error.message).toContain('System tool not available');
  });

  it('tools/call executes a workflow that IS in the group', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: sanitizeMcpName('Flujo A'), arguments: {} } },
      { workflowIds: ['flow-a'], exposeSystemTools: false }
    );
    expect(payload.result).toBeDefined();
    expect(payload.result.content[0].text).toContain('success');
  });
});

describe('Tool name uniqueness & new system tools', () => {
  it('asigna nombres únicos a workflows que sanitizan igual', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { workflowIds: ['c1', 'c2'], exposeSystemTools: false }
    );
    const names = payload.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['Flujo_1', 'Flujo_1_2']);
  });

  it('tools/call enruta al workflow correcto con el nombre desambiguado', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'Flujo_1_2', arguments: {} } },
      { workflowIds: ['c1', 'c2'], exposeSystemTools: false }
    );
    expect(payload.result).toBeDefined();
    expect(payload.error).toBeUndefined();
  });

  it('tools/list incluye las nuevas system tools cuando hay opt-in', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { workflowIds: ['flow-a'], exposeSystemTools: true }
    );
    const names = payload.result.tools.map((t: any) => t.name);
    for (const n of [
      'libreflow_delete_workflow',
      'libreflow_set_workflow_active',
      'libreflow_search_data_table_rows',
      'libreflow_update_data_table_row',
      'libreflow_delete_data_table_row',
      'libreflow_delete_data_table',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('set_workflow_active ejecuta y responde', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'libreflow_set_workflow_active', arguments: { id: 'flow-a', active: true } } },
      { workflowIds: null, exposeSystemTools: true }
    );
    expect(payload.result.content[0].text).toContain('activated');
  });

  it('search_data_table_rows filtra por campo exacto', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'libreflow_search_data_table_rows', arguments: { tableId: 't1', filters: { status: 'active' } } } },
      { workflowIds: null, exposeSystemTools: true }
    );
    const rows = JSON.parse(payload.result.content[0].text);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.status).toBe('active');
  });

  it('las system tools declaran annotations (read-only / destructive)', async () => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      { workflowIds: ['flow-a'], exposeSystemTools: true }
    );
    const byName: Record<string, any> = {};
    for (const t of payload.result.tools) byName[t.name] = t;
    expect(byName['libreflow_list_workflows'].annotations.readOnlyHint).toBe(true);
    expect(byName['libreflow_delete_workflow'].annotations.destructiveHint).toBe(true);
    expect(byName['libreflow_upsert_data_table_row'].annotations.idempotentHint).toBe(true);
  });

  it('las nuevas system tools están bloqueadas sin opt-in', async () => {
    const { status, payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'libreflow_delete_workflow', arguments: { id: 'flow-a' } } },
      { workflowIds: ['flow-a'], exposeSystemTools: false }
    );
    expect(status).toBe(404);
    expect(payload.error.message).toContain('System tool not available');
  });
});

describe('Named MCP servers — auth on public endpoints', () => {
  it('returns 404 for an unknown server', async () => {
    const handle = getRoute('/:serverId/sse');
    const req: any = { params: { serverId: 'nope' }, header: () => undefined, on: vi.fn() };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handle(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('rejects a protected server without a valid token (401)', async () => {
    const handle = getRoute('/:serverId/sse');
    const req: any = { params: { serverId: 'srv-auth' }, header: () => undefined, on: vi.fn() };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn(), writeHead: vi.fn(), write: vi.fn() };
    await handle(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts a protected server with the correct bearer token', async () => {
    const handle = getRoute('/:serverId/sse');
    const headers: Record<string, string> = { authorization: 'Bearer secret-token' };
    const req: any = {
      params: { serverId: 'srv-auth' },
      header: (k: string) => headers[k.toLowerCase()],
      on: vi.fn()
    };
    const writes: string[] = [];
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      writeHead: vi.fn(),
      write: vi.fn((d: string) => writes.push(d))
    };
    await handle(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(writes[0]).toContain('event: endpoint\ndata: /mcp/srv-auth/message?connectionId=');
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('allows a public server with no token', async () => {
    const handle = getRoute('/:serverId/sse');
    const req: any = { params: { serverId: 'srv-public' }, header: () => undefined, on: vi.fn() };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn(), writeHead: vi.fn(), write: vi.fn() };
    await handle(req, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.status).not.toHaveBeenCalledWith(401);
  });
});
