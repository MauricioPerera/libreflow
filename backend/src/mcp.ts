import { Router, Response } from 'express';
import { 
  getActiveWorkflows, 
  getWorkflows, 
  getWorkflowById, 
  saveWorkflow, 
  getAllExecutions, 
  getExecutionById,
  getDataTables,
  saveDataTable,
  getDataTableRows,
  addDataTableRow,
  getMcpServerById,
  deleteWorkflow,
  setWorkflowActiveState,
  updateDataTableRow,
  deleteDataTableRow,
  deleteDataTable
} from './db.js';
import { NodeRegistry } from './registry.js';
import { assertSafeUrl } from './security.js';
import { constantTimeEqual } from './auth.js';
import { triggerManager } from './triggerManager.js';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client as McpSdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const router = Router();
export const activeConnections = new Map<string, Response>();

// --- MCP SERVER ENDPOINTS ---

// SSE Endpoint
router.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  activeConnections.set(connectionId, res);

  // Send connect endpoint URL to client
  const messageUrl = `/api/mcp/message?connectionId=${connectionId}`;
  res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);

  req.on('close', () => {
    activeConnections.delete(connectionId);
  });
});

export interface ValidationIssue {
  severity: 'error' | 'warning';
  nodeId?: string;
  nodeName?: string;
  message: string;
}

export function validateWorkflow(nodes: any[], connections: any[]): { valid: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];

  // Rule 1: Trigger nodes
  const triggerNodes = nodes.filter((n: any) => n.type === 'trigger');
  if (triggerNodes.length === 0) {
    issues.push({
      severity: 'error',
      message: 'El flujo de trabajo debe contener exactamente un nodo Trigger (Inicio).'
    });
  } else if (triggerNodes.length > 1) {
    issues.push({
      severity: 'error',
      message: `El flujo contiene múltiples nodos Trigger (${triggerNodes.map(t => t.name || t.id).join(', ')}). Solo se permite uno.`
    });
  }

  // Helper mapping
  const nodeMap = new Map<string, any>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Rule 2 & 3: Node validation
  for (const node of nodes) {
    const nodeDef = NodeRegistry.getNodeType(node.type);
    if (!nodeDef) {
      issues.push({
        severity: 'error',
        nodeId: node.id,
        nodeName: node.name,
        message: `El tipo de nodo "${node.type}" no está registrado en el sistema.`
      });
      continue;
    }

    // Parameters check
    const params = node.parameters || {};
    if (node.type === 'httpRequest') {
      if (!params.url || params.url.trim() === '') {
        issues.push({
          severity: 'error',
          nodeId: node.id,
          nodeName: node.name,
          message: 'Falta el parámetro requerido "url" en el nodo Petición HTTP.'
        });
      }
    } else if (node.type === 'executeWorkflow') {
      if (!params.targetWorkflowId || params.targetWorkflowId.trim() === '') {
        issues.push({
          severity: 'error',
          nodeId: node.id,
          nodeName: node.name,
          message: 'Falta el parámetro requerido "targetWorkflowId" en el nodo Sub-workflow.'
        });
      }
    } else if (node.type === 'mcpToolCall') {
      if (!params.serverUrl || params.serverUrl.trim() === '') {
        issues.push({
          severity: 'error',
          nodeId: node.id,
          nodeName: node.name,
          message: 'Falta el parámetro requerido "serverUrl" en el nodo Llamada Herramienta MCP.'
        });
      }
      if (!params.toolName || params.toolName.trim() === '') {
        issues.push({
          severity: 'error',
          nodeId: node.id,
          nodeName: node.name,
          message: 'Falta el parámetro requerido "toolName" en el nodo Llamada Herramienta MCP.'
        });
      }
    }
  }

  // Rule 4: Reachability (Disconnected Nodes)
  if (triggerNodes.length === 1) {
    const startNode = triggerNodes[0];
    const adjacencyList = new Map<string, string[]>();
    for (const node of nodes) {
      adjacencyList.set(node.id, []);
    }
    for (const conn of connections) {
      if (adjacencyList.has(conn.source)) {
        adjacencyList.get(conn.source)!.push(conn.target);
      }
    }

    const visited = new Set<string>();
    const queue: string[] = [startNode.id];
    visited.add(startNode.id);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const neighbors = adjacencyList.get(curr) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          nodeName: node.name,
          message: 'Este nodo está desconectado y nunca será ejecutado.'
        });
      }
    }
  }

  // Rule 5: Cycles that don't involve "loop" nodes
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const conn of connections) {
    const sourceNode = nodeMap.get(conn.source);
    if (sourceNode && sourceNode.type === 'loop' && conn.sourceHandle === 'loop') {
      continue;
    }
    if (adj.has(conn.source)) {
      adj.get(conn.source)!.push(conn.target);
    }
  }

  const visitedState = new Map<string, 'unvisited' | 'visiting' | 'visited'>();
  for (const node of nodes) {
    visitedState.set(node.id, 'unvisited');
  }

  let hasCycles = false;
  function dfs(nodeId: string): boolean {
    visitedState.set(nodeId, 'visiting');
    const neighbors = adj.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (visitedState.get(neighbor) === 'visiting') {
        return true;
      } else if (visitedState.get(neighbor) === 'unvisited') {
        if (dfs(neighbor)) return true;
      }
    }
    visitedState.set(nodeId, 'visited');
    return false;
  }

  for (const node of nodes) {
    if (visitedState.get(node.id) === 'unvisited') {
      if (dfs(node.id)) {
        hasCycles = true;
        break;
      }
    }
  }

  if (hasCycles) {
    issues.push({
      severity: 'error',
      message: 'Se ha detectado una dependencia cíclica (bucle infinito) en las conexiones del flujo.'
    });
  }

  const valid = !issues.some(issue => issue.severity === 'error');
  return { valid, issues };
}

