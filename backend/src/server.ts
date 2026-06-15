import express from 'express';
import cors from 'cors';
import { WorkflowEngine } from './engine.js';
import { executeWorkflowAndRecord } from './executor.js';
import { 
  initDatabase, 
  getWorkflows, 
  getWorkflowById, 
  saveWorkflow, 
  deleteWorkflow, 
  saveExecution, 
  getExecutions, 
  getExecutionById,
  getAllExecutions,
  setWorkflowActiveState,
  getCredentials,
  getCredentialById,
  saveCredential,
  deleteCredential,
  getWorkflowVersions,
  getWorkflowVersion,
  restoreWorkflowToVersion,
  getDataTables,
  getDataTableById,
  saveDataTable,
  deleteDataTable,
  getDataTableRows,
  addDataTableRow,
  updateDataTableRow,
  deleteDataTableRow,
  getMcpServers,
  getMcpServerById,
  saveMcpServer,
  deleteMcpServer
} from './db.js';
import { triggerManager } from './triggerManager.js';
import { NodeRegistry } from './registry.js';
import mcpRouter, { publicMcpRouter } from './mcp.js';
import { requireAuth, verifyWebhookSignature } from './auth.js';
import { rateLimit } from './security.js';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT || 3000;

// CORS: restrict to an explicit allowlist in production; permissive in dev.
const corsOrigins = process.env.LF_CORS_ORIGINS;
app.use(
  cors(
    corsOrigins
      ? { origin: corsOrigins.split(',').map(o => o.trim()), credentials: true }
      : {}
  )
);

