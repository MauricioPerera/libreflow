---
name: run-libreflow
description: Build, launch, and drive the LibreFlow workflow-automation app (Express backend + Vue 3 / Vue Flow frontend). Use when asked to run, start, build, smoke-test, or screenshot LibreFlow, or to exercise its workflow execution engine.
---

# Run LibreFlow

LibreFlow is a self-hosted workflow-automation tool (an n8n-style clone): an
**Express + SQLite backend** (`backend/`, port 3000) exposing the execution
engine and REST API, and a **Vue 3 + Vue Flow frontend** (`frontend/`, port
5173) — a visual node-graph editor. It's an npm-workspaces monorepo.

You drive it two ways, both wrapped by **`.claude/skills/run-libreflow/driver.mjs`**:
- **API smoke** — POSTs a 3-node workflow to the engine and asserts it runs and
  resolves an expression. This is the layer where the logic lives.
- **Screenshot** — headless Chrome captures the running frontend to a PNG.

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

**2. Drive it** with the driver (smoke test + screenshot):
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
[shot] wrote C:\Users\...\lf-shots\libreflow.png (256348 bytes)
[driver] DONE
```
Sub-commands: `--smoke` (API only) or `--shot` (screenshot only).
Override targets with env vars `LF_BACKEND`, `LF_FRONTEND`, `LF_SHOT_DIR`.

**3. Look at the screenshot.** It lands in `%TEMP%\lf-shots\libreflow.png`
(printed by the driver). Read that PNG — you should see the dark-themed
"Flujos de Trabajo" list view with a left sidebar (Ejecuciones, Credenciales,
Tablas de Datos). Blank/white = the frontend didn't render; check `/tmp/lf-dev.log`.

## API quick reference (drive the backend directly)

The engine logic is reachable without the UI — most changes are testable here:
```bash
# list registered node types (11: trigger,set,httpRequest,jsCode,if,log,merge,executeWorkflow,loop,mcpToolCall,dataTable)
curl -s http://localhost:3000/api/node-types

# run an ad-hoc workflow (no save needed)
curl -s -X POST http://localhost:3000/api/workflows/run \
  -H "Content-Type: application/json" \
  -d '{"workflow":{"id":"x","name":"x","nodes":[...],"connections":[...]},"payload":{}}'
```
Workflow shape: `nodes[]` = `{id,type,name,parameters}`, `connections[]` =
`{source,target,sourceHandle?,targetHandle?}`. Expressions use
`{{ $node.<NodeName>.output.<path> }}`.

## Run (human path)

`npm run dev` then open http://localhost:5173 in a real browser. Useless for
headless agents — use the driver instead.

## Build / Test

```bash
npm run build        # tsc (backend) + vue-tsc && vite build (frontend)
npm test             # backend vitest suite (engine, loop, mcp, encryption, versions)
```

## Gotchas

- **Stale processes silently win.** If a prior `npm run dev` is still alive,
  the new backend crashes with `EADDRINUSE: :::3000` while an *old* build keeps
  answering on 3000, and Vite quietly moves the frontend to **5174**. Symptoms:
  driver screenshots the wrong port, or `/api/node-types` returns a node set
  that doesn't match source. Kill stragglers first — find PIDs with
  `netstat -ano | grep ":3000 "` / `":5173 "` then `Stop-Process -Id <pid> -Force`.
- **Don't trust HTTP 200 alone.** Confirm the running backend matches source by
  checking the node-type count (currently **11**, includes `dataTable`).
- **Chrome `--screenshot` exit code is unreliable.** Some builds exit non-zero
  even on success. The driver checks that the PNG exists and is >1KB instead of
  trusting the exit code.
- **No `ENCRYPTION_KEY` set** → backend logs a warning and uses a dev fallback
  key. Fine for local runs; credentials saved now won't decrypt under a real key later.
- **The app is state-driven, not route-driven** — there's no URL for the editor
  view; navigation is in-app via clicks. Headless `--screenshot` only captures
  the default list view. Deeper UI flows need a DevTools-protocol driver (not built here).
- **`database.sqlite` is committed and seeded** with demo workflows (incl. one
  Active cron `* * * * *`). That cron fires every minute while the backend runs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE :::3000` in `/tmp/lf-dev.log` | Old backend alive; kill its PID (see Gotchas), restart `npm run dev`. |
| Frontend on 5174 not 5173 | Old Vite alive on 5173; kill it or set `LF_FRONTEND=http://localhost:5174`. |
| `No Chrome/Edge found` | Install Chrome/Edge, or edit the `candidates` paths in `driver.mjs`. |
| Driver `--smoke` connection refused | Backend not up yet; re-run the readiness loop above. |
| Screenshot blank/white | Frontend build error — check `/tmp/lf-dev.log` for Vite/vue-tsc errors. |