const SYSTEM_TOOLS = [
  {
    name: 'libreflow_list_node_types',
    description: 'List all node types and their parameter schemas in the LibreFlow platform.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'libreflow_list_workflows',
    description: 'Get a list of all workflows in the platform (both active and inactive).',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'libreflow_get_workflow',
    description: 'Retrieve the detailed JSON definition of a workflow by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The unique ID of the workflow to retrieve.' }
      },
      required: ['id']
    }
  },
  {
    name: 'libreflow_save_workflow',
    description: 'Save or update a workflow in the platform.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The unique ID of the workflow.' },
        name: { type: 'string', description: 'The name of the workflow.' },
        nodes: {
          type: 'array',
          description: 'The list of node definitions in the workflow.',
          items: { type: 'object' }
        },
        connections: {
          type: 'array',
          description: 'The list of connections between nodes.',
          items: { type: 'object' }
        },
        onErrorWorkflowId: { type: 'string', description: 'Optional workflow ID to trigger on failure.' }
      },
      required: ['id', 'name', 'nodes', 'connections']
    }
  },
  {
    name: 'libreflow_run_workflow',
    description: 'Manually trigger a workflow run and get its execution report.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The ID of the workflow to run.' },
        payload: {
          type: 'object',
          description: 'Optional initial payload/variables to inject into the trigger.',
          additionalProperties: true
        }
      },
      required: ['workflowId']
    }
  },
  {
    name: 'libreflow_list_executions',
    description: 'List recent executions and runs across the platform.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'libreflow_get_execution',
    description: 'Get detailed results and node-by-node logs for a specific execution ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The unique execution ID.' }
      },
      required: ['id']
    }
  },
  {
    name: 'libreflow_validate_workflow',
    description: 'Perform a static validation analysis on a workflow to detect structural errors, missing parameters, disconnected nodes, or infinite loops before publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description: 'List of node definitions in the workflow.',
          items: { type: 'object' }
        },
        connections: {
          type: 'array',
          description: 'List of connections between nodes.',
          items: { type: 'object' }
        }
      },
      required: ['nodes', 'connections']
    }
  },
  {
    name: 'libreflow_list_data_tables',
    description: 'Get list of all data tables on the platform, including schemas.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'libreflow_create_data_table',
    description: 'Create a new data table with the specified name and columns.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The unique name of the data table.' },
        columns: {
          type: 'array',
          description: 'The columns list of the table: [{ name: string, type: "string" | "number" | "boolean" }]',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'boolean'] }
            },
            required: ['name', 'type']
          }
        }
      },
      required: ['name', 'columns']
    }
  },
  {
    name: 'libreflow_get_data_table_rows',
    description: 'Fetch all rows from a specified data table by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' }
      },
      required: ['tableId']
    }
  },
  {
    name: 'libreflow_add_data_table_rows',
    description: 'Add one or more rows to a data table.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        rows: {
          type: 'array',
          description: 'List of row objects to insert: [{"email": "info@example.com"}]',
          items: {
            type: 'object'
          }
        }
      },
      required: ['tableId', 'rows']
    }
  },
  {
    name: 'libreflow_delete_workflow',
    description: 'Delete a workflow permanently by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The unique ID of the workflow to delete.' }
      },
      required: ['id']
    }
  },
  {
    name: 'libreflow_set_workflow_active',
    description: 'Activate or deactivate a workflow. Active workflows are exposed as MCP tools and run their cron/webhook triggers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The unique ID of the workflow.' },
        active: { type: 'boolean', description: 'true to activate, false to deactivate.' }
      },
      required: ['id', 'active']
    }
  },
  {
    name: 'libreflow_search_data_table_rows',
    description: 'Search rows in a data table by exact-match field filters.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        filters: {
          type: 'object',
          description: 'Field/value pairs to match exactly, e.g. {"status":"active"}. Omit to return all rows.',
          additionalProperties: true
        }
      },
      required: ['tableId']
    }
  },
  {
    name: 'libreflow_update_data_table_row',
    description: 'Update the data of an existing row by its row ID.',
    inputSchema: {
      type: 'object',
      properties: {
        rowId: { type: 'string', description: 'The unique ID of the row to update.' },
        data: {
          type: 'object',
          description: 'The new field/value data for the row.',
          additionalProperties: true
        }
      },
      required: ['rowId', 'data']
    }
  },
  {
    name: 'libreflow_delete_data_table_row',
    description: 'Delete a single row from a data table by its row ID.',
    inputSchema: {
      type: 'object',
      properties: {
        rowId: { type: 'string', description: 'The unique ID of the row to delete.' }
      },
      required: ['rowId']
    }
  },
  {
    name: 'libreflow_delete_data_table',
    description: 'Delete a data table and all of its rows by table ID.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table to delete.' }
      },
      required: ['tableId']
    }
  }
];