// Capture the raw body so webhook HMAC signatures can be verified, and cap size.
app.use(
  express.json({
    limit: process.env.LF_BODY_LIMIT || '1mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Global rate limiting (tunable via LF_RATE_WINDOW_MS / LF_RATE_MAX).
app.use(
  rateLimit({
    windowMs: process.env.LF_RATE_WINDOW_MS ? Number(process.env.LF_RATE_WINDOW_MS) : undefined,
    max: process.env.LF_RATE_MAX ? Number(process.env.LF_RATE_MAX) : undefined,
  })
);

// All /api routes (including MCP) require authentication. Webhooks use HMAC instead.
app.use('/api', requireAuth);
app.use('/api/mcp', mcpRouter);

// Named MCP servers are reachable at their own public URL (/mcp/:id/...), outside
// the /api auth layer — each enforces its own per-server bearer token instead.
app.use('/mcp', publicMcpRouter);

const engine = new WorkflowEngine();

/** Logs the real error server-side and returns a generic message to the client. */
function serverError(res: express.Response, err: any) {
  console.error('[Server] Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
  'x-libreflow-signature',
]);

/** Removes sensitive headers before injecting request headers into a workflow payload. */
function sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// API NODE TYPES SCHEMA SDK
app.get('/api/node-types', (req, res) => {
  try {
    const list = NodeRegistry.getAllNodeTypes().map(nodeDef => {
      const { execute, ...meta } = nodeDef;
      return meta;
    });
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

// API WORKFLOW RUNNER
app.post('/api/workflows/run', async (req, res) => {
  try {
    const { workflow, payload } = req.body;
    if (!workflow || !Array.isArray(workflow.nodes)) {
      return res.status(400).json({ error: 'Invalid workflow. Must contain a list of nodes.' });
    }
    if (workflow.connections != null && !Array.isArray(workflow.connections)) {
      return res.status(400).json({ error: 'Invalid workflow. connections must be an array.' });
    }

    const report = await executeWorkflowAndRecord(workflow, payload);
    return res.json(report);
  } catch (err: any) {
    // Workflow-structure errors are user-facing; everything else is masked.
    if (err?.name === 'WorkflowValidationError') {
      return res.status(400).json({ error: err.message });
    }
    return serverError(res, err);
  }
});

// CRUD ENDPOINTS
app.get('/api/workflows', async (req, res) => {
  try {
    const list = await getWorkflows();
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/workflows/:id', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    return res.json(workflow);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/workflows', async (req, res) => {
  try {
    const { id, name, nodes, connections, onErrorWorkflowId } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: 'Workflow id and name are required' });
    }
    if (nodes != null && !Array.isArray(nodes)) {
      return res.status(400).json({ error: 'nodes must be an array' });
    }
    if (connections != null && !Array.isArray(connections)) {
      return res.status(400).json({ error: 'connections must be an array' });
    }

    // Check if the workflow was already active
    const existingWorkflow = await getWorkflowById(id);
    const wasActive = existingWorkflow ? !!existingWorkflow.active : false;

    await saveWorkflow(id, name, nodes || [], connections || [], onErrorWorkflowId);

    if (wasActive) {
      const updatedWorkflow = await getWorkflowById(id);
      if (updatedWorkflow) {
        await triggerManager.startTriggers(updatedWorkflow);
        console.log(`[Server] Reloaded active background triggers for workflow: ${name} (${id})`);
      }
    }

    return res.json({ success: true, message: 'Workflow saved successfully' });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.delete('/api/workflows/:id', async (req, res) => {
  try {
    await deleteWorkflow(req.params.id);
    return res.json({ success: true, message: 'Workflow deleted successfully' });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// EXECUTION LOGS ENDPOINTS
app.get('/api/workflows/:id/executions', async (req, res) => {
  try {
    const list = await getExecutions(req.params.id);
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/executions', async (req, res) => {
  try {
    const list = await getAllExecutions();
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/executions/:id', async (req, res) => {
  try {
    const execution = await getExecutionById(req.params.id);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    return res.json(execution);
  } catch (err: any) {
    return serverError(res, err);
  }
});

// ACTIVE STATE TOGGLE ENDPOINT
app.post('/api/workflows/:id/active', async (req, res) => {
  try {
    const { id } = req.params;
    const active = !!req.body.active; // coerce to boolean

    // Check if workflow exists
    const workflow = await getWorkflowById(id);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    // Update db
    await setWorkflowActiveState(id, active);

    // Start or stop triggers in memory
    if (active) {
      const updatedWorkflow = await getWorkflowById(id);
      if (updatedWorkflow) {
        await triggerManager.startTriggers(updatedWorkflow);
      }
      console.log(`[Server] Activated triggers for workflow: ${workflow.name} (${id})`);
    } else {
      triggerManager.stopTriggers(id);
      console.log(`[Server] Deactivated triggers for workflow: ${workflow.name} (${id})`);
    }
    
    return res.json({ success: true, active });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// VERSIONING ENDPOINTS
app.get('/api/workflows/:id/versions', async (req, res) => {
  try {
    const list = await getWorkflowVersions(req.params.id);
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/workflows/:id/versions/:version', async (req, res) => {
  try {
    const ver = await getWorkflowVersion(req.params.id, parseInt(req.params.version, 10));
    if (!ver) {
      return res.status(404).json({ error: 'Version not found' });
    }
    return res.json(ver);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/workflows/:id/versions/:version/restore', async (req, res) => {
  try {
    const { id, version } = req.params;
    
    // Check if the workflow is active first
    const workflow = await getWorkflowById(id);
    if (workflow && workflow.active) {
      // It's active. Let's stop triggers in memory before restoring, then we will restart them if it succeeds.
      triggerManager.stopTriggers(id);
    }

    const restoredVer = await restoreWorkflowToVersion(id, parseInt(version, 10));

    // Reload triggers if workflow was active
    if (workflow && workflow.active) {
      const updatedWorkflow = await getWorkflowById(id);
      if (updatedWorkflow) {
        await triggerManager.startTriggers(updatedWorkflow);
        console.log(`[Server] Reloaded active background triggers for restored workflow: ${updatedWorkflow.name} (${id})`);
      }
    }

    return res.json({ success: true, message: `Workflow restored to version ${version}`, version: restoredVer });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// CREDENTIALS ENDPOINTS
app.get('/api/credentials', async (req, res) => {
  try {
    const list = await getCredentials();
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/credentials/:id', async (req, res) => {
  try {
    const credential = await getCredentialById(req.params.id);
    if (!credential) {
      return res.status(404).json({ error: 'Credential not found' });
    }
    // Never expose decrypted secret material over the API — metadata only.
    const { data, ...meta } = credential;
    return res.json(meta);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/credentials', async (req, res) => {
  try {
    const { id, name, type, data } = req.body;
    if (!id || !name || !type || !data) {
      return res.status(400).json({ error: 'id, name, type, and data are required' });
    }
    await saveCredential(id, name, type, data);
    return res.json({ success: true, message: 'Credential saved successfully' });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.delete('/api/credentials/:id', async (req, res) => {
  try {
    await deleteCredential(req.params.id);
    return res.json({ success: true, message: 'Credential deleted successfully' });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// DATA TABLES API ENDPOINTS
app.get('/api/data-tables', async (req, res) => {
  try {
    const list = await getDataTables();
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/data-tables/:id', async (req, res) => {
  try {
    const table = await getDataTableById(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Data Table not found' });
    }
    return res.json(table);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/data-tables', async (req, res) => {
  try {
    const { id, name, columns, keyColumn } = req.body;
    if (!id || !name || !Array.isArray(columns)) {
      return res.status(400).json({ error: 'id, name, and columns (array) are required' });
    }
    await saveDataTable(id, name, columns, keyColumn || null);
    return res.json({ success: true, message: 'Data Table saved successfully' });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.delete('/api/data-tables/:id', async (req, res) => {
  try {
    await deleteDataTable(req.params.id);
    return res.json({ success: true, message: 'Data Table deleted successfully' });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/data-tables/:id/rows', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;
    const list = await getDataTableRows(req.params.id, limit, offset);
    return res.json(list);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/data-tables/:id/rows', async (req, res) => {
  try {
    const { id: rowId, data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data (object) is required' });
    }
    const generatedRowId = rowId || `row-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    await addDataTableRow(req.params.id, generatedRowId, data);
    return res.json({ success: true, id: generatedRowId });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.put('/api/data-tables/:id/rows/:rowId', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'data (object) is required' });
    }
    await updateDataTableRow(req.params.rowId, data);
    return res.json({ success: true });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.delete('/api/data-tables/:id/rows/:rowId', async (req, res) => {
  try {
    await deleteDataTableRow(req.params.rowId);
    return res.json({ success: true });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// MCP SERVERS CRUD — named servers exposing a curated group of workflows as MCP tools.
function generateMcpToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

app.get('/api/mcp-servers', async (req, res) => {
  try {
    return res.json(await getMcpServers());
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.get('/api/mcp-servers/:id', async (req, res) => {
  try {
    const server = await getMcpServerById(req.params.id);
    if (!server) return res.status(404).json({ error: 'MCP server not found' });
    return res.json(server);
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/mcp-servers', async (req, res) => {
  try {
    const { id, name, workflowIds = [], requireAuth: ra = true, exposeSystemTools = false, regenerateToken = false } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!Array.isArray(workflowIds)) {
      return res.status(400).json({ error: 'workflowIds must be an array' });
    }

    const existing = id ? await getMcpServerById(id) : null;
    const serverId = existing ? existing.id : `mcps-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    // A token is always generated and kept so auth can be toggled on later without losing it.
    let token: string | null = existing ? existing.token : generateMcpToken();
    if (regenerateToken || !token) token = generateMcpToken();

    await saveMcpServer(serverId, name, workflowIds, token, !!ra, !!exposeSystemTools);
    return res.json(await getMcpServerById(serverId));
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.delete('/api/mcp-servers/:id', async (req, res) => {
  try {
    await deleteMcpServer(req.params.id);
    return res.json({ success: true });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// WEBHOOK TRIGGER ENDPOINT (Supports all HTTP methods)
app.all('/hooks/:workflowId', async (req, res) => {
  const { workflowId } = req.params;

  // Verify HMAC signature over the raw body (no-op in dev when no secret is set).
  if (!verifyWebhookSignature((req as any).rawBody, req.header('x-libreflow-signature'))) {
    return res.status(401).json({ error: 'Invalid or missing webhook signature' });
  }

  const payload = {
    headers: sanitizeHeaders(req.headers as Record<string, any>),
    query: req.query,
    body: req.body,
    method: req.method,
    timestamp: new Date().toISOString(),
    source: 'webhook'
  };

  try {
    const workflow = await getWorkflowById(workflowId);
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }

    if (!workflow.active) {
      return res.status(400).json({ error: 'Workflow is not active. Activate it first.' });
    }

    // Verify if it has a webhook trigger node
    const hasWebhookTrigger = (workflow.nodes || []).some(
      (n: any) => n.type === 'trigger' && n.parameters?.triggerMode === 'webhook'
    );

    if (!hasWebhookTrigger) {
      return res.status(400).json({ error: 'Workflow does not support Webhook triggers. Set triggerMode to "webhook".' });
    }

    // Return success immediately to release client, then run in background
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    res.json({
      success: true, 
      message: 'Webhook received. Workflow executing in background.', 
      executionId 
    });

    console.log(`[Webhook Trigger] Starting execution ${executionId} for workflow "${workflow.name}" (${workflowId})`);
    
    // Execute and save execution logs in background
    try {
      await executeWorkflowAndRecord(workflow, payload, { executionId });
      console.log(`[Webhook Trigger] Completed execution ${executionId} for workflow "${workflow.name}"`);
    } catch (execErr: any) {
      console.error(`[Webhook Trigger] Execution error for ${workflowId}:`, execErr);
    }

  } catch (err: any) {
    console.error(`[Webhook Trigger Router Error] Failed to dispatch workflow ${workflowId}:`, err);
    if (!res.headersSent) {
      return serverError(res, err);
    }
  }
});

// Initialize database then start server
let server: any;

initDatabase().then(async () => {
  // Init trigger manager to load active background crons
  await triggerManager.init();

  server = app.listen(port, () => {
    console.log(`[LibreFlow Backend] Server running on port ${port}`);
  });
}).catch(err => {
  console.error('[LibreFlow Database] Failed to initialize SQLite database:', err);
});

// Clean shutdown handlers
function shutdown(signal: string) {
  console.log(`[LibreFlow Backend] Received ${signal}. Shutting down cleanly...`);
  
  try {
    triggerManager.stopAll();
  } catch (err) {
    console.error('[LibreFlow Backend] Error stopping triggers during shutdown:', err);
  }

  if (server) {
    server.close(() => {
      console.log('[LibreFlow Backend] HTTP server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  // Fallback to force exit if server.close hangs
  setTimeout(() => {
    console.warn('[LibreFlow Backend] Forced shutdown after timeout.');
    process.exit(1);
  }, 1000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

