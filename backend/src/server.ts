import express from 'express';
import path from 'node:path';
import cors from 'cors';
import compression from 'compression';
import { WorkflowEngine, buildRerunResume } from './engine.js';
import { executeWorkflowAndRecord, resumeWorkflowAndRecord } from './executor.js';
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
  deleteMcpServer,
  getBinary,
  getAllWorkflowsWithGraph,
  getUserByEmail
} from './db.js';
import { verifyPassword } from './password.js';
import { signToken } from './jwt.js';
import { triggerManager } from './triggerManager.js';
import { NodeRegistry } from './registry.js';
import mcpRouter, { publicMcpRouter } from './mcp.js';
import { requireAuth, verifyWebhookSignature } from './auth.js';
import { rateLimit } from './security.js';
import { buildAuthorizationUrl, handleOAuthCallback } from './oauth2.js';
import { parseFormFields, renderFormPage, renderCompletionPage, validateFormValues } from './forms.js';
import { validateWorkflow, validateWorkflows } from './flowValidate.js';
import { buildExecutionLlmContext } from './errorContext.js';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT || 3000;

// Gzip/deflate responses — meaningful for large JSON payloads (execution reports,
// tools/list, data-table rows). SSE (text/event-stream) is excluded: compression buffers
// and would stall the MCP SSE handshake / streamed responses.
app.use(
  compression({
    filter: (req, res) => {
      const type = res.getHeader('Content-Type');
      if (typeof type === 'string' && type.includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  })
);

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

// Login: emite un JWT de sesión. Debe ir ANTES del guard requireAuth (es público).
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email y password son obligatorios' });
    const user = await getUserByEmail(String(email));
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    const token = signToken({ sub: user.id, email: user.email, role: user.role });
    return res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// All /api routes (including MCP) require authentication. Webhooks use HMAC instead.
app.use('/api', requireAuth);

// Usuario actual (a partir del JWT/API key resuelto por requireAuth). Requiere auth.
app.get('/api/auth/me', (req, res) => {
  return res.json({ user: (req as any).user || null });
});
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
    const { workflow, payload, rerunFrom, priorResults } = req.body;
    if (!workflow || !Array.isArray(workflow.nodes)) {
      return res.status(400).json({ error: 'Invalid workflow. Must contain a list of nodes.' });
    }
    if (workflow.connections != null && !Array.isArray(workflow.connections)) {
      return res.status(400).json({ error: 'Invalid workflow. connections must be an array.' });
    }

    // "Re-ejecutar desde un nodo": reusa las salidas cacheadas (priorResults) salvo el nodo
    // indicado y sus descendientes, que se vuelven a ejecutar.
    let resume;
    if (typeof rerunFrom === 'string' && rerunFrom && priorResults && typeof priorResults === 'object') {
      resume = buildRerunResume(workflow, rerunFrom, priorResults);
    }

    // Manual test run from the editor: honor pinned node data (`pinData`).
    const report = await executeWorkflowAndRecord(workflow, payload, { usePinData: true, resume });
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

// Exporta un flujo como JSON portable (sin id/estado/timestamps): para compartir o versionar
// entre instancias. No incluye secretos — las credenciales se referencian por id.
app.get('/api/workflows/:id/export', async (req, res) => {
  try {
    const wf = await getWorkflowById(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    return res.json({
      libreflowWorkflow: 1,
      name: wf.name,
      description: wf.description ?? null,
      nodes: wf.nodes || [],
      connections: wf.connections || [],
    });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// Importa un flujo desde un JSON portable: crea un flujo NUEVO (id nuevo) y devuelve la
// validación de coherencia. Acepta el objeto exportado directamente o { workflow }.
app.post('/api/workflows/import', async (req, res) => {
  try {
    const body = req.body || {};
    const wf = body.libreflowWorkflow ? body : body.workflow;
    if (!wf || !Array.isArray(wf.nodes)) {
      return res.status(400).json({ error: 'JSON de flujo inválido: falta el array nodes.' });
    }
    if (wf.connections != null && !Array.isArray(wf.connections)) {
      return res.status(400).json({ error: 'connections debe ser un array.' });
    }
    const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = typeof wf.name === 'string' && wf.name.trim() ? wf.name : 'Flujo importado';
    await saveWorkflow(id, name, wf.nodes, wf.connections || [], undefined, wf.description ?? null);
    const validation = validateWorkflow({ nodes: wf.nodes, connections: wf.connections || [] });
    return res.json({ id, name, validation });
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/api/workflows', async (req, res) => {
  try {
    const { id, name, nodes, connections, onErrorWorkflowId, description } = req.body;
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

    await saveWorkflow(id, name, nodes || [], connections || [], onErrorWorkflowId, description);

    if (wasActive) {
      const updatedWorkflow = await getWorkflowById(id);
      if (updatedWorkflow) {
        await triggerManager.startTriggers(updatedWorkflow);
        console.log(`[Server] Reloaded active background triggers for workflow: ${name} (${id})`);
      }
    }

    // Validación de coherencia (no bloqueante): se guarda igual, pero el cliente recibe los
    // avisos (expresiones colgando, handles inválidos, etc.) para mostrarlos.
    const validation = validateWorkflow({ nodes: nodes || [], connections: connections || [] });
    return res.json({ success: true, message: 'Workflow saved successfully', validation });
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

// Valida la coherencia estructural de un flujo sin guardarlo (tipos, conexiones, handles,
// expresiones colgando). Útil tras un fix en lote antes de dar el flujo por bueno.
app.post('/api/workflows/validate', async (req, res) => {
  try {
    const { nodes, connections } = req.body || {};
    return res.json(validateWorkflow({ nodes: nodes || [], connections: connections || [] }));
  } catch (err: any) {
    return serverError(res, err);
  }
});

// Valida en lote los flujos guardados. Sin filtros valida todos; `ids` valida ese conjunto;
// `contains` selecciona los flujos cuyo grafo menciona esa cadena (p.ej. el host de una API),
// para el patrón "arregla en una sesión todos los flujos vinculados a la misma API".
app.post('/api/workflows/validate-batch', async (req, res) => {
  try {
    const { ids, contains } = req.body || {};
    const all = await getAllWorkflowsWithGraph();
    let selected = all;
    if (Array.isArray(ids) && ids.length) {
      const set = new Set(ids.map(String));
      selected = selected.filter(w => set.has(w.id));
    }
    if (typeof contains === 'string' && contains.trim()) {
      const needle = contains.trim();
      selected = selected.filter(w => JSON.stringify(w.nodes).includes(needle));
    }
    return res.json(validateWorkflows(selected));
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

// Contexto pre-armado para el LLM a partir de una ejecución (típicamente fallida): qué nodo
// falló, con qué error, dónde verlo + una instrucción lista para pegar a un agente.
app.get('/api/executions/:id/llm-context', async (req, res) => {
  try {
    const execution = await getExecutionById(req.params.id);
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    let workflowName: string | undefined;
    let nodeTypeById: Record<string, string> | undefined;
    if (execution.workflow_id) {
      const wf = await getWorkflowById(execution.workflow_id);
      if (wf) {
        workflowName = wf.name;
        nodeTypeById = {};
        for (const n of wf.nodes || []) nodeTypeById[n.id] = n.type;
      }
    }
    return res.json(buildExecutionLlmContext(execution, { workflowName, nodeTypeById }));
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
    // For oauth2 we surface a derived `connected` flag (has a usable token?) without
    // leaking the token itself, so the UI can show connection status.
    const { data, ...meta } = credential;
    if (credential.type === 'oauth2') {
      (meta as any).connected = !!(data && data.accessToken);
    }
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
    // OAuth2: al editar una credencial ya conectada, el formulario no reenvía los tokens
    // (la GET no los expone). Conserva accessToken/refreshToken/expiresAt para no desconectarla.
    if (type === 'oauth2') {
      const existing = await getCredentialById(id);
      if (existing?.data) {
        for (const f of ['accessToken', 'refreshToken', 'expiresAt']) {
          if (existing.data[f] !== undefined && data[f] === undefined) data[f] = existing.data[f];
        }
      }
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

// Descarga de un binario del store por su id (referenciado desde la salida de un nodo).
app.get('/api/binaries/:id', async (req, res) => {
  try {
    const bin = await getBinary(req.params.id);
    if (!bin) return res.status(404).json({ error: 'Binary not found' });
    if (bin.mime_type) res.set('Content-Type', bin.mime_type);
    res.set('Content-Length', String(bin.size));
    const safeName = (bin.file_name || bin.id).replace(/[^\w.\-]+/g, '_');
    res.set('Content-Disposition', `attachment; filename="${safeName}"`);
    return res.send(bin.data);
  } catch (err: any) {
    return serverError(res, err);
  }
});

// URL pública base de esta instancia (para construir el redirect_uri de OAuth). Si no se
// configura LF_PUBLIC_URL, cae a localhost:PORT (solo válido con proveedores que lo permitan).
function publicBaseUrl(): string {
  const raw = process.env.LF_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  return raw.replace(/\/+$/, '');
}
const oauthRedirectUri = () => `${publicBaseUrl()}/oauth/callback`;

// El redirect_uri que el usuario debe registrar en la app OAuth del proveedor.
app.get('/api/oauth/redirect-uri', (_req, res) => {
  return res.json({ redirectUri: oauthRedirectUri() });
});

// Inicia el flujo interactivo: devuelve la URL del proveedor a la que abrir el navegador.
app.post('/api/credentials/:id/oauth/authorize', async (req, res) => {
  try {
    const cred = await getCredentialById(req.params.id);
    if (!cred || cred.type !== 'oauth2') {
      return res.status(404).json({ error: 'OAuth2 credential not found' });
    }
    const url = buildAuthorizationUrl(cred, oauthRedirectUri());
    return res.json({ url });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
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
    // A public (no-token) server must not expose the system tools — that would put
    // destructive tools (delete_workflow, delete_data_table) on an unauthenticated URL.
    if (!ra && exposeSystemTools) {
      return res.status(400).json({ error: 'A public MCP server (requireAuth=false) cannot expose system tools. Enable a token or disable system tools.' });
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

// RESUME ENDPOINT — continues a workflow suspended at a `wait` node. The token (returned
// in the suspended run's report) is the secret; the POSTed body becomes the wait output.
app.post('/hooks/resume/:token', async (req, res) => {
  try {
    const report = await resumeWorkflowAndRecord(req.params.token, req.body ?? {});
    if (!report) {
      return res.status(404).json({ error: 'Unknown or already-consumed resume token' });
    }
    if (report.suspended) {
      return res.json({ success: true, suspended: true, resumeToken: report.resumeToken, waitNodeId: report.waitNodeId });
    }
    return res.json({ success: report.success, suspended: false, nodeResults: report.nodeResults });
  } catch (err: any) {
    return serverError(res, err);
  }
});

// OAuth2 CALLBACK (público — lo invoca el proveedor). Valida el `state`, intercambia el
// código por tokens y devuelve una página que avisa al popup y se cierra. Sin auth: la
// seguridad la dan el `state` infalsificable de un solo uso + PKCE.
function oauthResultPage(ok: boolean, detail: string): string {
  const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
  const payload = JSON.stringify({ source: 'libreflow-oauth', ok, detail });
  const msg = ok
    ? `✅ Credencial conectada (${esc(detail)}). Puedes cerrar esta ventana.`
    : `❌ No se pudo conectar: ${esc(detail)}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>LibreFlow OAuth</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#222">
<p>${msg}</p>
<script>
  try { if (window.opener) window.opener.postMessage(${payload}, '*'); } catch (e) {}
  setTimeout(function(){ window.close(); }, ${ok ? 800 : 4000});
</script>
</body></html>`;
}

app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (error) return res.send(oauthResultPage(false, error_description || error));
  if (!code || !state) return res.send(oauthResultPage(false, 'Faltan parámetros code/state'));
  try {
    const r = await handleOAuthCallback(String(state), String(code));
    return res.send(oauthResultPage(true, r.credentialName));
  } catch (err: any) {
    return res.send(oauthResultPage(false, err.message || 'Error desconocido'));
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

    const webhookTrigger = (workflow.nodes || []).find(
      (n: any) => n.type === 'trigger' && n.parameters?.triggerMode === 'webhook'
    );
    const responseMode = webhookTrigger?.parameters?.responseMode || 'onReceived';
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    // Modo clásico: acuse inmediato y ejecución en segundo plano (comportamiento histórico).
    if (responseMode === 'onReceived') {
      res.json({
        success: true,
        message: 'Webhook received. Workflow executing in background.',
        executionId
      });
      console.log(`[Webhook Trigger] Starting execution ${executionId} for workflow "${workflow.name}" (${workflowId})`);
      try {
        await executeWorkflowAndRecord(workflow, payload, { executionId });
        console.log(`[Webhook Trigger] Completed execution ${executionId} for workflow "${workflow.name}"`);
      } catch (execErr: any) {
        console.error(`[Webhook Trigger] Execution error for ${workflowId}:`, execErr);
      }
      return;
    }

    // Modos síncronos: espera la ejecución (con timeout) y responde a medida. Si salta el
    // timeout, la ejecución sigue en segundo plano y se persiste igualmente.
    const syncTimeout = Math.max(1000, Number(process.env.LF_WEBHOOK_SYNC_TIMEOUT_MS) || 30000);
    const TIMED_OUT = Symbol('timed-out');
    const raced = await Promise.race([
      executeWorkflowAndRecord(workflow, payload, { executionId }),
      new Promise<typeof TIMED_OUT>(r => setTimeout(() => r(TIMED_OUT), syncTimeout)),
    ]);

    if (raced === TIMED_OUT) {
      return res.status(504).json({ error: 'Workflow did not respond in time', executionId });
    }

    const report = raced as Awaited<ReturnType<typeof executeWorkflowAndRecord>>;

    // Un nodo `wait` suspendió la ejecución: no hay respuesta síncrona definitiva.
    if (report.suspended) {
      return res.status(202).json({ success: true, suspended: true, resumeToken: report.resumeToken, executionId });
    }

    if (responseMode === 'respondNode') {
      if (report.httpResponse) {
        const { status, headers, contentType, body } = report.httpResponse;
        res.status(status);
        for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
        const hasCT = Object.keys(headers || {}).some(k => k.toLowerCase() === 'content-type');
        if (contentType && !hasCT) res.type(contentType);
        const out = (body !== null && typeof body === 'object') ? JSON.stringify(body) : (body ?? '');
        return res.send(out);
      }
      // responseMode = respondNode pero ningún nodo "Responder" llegó a ejecutarse.
      return res.status(report.success ? 200 : 500).json({ success: report.success, message: 'No respond node was reached', executionId });
    }

    // responseMode === 'lastNode': devuelve la salida del último nodo ejecutado con éxito.
    const successResults = Object.values(report.nodeResults).filter(r => r.status === 'success' && r.endTime);
    successResults.sort((a, b) => (a.endTime! < b.endTime! ? -1 : a.endTime! > b.endTime! ? 1 : 0));
    const last = successResults[successResults.length - 1];
    return res.status(report.success ? 200 : 500).json(last ? last.output : { success: report.success });

  } catch (err: any) {
    console.error(`[Webhook Trigger Router Error] Failed to dispatch workflow ${workflowId}:`, err);
    if (!res.headersSent) {
      return serverError(res, err);
    }
  }
});

// ----- PUBLIC FORM TRIGGER -----
// Sirve un formulario web (GET) y ejecuta el flujo al enviarlo (POST). Público, como
// /hooks, pero sin HMAC (lo invoca un navegador): la seguridad la dan flujo-activo +
// solo-campos-definidos + rate limiting global. Igual que un webhook síncrono, una
// respuesta a medida sale de un nodo `respond`; si no, se muestra una página de gracias.
function findFormTrigger(workflow: any) {
  return (workflow?.nodes || []).find(
    (n: any) => n.type === 'trigger' && n.parameters?.triggerMode === 'form'
  );
}

app.get('/form/:workflowId', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.workflowId);
    if (!workflow) return res.status(404).type('text/plain').send('Workflow not found');
    const trigger = findFormTrigger(workflow);
    if (!trigger) return res.status(400).type('text/plain').send('Este flujo no tiene un trigger de tipo Formulario.');
    if (!workflow.active) return res.status(503).type('text/plain').send('Formulario no disponible (flujo inactivo).');
    const p = trigger.parameters || {};
    return res.type('text/html').send(renderFormPage({
      title: p.formTitle, description: p.formDescription, buttonText: p.formButtonText,
      fields: parseFormFields(p.formFields),
    }));
  } catch (err: any) {
    return serverError(res, err);
  }
});

app.post('/form/:workflowId', express.urlencoded({ extended: true }), async (req, res) => {
  const { workflowId } = req.params;
  try {
    const workflow = await getWorkflowById(workflowId);
    if (!workflow) return res.status(404).type('text/plain').send('Workflow not found');
    const trigger = findFormTrigger(workflow);
    if (!trigger) return res.status(400).type('text/plain').send('Este flujo no tiene un trigger de tipo Formulario.');
    if (!workflow.active) return res.status(503).type('text/plain').send('Formulario no disponible (flujo inactivo).');

    const p = trigger.parameters || {};
    const fields = parseFormFields(p.formFields);
    const values: Record<string, any> = (req.body && typeof req.body === 'object') ? req.body : {};

    // Validación de obligatorios → re-render con errores (conserva lo introducido).
    const errors = validateFormValues(fields, values);
    if (errors.length) {
      return res.status(400).type('text/html').send(renderFormPage({
        title: p.formTitle, description: p.formDescription, buttonText: p.formButtonText,
        fields, values, errors,
      }));
    }

    // Solo los campos DEFINIDOS llegan al flujo (no se inyectan claves arbitrarias).
    const formData: Record<string, any> = {};
    for (const f of fields) if (values[f.name] !== undefined) formData[f.name] = values[f.name];

    const payload = { form: formData, query: req.query, source: 'form', timestamp: new Date().toISOString() };
    const executionId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const syncTimeout = Math.max(1000, Number(process.env.LF_WEBHOOK_SYNC_TIMEOUT_MS) || 30000);
    const TIMED_OUT = Symbol('timed-out');
    const raced = await Promise.race([
      executeWorkflowAndRecord(workflow, payload, { executionId }),
      new Promise<typeof TIMED_OUT>(r => setTimeout(() => r(TIMED_OUT), syncTimeout)),
    ]);
    if (raced === TIMED_OUT) return res.status(504).type('text/plain').send('El flujo tardó demasiado en responder.');

    const report = raced as Awaited<ReturnType<typeof executeWorkflowAndRecord>>;

    // Un nodo `respond` permite páginas de gracias / redirecciones a medida.
    if (report.httpResponse) {
      const { status, headers, contentType, body } = report.httpResponse;
      res.status(status);
      for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
      const hasCT = Object.keys(headers || {}).some(k => k.toLowerCase() === 'content-type');
      if (contentType && !hasCT) res.type(contentType);
      const out = (body !== null && typeof body === 'object') ? JSON.stringify(body) : (body ?? '');
      return res.send(out);
    }

    if (report.suspended) {
      return res.status(202).type('text/html').send(renderCompletionPage('Tu envío se está procesando.'));
    }

    return res.status(report.success ? 200 : 500).type('text/html').send(
      renderCompletionPage(report.success ? (p.formCompletionMessage || undefined) : 'Hubo un problema al procesar el formulario.')
    );
  } catch (err: any) {
    console.error(`[Form Trigger] Error for ${workflowId}:`, err);
    if (!res.headersSent) return serverError(res, err);
  }
});

// Serve the built frontend (single-container production deploy). `LF_STATIC_DIR` points at
// frontend/dist; it's unset in dev (Vite serves the frontend on :5173 and proxies /api).
const staticDir = process.env.LF_STATIC_DIR;
if (staticDir) {
  app.use(express.static(staticDir));
  // SPA fallback: any non-API GET returns index.html for client-side routing. Backend route
  // prefixes are excluded so they keep their own handlers / 404s.
  app.get('*', (req, res, next) => {
    const p = req.path;
    if (p.startsWith('/api') || p.startsWith('/hooks') || p.startsWith('/mcp') ||
        p.startsWith('/oauth') || p.startsWith('/form')) return next();
    return res.sendFile(path.join(staticDir, 'index.html'));
  });
}

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

