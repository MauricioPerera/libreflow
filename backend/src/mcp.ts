import { Router, Response } from 'express';
import { 
  getActiveWorkflows, 
  getWorkflows, 
  getWorkflowById, 
  saveWorkflow, 
  getAllExecutions,
  getExecutionById,
  saveExecution,
  getDataTables,
  saveDataTable,
  getDataTableRows,
  addDataTableRow,
  addDataTableRows,
  getWorkflowsByIds,
  getMcpServerById,
  deleteWorkflow,
  setWorkflowActiveState,
  updateDataTableRow,
  deleteDataTableRow,
  deleteDataTable,
  upsertDataTableRow,
  incrementDataTableRow,
  getOrCreateDataTableRow,
  queryDataTableRows,
  countDataTableRows,
  getDataTableById,
  batchDataTableRows,
  assertOwnership
} from './db.js';

// Default cap on rows/items returned to an agent — protects its context window.
const AGENT_ROW_LIMIT = 20;

/** Trims a data-table row to what an agent needs: drops the redundant table_id and
 *  the created_at/updated_at timestamps (kept in the DB; rarely needed by the agent). */
function slimRow(row: any) {
  return { id: row.id, data: row.data };
}

/**
 * Builds a data tool result with BOTH a compact text representation (works with any
 * client) and `structuredContent` (spec 2025) so agents parse data reliably without
 * extracting JSON from prose. structuredContent must be an object, so non-objects wrap.
 */