/**
 * Scope of an MCP session: which workflows are exposed as tools and whether the
 * `libreflow_*` system tools are available. `workflowIds: null` means "all active
 * workflows" (the always-on global server); an explicit array means a curated group
 * (a named MCP server, exposed regardless of each workflow's global `active` flag).
 */
export interface McpScope {
  workflowIds: string[] | null;
  exposeSystemTools: boolean;
}

async function resolveScopedWorkflows(scope: McpScope): Promise<any[]> {
  if (scope.workflowIds === null) {
    return await getActiveWorkflows();
  }
  const out: any[] = [];
  for (const wid of scope.workflowIds) {
    const wf = await getWorkflowById(wid);
    if (wf) out.push(wf);
  }
  return out;
}

/**
 * Maps each workflow id to a UNIQUE MCP tool name. Two workflows whose names sanitize
 * to the same string (e.g. "Flujo #1" and "Flujo 1") would otherwise collide and make
 * tools/call ambiguous; collisions get a numeric suffix (`_2`, `_3`, …).
 */
function assignUniqueToolNames(workflows: any[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const w of workflows) {
    const base = sanitizeMcpName(w.name);
    let name = base;
    let i = 2;
    while (used.has(name)) name = `${base}_${i++}`;
    used.add(name);
    map.set(w.id, name);
  }
  return map;
}

type RpcResult = { status: number; payload: any };

/**
 * Pure JSON-RPC dispatcher for the MCP protocol, parameterized by `scope`. Returns
 * the HTTP status + JSON-RPC payload so it can back both the global `/api/mcp`
 * endpoint and the per-server public endpoints (`/mcp/:id`). The caller owns the
 * transport (SSE connection check, auth) and writes the response.
 */
