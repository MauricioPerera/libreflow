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
npm test               # backend vitest + frontend vitest (test:backend / test:frontend for one)
docker compose up -d --build   # single-container deploy (backend serves the built frontend)
```

Verify changes with `npm test` (backend + frontend) and `npm run build` (both). CI
(`.github/workflows/ci.yml`) runs the suite + a Docker image build on every push/PR. To
exercise the running app, use the run skill: `node .claude/skills/run-libreflow/driver.mjs`.

## Architecture

### Backend (`backend/src/`)
- **engine.ts** — the workflow execution engine. BFS over the node graph. Loops are
  **collapsed to a single node** and their body runs as an isolated recursive sub-graph
  **once per iteration** (`runSubgraph` / `runLoop`), which makes every sub-graph acyclic
  and supports **nested loops**. `getLoopBodyNodes` treats the loop node as a boundary
  (never traverses through it). The loop supports `batchSize` (>1 → body runs per CHUNK,
  reading `$node.Loop.output.items`; default 1 keeps the item-at-a-time `.item`/`.index`/
  `.isLast` shape). Exports `WorkflowValidationError` for user-facing structural
  errors (surfaced as HTTP 400). A step cap (`LF_MAX_EXECUTION_STEPS`) guards infinite loops.
  **Pin data**: a node may carry `pinData`; on **manual** runs (`execMeta.usePinData`, set only
  by `POST /api/workflows/run`) the engine uses it instead of executing the node — iterate
  downstream without re-calling expensive/external nodes. Ignored in production (triggered runs
  don't set the flag). Honors if/switch branch routing from the pinned output; result flagged
  `pinned: true`. **Re-run from a node**: `descendantsOf` + `buildRerunResume` build a
  `ResumeState` from a prior run's `nodeResults` minus the target node and its descendants, so
  the replay reuses cached upstream outputs and only re-runs that node downward (same mechanism
  as suspend/resume; `POST /api/workflows/run` accepts `{ rerunFrom, priorResults }`).
- **nodes.ts** — `executeNode` + expression resolution `{{ $node.Name.output.path }}`.
  Ephemeral params (loop state, trigger payload) are passed as `paramOverrides` — the engine
  NEVER mutates the shared node object (keeps re-runs deterministic). Prototype-pollution
  keys are blocked in path traversal.
- **registry.ts** — node definitions (trigger, set, httpRequest, jsCode, if, log, merge,
  executeWorkflow, loop, mcpToolCall, dataTable, **extractFromFile**, **convertToFile**,
  **switch**, **filter**, **aggregate**, **aiAgent**, **respond**, wait).
  `extractFromFile`/`convertToFile` parse and generate file CONTENT (CSV/XLSX/JSON/text) —
  bridging the binary store to structured data (logic in `fileParse.ts`). `switch` (N-way
  routing by rules), `filter` and `aggregate` (summarize/sort/limit/unique) are local
  collection primitives (pure logic in `collections.ts`). `switch` routes like `if` — the
  engine forwards only the output handle matching `output.matched`, skipping the rest. The `trigger`
  node has modes manual/webhook/cron/dataTable/stream/**form**, plus a webhook `responseMode`
  (onReceived/lastNode/respondNode). The `respond` node declares a custom synchronous HTTP
  response (status/headers/body); the engine captures it into `report.httpResponse` and the
  webhook/form routes emit it. `NodeRegistry` is the single
  source of node types. `aiAgent` is an LLM tool-calling loop (OpenAI-compatible endpoint)
  whose toolset is an MCP server — own (in-process) or external (SDK client). Optional
  **self-consistency**: `runs > 1` runs the agent N times in parallel (one shared toolset, a
  conversation per run) and merges the answers via `mergeAnswers` (`collections.ts`:
  first/majority/mostSimilar), returning the consensus answer + an `agreement` ratio.
  Optional **skills**: `loadSkills` reads an external MCP server's **resources** (not tools) via
  `loadSkillsFromSession` (`mcp.ts`) and injects them as a trusted-instructions system message —
  e.g. a signed/governed skill registry (postal-skills) served over MCP. Shared
  credential→auth helper (`resolveCredentialAuth`) used by httpRequest / mcpToolCall / aiAgent;
  schemes: basicAuth, apiKey, and **oauth2** (`oauth2.ts`: server-to-server client_credentials /
  refresh_token **plus interactive authorization_code + PKCE**, auto token fetch/refresh,
  in-memory + encrypted-credential token cache). Interactive flow: `buildAuthorizationUrl` /
  `handleOAuthCallback` (single-use `state` store) wired in server.ts as authenticated
  `POST /api/credentials/:id/oauth/authorize` + public `GET /oauth/callback` (popup →
  postMessage). `redirect_uri` derives from `LF_PUBLIC_URL`.
- **executor.ts** — `executeWorkflowAndRecord`: persists a `running` record, runs, saves the
  final report, triggers the error-workflow, prunes old executions (throttled, every Nth run).
  Serializes concurrent runs of the same workflow id (per-id promise chain), and exports an
  `execStack` (`AsyncLocalStorage`) re-entrancy guard that aborts a workflow trying to run
  itself (e.g. an agent whose toolset includes its own flow) instead of deadlocking.
- **db.ts** — SQLite access (path from `LF_DB_PATH`, default `./database.sqlite`).
  `PRAGMA foreign_keys = ON`, `busy_timeout`, `journal_mode = WAL`;
  `saveWorkflow` + version are atomic (BEGIN/COMMIT); indexes on hot columns; idempotent column
  migrations. Tables: workflows, executions, credentials, workflow_versions, data_tables,
  data_table_rows, **mcp_servers**, **binaries**. **Binary store** (`binary.ts` + db helpers
  `saveBinary`/`getBinary`): bytes live in the `binaries` BLOB table, NOT inline in the
  execution JSON; node outputs carry a `{_lfBinary,fileName,mimeType,size}` reference. Tied to
  `execution_id` (no FK; cleaned in `pruneOldExecutions` + a NULL-orphan TTL sweep). The
  `executionId` reaches nodes via `execMeta`. Capped by `LF_MAX_BINARY_MB`; downloaded via
  `GET /api/binaries/:id`. `httpRequest` does `responseFormat: binary` (download) and
  `bodyType: binary` (upload). **Data-table state engine**: optional unique key column
  (`key_column` + derived `row_key`) enabling atomic `upsert` / `increment` / get-or-default,
  rich `queryDataTableRows` (operators eq/ne/gt/lt/gte/lte/contains/in via `json_extract`),
  a transactional batch insert (`addDataTableRows`), and `batchDataTableRows` — an
  all-or-nothing transaction of MIXED ops (append/update/delete/upsert/increment) in one
  BEGIN/COMMIT (events emitted only after commit). This is the "one transaction = one node"
  unit (no cross-node transactions in the stateless engine); exposed as the dataTable `batch`
  operation.
- **dataTableEvents.ts** — reactive data-table triggers: a decoupled event bus (db.ts emits,
  triggerManager subscribes — so db never imports the executor) plus an `AsyncLocalStorage`
  trigger-depth guard that caps self-feeding cascades (`MAX_TRIGGER_DEPTH`).
- **triggerManager.ts** — registers active workflows' background triggers: `cron` (node-cron),
  `dataTable` (subscribes to row insert/update; dispatches the flow fire-and-forget,
  detached from `execStack`) and `stream` (delegates to `streamTriggers.ts`).
- **streamTriggers.ts** — long-running/streaming triggers (`StreamTriggerManager`): persistent
  connections over **SSE** (native fetch), **WebSocket** (`ws`), **MQTT** (`mqtt`) and **IMAP**
  (`imapflow`) that fire the flow per inbound message (detached, like dataTable). Common
  lifecycle: connect → fire-per-message → exponential-backoff reconnect on drop → clean
  teardown. Transports are injectable adapters (`ConnectFn`) — the manager owns the backoff;
  the SSRF guard maps ws/mqtt schemes to http for `assertSafeUrl`.
- **server.ts** — Express API. `requireAuth` on `/api`, HMAC on `/hooks/:id`, gzip compression
  (SSE excluded), rate limiting, generic 500s (real error logged, masked to client) via
  `serverError`. Mounts the public named-MCP-server router at `/mcp` (outside `/api` auth).
  Webhooks (`/hooks/:id`) honor the trigger's `responseMode`: `onReceived` (immediate ack +
  background run, the legacy default) vs synchronous `lastNode`/`respondNode` (await the run,
  bounded by `LF_WEBHOOK_SYNC_TIMEOUT_MS`, then emit `report.httpResponse`). Export/import a flow
  as portable JSON (no id/secrets): `GET /api/workflows/:id/export` + `POST /api/workflows/import`
  (creates a new flow). In single-container deploys serves the built frontend from `LF_STATIC_DIR`
  with an SPA fallback that excludes the `/api`,`/hooks`,`/mcp`,`/oauth`,`/form` prefixes.
- **flowValidate.ts** — `validateWorkflow` (pure, uses registry): structural coherence checks —
  unknown node types, dangling connections, invalid output handles, duplicate names, and
  **hanging `{{ $node.X.output }}` expressions** (catches the rename-breakage). Returns
  `{ ok, errors, warnings, issues[] }`. Run on save (non-blocking, returned to the client) and
  exposed at `POST /api/workflows/validate`. `validateWorkflows` (batch) backs `POST
  /api/workflows/validate-batch` — validate many saved flows, filtered by `ids` or `contains`
  (graph substring, e.g. an API host) for the "fix all flows tied to one API" pass.
- **errorContext.ts** — `buildExecutionLlmContext` (pure): from a failed execution builds a
  structured `{ failedNode, ... }` + a **pre-armed Spanish prompt** to paste into an LLM/agent
  (flow, execution id, failed node + error, instruction). Exposed at
  `GET /api/executions/:id/llm-context`; surfaced in the UI as a "🤖 Contexto IA" button on
  failed executions.
- **collections.ts** — pure local-collection primitives (no DB): `compareValues`, `filterItems`,
  `summarize` (group by + count/sum/avg/min/max), `sortItems`, `limitItems`, `uniqueItems`,
  `getPath` (dotted paths). Backs the switch/filter/aggregate nodes.
- **fileParse.ts** — pure parse/serialize of file CONTENT via SheetJS (`xlsx`): `parseFileBuffer`
  / `serializeToFile` / `detectFormat` for CSV/XLSX/JSON/text, plus `parsePdfBuffer` (async, PDF
  text extraction via `pdf-parse` v2 / pdf.js — extract-only). Sanitizes object keys on parse
  (`isUnsafeKey`) to mitigate SheetJS 0.18.x prototype pollution. Used by the
  extractFromFile/convertToFile nodes; the bytes live in the binary store, never inline.
- **forms.ts** — public **form trigger** rendering (no DB, no state): `renderFormPage` /
  `renderCompletionPage` / `parseFormFields` / `validateFormValues`. Routes `GET/POST
  /form/:workflowId` (public, no HMAC — browser-driven; guarded by active-flow +
  only-defined-fields + global rate limit) serve an auto-generated HTML form and run the flow
  on submit; a `respond` node gives a custom thank-you/redirect, else a default completion page.
- **auth.ts / security.ts** — API key + webhook HMAC; `constantTimeEqual` (per-MCP-server token);
  SSRF guard (`assertSafeUrl` + `safeFetch`, which re-validates every redirect hop),
  `isUnsafeKey`, `rateLimit` (evicts expired windows), `cronTooFrequent`. httpRequest/oauth2
  use `safeFetch`; httpRequest reads the body capped (`readResponseCapped`, `binary.ts`) to
  avoid OOM on huge/lying responses.
- **mcp.ts** — MCP server **and** client, via the official SDK (`@modelcontextprotocol/sdk`).
  `dispatchMcpRpc(body, scope)` is the single JSON-RPC source of truth (scope = which
  workflows + whether the `libreflow_*` system tools are exposed). Transports: **Streamable
  HTTP** (current spec) at `POST /api/mcp` (global) and `POST /mcp/:serverId` (named servers);
  legacy SSE kept for back-compat. The global server also exposes **resources** (`scope.exposeResources`):
  the data-tables as read-only MCP resources (`libreflow://datatable/{id}`, rows capped by
  `AGENT_ROW_LIMIT`) — agent *context* the host can attach, distinct from tools. Named servers
  stay tools-only (v1). **Named MCP servers** expose a curated workflow group as
  tools at their own token-protected URL. Client (`fetchToolsFromMcpServer` /
  `executeMcpToolCall` / `openMcpClientSession`) consumes Streamable HTTP or SSE. Tools return
  compact JSON + `structuredContent` + annotations, with default row limits (agent-first).

