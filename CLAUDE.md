# CLAUDE.md — LibreFlow

Guidance for AI agents working in this repo. LibreFlow is a self-hosted, n8n-style visual
workflow-automation tool. npm-workspaces monorepo: `backend/` (Express + SQLite) and
`frontend/` (Vue 3 + Vue Flow).

## Commands

```bash
npm run dev            # backend :3000 + frontend :5173 (concurrently)
npm run dev:backend    # backend only (tsx watch)
npm run dev:frontend   # frontend only (vite)
npm run build          # backend tsc + frontend vue-tsc && vite build
npm test               # backend vitest suite (run from repo; delegates to backend)
```

Verify changes with `npm test` (backend) and `npm run build` (both). To exercise the
running app, use the run skill: `node .claude/skills/run-libreflow/driver.mjs`.

## Architecture

### Backend (`backend/src/`)
- **engine.ts** — the workflow execution engine. BFS over the node graph. Loops are
  **collapsed to a single node** and their body runs as an isolated recursive sub-graph
  **once per iteration** (`runSubgraph` / `runLoop`), which makes every sub-graph acyclic
  and supports **nested loops**. `getLoopBodyNodes` treats the loop node as a boundary
  (never traverses through it). Exports `WorkflowValidationError` for user-facing structural
  errors (surfaced as HTTP 400). A step cap (`LF_MAX_EXECUTION_STEPS`) guards infinite loops.
- **nodes.ts** — `executeNode` + expression resolution `{{ $node.Name.output.path }}`.
  Ephemeral params (loop state, trigger payload) are passed as `paramOverrides` — the engine
  NEVER mutates the shared node object (keeps re-runs deterministic). Prototype-pollution
  keys are blocked in path traversal.
- **registry.ts** — node definitions (trigger, set, httpRequest, jsCode, if, log, merge,
  executeWorkflow, loop, mcpToolCall, dataTable, **aiAgent**). `NodeRegistry` is the single
  source of node types. `aiAgent` is an LLM tool-calling loop (OpenAI-compatible endpoint)
  whose toolset is an MCP server — own (in-process) or external (SDK client). Shared
  credential→auth helper (`resolveCredentialAuth`) used by httpRequest / mcpToolCall / aiAgent;
  schemes: basicAuth, apiKey, and **oauth2** (`oauth2.ts`: server-to-server client_credentials /
  refresh_token, auto token fetch/refresh, in-memory + encrypted-credential token cache).
- **executor.ts** — `executeWorkflowAndRecord`: persists a `running` record, runs, saves the
  final report, triggers the error-workflow, prunes old executions (throttled, every Nth run).
  Serializes concurrent runs of the same workflow id (per-id promise chain), and exports an
  `execStack` (`AsyncLocalStorage`) re-entrancy guard that aborts a workflow trying to run
  itself (e.g. an agent whose toolset includes its own flow) instead of deadlocking.
- **db.ts** — SQLite access. `PRAGMA foreign_keys = ON`, `busy_timeout`, `journal_mode = WAL`;
  `saveWorkflow` + version are atomic (BEGIN/COMMIT); indexes on hot columns; idempotent column
  migrations. Tables: workflows, executions, credentials, workflow_versions, data_tables,
  data_table_rows, **mcp_servers**. **Data-table state engine**: optional unique key column
  (`key_column` + derived `row_key`) enabling atomic `upsert` / `increment` / get-or-default,
  rich `queryDataTableRows` (operators eq/ne/gt/lt/gte/lte/contains/in via `json_extract`),
  and a transactional batch insert (`addDataTableRows`).
- **dataTableEvents.ts** — reactive data-table triggers: a decoupled event bus (db.ts emits,
  triggerManager subscribes — so db never imports the executor) plus an `AsyncLocalStorage`
  trigger-depth guard that caps self-feeding cascades (`MAX_TRIGGER_DEPTH`).
- **triggerManager.ts** — registers active workflows' background triggers: `cron` (node-cron)
  and `dataTable` (subscribes to row insert/update; dispatches the flow fire-and-forget,
  detached from `execStack`).
- **server.ts** — Express API. `requireAuth` on `/api`, HMAC on `/hooks/:id`, gzip compression
  (SSE excluded), rate limiting, generic 500s (real error logged, masked to client) via
  `serverError`. Mounts the public named-MCP-server router at `/mcp` (outside `/api` auth).
- **auth.ts / security.ts** — API key + webhook HMAC; `constantTimeEqual` (per-MCP-server token);
  SSRF guard (`assertSafeUrl`), `isUnsafeKey`, `rateLimit`, `cronTooFrequent`.
- **mcp.ts** — MCP server **and** client, via the official SDK (`@modelcontextprotocol/sdk`).
  `dispatchMcpRpc(body, scope)` is the single JSON-RPC source of truth (scope = which
  workflows + whether the `libreflow_*` system tools are exposed). Transports: **Streamable
  HTTP** (current spec) at `POST /api/mcp` (global) and `POST /mcp/:serverId` (named servers);
  legacy SSE kept for back-compat. **Named MCP servers** expose a curated workflow group as
  tools at their own token-protected URL. Client (`fetchToolsFromMcpServer` /
  `executeMcpToolCall` / `openMcpClientSession`) consumes Streamable HTTP or SSE. Tools return
  compact JSON + `structuredContent` + annotations, with default row limits (agent-first).

### Frontend (`frontend/src/`)
- **App.vue** — the whole UI (dashboard + node-canvas editor). Dashboard subviews: Flujos,
  Ejecuciones, Credenciales, Tablas de Datos, **Servidores MCP** (CRUD a named server's
  workflow group + token + URL). Calls the backend via `/api` (Vite proxy). `apiGetJson`
  checks `res.ok`; `applyExecutionResults` is the shared node/edge status-styling helper.
  Unsaved-changes are tracked via `isDirty` (+ beforeunload).
- **components/** — `CustomNode`, `NodeConfigPanel` (param form, inline JSON/cron validation),
  `ExpressionEditor`, `JsonTreeItem`.
- **focusTrap.ts** — global `v-focus-trap` directive for modals (Esc + click-outside + ARIA
  are also wired).

## Conventions

- ESM throughout; backend imports use `.js` extensions (TS → ESM).
- Comments and UI strings are in **Spanish**; match the surrounding style.
- All new env vars are documented in [.env.example](.env.example) and read via `process.env`.
  Production-strict behavior gates on `NODE_ENV === 'production'`.
- Adding a node type = add a definition in `registry.ts` and register it; the API and UI
  pick it up from `NodeRegistry` automatically.
- Loop wiring convention: loop node `loop` handle → body → feeds back to the loop node;
  `done` handle → continuation. Loop output is `{ done, results }`.
