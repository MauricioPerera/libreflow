# LibreFlow

A self-hosted, visual **workflow-automation** tool (an n8n-style engine). Build flows
on a node canvas, run them manually / on a schedule / via webhook, and expose them as
MCP tools. Workflows are also a **state engine** (data tables with atomic ops + reactive
triggers) and can run an **AI agent** node whose tools are your own workflows. Monorepo
with an Express + SQLite backend and a Vue 3 + Vue Flow frontend.

## Highlights

- **12 node types** incl. `aiAgent` (LLM tool-calling loop), `mcpToolCall` (MCP client),
  `dataTable`, loops, sub-workflows, HTTP, JS code.
- **MCP server, both ways** — expose the whole platform globally, or a curated **named
  server** (group of workflows as tools on its own token-protected URL). Standards-compliant
  **Streamable HTTP** transport via the official `@modelcontextprotocol/sdk`.
- **Data-table state engine** — unique-key idempotency, atomic `upsert` / `increment` /
  get-or-default, rich queries (operators + sort + limit), and **reactive triggers** (run a
  flow on row insert/update).

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
npm test                    # backend test suite (vitest)
```

## Driving it programmatically

There's a run/smoke skill at [.claude/skills/run-libreflow/](.claude/skills/run-libreflow):
`node .claude/skills/run-libreflow/driver.mjs` runs an engine smoke test over the API and
screenshots the UI with headless Chrome.

## Key API endpoints

All under `/api` (require `x-api-key` when `LF_API_KEY` is set):

- `GET  /api/node-types` — registered node definitions
- `POST /api/workflows/run` — run an ad-hoc workflow `{ workflow, payload }`
- `GET|POST|DELETE /api/workflows[/:id]` — workflow CRUD (+ `/:id/active`, `/:id/versions`)
- `GET /api/executions[/:id]`, `GET /api/workflows/:id/executions` — run history
- `GET|POST|DELETE /api/mcp-servers[/:id]` — named MCP servers (curated workflow groups)
- `GET|POST|DELETE /api/credentials[/:id]`, `GET|POST|DELETE /api/data-tables[/:id]` (+ `/rows`)
- `*  /hooks/:workflowId` — webhook trigger (HMAC-verified when `LF_WEBHOOK_SECRET` is set)

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
  opt-in flag. Tune limits with `LF_JS_TIMEOUT_MS` (default 5000) and `LF_JS_MEMORY_MB`
  (default 128).
- Outbound requests (httpRequest / MCP / aiAgent LLM) are SSRF-guarded; private IPs blocked
  in production.
- Credentials are encrypted at rest (AES-256-GCM); the API never returns decrypted secrets.
  Types: `basicAuth`, `apiKey`, and `oauth2` (server-to-server: `client_credentials` /
  `refresh_token`, with automatic token fetch/refresh and an encrypted token cache).
- Named MCP servers use a per-server bearer token (constant-time compared); a **public**
  (no-token) server may not expose the destructive `libreflow_*` system tools.
