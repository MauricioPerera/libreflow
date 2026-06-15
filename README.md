# LibreFlow

A self-hosted, visual **workflow-automation** tool (an n8n-style engine). Build flows
on a node canvas, run them manually / on a schedule / via webhook, and expose them as
MCP tools. Monorepo with an Express + SQLite backend and a Vue 3 + Vue Flow frontend.

## Stack

- **Backend** (`backend/`) — Node + Express + TypeScript, SQLite, `node-cron`. Port **3000**.
- **Frontend** (`frontend/`) — Vue 3 + Vue Flow + Vite. Port **5173** (proxies `/api` → backend).

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
- `*  /hooks/:workflowId` — webhook trigger (HMAC-verified when `LF_WEBHOOK_SECRET` is set)
- credentials, data-tables, and MCP routes under `/api/...`

Workflow shape: `nodes[] = {id,type,name,parameters}`, `connections[] =
{source,target,sourceHandle?,targetHandle?}`. Expressions use
`{{ $node.<NodeName>.output.<path> }}`.

## Security notes

- `jsCode` runs arbitrary code with full host access — disabled by default in production
  (`LF_ENABLE_JS_CODE=true` to opt in on a trusted instance).
- Outbound requests (httpRequest / MCP) are SSRF-guarded; private IPs blocked in production.
- Credentials are encrypted at rest (AES-256-GCM); the API never returns decrypted secrets.