export async function dispatchMcpRpc(body: any, scope: McpScope): Promise<RpcResult> {
  const { id, method, params } = body;

  try {
    if (method === 'initialize') {
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'LibreFlow MCP Server', version: '1.0.0' }
          }
        }
      };
    }

    if (method === 'tools/list') {
      const workflows = await resolveScopedWorkflows(scope);
      const nameMap = assignUniqueToolNames(workflows);
      const workflowTools = workflows.map(workflow => {
        let inputSchema: any = { type: 'object', properties: {} };

        const triggerNode = (workflow.nodes || []).find((n: any) => n.type === 'trigger');
        if (triggerNode && triggerNode.parameters && triggerNode.parameters.inputSchema) {
          try {
            const parsed = typeof triggerNode.parameters.inputSchema === 'string'
              ? JSON.parse(triggerNode.parameters.inputSchema)
              : triggerNode.parameters.inputSchema;
            if (parsed && typeof parsed === 'object') {
              inputSchema = parsed;
            }
          } catch (err) {
            // Fail silently and use default empty schema
          }
        }

        return {
          name: nameMap.get(workflow.id),
          description: `Ejecuta el flujo LibreFlow: ${workflow.name}`,
          inputSchema
        };
      });

      const tools = scope.exposeSystemTools ? [...SYSTEM_TOOLS, ...workflowTools] : workflowTools;
      return { status: 200, payload: { jsonrpc: '2.0', id, result: { tools } } };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArguments = params?.arguments || {};

      if (typeof toolName === 'string' && toolName.startsWith('libreflow_')) {
        // System tools are only reachable when the scope opts into them.
        if (!scope.exposeSystemTools) {
          return { status: 404, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `System tool not available on this server: ${toolName}` } } };
        }

        if (toolName === 'libreflow_list_node_types') {
          const list = NodeRegistry.getAllNodeTypes().map(nodeDef => {
            const { execute, ...meta } = nodeDef;
            return meta;
          });
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] } } };
        }

        if (toolName === 'libreflow_list_workflows') {
          const list = await getWorkflows();
          const cleanList = list.map(w => ({ id: w.id, name: w.name, active: w.active }));
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(cleanList, null, 2) }] } } };
        }

        if (toolName === 'libreflow_get_workflow') {
          const wId = toolArguments.id;
          if (!wId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id parameter' } } };
          }
          const workflow = await getWorkflowById(wId);
          if (!workflow) {
            return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Workflow not found with ID: ${wId}` }] } } };
          }
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(workflow, null, 2) }] } } };
        }

        if (toolName === 'libreflow_save_workflow') {
          const { id: wId, name: wName, nodes = [], connections = [], onErrorWorkflowId } = toolArguments;
          if (!wId || !wName) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id or name parameter' } } };
          }
          await saveWorkflow(wId, wName, nodes, connections, onErrorWorkflowId);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Workflow '${wName}' saved successfully.` }] } } };
        }

        if (toolName === 'libreflow_run_workflow') {
          const wId = toolArguments.workflowId;
          const payload = toolArguments.payload || {};
          if (!wId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing workflowId parameter' } } };
          }
          const workflow = await getWorkflowById(wId);
          if (!workflow) {
            return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Workflow not found with ID: ${wId}` }] } } };
          }
          const { executeWorkflowAndRecord } = await import('./executor.js');
          const report = await executeWorkflowAndRecord(workflow, payload);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] } } };
        }

        if (toolName === 'libreflow_list_executions') {
          const list = await getAllExecutions();
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] } } };
        }

        if (toolName === 'libreflow_get_execution') {
          const execId = toolArguments.id;
          if (!execId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id parameter' } } };
          }
          const execution = await getExecutionById(execId);
          if (!execution) {
            return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Execution not found with ID: ${execId}` }] } } };
          }
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(execution, null, 2) }] } } };
        }

        if (toolName === 'libreflow_validate_workflow') {
          const { nodes = [], connections = [] } = toolArguments;
          const result = validateWorkflow(nodes, connections);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } } };
        }

        if (toolName === 'libreflow_list_data_tables') {
          const list = await getDataTables();
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] } } };
        }

        if (toolName === 'libreflow_create_data_table') {
          const { name: tName, columns = [] } = toolArguments;
          if (!tName) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing name parameter' } } };
          }
          const tId = `table-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          await saveDataTable(tId, tName, columns);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Data table '${tName}' created successfully with ID: ${tId}` }] } } };
        }

        if (toolName === 'libreflow_get_data_table_rows') {
          const tId = toolArguments.tableId;
          if (!tId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tableId parameter' } } };
          }
          const rows = await getDataTableRows(tId);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] } } };
        }

        if (toolName === 'libreflow_add_data_table_rows') {
          const tId = toolArguments.tableId;
          const rows = toolArguments.rows || [];
          if (!tId || !Array.isArray(rows)) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tableId or invalid rows parameter' } } };
          }
          const addedIds: string[] = [];
          for (const rowData of rows) {
            const rowId = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
            await addDataTableRow(tId, rowId, rowData);
            addedIds.push(rowId);
          }
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Successfully added ${rows.length} rows. IDs: ${addedIds.join(', ')}` }] } } };
        }

        if (toolName === 'libreflow_delete_workflow') {
          const wId = toolArguments.id;
          if (!wId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id parameter' } } };
          }
          await deleteWorkflow(wId);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Workflow '${wId}' deleted.` }] } } };
        }

        if (toolName === 'libreflow_set_workflow_active') {
          const wId = toolArguments.id;
          const active = !!toolArguments.active;
          if (!wId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id parameter' } } };
          }
          const workflow = await getWorkflowById(wId);
          if (!workflow) {
            return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Workflow not found with ID: ${wId}` }] } } };
          }
          await setWorkflowActiveState(wId, active);
          // Mirror the HTTP endpoint: (de)register cron/webhook triggers in memory.
          if (active) {
            const fresh = await getWorkflowById(wId);
            if (fresh) await triggerManager.startTriggers(fresh);
          } else {
            triggerManager.stopTriggers(wId);
          }
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Workflow '${workflow.name}' ${active ? 'activated' : 'deactivated'}.` }] } } };
        }

        if (toolName === 'libreflow_search_data_table_rows') {
          const tId = toolArguments.tableId;
          if (!tId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tableId parameter' } } };
          }
          const filters = (toolArguments.filters && typeof toolArguments.filters === 'object') ? toolArguments.filters : {};
          const allRows = await getDataTableRows(tId);
          const filtered = allRows.filter((row: any) => {
            for (const [k, v] of Object.entries(filters)) {
              if (String(row.data?.[k]) !== String(v)) return false;
            }
            return true;
          });
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] } } };
        }

        if (toolName === 'libreflow_update_data_table_row') {
          const rowId = toolArguments.rowId;
          const data = toolArguments.data;
          if (!rowId || !data || typeof data !== 'object') {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing rowId or data parameter' } } };
          }
          await updateDataTableRow(rowId, data);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Row '${rowId}' updated.` }] } } };
        }

        if (toolName === 'libreflow_delete_data_table_row') {
          const rowId = toolArguments.rowId;
          if (!rowId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing rowId parameter' } } };
          }
          await deleteDataTableRow(rowId);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Row '${rowId}' deleted.` }] } } };
        }

        if (toolName === 'libreflow_delete_data_table') {
          const tId = toolArguments.tableId;
          if (!tId) {
            return { status: 400, payload: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tableId parameter' } } };
          }
          await deleteDataTable(tId);
          return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Data table '${tId}' deleted.` }] } } };
        }

        return { status: 404, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `System tool not found: ${toolName}` } } };
      }

      // Workflow tools — only those within the current scope, matched by unique name.
      const workflows = await resolveScopedWorkflows(scope);
      const nameMap = assignUniqueToolNames(workflows);
      const matchedWorkflow = workflows.find(w => nameMap.get(w.id) === toolName);

      if (!matchedWorkflow) {
        return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found or workflow not active: ${toolName}` } } };
      }

      const { executeWorkflowAndRecord } = await import('./executor.js');
      const report = await executeWorkflowAndRecord(matchedWorkflow, toolArguments);

      let responseText = '';
      if (report.success) {
        const succeededNodeOutputs: Record<string, any> = {};
        for (const [nodeId, nodeRes] of Object.entries(report.nodeResults)) {
          if (nodeRes.status === 'success') {
            succeededNodeOutputs[nodeRes.nodeName] = nodeRes.output;
          }
        }
        responseText = JSON.stringify({
          success: true,
          message: `Workflow executed successfully`,
          outputs: succeededNodeOutputs
        }, null, 2);
      } else {
        const failedNode = Object.values(report.nodeResults).find(r => r.status === 'failed');
        responseText = JSON.stringify({
          success: false,
          message: `Workflow execution failed at node: ${failedNode?.nodeName || 'unknown'}`,
          error: failedNode?.error || 'Unknown error'
        }, null, 2);
      }

      return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: responseText }] } } };
    }

    return { status: 404, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
  } catch (err: any) {
    return { status: 500, payload: { jsonrpc: '2.0', id: id || null, error: { code: -32603, message: err.message } } };
  }
}

