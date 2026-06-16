# LibreFlow

[![CI](https://github.com/MauricioPerera/libreflow/actions/workflows/ci.yml/badge.svg)](https://github.com/MauricioPerera/libreflow/actions/workflows/ci.yml)

A self-hosted, visual **workflow-automation** tool (an n8n-style engine). Build flows
on a node canvas, run them manually / on a schedule / via webhook, and expose them as
MCP tools. Workflows are also a **state engine** (data tables with atomic ops + reactive
triggers) and can run an **AI agent** node whose tools are your own workflows. Monorepo
with an Express + SQLite backend and a Vue 3 + Vue Flow frontend.

## Highlights

- **19 node types** incl. `aiAgent` (LLM tool-calling loop), `mcpToolCall` (MCP client),
  `dataTable`, loops, sub-workflows, HTTP, JS code, plus control/data primitives
  (`switch`, `filter`, `aggregate`), file content (`extractFromFile`, `convertToFile`) and a
  custom HTTP `respond`.
- **MCP server, both ways** — expose the whole platform globally, or a curated **named
  server** (group of workflows as tools on its own token-protected URL). Standards-compliant
  **Streamable HTTP** transport via the official `@modelcontextprotocol/sdk`.
- **Custom HTTP responses & web forms** — a webhook trigger can be **synchronous**
  (`responseMode`: `lastNode`/`respondNode`) and the `respond` node returns a custom
  status/headers/body. A **form trigger** serves an auto-generated public web form
  (`GET/POST /form/:workflowId`) that runs the flow on submit.
- **File content** — `extractFromFile` parses **CSV/XLSX/JSON/text** into structured rows and
  extracts **text from PDF**; `convertToFile` generates CSV/XLSX/JSON/text back into a
  downloadable binary (SheetJS + pdf-parse).
- **Collection primitives** — `switch` (N-way routing by rules), `filter`, and `aggregate`
  (group-by + count/sum/avg/min/max, sort, limit, dedupe) — local, deterministic, no LLM.
- **Data-table state engine** — unique-key idempotency, atomic `upsert` / `increment` /
  get-or-default, an all-or-nothing **`batch`** of mixed ops in one transaction, rich queries
  (operators + sort + limit), and **reactive triggers** (run a flow on row insert/update).
- **Streaming triggers** — persistent long-running connections (SSE, WebSocket, MQTT, IMAP)
  that fire a flow per inbound message, with automatic exponential-backoff reconnect.
- **Durable execution** — a `wait` node suspends the run and returns a resume token; continue
  later via `POST /hooks/resume/:token`. The engine replays the already-run nodes from cached
  outputs (no double side-effects) and resumes from the wait node.
- **Granular debugging** — **pin** a node's output so manual runs reuse it instead of
  re-executing (skip expensive/external calls while iterating), and **re-run from a node**
  (reuses cached upstream outputs, re-runs only that node and its descendants). Pins apply to
  manual runs only, never in production.
- **Binary files** — `httpRequest` can download to / upload from a binary store; node outputs
  carry a lightweight reference (`_lfBinary`) instead of inline bytes, downloadable via
  `/api/binaries/:id`. Capped by `LF_MAX_BINARY_MB`.
- **Large-data helpers** — the `loop` supports `batchSize` (process items in chunks) and
  `jsCode` accepts per-node memory/timeout overrides.
- **Flow coherence validation & AI error context** — a structural validator catches dangling
  expressions (the rename-breakage), unknown types and bad handles (`POST
  /api/workflows/validate`, also run on save). Failed executions expose a **pre-armed LLM
  prompt** (`GET /api/executions/:id/llm-context`), surfaced as a "🤖 Contexto IA" button.

## Stack

- **Backend** (`backend/`) — Node + Express + TypeScript, SQLite (WAL), `node-cron`,
  `@modelcontextprotocol/sdk`. Port **3000**.
- **Frontend** (`frontend/`) — Vue 3 + Vue Flow + Vite. Port **5173** (proxies `/api` and
  `/mcp` → backend).

## Prerequisites

- Node **20.6+** (developed on Node 24) and npm.

## Setup

```bash
npm install                 # root + workspaces
npm install -w backend
npm install -w frontend
```

Configuration is **optional in development** — the app runs with safe defaults and zero
config. For production, copy the env template and set the required secrets:

```bash
cp .env.example .env        # then edit; see the file for every variable
```

Required in production (`NODE_ENV=production`): `ENCRYPTION_KEY`, `LF_API_KEY`,
`LF_WEBHOOK_SECRET`. All others are optional with sensible defaults — see
[.env.example](.env.example).

## Run (development)

```bash
npm run dev                 # backend (:3000) + frontend (:5173) together
# or individually:
npm run dev:backend
npm run dev:frontend
```

Open http://localhost:5173. The backend creates `backend/database.sqlite` on first run.

## Build & test

```bash
npm run build               # backend (tsc) + frontend (vue-tsc && vite build)
npm test                    # backend (vitest) + frontend (vitest + @vue/test-utils + jsdom)
```

## Deploy with Docker (single container)

One container runs the backend, which also serves the built frontend. State (SQLite +
binaries) lives in a named volume — back it up by copying that one file.

```bash
cp .env.example .env        # then set ENCRYPTION_KEY, LF_API_KEY (and LF_PUBLIC_URL for OAuth)
docker compose up -d --build
# → http://localhost:3000
```

- **Persistence**: SQLite at `/data/database.sqlite` (env `LF_DB_PATH`) on the `libreflow-data`
  volume; the binaries table is in the same file. Back up = stop + copy the file.
- **Portability**: export a single flow as JSON (Flujos → *Exportar*, or `GET
  /api/workflows/:id/export`) and import it elsewhere (*Importar*, or `POST
  /api/workflows/import`) — credentials are referenced by id, never exported.
- **Frontend**: served by the backend from `LF_STATIC_DIR` (`/app/frontend/dist`); the API is
  same-origin at `/api`, so no proxy needed in production.
- **Secrets**: `ENCRYPTION_KEY` and `LF_API_KEY` are required (compose refuses to start
  without them). Set `LF_PUBLIC_URL` to your real URL for interactive OAuth and webhook/form links.

## Driving it programmatically

There's a run/smoke skill at [.claude/skills/run-libreflow/](.claude/skills/run-libreflow):
`node .claude/skills/run-libreflow/driver.mjs` runs an engine smoke test over the API and
screenshots the UI with headless Chrome.

## Key API endpoints

All under `/api` (require `x-api-key` when `LF_API_KEY` is set):

- `GET  /api/node-types` — registered node definitions
- `POST /api/workflows/run` — run an ad-hoc workflow `{ workflow, payload }`
- `POST /api/workflows/validate` — structural coherence check `{ nodes, connections }`
- `POST /api/workflows/validate-batch` — validate many saved flows at once; filter by `{ ids }`
  or `{ contains }` (graph substring, e.g. an API host) for "fix all flows tied to one API"
- `GET  /api/executions/:id/llm-context` — pre-armed LLM prompt + context for a failed run
- `GET|POST|DELETE /api/workflows[/:id]` — workflow CRUD (+ `/:id/active`, `/:id/versions`,
  `/:id/versions/:version`, `/:id/versions/:version/restore`)
- `GET /api/workflows/:id/export` / `POST /api/workflows/import` — export/import a flow as
  portable JSON (no id/secrets; import creates a new flow)
- `GET /api/executions[/:id]`, `GET /api/workflows/:id/executions` — run history
- `GET /api/binaries/:id` — download a binary-store object (referenced by `_lfBinary` in outputs)
- `POST /hooks/resume/:token` — resume a suspended (`wait`) run; the POST body becomes the wait output
- OAuth2 interactive: `POST /api/credentials/:id/oauth/authorize` (start) + public
  `GET /oauth/callback` (provider redirect) + `GET /api/oauth/redirect-uri` (URI to register)
- `GET|POST|DELETE /api/mcp-servers[/:id]` — named MCP servers (curated workflow groups)
- `GET|POST|DELETE /api/credentials[/:id]`, `GET|POST|DELETE /api/data-tables[/:id]` (+ `/rows`)
- `*  /hooks/:workflowId` — webhook trigger (HMAC-verified when `LF_WEBHOOK_SECRET` is set).
  Synchronous when the trigger's `responseMode` is `lastNode`/`respondNode` (bounded by
  `LF_WEBHOOK_SYNC_TIMEOUT_MS`); otherwise acks immediately and runs in the background.
- `GET|POST /form/:workflowId` — public web form (form trigger); GET renders, POST runs the flow

MCP endpoints (JSON-RPC, Streamable HTTP):

- `POST /api/mcp` — global MCP server (all active workflows + `libreflow_*` system tools)
- `POST /mcp/:serverId` — a **named** MCP server's URL (its workflow group as tools,
  protected by a per-server bearer token unless marked public). Mounted outside `/api` auth.

