---
name: run-libreflow
description: Build, launch, and drive the LibreFlow workflow-automation app (Express backend + Vue 3 / Vue Flow frontend). Use when asked to run, start, build, smoke-test, or screenshot LibreFlow, or to exercise its workflow execution engine.
---

# Run LibreFlow

LibreFlow is a self-hosted workflow-automation tool (an n8n-style clone): an
**Express + SQLite backend** (`backend/`, port 3000) exposing the execution
engine and REST API, and a **Vue 3 + Vue Flow frontend** (`frontend/`, port
5173) — a visual node-graph editor. It's an npm-workspaces monorepo.

You drive it three ways, all wrapped by **`.claude/skills/run-libreflow/driver.mjs`**:
- **Engine smoke** (`--smoke`) — POSTs a 3-node workflow to the engine and asserts it runs
  and resolves an expression. This is the layer where the logic lives.
- **MCP smoke** (`--mcp`) — opens the MCP server over SSE (zero-dep) and exercises the
  GLOBAL server (system tools + data-table **state engine**: upsert idempotency + atomic
  increment) and a **named** server (a curated workflow group exposed as tools on its own
  URL). This covers the platform's MCP surface — the focus of most recent work.
- **Screenshot** (`--shot`) — headless Chrome captures the running frontend to a PNG.

All paths below are relative to `<unit>/` = `D:\repos\nn8n\libreflow`.
This skill was verified on **Windows 11 (MINGW64 shell), Node v24, Chrome stable.**

## Prerequisites

- Node 20+ (verified on v24) and npm.
- Google Chrome **or** Microsoft Edge installed in the standard location
  (the driver auto-detects both). No extra packages — no Playwright, no xvfb.
- Dependencies are installed per-workspace. If `node_modules/` is missing:
  ```bash
  npm install && npm install -w backend && npm install -w frontend
  ```

## Run (agent path)

**1. Start both servers** (concurrently, from the repo root) in the background:
```bash
npm run dev > /tmp/lf-dev.log 2>&1 &
```
Wait until both ports answer (backend usually within ~2s, frontend ~1s):
```bash
for i in $(seq 1 30); do
  b=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/node-types)
  f=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/)
  echo "backend=$b frontend=$f"; [ "$b" = "200" ] && [ "$f" = "200" ] && break; sleep 1
done
```

**2. Drive it** with the driver (engine smoke + MCP smoke + screenshot):
```bash
node .claude/skills/run-libreflow/driver.mjs
```
Expected output ends with `[driver] DONE` and exit 0:
```
[smoke] success=true duration=0ms
  Start => success ...
  SetVars => success {"greeting":"hello"}
  Logger => success {"message":"value is hello",...}
[smoke] OK — engine ran and expression resolved
[mcp] global tools/list OK — 33 tools (system + active workflows)
[mcp] state engine OK — upsert idempotent (1 row), increment -> n=10
[mcp] named server OK — mcps-… exposes only [Driver_Echo], executed via tools/call
[mcp] OK — MCP server (global + named) + data-table state engine
[shot] wrote C:\Users\...\lf-shots\libreflow.png (244987 bytes)
[driver] DONE
```
Sub-commands run one part only: `--smoke` (engine API), `--mcp` (MCP server + state
engine), `--shot` (screenshot). Override targets with env vars `LF_BACKEND`,
`LF_FRONTEND`, `LF_SHOT_DIR`. The `--mcp` mode is zero-dep (manual SSE handshake); standard
MCP clients connect over **Streamable HTTP** at `POST /api/mcp` or `POST /mcp/:serverId`.

**3. Look at the screenshot.** It lands in `%TEMP%\lf-shots\libreflow.png`
(printed by the driver). Read that PNG — you should see the dark-themed
"Flujos de Trabajo" list view with a left sidebar (Ejecuciones, Credenciales,
Tablas de Datos, **Servidores MCP**). Blank/white = the frontend didn't render;
check `/tmp/lf-dev.log`.

## API quick reference (drive the backend directly)

