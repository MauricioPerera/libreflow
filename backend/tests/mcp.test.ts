import { describe, it, expect, vi } from 'vitest';
import router, { sanitizeMcpName, activeConnections, validateWorkflow } from '../src/mcp.js';
import { executeNode } from '../src/nodes.js';
import { NodeRegistry } from '../src/registry.js';
import { executeMcpToolCall } from '../src/mcp.js';

// Mock db.ts
vi.mock('../src/db.js', () => {
  const mockWorkflow = {
    id: 'flow-1',
    name: 'My Custom Workflow!',
    active: 1,
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        name: 'Start',
        parameters: {
          inputSchema: JSON.stringify({
            type: 'object',
            properties: {
              nombre: { type: 'string', description: 'Nombre del usuario' }
            },
            required: ['nombre']
          })
        }
      }
    ],
    connections: []
  };

  return {
    getActiveWorkflows: async () => [mockWorkflow],
    getWorkflows: async () => [mockWorkflow],
    getWorkflowById: async (id: string) => id === 'flow-1' ? mockWorkflow : null,
    saveWorkflow: async (id: string, name: string, nodes: any[], connections: any[], onErrorId?: string) => {},
    getAllExecutions: async () => [
      { id: 'exec-1', workflowId: 'flow-1', success: true, durationMs: 150, startTime: '2026-06-14T00:00:00Z', endTime: '2026-06-14T00:00:00Z' }
    ],
    getExecutionById: async (id: string) => id === 'exec-1' ? { id: 'exec-1', workflowId: 'flow-1', success: true, nodeResults: {} } : null,
    getDataTables: async () => [
      { id: 'table-1', name: 'Leads', columns: JSON.stringify([{ name: 'email', type: 'string' }]), created_at: '2026-06-14T00:00:00Z', updated_at: '2026-06-14T00:00:00Z' }
    ],
    saveDataTable: async (id: string, name: string, columns: any[]) => {},
    getDataTableRows: async (tableId: string) => [
      { id: 'row-1', table_id: tableId, data: { email: 'test@example.com' }, created_at: '2026-06-14T00:00:00Z', updated_at: '2026-06-14T00:00:00Z' }
    ],
    addDataTableRow: async (tableId: string, rowId: string, data: any) => {},
    updateDataTableRow: async (rowId: string, data: any) => {},
    deleteDataTableRow: async (rowId: string) => {}
  };
});

// Mock executor execution
vi.mock('../src/executor.js', () => {
  return {
    executeWorkflowAndRecord: async (workflow: any, payload: any) => {
      return {
        success: true,
        executionId: 'exec-mock-999',
        nodeResults: {
          'trigger-1': {
            nodeId: 'trigger-1',
            nodeName: 'Start',
            status: 'success',
            output: {
              saludo: `Hola ${payload.nombre || 'Mundo'}!`
            }
          }
        }
      };
    }
  };
});