// --- STREAMABLE HTTP TRANSPORT (current MCP spec, via the official SDK) ---
// Interoperable with standard MCP clients (Claude Desktop, mcp-inspector). The SDK
// owns the protocol/transport; we only register the tool handlers, which delegate to
// the existing scope-aware dispatchMcpRpc so there is a single source of truth.

function buildSdkServer(scope: McpScope): McpSdkServer {
  const server = new McpSdkServer(
    { name: 'LibreFlow MCP Server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { payload } = await dispatchMcpRpc({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, scope);
    if (payload.error) throw new McpError(payload.error.code, payload.error.message);
    return payload.result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const { payload } = await dispatchMcpRpc(
      { jsonrpc: '2.0', id: 0, method: 'tools/call', params: req.params },
      scope
    );
    if (payload.error) throw new McpError(payload.error.code, payload.error.message);
    return payload.result;
  });

  return server;
}

/** Serves one Streamable HTTP request in stateless mode (fresh server+transport per call). */
export async function handleStreamableHttp(req: any, res: Response, scope: McpScope) {
  const server = buildSdkServer(scope);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, (req as any).body);
}

/** Stateless transport accepts POST only; GET/DELETE (session streams) are rejected. */
function methodNotAllowed(_req: any, res: Response) {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST (Streamable HTTP).' },
    id: null,
  });
}