function dataResult(id: any, data: any) {
  const structuredContent = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data
    : { result: data };
  return {
    status: 200,
    payload: {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent },
    },
  };
}
import { NodeRegistry } from './registry.js';
import { assertSafeUrl, safeFetch } from './security.js';
import { validateWorkflow as validateWorkflowCore } from './flowValidate.js';
import { constantTimeEqual } from './auth.js';
import { triggerManager } from './triggerManager.js';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
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
  // Delega en el validador unificado (flowValidate) y mapea a la forma de la tool MCP
  // ({valid, issues:[{severity}]}). Un ÚNICO conjunto de checks para la UI y el agente.
  const r = validateWorkflowCore({ nodes, connections });
  return {
    valid: r.ok,
    issues: r.issues.map(i => ({ severity: i.level, nodeId: i.nodeId, nodeName: i.nodeName, message: i.message })),
  };
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
        workflowId: { type: 'string', description: 'The unique ID of the workflow to retrieve.' },
        id: { type: 'string', description: '[alias legacy de workflowId]' }
      },
      required: []
    }
  },
  {
    name: 'libreflow_save_workflow',
    description: 'Guarda o actualiza un workflow. Valida ANTES de guardar: si hay errores estructurales, ' +
      'NO guarda y devuelve { saved:false, issues }. Si es válido, guarda y devuelve { saved:true, issues } (con warnings si los hay).',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The unique ID of the workflow.' },
        id: { type: 'string', description: '[alias legacy de workflowId]' },
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
        onErrorWorkflowId: { type: 'string', description: 'Optional workflow ID to trigger on failure.' },
        description: { type: 'string', description: 'Optional human/agent-facing description; becomes the MCP tool description when this workflow is exposed.' }
      },
      required: ['name', 'nodes', 'connections']
    }
  },
  {
    name: 'libreflow_run_workflow',
    description: 'Ejecuta un workflow. Por defecto BLOQUEA y devuelve el reporte. Para flujos largos, ' +
      'pasa "wait": false → lanza la ejecución en segundo plano y devuelve { executionId, status:"pending" }; ' +
      'consulta el resultado con libreflow_get_execution.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The ID of the workflow to run.' },
        id: { type: 'string', description: '[alias legacy de workflowId]' },
        payload: {
          type: 'object',
          description: 'Optional initial payload/variables to inject into the trigger.',
          additionalProperties: true
        },
        wait: { type: 'boolean', description: 'Default true (bloquea hasta terminar). false → async: devuelve executionId + pending y haces polling con get_execution.' },
        concise: { type: 'boolean', description: 'Default true: return only success + succeeded-node outputs. Set false for the full node-by-node report.' }
      },
      required: []
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
        executionId: { type: 'string', description: 'The unique execution ID.' },
        id: { type: 'string', description: '[alias legacy de executionId]' }
      },
      required: []
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
    description: 'Create a new data table with the specified name and columns. Optionally set a unique key column to enable upsert/increment/idempotency.',
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
        },
        keyColumn: { type: 'string', description: 'Optional. Name of the column used as the unique key (enables upsert/increment/get-or-default).' }
      },
      required: ['name', 'columns']
    }
  },
  {
    name: 'libreflow_query_data',
    description: 'Lectura unificada de una tabla (reemplaza get_row/get_rows/query_rows/search_rows). ' +
      'Con "key" → get-or-default de UNA fila. Con "filters" → query por operadores (eq/ne/gt/lt/gte/lte/contains/in) + sort. ' +
      'Sin filtros → listado paginado (limit/offset) con total. Devuelve { mode, rows|row, ... }.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'ID de la tabla.' },
        key: { type: 'string', description: 'Si se indica, devuelve (o crea por defecto) la fila de esa clave (modo get).' },
        defaults: { type: 'object', description: 'Valores por defecto si la fila por "key" no existe.', additionalProperties: true },
        filters: {
          type: 'array',
          description: 'Filtros por operador: [{ "column": "status", "op": "eq", "value": "active" }]. Para "in", value es un array.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              op: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'] },
              value: {}
            },
            required: ['column']
          }
        },
        sort: { type: 'object', description: 'Orden: { "column": "score", "dir": "desc" }.', properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
        limit: { type: 'number', description: 'Máx filas (default 20, máx 1000).' },
        offset: { type: 'number', description: 'Filas a saltar (solo en listado sin filtros).' }
      },
      required: ['tableId']
    }
  },
  {
    name: 'libreflow_batch_rows',
    description: 'Aplica VARIAS escrituras (append/update/delete/upsert/increment) en UNA transacción atómica (todo-o-nada). ' +
      'Reemplaza N llamadas por una sola: ideal para insertar/actualizar muchos registros generados. Si una op falla, se revierte todo.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'ID de la tabla.' },
        ops: {
          type: 'array',
          description: 'Lista de operaciones. Cada una: { "op": "append|update|delete|upsert|increment", rowId?, key?, data?, field?, amount? }.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['append', 'update', 'delete', 'upsert', 'increment'] },
              rowId: { type: 'string', description: 'Para update/delete por id de fila.' },
              key: { type: 'string', description: 'Para upsert/increment/delete por clave.' },
              data: { type: 'object', description: 'Datos de la fila (append/update/upsert).', additionalProperties: true },
              field: { type: 'string', description: 'Campo numérico (increment).' },
              amount: { type: 'number', description: 'Cantidad a sumar (increment, default 1).' }
            },
            required: ['op']
          }
        }
      },
      required: ['tableId', 'ops']
    }
  },
  {
    name: 'libreflow_upsert_data_table_row',
    description: 'Insert or update a row by the table key column (atomic, idempotent). Requires the table to have a key column.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        data: { type: 'object', description: 'The full row data; must include the key column.', additionalProperties: true }
      },
      required: ['tableId', 'data']
    }
  },
  {
    name: 'libreflow_increment_data_table_row',
    description: 'Atomically increment a numeric field of the row identified by key, creating it if absent (concurrency-safe counter).',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        key: { type: 'string', description: 'The key value identifying the row.' },
        field: { type: 'string', description: 'The numeric field to increment.' },
        amount: { type: 'number', description: 'Amount to add (default 1).' }
      },
      required: ['tableId', 'key', 'field']
    }
  },
  {
    name: 'libreflow_get_data_table_row',
    description: '[DEPRECATED → usa libreflow_query_data con "key"] Get the row identified by key, creating it from defaults if absent (get-or-default state read).',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        key: { type: 'string', description: 'The key value identifying the row.' },
        defaults: { type: 'object', description: 'Optional default field values used when the row is created.', additionalProperties: true }
      },
      required: ['tableId', 'key']
    }
  },
  {
    name: 'libreflow_query_data_table_rows',
    description: '[DEPRECATED → usa libreflow_query_data con "filters"] Query rows with field operators, sorting and limit. Operators: eq, ne, gt, lt, gte, lte, contains, in.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        filters: {
          type: 'array',
          description: 'Filter list: [{ "column": "status", "op": "eq", "value": "active" }]. For "in", value is an array.',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              op: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'in'] },
              value: {}
            },
            required: ['column']
          }
        },
        sort: {
          type: 'object',
          description: 'Optional sort: { "column": "score", "dir": "desc" }.',
          properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } }
        },
        limit: { type: 'number', description: 'Max rows to return (default 20, max 1000).' }
      },
      required: ['tableId']
    }
  },
  {
    name: 'libreflow_get_data_table_rows',
    description: '[DEPRECATED → usa libreflow_query_data sin filtros] Fetch rows from a data table (paginated; rows trimmed to { id, data }). Returns { total, returned, offset, truncated, rows }.',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: 'The unique ID of the table.' },
        limit: { type: 'number', description: 'Max rows to return (default 20, max 1000).' },
        offset: { type: 'number', description: 'Rows to skip for pagination (default 0).' }
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
        workflowId: { type: 'string', description: 'The unique ID of the workflow to delete.' },
        id: { type: 'string', description: '[alias legacy de workflowId]' }
      },
      required: []
    }
  },
  {
    name: 'libreflow_set_workflow_active',
    description: 'Activate or deactivate a workflow. Active workflows are exposed as MCP tools and run their cron/webhook triggers.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The unique ID of the workflow.' },
        id: { type: 'string', description: '[alias legacy de workflowId]' },
        active: { type: 'boolean', description: 'true to activate, false to deactivate.' }
      },
      required: ['active']
    }
  },
  {
    name: 'libreflow_search_data_table_rows',
    description: '[DEPRECATED → usa libreflow_query_data con "filters" (op eq)] Search rows in a data table by exact-match field filters.',
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
/**
 * MCP tool annotations (spec 2025): let agent clients reason about a tool before calling
 * it — gate or auto-approve read-only tools, ask confirmation before destructive ones.
 */
const TOOL_ANNOTATIONS: Record<string, any> = {
  libreflow_list_node_types: { readOnlyHint: true },
  libreflow_list_workflows: { readOnlyHint: true },
  libreflow_get_workflow: { readOnlyHint: true },
  libreflow_list_executions: { readOnlyHint: true },
  libreflow_get_execution: { readOnlyHint: true },
  libreflow_validate_workflow: { readOnlyHint: true },
  libreflow_list_data_tables: { readOnlyHint: true },
  libreflow_query_data: { readOnlyHint: true },
  libreflow_get_data_table_row: { readOnlyHint: true },
  libreflow_get_data_table_rows: { readOnlyHint: true },
  libreflow_search_data_table_rows: { readOnlyHint: true },
  libreflow_query_data_table_rows: { readOnlyHint: true },
  libreflow_save_workflow: { idempotentHint: true },
  libreflow_set_workflow_active: { idempotentHint: true },
  libreflow_upsert_data_table_row: { idempotentHint: true },
  libreflow_update_data_table_row: { idempotentHint: true },
  libreflow_delete_workflow: { destructiveHint: true },
  libreflow_delete_data_table: { destructiveHint: true },
  libreflow_delete_data_table_row: { destructiveHint: true },
};

// Lecturas granulares reemplazadas por libreflow_query_data. Se mantienen por retrocompatibilidad;
// se pueden ocultar de tools/list con LF_MCP_HIDE_DEPRECATED=true.
const DEPRECATED_TOOLS = new Set([
  'libreflow_get_data_table_row',
  'libreflow_get_data_table_rows',
  'libreflow_query_data_table_rows',
  'libreflow_search_data_table_rows',
]);

export interface McpScope {
  workflowIds: string[] | null;
  exposeSystemTools: boolean;
  // Expone las data-tables como RESOURCES MCP de solo lectura. Solo en el server global
  // (tras auth); los named servers son exposiciones curadas de tools (v1: sin resources).
  exposeResources?: boolean;
  // F2-MCP/F3: acota los flujos expuestos al dueño del scope (server global → usuario
  // autenticado; named server / toolset del aiAgent → dueño del server/flujo; admin = todos).
  // `ownerId === undefined` ⇒ sin scoping (single-tenant / back-compat).
  ownerId?: string | null;
  isAdmin?: boolean;
}

async function resolveScopedWorkflows(scope: McpScope): Promise<any[]> {
  const list = scope.workflowIds === null
    ? await getActiveWorkflows()
    : await getWorkflowsByIds(scope.workflowIds);
  // Filtra por dueño en AMBAS rutas (global y named) cuando el scope lo trae.
  if (scope.ownerId === undefined) return list;
  return list.filter((w: any) => assertOwnership(w.owner_id ?? null, scope.ownerId ?? null, scope.isAdmin ?? false));
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

// --- Helpers de respuesta JSON-RPC (forma única; el status varía por caso) ---
function rpcText(id: any, text: string): RpcResult {
  return { status: 200, payload: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } } };
}
function rpcErr(id: any, code: number, message: string, status = 200): RpcResult {
  return { status, payload: { jsonrpc: '2.0', id, error: { code, message } } };
}
function rpcOk(id: any, result: any): RpcResult {
  return { status: 200, payload: { jsonrpc: '2.0', id, result } };
}
function missingParam(id: any, message: string): RpcResult {
  return rpcErr(id, -32602, message, 400);
}

