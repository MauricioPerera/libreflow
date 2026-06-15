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
  addDataTableRow
} from './db.js';
import { NodeRegistry } from './registry.js';
import { assertSafeUrl } from './security.js';

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
  }
];

// JSON-RPC Message Endpoint
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

  const { jsonrpc, id, method, params } = req.body;

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid Request' } });
  }

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'LibreFlow MCP Server',
            version: '1.0.0'
          }
        }
      });
    }

    if (method === 'tools/list') {
      const activeWorkflows = await getActiveWorkflows();
      const workflowTools = activeWorkflows.map(workflow => {
        let inputSchema = {
          type: 'object',
          properties: {}
        };

        const triggerNode = workflow.nodes.find((n: any) => n.type === 'trigger');
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
          name: sanitizeMcpName(workflow.name),
          description: `Ejecuta el flujo LibreFlow: ${workflow.name}`,
          inputSchema
        };
      });

      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [...SYSTEM_TOOLS, ...workflowTools]
        }
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArguments = params?.arguments || {};

      if (typeof toolName === 'string' && toolName.startsWith('libreflow_')) {
        // System Tools
        if (toolName === 'libreflow_list_node_types') {
          const list = NodeRegistry.getAllNodeTypes().map(nodeDef => {
            const { execute, ...meta } = nodeDef;
            return meta;
          });
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_list_workflows') {
          const list = await getWorkflows();
          const cleanList = list.map(w => ({ id: w.id, name: w.name, active: w.active }));
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(cleanList, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_get_workflow') {
          const wId = toolArguments.id;
          if (!wId) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id parameter' } });
          }
          const workflow = await getWorkflowById(wId);
          if (!workflow) {
            return res.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Workflow not found with ID: ${wId}` }]
              }
            });
          }
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(workflow, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_save_workflow') {
          const { id: wId, name: wName, nodes = [], connections = [], onErrorWorkflowId } = toolArguments;
          if (!wId || !wName) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id or name parameter' } });
          }
          await saveWorkflow(wId, wName, nodes, connections, onErrorWorkflowId);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Workflow '${wName}' saved successfully.` }]
            }
          });
        }

        if (toolName === 'libreflow_run_workflow') {
          const wId = toolArguments.workflowId;
          const payload = toolArguments.payload || {};
          if (!wId) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing workflowId parameter' } });
          }
          const workflow = await getWorkflowById(wId);
          if (!workflow) {
            return res.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Workflow not found with ID: ${wId}` }]
              }
            });
          }
          const { executeWorkflowAndRecord } = await import('./executor.js');
          const report = await executeWorkflowAndRecord(workflow, payload);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_list_executions') {
          const list = await getAllExecutions();
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_get_execution') {
          const execId = toolArguments.id;
          if (!execId) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing id parameter' } });
          }
          const execution = await getExecutionById(execId);
          if (!execution) {
            return res.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Execution not found with ID: ${execId}` }]
              }
            });
          }
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(execution, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_validate_workflow') {
          const { nodes = [], connections = [] } = toolArguments;
          const result = validateWorkflow(nodes, connections);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_list_data_tables') {
          const list = await getDataTables();
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(list, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_create_data_table') {
          const { name: tName, columns = [] } = toolArguments;
          if (!tName) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing name parameter' } });
          }
          const tId = `table-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          await saveDataTable(tId, tName, columns);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Data table '${tName}' created successfully with ID: ${tId}` }]
            }
          });
        }

        if (toolName === 'libreflow_get_data_table_rows') {
          const tId = toolArguments.tableId;
          if (!tId) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tableId parameter' } });
          }
          const rows = await getDataTableRows(tId);
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }]
            }
          });
        }

        if (toolName === 'libreflow_add_data_table_rows') {
          const tId = toolArguments.tableId;
          const rows = toolArguments.rows || [];
          if (!tId || !Array.isArray(rows)) {
            return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tableId or invalid rows parameter' } });
          }
          const addedIds: string[] = [];
          for (const rowData of rows) {
            const rowId = `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
            await addDataTableRow(tId, rowId, rowData);
            addedIds.push(rowId);
          }
          return res.json({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Successfully added ${rows.length} rows. IDs: ${addedIds.join(', ')}` }]
            }
          });
        }

        return res.status(404).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `System tool not found: ${toolName}` }
        });
      }

      const activeWorkflows = await getActiveWorkflows();
      const matchedWorkflow = activeWorkflows.find(w => sanitizeMcpName(w.name) === toolName);

      if (!matchedWorkflow) {
        return res.json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Tool not found or workflow not active: ${toolName}`
          }
        });
      }

      // Execute workflow
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

      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: responseText
            }
          ]
        }
      });
    }

    // Unhandled method
    return res.status(404).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    });

  } catch (err: any) {
    return res.status(500).json({
      jsonrpc: '2.0',
      id: id || null,
      error: {
        code: -32603,
        message: err.message
      }
    });
  }
});

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

export async function fetchToolsFromMcpServer(serverUrl: string): Promise<any[]> {
  await assertSafeUrl(serverUrl); // SSRF guard
  const response = await fetch(serverUrl);
  if (!response.ok) {
    throw new Error(`Failed to connect to MCP server: ${response.statusText}`);
  }
  
  const body = response.body;
  if (!body) {
    throw new Error('No response body from MCP server');
  }

  let endpointUrl = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = buffer.match(/event:\s*endpoint\r?\ndata:\s*([^\r\n]+)/);
    if (match) {
      endpointUrl = match[1].trim();
      break;
    }
  }

  if (!endpointUrl) {
    throw new Error('Could not find endpoint event from MCP server');
  }

  const resolvedUrl = new URL(endpointUrl, serverUrl).toString();

  // Send initialize request
  const initId = 1;
  const initRes = await fetch(resolvedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'LibreFlow-Client', version: '1.0.0' }
      }
    })
  });

  if (!initRes.ok) {
    throw new Error(`Failed to initialize MCP session: ${initRes.statusText}`);
  }

  // Send tools/list request
  const listId = 2;
  const listRes = await fetch(resolvedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: listId,
      method: 'tools/list',
      params: {}
    })
  });

  if (!listRes.ok) {
    throw new Error(`Failed to list tools: ${listRes.statusText}`);
  }

  const listData = await listRes.json();
  if (listData.error) {
    throw new Error(`MCP Server Error: ${listData.error.message}`);
  }

  return listData.result?.tools || [];
}

export async function executeMcpToolCall(serverUrl: string, toolName: string, toolArguments: Record<string, any>): Promise<any> {
  await assertSafeUrl(serverUrl); // SSRF guard
  const response = await fetch(serverUrl);
  if (!response.ok) {
    throw new Error(`Failed to connect to MCP server: ${response.statusText}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error('No response body from MCP server');
  }

  let endpointUrl = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    const match = buffer.match(/event:\s*endpoint\r?\ndata:\s*([^\r\n]+)/);
    if (match) {
      endpointUrl = match[1].trim();
      break;
    }
  }

  if (!endpointUrl) {
    throw new Error('Could not find endpoint event from MCP server');
  }

  const resolvedUrl = new URL(endpointUrl, serverUrl).toString();

  // Send initialize request
  const initId = 1;
  const initRes = await fetch(resolvedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'LibreFlow-Client', version: '1.0.0' }
      }
    })
  });

  if (!initRes.ok) {
    throw new Error(`Failed to initialize MCP session: ${initRes.statusText}`);
  }

  // Send tools/call request
  const callId = 2;
  const callRes = await fetch(resolvedUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArguments
      }
    })
  });

  if (!callRes.ok) {
    throw new Error(`Failed to call tool: ${callRes.statusText}`);
  }

  const callData = await callRes.json();
  if (callData.error) {
    throw new Error(`MCP Tool Error: ${callData.error.message}`);
  }

  return callData.result;
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