// Global server (POST /api/mcp): all active workflows + system tools.
router.post('/', (req, res) => handleStreamableHttp(req, res, { workflowIds: null, exposeSystemTools: true }));
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

// JSON-RPC Message Endpoint (LEGACY SSE transport, kept for backward compatibility)
router.post('/message', async (req, res) => {
  const connectionId = req.query.connectionId as string;

  if (!connectionId || !activeConnections.has(connectionId)) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: { code: -32000, message: 'Invalid or closed connectionId' }
    });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request: Missing Body' }
    });
  }

  if (req.body.jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: req.body.id || null, error: { code: -32600, message: 'Invalid Request' } });
  }

  const { status, payload } = await dispatchMcpRpc(req.body, { workflowIds: null, exposeSystemTools: true });
  return res.status(status).json(payload);
});

// --- NAMED MCP SERVERS (public, per-server URL: /mcp/:serverId/...) ---

export const publicMcpRouter = Router();
const publicConnections = new Map<string, Response>();

/** Validates the per-server bearer token (`Authorization: Bearer` or `x-api-key`). */
function checkMcpServerToken(req: any, token: string | null | undefined): boolean {
  if (!token) return false;
  const headerKey = req.header('x-api-key');
  const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  const provided = headerKey || bearer;
  if (!provided) return false;
  try {
    return constantTimeEqual(provided, token);
  } catch {
    return false;
  }
}