function handleInitialize(id: any, scope: McpScope): RpcResult {
  const capabilities: any = { tools: {} };
  if (scope.exposeResources) capabilities.resources = {};
  return rpcOk(id, {
    protocolVersion: '2024-11-05',
    capabilities,
    serverInfo: { name: 'LibreFlow MCP Server', version: '1.0.0' },
  });
}

// RESOURCES (solo lectura): data-tables y definiciones de flujo como contexto adjuntable por el
// host MCP. Distinto de las tools (acción). Solo si el scope lo permite, y acotado por dueño.
async function handleResourcesList(id: any, scope: McpScope): Promise<RpcResult> {
  if (!scope.exposeResources) return rpcOk(id, { resources: [] });
  const allTables = await getDataTables();
  const tables = scope.ownerId === undefined
    ? allTables
    : (allTables || []).filter((t: any) => assertOwnership(t.owner_id ?? null, scope.ownerId ?? null, scope.isAdmin ?? false));
  const tableResources = (tables || []).map((t: any) => ({
    uri: `libreflow://datatable/${t.id}`,
    name: t.name,
    description: t.description || `Filas de la tabla de datos "${t.name}"`,
    mimeType: 'application/json',
  }));
  const workflows = await resolveScopedWorkflows(scope);
  const workflowResources = (workflows || []).map((w: any) => ({
    uri: `libreflow://workflow/${w.id}`,
    name: `Flujo: ${w.name}`,
    description: w.description || `Definición del flujo "${w.name}" (nodos y conexiones)`,
    mimeType: 'application/json',
  }));
  return rpcOk(id, { resources: [...tableResources, ...workflowResources] });
}