The engine logic is reachable without the UI — most changes are testable here:
```bash
# list registered node types (19: trigger,set,httpRequest,jsCode,if,log,merge,
#   executeWorkflow,loop,mcpToolCall,dataTable,extractFromFile,convertToFile,
#   switch,filter,aggregate,aiAgent,respond,wait)
curl -s http://localhost:3000/api/node-types

# run an ad-hoc workflow (no save needed)
curl -s -X POST http://localhost:3000/api/workflows/run \
  -H "Content-Type: application/json" \
  -d '{"workflow":{"id":"x","name":"x","nodes":[...],"connections":[...]},"payload":{}}'

# named MCP servers (curated workflow groups exposed as tools on their own URL)
curl -s http://localhost:3000/api/mcp-servers
```
Workflow shape: `nodes[]` = `{id,type,name,parameters}`, `connections[]` =
`{source,target,sourceHandle?,targetHandle?}`. Expressions use
`{{ $node.<NodeName>.output.<path> }}`.

**MCP endpoints** (JSON-RPC; the `--mcp` driver mode drives these):
- `POST /api/mcp` — global server (Streamable HTTP). Legacy SSE at `GET /api/mcp/sse`.
- `POST /mcp/:serverId` — a named server's URL (token-protected unless public).
- `aiAgent` node runs an LLM tool-calling loop against an OpenAI-compatible endpoint
  (e.g. LM Studio at `http://localhost:1234/v1`) with an MCP server as its toolset. Not
  exercised by the driver (needs an external LLM); test it manually when one is available.

## Run (human path)

`npm run dev` then open http://localhost:5173 in a real browser. Useless for
headless agents — use the driver instead.

## Build / Test

```bash
npm run build        # tsc (backend) + vue-tsc && vite build (frontend)
npm test             # backend vitest (engine, loop, mcp, mcp-servers, datatable-state/
                     #   query/trigger, executor, credential-auth, encryption, versions)
```
The vitest config sets `fileParallelism: false` — several suites share the on-disk
SQLite file and would otherwise contend (SQLITE_BUSY).

## Gotchas

- **Stale processes silently win.** If a prior `npm run dev` is still alive,
  the new backend crashes with `EADDRINUSE: :::3000` while an *old* build keeps
  answering on 3000, and Vite quietly moves the frontend to **5174**. Symptoms:
  driver screenshots the wrong port, or `/api/node-types` returns a node set
  that doesn't match source. Kill stragglers first — find PIDs with
  `netstat -ano | grep ":3000 "` / `":5173 "` then `Stop-Process -Id <pid> -Force`.
- **Don't trust HTTP 200 alone.** Confirm the running backend matches source by
  checking the node-type count (currently **19**, includes `switch`/`filter`/`aggregate`
  and `extractFromFile`/`convertToFile`).
- **Chrome `--screenshot` exit code is unreliable.** Some builds exit non-zero
  even on success. The driver checks that the PNG exists and is >1KB instead of
  trusting the exit code.
- **No `ENCRYPTION_KEY` set** → backend logs a warning and uses a dev fallback
  key. Fine for local runs; credentials saved now won't decrypt under a real key later.
- **The app is state-driven, not route-driven** — there's no URL for the editor
  view; navigation is in-app via clicks. Headless `--screenshot` only captures
  the default list view. The non-UI surfaces (engine, MCP, state engine) are driven
  via the `--smoke`/`--mcp` modes instead.
- **`database.sqlite` is NOT committed** (it's gitignored); the backend creates and
  seeds it on first run. It uses WAL, so you'll also see `database.sqlite-wal/-shm`
  files. The `--mcp` driver mode writes demo tables/workflows/servers into it (harmless).
- **MCP over SSE keeps the connection open** — the `--mcp` mode reads the `event:
  endpoint` then POSTs to `/message?connectionId=…`; closing the SSE stream invalidates
  the session. The driver keeps it alive until each phase finishes.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE :::3000` in `/tmp/lf-dev.log` | Old backend alive; kill its PID (see Gotchas), restart `npm run dev`. |
| Frontend on 5174 not 5173 | Old Vite alive on 5173; kill it or set `LF_FRONTEND=http://localhost:5174`. |
| `No Chrome/Edge found` | Install Chrome/Edge, or edit the `candidates` paths in `driver.mjs`. |
| Driver `--smoke` connection refused | Backend not up yet; re-run the readiness loop above. |
| Screenshot blank/white | Frontend build error — check `/tmp/lf-dev.log` for Vite/vue-tsc errors. |