Workflow shape: `nodes[] = {id,type,name,parameters}`, `connections[] =
{source,target,sourceHandle?,targetHandle?}`. Expressions use
`{{ $node.<NodeName>.output.<path> }}`.

## Security notes

- `jsCode` runs user code in an **isolated-vm** sandbox (V8 with no host bindings — no
  `require`/`process`/`fs`/network), with bounded memory and time. Safe in production; no
  opt-in flag. Tune limits globally with `LF_JS_TIMEOUT_MS` (default 5000) and
  `LF_JS_MEMORY_MB` (default 128), or per node via the `jsTimeoutMs` / `jsMemoryMb` params.
- Outbound requests (httpRequest / oauth2 / SSE trigger) go through `safeFetch`, which blocks
  private/loopback/metadata IPs in production **and re-validates every redirect hop** (so a
  public host can't 30x-redirect into your network). Response bodies are read with a memory cap.
- Credentials are encrypted at rest (AES-256-GCM); the API never returns decrypted secrets.
  Types: `basicAuth`, `apiKey`, and `oauth2` — server-to-server (`client_credentials` /
  `refresh_token`) **and interactive `authorization_code` + PKCE** (browser consent via a
  popup → `/oauth/callback`), all with automatic token fetch/refresh and an encrypted token
  cache. Interactive flow needs `LF_PUBLIC_URL` set and the redirect URI registered at the
  provider.
- Named MCP servers use a per-server bearer token (constant-time compared); a **public**
  (no-token) server may not expose the destructive `libreflow_*` system tools.