// SSE handshake for a named server. Auth (when required) is checked here too, so
// the connection cannot even be opened without a valid token.
publicMcpRouter.get('/:serverId/sse', async (req, res) => {
  const server = await getMcpServerById(req.params.serverId);
  if (!server) {
    return res.status(404).json({ error: 'MCP server not found' });
  }
  if (server.require_auth && !checkMcpServerToken(req, server.token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const connectionId = `mconn-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  publicConnections.set(connectionId, res);

  const messageUrl = `/mcp/${server.id}/message?connectionId=${connectionId}`;
  res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);

  req.on('close', () => {
    publicConnections.delete(connectionId);
  });
});

publicMcpRouter.post('/:serverId/message', async (req, res) => {
  const server = await getMcpServerById(req.params.serverId);
  if (!server) {
    return res.status(404).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32000, message: 'MCP server not found' } });
  }
  if (server.require_auth && !checkMcpServerToken(req, server.token)) {
    return res.status(401).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32001, message: 'Unauthorized' } });
  }

  const connectionId = req.query.connectionId as string;
  if (!connectionId || !publicConnections.has(connectionId)) {
    return res.status(400).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32000, message: 'Invalid or closed connectionId' } });
  }

  if (!req.body || typeof req.body !== 'object' || req.body.jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: req.body?.id || null, error: { code: -32600, message: 'Invalid Request' } });
  }

  const { status, payload } = await dispatchMcpRpc(req.body, {
    workflowIds: server.workflow_ids,
    exposeSystemTools: server.expose_system_tools,
  });
  return res.status(status).json(payload);
});

// Streamable HTTP endpoint for a named server (POST /mcp/:serverId) — the recommended,
// standards-compliant URL. Auth (when required) is enforced before the SDK takes over.
async function handleNamedStreamable(req: any, res: Response) {
  const server = await getMcpServerById(req.params.serverId);
  if (!server) {
    return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server not found' } });
  }
  if (server.require_auth && !checkMcpServerToken(req, server.token)) {
    return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
  }
  return handleStreamableHttp(req, res, {
    workflowIds: server.workflow_ids,
    exposeSystemTools: server.expose_system_tools,
  });
}

publicMcpRouter.post('/:serverId', handleNamedStreamable);
publicMcpRouter.get('/:serverId', methodNotAllowed);
publicMcpRouter.delete('/:serverId', methodNotAllowed);

// --- MCP CLIENT ENDPOINTS & UTILITIES ---

// Route to proxy listing tools from an external MCP server to the frontend
router.get('/client/tools', async (req, res) => {
  const serverUrl = req.query.serverUrl as string;
  if (!serverUrl) {
    return res.status(400).json({ error: 'serverUrl query parameter is required' });
  }

  try {
    const tools = await fetchToolsFromMcpServer(serverUrl);
    return res.json(tools);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Connects to an external MCP server using the official SDK. Tries the current
 * Streamable HTTP transport first and falls back to the legacy SSE transport, so the
 * `mcpToolCall` node can consume any standard MCP server. SSRF-guarded before connecting.
 */
async function connectMcpClient(serverUrl: string, headers?: Record<string, string>): Promise<McpSdkClient> {
  await assertSafeUrl(serverUrl); // SSRF guard
  const url = new URL(serverUrl);

  // Inject auth headers (when provided) into EVERY request via a custom fetch — this
  // also covers the SSE GET stream, which doesn't go through requestInit.
  const hasHeaders = !!headers && Object.keys(headers).length > 0;
  const opts: any = {};
  if (hasHeaders) {
    opts.requestInit = { headers };
    opts.fetch = (input: any, init: any = {}) => {
      const h = new Headers(init.headers || {});
      for (const [k, v] of Object.entries(headers!)) h.set(k, v);
      return fetch(input, { ...init, headers: h });
    };
  }

  try {
    const client = new McpSdkClient({ name: 'LibreFlow-Client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(url, opts));
    return client;
  } catch {
    // Older servers only speak the deprecated HTTP+SSE transport — retry with a fresh client.
    const client = new McpSdkClient({ name: 'LibreFlow-Client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new SSEClientTransport(url, opts));
    return client;
  }
}

export async function fetchToolsFromMcpServer(serverUrl: string, headers?: Record<string, string>): Promise<any[]> {
  const client = await connectMcpClient(serverUrl, headers);
  try {
    const res = await client.listTools();
    return res.tools || [];
  } finally {
    await client.close().catch(() => {});
  }
}

export async function executeMcpToolCall(serverUrl: string, toolName: string, toolArguments: Record<string, any>, headers?: Record<string, string>): Promise<any> {
  const client = await connectMcpClient(serverUrl, headers);
  try {
    return await client.callTool({ name: toolName, arguments: toolArguments });
  } finally {
    await client.close().catch(() => {});
  }
}

export function sanitizeMcpName(name: string): string {
  const sanitized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^a-zA-Z0-9_-]/g, "_") // Replace spaces/special chars with underscores
    .replace(/_+/g, "_")             // Deduplicate underscores
    .replace(/^_+|_+$/g, "");        // Trim leading/trailing underscores
  return sanitized || "unnamed_tool";
}

export default router;