### Frontend (`frontend/src/`)
- **App.vue** — the shell/orchestrator: VueFlow node-canvas editor + dashboard, owning the
  reactive state, fetchers and CRUD; the dashboard subviews and modals are now **extracted
  components** (App.vue went 2623→~1800 LOC). Backend via `/api` (Vite proxy in dev;
  same-origin in the single-container prod build). `apiGetJson` (used by all read fetchers)
  checks `res.ok`; `applyExecutionResults` styles node/edge status. Unsaved-changes via
  `isDirty` — set on connect/add/param-edit **and** node move (`@node-drag-stop`) / delete
  (`@nodes/edges-change` `remove`), guarded by `applyingCanvas` so programmatic loads don't
  trip it. On save, the coherence `validation` paints as a floating banner (click an issue →
  `focusIssueNode`). Wires the **pin** (`set-pin`) and **re-run** (`rerun`) actions from
  `NodeConfigPanel`, and workflow **export/import** (download blob / file-picker → POST).
- **components/** — extracted, presentational (props in / emits out) unless noted:
  - Dashboard subviews: `FlowsView`, `CredentialsView`, `ExecutionsView`, `DataTablesList`,
    `DataTableDetail` (controlled inline-edit: state stays in App.vue), `McpServersView`.
  - Modals: `SaveWorkflowModal`, `AddRowModal`, `DataTableModal`, `McpServerModal`,
    `BatchValidateModal`, `AiContextModal`, and `CredentialModal` (self-contained: owns the
    whole form + the OAuth connect flow — popup, `e.origin`-checked `postMessage`, listener
    cleaned on unmount).
  - Editor: `CustomNode` (pin badge), `NodeConfigPanel` (param form, inline JSON/cron
    validation, pin/re-run controls), `ExpressionEditor`, `JsonTreeItem` (binary refs → download).
- **utils.ts** — pure helpers (no reactive state): `statusLabel`, `formatFullDate`,
  `credentialTypeLabel`, `mcpServerUrl`, `setNestedValue` (prototype-pollution-guarded),
  `parseJsonColumns`, `coerceRowByColumns`. Unit-tested.
- **focusTrap.ts** — global `v-focus-trap` directive for modals (Esc + click-outside + ARIA
  are also wired). Mount tests stub it via `global.directives`.
- **Frontend tests** — `vitest` + `@vue/test-utils` + jsdom (`frontend/vitest.config.ts`): a
  mount test per extracted component (props render, emits, key behaviors) + `utils.test.ts`.
  Run via `npm run test -w frontend` (included in root `npm test`).

## Conventions

- ESM throughout; backend imports use `.js` extensions (TS → ESM).
- Comments and UI strings are in **Spanish**; match the surrounding style.
- All new env vars are documented in [.env.example](.env.example) and read via `process.env`.
  Production-strict behavior gates on `NODE_ENV === 'production'`.
- Adding a node type = add a definition in `registry.ts` and register it; the API and UI
  pick it up from `NodeRegistry` automatically.
- Loop wiring convention: loop node `loop` handle → body → feeds back to the loop node;
  `done` handle → continuation. Loop output is `{ done, results }`.