async function readDataTableResource(id: any, uri: string, tableId: string, scope: McpScope): Promise<RpcResult> {
  if (scope.ownerId !== undefined) {
    const t = await getDataTableById(tableId);
    if (!t || !assertOwnership((t as any).owner_id ?? null, scope.ownerId ?? null, scope.isAdmin ?? false)) {
      return rpcErr(id, -32602, `Unknown resource uri: ${uri}`);
    }
  }
  const rows = await queryDataTableRows(tableId, [], { limit: AGENT_ROW_LIMIT });
  const out = {
    table: tableId,
    returned: rows.length,
    limit: AGENT_ROW_LIMIT,
    truncated: rows.length >= AGENT_ROW_LIMIT,
    rows: rows.map(slimRow),
  };
  return rpcOk(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(out) }] });
}

async function readWorkflowResource(id: any, uri: string, workflowId: string, scope: McpScope): Promise<RpcResult> {
  const workflow = await getWorkflowById(workflowId);
  if (!workflow || (scope.ownerId !== undefined && !assertOwnership((workflow as any).owner_id ?? null, scope.ownerId ?? null, scope.isAdmin ?? false))) {
    return rpcErr(id, -32602, `Unknown resource uri: ${uri}`);
  }
  const def = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? null,
    active: workflow.active ?? false,
    nodes: workflow.nodes,
    connections: workflow.connections,
  };
  return rpcOk(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(def) }] });
}

async function handleResourcesRead(id: any, params: any, scope: McpScope): Promise<RpcResult> {
  if (!scope.exposeResources) {
    return rpcErr(id, -32601, 'Resources not enabled on this server', 404);
  }
  const uri = String(params?.uri || '');
  const tableMatch = uri.match(/^libreflow:\/\/datatable\/(.+)$/);
  if (tableMatch) return readDataTableResource(id, uri, tableMatch[1], scope);
  const workflowMatch = uri.match(/^libreflow:\/\/workflow\/(.+)$/);
  if (workflowMatch) return readWorkflowResource(id, uri, workflowMatch[1], scope);
  return rpcErr(id, -32602, `Unknown resource uri: ${uri}`);
}

/** inputSchema declarado por el trigger del flujo (JSON o ya objeto); default vacío. */
function workflowInputSchema(workflow: any): any {
  const triggerNode = (workflow.nodes || []).find((n: any) => n.type === 'trigger');
  const raw = triggerNode?.parameters?.inputSchema;
  if (!raw) return { type: 'object', properties: {} };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // schema inválido → default vacío
  }
  return { type: 'object', properties: {} };
}

async function handleToolsList(id: any, scope: McpScope): Promise<RpcResult> {
  const workflows = await resolveScopedWorkflows(scope);
  const nameMap = assignUniqueToolNames(workflows);
  const workflowTools = workflows.map(workflow => ({
    name: nameMap.get(workflow.id),
    description: workflow.description || `Ejecuta el flujo LibreFlow: ${workflow.name}`,
    inputSchema: workflowInputSchema(workflow),
  }));
  // Tools deprecadas (reemplazadas por libreflow_query_data). Siguen FUNCIONANDO (back-compat);
  // con LF_MCP_HIDE_DEPRECATED=true se ocultan de tools/list para una superficie más limpia.
  const hideDeprecated = process.env.LF_MCP_HIDE_DEPRECATED === 'true';
  const systemTools = SYSTEM_TOOLS
    .filter(t => !(hideDeprecated && DEPRECATED_TOOLS.has(t.name)))
    .map(t => TOOL_ANNOTATIONS[t.name] ? { ...t, annotations: TOOL_ANNOTATIONS[t.name] } : t);
  const tools = scope.exposeSystemTools ? [...systemTools, ...workflowTools] : workflowTools;
  return rpcOk(id, { tools });
}

/** Reporte conciso de una ejecución para los agentes: solo salidas de nodos exitosos (+ error). */
function conciseRunReport(report: any): any {
  const outputs: Record<string, any> = {};
  for (const r of Object.values(report.nodeResults) as any[]) {
    if (r.status === 'success') outputs[r.nodeName] = r.output;
  }
  const concise: any = { success: report.success, durationMs: report.durationMs, outputs };
  if (!report.success) {
    const failed = (Object.values(report.nodeResults) as any[]).find(r => r.status === 'failed');
    concise.error = failed ? { node: failed.nodeName, message: failed.error } : 'unknown error';
  }
  return concise;
}

// --- Dispatch table de las system tools (libreflow_*). Cada handler es pequeño y puro de control. ---
type ToolHandler = (id: any, args: any) => Promise<RpcResult> | RpcResult;

// Resolución de identificadores con retrocompatibilidad: el nombre estándar tiene prioridad,
// pero se acepta el alias legacy `id` (workflows) / lo que toque.
const wfId = (args: any) => args.workflowId ?? args.id;
const execId = (args: any) => args.executionId ?? args.id;