describe('MCP Server & Client Integration', () => {
  describe('Name Sanitization', () => {
    it('should sanitize names to meet MCP requirements', () => {
      expect(sanitizeMcpName('My Custom Workflow!')).toBe('My_Custom_Workflow');
      expect(sanitizeMcpName('Flujo de Autenticación 1')).toBe('Flujo_de_Autenticacion_1');
    });

    it('should fallback to unnamed_tool for emoji-only or empty names', () => {
      expect(sanitizeMcpName('😊🔥')).toBe('unnamed_tool');
      expect(sanitizeMcpName('!!!')).toBe('unnamed_tool');
      expect(sanitizeMcpName('')).toBe('unnamed_tool');
    });
  });

  describe('MCP Client functions', () => {
    it('should mock connect, list tools, and call tools via fetch using Uint8Array streams', async () => {
      const encoder = new TextEncoder();
      const mockSseBody = {
        [Symbol.asyncIterator]: async function* () {
          yield encoder.encode("event: endpoint\ndata: /api/mcp/message?connectionId=conn-123\n\n");
        }
      };

      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any, options: any) => {
        if (typeof url === 'string' && url.endsWith('/sse-server')) {
          // SSE Handshake
          return {
            ok: true,
            body: mockSseBody
          } as any;
        }

        // POST requests to message endpoint
        if (options && options.method === 'POST') {
          const body = JSON.parse(options.body);
          if (body.method === 'initialize') {
            return {
              ok: true,
              json: async () => ({
                jsonrpc: '2.0',
                id: body.id,
                result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-server', version: '1.0' } }
              })
            } as any;
          }
          if (body.method === 'tools/call') {
            return {
              ok: true,
              json: async () => ({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  content: [{ type: 'text', text: '{"success":true,"result":"Ok"}' }]
                }
              })
            } as any;
          }
        }

        return { ok: false } as any;
      });

      const result = await executeMcpToolCall('http://localhost:9999/sse-server', 'my_tool', { param1: 'test' });
      expect(result.content[0].text).toContain('Ok');
      expect(fetchSpy).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('Node Registry mcpToolCall execution', () => {
    it('should execute mcpToolCall node in engine', async () => {
      const mcpNode = NodeRegistry.getNodeType('mcpToolCall');
      expect(mcpNode).toBeDefined();

      const encoder = new TextEncoder();
      const mockSseBody = {
        [Symbol.asyncIterator]: async function* () {
          yield encoder.encode("event: endpoint\ndata: /api/mcp/message?connectionId=conn-123\n\n");
        }
      };

      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any, options: any) => {
        if (typeof url === 'string' && url.endsWith('/sse')) {
          return { ok: true, body: mockSseBody } as any;
        }
        if (options && options.method === 'POST') {
          const body = JSON.parse(options.body);
          if (body.method === 'initialize') {
            return {
              ok: true,
              json: async () => ({ jsonrpc: '2.0', id: body.id, result: {} })
            } as any;
          }
          if (body.method === 'tools/call') {
            return {
              ok: true,
              json: async () => ({
                jsonrpc: '2.0',
                id: body.id,
                result: { hello: 'world' }
              })
            } as any;
          }
        }
        return { ok: false } as any;
      });

      // Passing arguments both as array (keyvalue parameter style)
      const nodeObjArray = {
        id: 'node-mcp-1',
        type: 'mcpToolCall',
        name: 'McpCall',
        parameters: {
          serverUrl: 'http://localhost:5000/sse',
          toolName: 'my_tool',
          arguments: [
            { key: 'nombre', value: 'Diego' },
            { key: 'edad', value: '30' }
          ]
        }
      };

      const outputArray = await executeNode(nodeObjArray, {});
      expect(outputArray).toEqual({ hello: 'world' });

      // Passing arguments as a raw object (safe check validation)
      const nodeObjRaw = {
        id: 'node-mcp-2',
        type: 'mcpToolCall',
        name: 'McpCallRaw',
        parameters: {
          serverUrl: 'http://localhost:5000/sse',
          toolName: 'my_tool',
          arguments: {
            nombre: 'Diego',
            edad: 30
          }
        }
      };

      const outputRaw = await executeNode(nodeObjRaw, {});
      expect(outputRaw).toEqual({ hello: 'world' });

      fetchSpy.mockRestore();
    });
  });

  describe('Express Router Endpoints & System Tools', () => {
    it('should handle SSE connection and save connection', async () => {
      let closeCb: (() => void) | null = null;
      const req = {
        on: vi.fn((event, cb) => {
          if (event === 'close') {
            closeCb = cb;
          }
        })
      } as any;
      
      const writtenHeaders: any[] = [];
      const writtenData: any[] = [];
      const res = {
        writeHead: vi.fn((status, headers) => {
          writtenHeaders.push({ status, headers });
        }),
        write: vi.fn((data) => {
          writtenData.push(data);
        })
      } as any;

      // Call the sse endpoint handler
      const sseRoute = router.stack.find((s: any) => s.route?.path === '/sse');
      expect(sseRoute).toBeDefined();
      
      await sseRoute.route.stack[0].handle(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(writtenData[0]).toContain('event: endpoint\ndata: /api/mcp/message?connectionId=');
      
      // Verify active connections has connectionId
      const connectionId = Array.from(activeConnections.keys())[0];
      expect(connectionId).toBeDefined();
      expect(activeConnections.get(connectionId)).toBe(res);

      // Close connection
      if (closeCb) closeCb();
      expect(activeConnections.has(connectionId)).toBe(false);
    });

    it('should reject message POST with missing or invalid connectionId', async () => {
      const req = {
        query: { connectionId: 'invalid-conn' },
        body: { jsonrpc: '2.0', id: 1, method: 'initialize' }
      } as any;

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      } as any;

      const messageRoute = router.stack.find((s: any) => s.route?.path === '/message');
      expect(messageRoute).toBeDefined();

      await messageRoute.route.stack[0].handle(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: -32000 })
      }));
    });

    it('should handle tools/list request and include system tools plus active workflows', async () => {
      const connId = 'conn-test-abc';
      const mockRes = { write: vi.fn() } as any;
      activeConnections.set(connId, mockRes);

      const req = {
        query: { connectionId: connId },
        body: { jsonrpc: '2.0', id: 45, method: 'tools/list' }
      } as any;

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      } as any;

      const messageRoute = router.stack.find((s: any) => s.route?.path === '/message');
      await messageRoute.route.stack[0].handle(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        jsonrpc: '2.0',
        id: 45,
        result: expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: 'libreflow_list_node_types' }),
            expect.objectContaining({ name: 'libreflow_validate_workflow' }),
            expect.objectContaining({ name: 'My_Custom_Workflow' })
          ])
        })
      }));

      activeConnections.delete(connId);
    });

    it('should execute libreflow_list_node_types via tools/call', async () => {
      const connId = 'conn-test-abc';
      const mockRes = {} as any;
      activeConnections.set(connId, mockRes);

      const req = {
        query: { connectionId: connId },
        body: {
          jsonrpc: '2.0',
          id: 50,
          method: 'tools/call',
          params: { name: 'libreflow_list_node_types', arguments: {} }
        }
      } as any;

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      } as any;

      const messageRoute = router.stack.find((s: any) => s.route?.path === '/message');
      await messageRoute.route.stack[0].handle(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = res.json.mock.calls[0][0];
      expect(response.result.content[0].text).toContain('trigger');
      expect(response.result.content[0].text).toContain('mcpToolCall');

      activeConnections.delete(connId);
    });

    it('should execute libreflow_validate_workflow via tools/call and return validation results', async () => {
      const connId = 'conn-test-abc';
      const mockRes = {} as any;
      activeConnections.set(connId, mockRes);

      const req = {
        query: { connectionId: connId },
        body: {
          jsonrpc: '2.0',
          id: 51,
          method: 'tools/call',
          params: {
            name: 'libreflow_validate_workflow',
            arguments: {
              nodes: [
                { id: '1', type: 'trigger', name: 'Start' },
                { id: '2', type: 'httpRequest', name: 'HTTP Req', parameters: { url: '' } } // Error: missing URL
              ],
              connections: [
                { source: '1', target: '2' }
              ]
            }
          }
        }
      } as any;

      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn()
      } as any;

      const messageRoute = router.stack.find((s: any) => s.route?.path === '/message');
      await messageRoute.route.stack[0].handle(req, res);

      expect(res.json).toHaveBeenCalled();
      const response = res.json.mock.calls[0][0];
      const resultObj = JSON.parse(response.result.content[0].text);
      expect(resultObj.valid).toBe(false);
      expect(resultObj.issues).toHaveLength(1);
      expect(resultObj.issues[0].message).toContain('url');

      activeConnections.delete(connId);
    });
  });

  describe('validateWorkflow logic', () => {
    it('should succeed for a valid workflow structure', () => {
      const nodes = [
        { id: '1', type: 'trigger', name: 'Start' },
        { id: '2', type: 'log', name: 'Log It', parameters: { message: 'hi' } }
      ];
      const connections = [{ source: '1', target: '2' }];
      const result = validateWorkflow(nodes, connections);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should catch missing trigger or multiple triggers', () => {
      // 0 triggers
      const res0 = validateWorkflow([{ id: '1', type: 'log', name: 'Log' }], []);
      expect(res0.valid).toBe(false);
      expect(res0.issues[0].message).toContain('nodo Trigger');

      // 2 triggers
      const res2 = validateWorkflow([
        { id: '1', type: 'trigger', name: 'T1' },
        { id: '2', type: 'trigger', name: 'T2' }
      ], []);
      expect(res2.valid).toBe(false);
      expect(res2.issues[0].message).toContain('múltiples nodos Trigger');
    });

    it('should catch disconnected nodes as warnings', () => {
      const nodes = [
        { id: '1', type: 'trigger', name: 'Start' },
        { id: '2', type: 'log', name: 'Log' },
        { id: '3', type: 'set', name: 'Set Var' } // Disconnected
      ];
      const connections = [{ source: '1', target: '2' }];
      const result = validateWorkflow(nodes, connections);
      expect(result.valid).toBe(true); // Warnings do not invalidate the workflow
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('warning');
      expect(result.issues[0].message).toContain('desconectado');
    });

    it('should catch cyclic dependencies (loops)', () => {
      const nodes = [
        { id: '1', type: 'trigger', name: 'Start' },
        { id: '2', type: 'log', name: 'Log 1' },
        { id: '3', type: 'log', name: 'Log 2' }
      ];
      // Cycle between 2 and 3
      const connections = [
        { source: '1', target: '2' },
        { source: '2', target: '3' },
        { source: '3', target: '2' }
      ];
      const result = validateWorkflow(nodes, connections);
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('error');
      expect(result.issues[0].message).toContain('dependencia cíclica');
    });

    it('should bypass cyclic warnings when loop node is used correctly', () => {
      const nodes = [
        { id: '1', type: 'trigger', name: 'Start' },
        { id: '2', type: 'loop', name: 'Loop Node' },
        { id: '3', type: 'log', name: 'Log Inside Loop' }
      ];
      const connections = [
        { source: '1', target: '2' },
        // Loop handle links to 3, and 3 goes back to loop node. This is a cycle but handled!
        { source: '2', target: '3', sourceHandle: 'loop' },
        { source: '3', target: '2' }
      ];
      const result = validateWorkflow(nodes, connections);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
  });

  describe('Data Tables MCP tools & Node execution', () => {
    it('should list and execute data table tools via MCP router', async () => {
      const connId = 'conn-test-abc';
      activeConnections.set(connId, {} as any);

      // 1. List data tables
      const reqList = {
        query: { connectionId: connId },
        body: { jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'libreflow_list_data_tables', arguments: {} } }
      } as any;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      const messageRoute = router.stack.find((s: any) => s.route?.path === '/message');
      await messageRoute.route.stack[0].handle(reqList, res);

      expect(res.json).toHaveBeenCalled();
      const listRes = res.json.mock.calls[0][0];
      expect(listRes.result.content[0].text).toContain('Leads');

      // 2. Get rows
      const reqRows = {
        query: { connectionId: connId },
        body: { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'libreflow_get_data_table_rows', arguments: { tableId: 'table-1' } } }
      } as any;
      res.json.mockClear();
      await messageRoute.route.stack[0].handle(reqRows, res);
      const rowsRes = res.json.mock.calls[0][0];
      expect(rowsRes.result.content[0].text).toContain('test@example.com');

      activeConnections.delete(connId);
    });

    it('should execute dataTable node in engine', async () => {
      const dtNode = NodeRegistry.getNodeType('dataTable');
      expect(dtNode).toBeDefined();

      const nodeObj = {
        id: 'node-dt-1',
        type: 'dataTable',
        name: 'DataTableOp',
        parameters: {
          operation: 'append',
          tableId: 'table-1',
          fields: [
            { key: 'email', value: 'inserted@example.com' },
            { key: 'status', value: 'active' }
          ]
        }
      };

      const result = await executeNode(nodeObj, {});
      expect(result.id).toBeDefined();
      expect(result.tableId).toBe('table-1');
      expect(result.data.email).toBe('inserted@example.com');
    });
  });
});