const SYSTEM_TOOL_HANDLERS: Record<string, ToolHandler> = {
  libreflow_list_node_types: (id) => {
    const list = NodeRegistry.getAllNodeTypes().map(nodeDef => {
      const { execute, ...meta } = nodeDef;
      return meta;
    });
    return dataResult(id, list);
  },

  libreflow_list_workflows: async (id) => {
    const list = await getWorkflows();
    return dataResult(id, list.map(w => ({ id: w.id, name: w.name, active: w.active })));
  },

  libreflow_get_workflow: async (id, args) => {
    const target = wfId(args);
    if (!target) return missingParam(id, 'Missing workflowId parameter');
    const workflow = await getWorkflowById(target);
    if (!workflow) return rpcText(id, `Workflow not found with ID: ${target}`);
    return dataResult(id, workflow);
  },

  libreflow_save_workflow: async (id, args) => {
    const { name: wName, nodes = [], connections = [], onErrorWorkflowId, description: wDesc } = args;
    const wId = wfId(args);
    if (!wId || !wName) return missingParam(id, 'Missing workflowId or name parameter');
    // Valida ANTES de guardar: si hay errores estructurales, aborta y devuelve los issues.
    const validation = validateWorkflow(nodes, connections);
    if (!validation.valid) {
      return dataResult(id, { saved: false, valid: false, issues: validation.issues });
    }
    await saveWorkflow(wId, wName, nodes, connections, onErrorWorkflowId, wDesc);
    return dataResult(id, { saved: true, valid: true, workflowId: wId, name: wName, issues: validation.issues });
  },

  libreflow_run_workflow: async (id, args) => {
    const wId = wfId(args);
    if (!wId) return missingParam(id, 'Missing workflowId parameter');
    const workflow = await getWorkflowById(wId);
    if (!workflow) return rpcText(id, `Workflow not found with ID: ${wId}`);
    const { executeWorkflowAndRecord } = await import('./executor.js');
    // Async (wait:false): pre-persiste 'running' (para que un get_execution inmediato lo vea),
    // lanza la ejecución detached y devuelve el executionId. El agente hace polling.
    if (args.wait === false) {
      const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      await saveExecution(executionId, wId, 'running', { running: true, startTime: new Date().toISOString() });
      executeWorkflowAndRecord(workflow, args.payload || {}, { executionId })
        .catch(err => console.error('[MCP] async run_workflow failed:', err));
      return dataResult(id, { executionId, status: 'pending', workflowId: wId });
    }
    const report = await executeWorkflowAndRecord(workflow, args.payload || {});
    // Conciso por defecto; el reporte nodo-a-nodo completo con concise:false o get_execution.
    return dataResult(id, args.concise === false ? report : conciseRunReport(report));
  },

  libreflow_list_executions: async (id) => {
    const list = await getAllExecutions();
    return dataResult(id, { returned: list.length, truncated: list.length >= 100, executions: list });
  },

  libreflow_get_execution: async (id, args) => {
    const target = execId(args);
    if (!target) return missingParam(id, 'Missing executionId parameter');
    const execution = await getExecutionById(target);
    if (!execution) return rpcText(id, `Execution not found with ID: ${target}`);
    return dataResult(id, execution);
  },

  libreflow_validate_workflow: (id, args) => {
    const { nodes = [], connections = [] } = args;
    return dataResult(id, validateWorkflow(nodes, connections));
  },

  libreflow_list_data_tables: async (id) => {
    return dataResult(id, await getDataTables());
  },

  libreflow_create_data_table: async (id, args) => {
    const { name: tName, columns = [], keyColumn } = args;
    if (!tName) return missingParam(id, 'Missing name parameter');
    const tId = `table-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    await saveDataTable(tId, tName, columns, keyColumn || null);
    return rpcText(id, `Data table '${tName}' created successfully with ID: ${tId}`);
  },

  // Lectura unificada: key→get | filters→query | (nada)→listado paginado.
  libreflow_query_data: async (id, args) => {
    const tId = args.tableId;
    if (!tId) return missingParam(id, 'Missing tableId parameter');
    if (args.key !== undefined && args.key !== null && args.key !== '') {
      const defaults = args.defaults && typeof args.defaults === 'object' ? args.defaults : {};
      const row = await getOrCreateDataTableRow(tId, String(args.key), defaults);
      return dataResult(id, { mode: 'get', row: slimRow(row) });
    }
    const filters = Array.isArray(args.filters) ? args.filters : [];
    const effLimit = Math.min(1000, Math.max(1, Number(args.limit) || AGENT_ROW_LIMIT));
    if (filters.length) {
      const rows = await queryDataTableRows(tId, filters, { sort: args.sort, limit: effLimit });
      return dataResult(id, { mode: 'query', returned: rows.length, limit: effLimit, truncated: rows.length >= effLimit, rows: rows.map(slimRow) });
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const total = await countDataTableRows(tId);
    const rows = await getDataTableRows(tId, effLimit, offset);
    return dataResult(id, { mode: 'list', total, returned: rows.length, offset, truncated: offset + rows.length < total, rows: rows.map(slimRow) });
  },

  // Escrituras en lote (una transacción atómica): append/update/delete/upsert/increment.
  libreflow_batch_rows: async (id, args) => {
    const tId = args.tableId;
    const ops = args.ops;
    if (!tId || !Array.isArray(ops) || ops.length === 0) return missingParam(id, 'Missing tableId or non-empty ops[]');
    return dataResult(id, await batchDataTableRows(tId, ops));
  },

  libreflow_upsert_data_table_row: async (id, args) => {
    const { tableId: tId, data } = args;
    if (!tId || !data || typeof data !== 'object') return missingParam(id, 'Missing tableId or data parameter');
    return dataResult(id, await upsertDataTableRow(tId, data));
  },

  libreflow_increment_data_table_row: async (id, args) => {
    const { tableId: tId, key, field, amount = 1 } = args;
    if (!tId || !key || !field) return missingParam(id, 'Missing tableId, key or field parameter');
    return dataResult(id, await incrementDataTableRow(tId, String(key), field, Number(amount) || 1));
  },

  libreflow_get_data_table_row: async (id, args) => {
    const { tableId: tId, key, defaults = {} } = args;
    if (!tId || !key) return missingParam(id, 'Missing tableId or key parameter');
    return dataResult(id, await getOrCreateDataTableRow(tId, String(key), defaults && typeof defaults === 'object' ? defaults : {}));
  },

  libreflow_query_data_table_rows: async (id, args) => {
    const { tableId: tId, filters = [], sort, limit } = args;
    if (!tId) return missingParam(id, 'Missing tableId parameter');
    const effLimit = Math.min(1000, Math.max(1, Number(limit) || AGENT_ROW_LIMIT));
    const rows = await queryDataTableRows(tId, Array.isArray(filters) ? filters : [], { sort, limit: effLimit });
    return dataResult(id, { returned: rows.length, limit: effLimit, truncated: rows.length >= effLimit, rows: rows.map(slimRow) });
  },

  libreflow_get_data_table_rows: async (id, args) => {
    const tId = args.tableId;
    if (!tId) return missingParam(id, 'Missing tableId parameter');
    const limit = Math.min(1000, Math.max(1, Number(args.limit) || AGENT_ROW_LIMIT));
    const offset = Math.max(0, Number(args.offset) || 0);
    const total = await countDataTableRows(tId);
    const rows = await getDataTableRows(tId, limit, offset);
    return dataResult(id, { total, returned: rows.length, offset, truncated: offset + rows.length < total, rows: rows.map(slimRow) });
  },

  libreflow_add_data_table_rows: async (id, args) => {
    const tId = args.tableId;
    const rows = args.rows || [];
    if (!tId || !Array.isArray(rows)) return missingParam(id, 'Missing tableId or invalid rows parameter');
    const addedIds = await addDataTableRows(tId, rows);
    return rpcText(id, `Successfully added ${addedIds.length} rows. IDs: ${addedIds.join(', ')}`);
  },

  libreflow_delete_workflow: async (id, args) => {
    const target = wfId(args);
    if (!target) return missingParam(id, 'Missing workflowId parameter');
    await deleteWorkflow(target);
    return rpcText(id, `Workflow '${target}' deleted.`);
  },

  libreflow_set_workflow_active: async (id, args) => {
    const wId = wfId(args);
    const active = !!args.active;
    if (!wId) return missingParam(id, 'Missing workflowId parameter');
    const workflow = await getWorkflowById(wId);
    if (!workflow) return rpcText(id, `Workflow not found with ID: ${wId}`);
    await setWorkflowActiveState(wId, active);
    // Igual que el endpoint HTTP: (des)registra los triggers cron/webhook en memoria.
    if (active) {
      const fresh = await getWorkflowById(wId);
      if (fresh) await triggerManager.startTriggers(fresh);
    } else {
      triggerManager.stopTriggers(wId);
    }
    return rpcText(id, `Workflow '${workflow.name}' ${active ? 'activated' : 'deactivated'}.`);
  },

  libreflow_search_data_table_rows: async (id, args) => {
    const tId = args.tableId;
    if (!tId) return missingParam(id, 'Missing tableId parameter');
    const filters = (args.filters && typeof args.filters === 'object') ? args.filters : {};
    const allRows = await getDataTableRows(tId);
    const filtered = allRows.filter((row: any) => {
      for (const [k, v] of Object.entries(filters)) {
        if (String(row.data?.[k]) !== String(v)) return false;
      }
      return true;
    });
    return dataResult(id, filtered.map(slimRow));
  },

  libreflow_update_data_table_row: async (id, args) => {
    const { rowId, data } = args;
    if (!rowId || !data || typeof data !== 'object') return missingParam(id, 'Missing rowId or data parameter');
    await updateDataTableRow(rowId, data);
    return rpcText(id, `Row '${rowId}' updated.`);
  },

  libreflow_delete_data_table_row: async (id, args) => {
    if (!args.rowId) return missingParam(id, 'Missing rowId parameter');
    await deleteDataTableRow(args.rowId);
    return rpcText(id, `Row '${args.rowId}' deleted.`);
  },

  libreflow_delete_data_table: async (id, args) => {
    if (!args.tableId) return missingParam(id, 'Missing tableId parameter');
    await deleteDataTable(args.tableId);
    return rpcText(id, `Data table '${args.tableId}' deleted.`);
  },
};

/** Ejecuta una tool de FLUJO (acotada al scope, casada por nombre único). */
async function runWorkflowTool(id: any, toolName: any, args: any, scope: McpScope): Promise<RpcResult> {
  const workflows = await resolveScopedWorkflows(scope);
  const nameMap = assignUniqueToolNames(workflows);
  const matchedWorkflow = workflows.find(w => nameMap.get(w.id) === toolName);
  if (!matchedWorkflow) {
    return rpcErr(id, -32601, `Tool not found or workflow not active: ${toolName}`);
  }
  const { executeWorkflowAndRecord } = await import('./executor.js');
  const report = await executeWorkflowAndRecord(matchedWorkflow, args);

  let responseText = '';
  if (report.success) {
    const succeededNodeOutputs: Record<string, any> = {};
    for (const nodeRes of Object.values(report.nodeResults)) {
      if (nodeRes.status === 'success') succeededNodeOutputs[nodeRes.nodeName] = nodeRes.output;
    }
    responseText = JSON.stringify({ success: true, message: `Workflow executed successfully`, outputs: succeededNodeOutputs });
  } else {
    const failedNode = Object.values(report.nodeResults).find(r => r.status === 'failed');
    responseText = JSON.stringify({
      success: false,
      message: `Workflow execution failed at node: ${failedNode?.nodeName || 'unknown'}`,
      error: failedNode?.error || 'Unknown error',
    });
  }
  return rpcText(id, responseText);
}

async function handleToolsCall(id: any, params: any, scope: McpScope): Promise<RpcResult> {
  const toolName = params?.name;
  const toolArguments = params?.arguments || {};

  if (typeof toolName === 'string' && toolName.startsWith('libreflow_')) {
    // Las system tools solo son alcanzables si el scope las habilita.
    if (!scope.exposeSystemTools) {
      return rpcErr(id, -32601, `System tool not available on this server: ${toolName}`, 404);
    }
    const handler = SYSTEM_TOOL_HANDLERS[toolName];
    if (!handler) return rpcErr(id, -32601, `System tool not found: ${toolName}`, 404);
    return handler(id, toolArguments);
  }

  return runWorkflowTool(id, toolName, toolArguments, scope);
}

/**
 * Núcleo JSON-RPC del MCP (única fuente). Enruta el método al handler correspondiente y
 * normaliza errores. Devuelve { status HTTP, payload JSON-RPC } para que el llamante (global
 * `/api/mcp` o los públicos `/mcp/:id`) controle el transporte (auth, conexión SSE) y escriba.
 */
export async function dispatchMcpRpc(body: any, scope: McpScope): Promise<RpcResult> {
  const { id, method, params } = body;
  try {
    if (method === 'initialize') return handleInitialize(id, scope);
    if (method === 'resources/list') return await handleResourcesList(id, scope);
    if (method === 'resources/read') return await handleResourcesRead(id, params, scope);
    if (method === 'tools/list') return await handleToolsList(id, scope);
    if (method === 'tools/call') return await handleToolsCall(id, params, scope);
    return rpcErr(id, -32601, `Method not found: ${method}`, 404);
  } catch (err: any) {
    return { status: 500, payload: { jsonrpc: '2.0', id: id || null, error: { code: -32603, message: err.message } } };
  }
}

// --- STREAMABLE HTTP TRANSPORT (current MCP spec, via the official SDK) ---
// Interoperable with standard MCP clients (Claude Desktop, mcp-inspector). The SDK
// owns the protocol/transport; we only register the tool handlers, which delegate to
// the existing scope-aware dispatchMcpRpc so there is a single source of truth.

function buildSdkServer(scope: McpScope): McpSdkServer {
  const capabilities: any = { tools: {} };
  if (scope.exposeResources) capabilities.resources = {};
  const server = new McpSdkServer(
    { name: 'LibreFlow MCP Server', version: '1.0.0' },
    { capabilities }
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

  // Resources (solo si el scope los expone): delegan en dispatchMcpRpc (única fuente).
  if (scope.exposeResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const { payload } = await dispatchMcpRpc({ jsonrpc: '2.0', id: 0, method: 'resources/list' }, scope);
      if (payload.error) throw new McpError(payload.error.code, payload.error.message);
      return payload.result;
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (req: any) => {
      const { payload } = await dispatchMcpRpc({ jsonrpc: '2.0', id: 0, method: 'resources/read', params: req.params }, scope);
      if (payload.error) throw new McpError(payload.error.code, payload.error.message);
      return payload.result;
    });
  }

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
router.post('/', (req, res) => handleStreamableHttp(req, res, { workflowIds: null, exposeSystemTools: true, exposeResources: true, ownerId: (req as any).user?.id, isAdmin: (req as any).user?.role === 'admin' }));
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

  const { status, payload } = await dispatchMcpRpc(req.body, { workflowIds: null, exposeSystemTools: true, exposeResources: true, ownerId: (req as any).user?.id, isAdmin: (req as any).user?.role === 'admin' });
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
    // F3: un named server solo expone flujos de SU dueño (sin dueño → sin scoping, back-compat).
    ownerId: server.owner_id ?? undefined,
    isAdmin: false,
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
    // F3: un named server solo expone flujos de SU dueño (sin dueño → sin scoping, back-compat).
    ownerId: server.owner_id ?? undefined,
    isAdmin: false,
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

  // Route EVERY request the SDK makes through `safeFetch` (re-validates SSRF on each redirect
  // hop, not just the initial URL) and inject auth headers when provided. The custom fetch is
  // set ALWAYS — even without headers — so the redirect re-validation always applies. This
  // also covers the SSE GET stream, which doesn't go through requestInit.
  const hasHeaders = !!headers && Object.keys(headers).length > 0;
  const opts: any = {};
  if (hasHeaders) opts.requestInit = { headers };
  opts.fetch = (input: any, init: any = {}) => {
    const u = typeof input === 'string' ? input : (input?.url ?? String(input));
    const h = new Headers(init.headers || {});
    if (hasHeaders) for (const [k, v] of Object.entries(headers!)) h.set(k, v);
    return safeFetch(u, { ...init, headers: h });
  };

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

/**
 * Opens a single connected MCP client session and returns list/call/close handles.
 * Use this when making MULTIPLE calls to the same server (e.g. an agent loop) to avoid
 * reconnecting (connect + initialize handshake) on every tool call.
 */
export async function openMcpClientSession(serverUrl: string, headers?: Record<string, string>) {
  const client = await connectMcpClient(serverUrl, headers);
  return {
    listTools: async () => (await client.listTools()).tools || [],
    callTool: async (name: string, args: Record<string, any>) => client.callTool({ name, arguments: args }),
    // Recursos MCP (p.ej. skills firmadas servidas por un bridge tipo postal-skills).
    // Tolerante: un servidor que no implemente recursos devuelve method-not-found → [].
    listResources: async () => {
      try { return ((await (client as any).listResources())?.resources) || []; } catch { return []; }
    },
    readResource: async (uri: string) => {
      try { return await (client as any).readResource({ uri }); } catch { return null; }
    },
    // Prompts MCP (plantillas parametrizables servidas por un servidor gobernado).
    // Tolerante: un servidor sin prompts devuelve method-not-found → [] / null.
    listPrompts: async () => {
      try { return ((await (client as any).listPrompts())?.prompts) || []; } catch { return []; }
    },
    getPrompt: async (name: string, args?: Record<string, any>) => {
      try { return await (client as any).getPrompt({ name, arguments: args || {} }); } catch { return null; }
    },
    close: () => client.close().catch(() => {}),
  };
}

/**
 * Formatea una lista de skills (instrucciones de confianza leídas de recursos MCP) en un
 * bloque de system message para inyectar en el contexto del agente. Ignora las vacías.
 */
export function buildSkillsBlock(skills: { name?: string; text: string }[]): string {
  const parts = (skills || [])
    .filter(s => s && s.text && s.text.trim())
    .map(s => `## ${s.name || 'skill'}\n${s.text.trim()}`);
  if (parts.length === 0) return '';
  return `Tienes acceso a las siguientes skills (instrucciones de confianza). Síguelas cuando apliquen:\n\n${parts.join('\n\n')}`;
}

interface McpResourceSession {
  listResources: () => Promise<any[]>;
  readResource: (uri: string) => Promise<any>;
}

/** Lee todos los recursos-skill de una sesión MCP y devuelve el bloque de contexto formateado. */
export async function loadSkillsFromSession(session: McpResourceSession): Promise<string> {
  const resources = await session.listResources();
  const skills: { name?: string; text: string }[] = [];
  for (const r of resources || []) {
    const read: any = await session.readResource(r.uri);
    const text = (read?.contents || []).map((c: any) => c.text).filter(Boolean).join('\n');
    if (text) skills.push({ name: r.name || r.uri, text });
  }
  return buildSkillsBlock(skills);
}

interface McpPromptSession {
  getPrompt: (name: string, args?: Record<string, any>) => Promise<any>;
}

/** Mensaje de chat en formato OpenAI (rol + texto). */
export interface ChatMessage { role: string; content: string }

/**
 * Trae un prompt MCP parametrizable de una sesión y lo convierte en mensajes de chat
 * (formato OpenAI: rol + texto). Los roles MCP `user`/`assistant` se mapean tal cual; el
 * texto se extrae del content `text`. Filtra mensajes vacíos. Si el servidor no tiene el
 * prompt (o no implementa prompts), devuelve []. Es la semilla de la conversación del agente.
 */
export async function loadPromptMessages(
  session: McpPromptSession,
  name: string,
  args?: Record<string, any>
): Promise<ChatMessage[]> {
  if (!name) return [];
  const result: any = await session.getPrompt(name, args);
  const messages: ChatMessage[] = [];
  for (const m of (result?.messages || [])) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user';
    const c = m?.content;
    const text = typeof c?.text === 'string'
      ? c.text
      : Array.isArray(c) ? c.map((x: any) => x?.text).filter(Boolean).join('\n') : '';
    if (text && text.trim()) messages.push({ role, content: text.trim() });
  }
  return messages;
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
