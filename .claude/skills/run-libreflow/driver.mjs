#!/usr/bin/env node
// LibreFlow driver — smoke-tests the backend over HTTP and screenshots the frontend.
//
// Prereq: servers already running via `npm run dev` (backend :3000, frontend :5173).
// Usage:
//   node .claude/skills/run-libreflow/driver.mjs            # engine smoke + mcp smoke + screenshot
//   node .claude/skills/run-libreflow/driver.mjs --smoke    # engine API smoke only
//   node .claude/skills/run-libreflow/driver.mjs --mcp      # MCP server + data-table state engine
//   node .claude/skills/run-libreflow/driver.mjs --shot     # screenshot only
//
// Verified on Windows 11 (MINGW64), Node v24, Chrome stable.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BACKEND = process.env.LF_BACKEND || 'http://localhost:3000';
const FRONTEND = process.env.LF_FRONTEND || 'http://localhost:5173';
const SHOT_DIR = process.env.LF_SHOT_DIR || join(tmpdir(), 'lf-shots');

const args = process.argv.slice(2);
const only = args.find((a) => a === '--smoke' || a === '--mcp' || a === '--shot');

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found in standard install paths');
  return hit;
}

// ---- Engine API smoke: trigger -> set -> log, resolving an expression ----
async function smoke() {
  const workflow = {
    id: 'driver-smoke',
    name: 'Driver Smoke',
    nodes: [
      { id: 'n1', type: 'trigger', name: 'Start', parameters: { triggerMode: 'manual' } },
      { id: 'n2', type: 'set', name: 'SetVars', parameters: { values: [{ key: 'greeting', value: 'hello' }] } },
      { id: 'n3', type: 'log', name: 'Logger', parameters: { message: 'value is {{ $node.SetVars.output.greeting }}' } },
    ],
    connections: [
      { source: 'n1', target: 'n2' },
      { source: 'n2', target: 'n3' },
    ],
  };

  const res = await fetch(`${BACKEND}/api/workflows/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow, payload: {} }),
  });
  if (!res.ok) throw new Error(`run endpoint returned HTTP ${res.status}`);
  const report = await res.json();

  console.log(`[smoke] success=${report.success} duration=${report.durationMs}ms`);
  for (const k of Object.keys(report.nodeResults)) {
    const n = report.nodeResults[k];
    console.log(`  ${n.nodeName} => ${n.status} ${JSON.stringify(n.output ?? n.error ?? '')}`);
  }

  const logOut = report.nodeResults.n3?.output?.message;
  if (!report.success) throw new Error('workflow reported failure');
  if (logOut !== 'value is hello') throw new Error(`expression did not resolve, got: ${logOut}`);
  console.log('[smoke] OK — engine ran and expression resolved');
}

// ---- MCP smoke: opens the legacy SSE transport (zero-dep) and drives the MCP server.
// Exercises the GLOBAL server (system tools + data-table state engine: upsert idempotency
// + atomic increment) and a NAMED server (a curated workflow group on its own URL). ----
let _rpcId = 1;
async function openSse(sseUrl) {
  const res = await fetch(sseUrl);
  if (!res.ok) throw new Error(`SSE ${sseUrl} -> HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', url = null;
  while (!url) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/event:\s*endpoint\r?\ndata:\s*([^\r\n]+)/);
    if (m) url = new URL(m[1].trim(), sseUrl).toString();
  }
  if (!url) throw new Error(`no endpoint event from ${sseUrl}`);
  // keep the stream alive so the session stays open
  (async () => { try { while (true) { const { done } = await reader.read(); if (done) break; } } catch {} })();
  return { url, cancel: () => reader.cancel().catch(() => {}) };
}
async function rpc(msgUrl, method, params) {
  const r = await fetch(msgUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const callTool = async (msgUrl, name, args) => {
  const r = await rpc(msgUrl, 'tools/call', { name, arguments: args });
  return r.content[0].text;
};

async function mcpSmoke() {
  // GLOBAL server: system tools present
  const g = await openSse(`${BACKEND}/api/mcp/sse`);
  await rpc(g.url, 'initialize', {});
  const tools = (await rpc(g.url, 'tools/list', {})).tools;
  if (!tools.some((t) => t.name === 'libreflow_list_workflows')) throw new Error('global server missing system tools');
  console.log(`[mcp] global tools/list OK — ${tools.length} tools (system + active workflows)`);

  // Data-table state engine: keyed table, upsert idempotency, atomic increment
  const createTxt = await callTool(g.url, 'libreflow_create_data_table', {
    name: `driver_${Date.now()}`, columns: [{ name: 'k', type: 'string' }, { name: 'n', type: 'number' }], keyColumn: 'k',
  });
  const tableId = createTxt.match(/ID: (table-[^\s]+)/)[1];
  await callTool(g.url, 'libreflow_upsert_data_table_row', { tableId, data: { k: 'a', n: 1 } });
  await callTool(g.url, 'libreflow_upsert_data_table_row', { tableId, data: { k: 'a', n: 9 } });
  const inc = JSON.parse(await callTool(g.url, 'libreflow_increment_data_table_row', { tableId, key: 'a', field: 'n', amount: 1 }));
  const page = JSON.parse(await callTool(g.url, 'libreflow_get_data_table_rows', { tableId }));
  g.cancel();
  if (page.total !== 1) throw new Error(`state engine: expected 1 row (idempotent upsert), got ${page.total}`);
  if (inc.data.n !== 10) throw new Error(`increment: expected n=10, got ${inc.data.n}`);
  console.log('[mcp] state engine OK — upsert idempotent (1 row), increment -> n=10');

  // NAMED server: a curated workflow group exposed on its own URL, system tools off
  await fetch(`${BACKEND}/api/workflows`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'driver-mcp-wf', name: 'Driver Echo',
      nodes: [
        { id: 'n1', type: 'trigger', name: 'Start', parameters: { triggerMode: 'manual', inputSchema: '{"type":"object","properties":{}}' } },
        { id: 'n2', type: 'set', name: 'Out', parameters: { values: [{ key: 'echo', value: 'ok' }] } },
      ],
      connections: [{ source: 'n1', target: 'n2' }],
    }),
  });
  const srv = await (await fetch(`${BACKEND}/api/mcp-servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Driver Server', workflowIds: ['driver-mcp-wf'], requireAuth: false, exposeSystemTools: false }),
  })).json();
  const n = await openSse(`${BACKEND}/mcp/${srv.id}/sse`);
  await rpc(n.url, 'initialize', {});
  const nNames = (await rpc(n.url, 'tools/list', {})).tools.map((t) => t.name);
  if (nNames.some((x) => x.startsWith('libreflow_'))) throw new Error('named server leaked system tools');
  if (!nNames.includes('Driver_Echo')) throw new Error('named server missing its workflow tool');
  const call = await callTool(n.url, 'Driver_Echo', {});
  n.cancel();
  if (!call.includes('"echo"')) throw new Error('named workflow tool did not run');
  console.log(`[mcp] named server OK — ${srv.id} exposes only [Driver_Echo], executed via tools/call`);
  console.log('[mcp] OK — MCP server (global + named) + data-table state engine');
}

function screenshot() {
  return new Promise((resolve, reject) => {
    mkdirSync(SHOT_DIR, { recursive: true });
    const out = join(SHOT_DIR, 'libreflow.png');
    const chrome = findChrome();
    const chromeArgs = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1600,1000',
      `--screenshot=${out}`,
      '--virtual-time-budget=5000',
      FRONTEND + '/',
    ];
    execFile(chrome, chromeArgs, (err) => {
      // chrome headless --screenshot returns 0 and writes the file; older builds
      // exit non-zero even on success, so verify the file instead of the code.
      if (existsSync(out) && statSync(out).size > 1000) {
        console.log(`[shot] wrote ${out} (${statSync(out).size} bytes)`);
        resolve(out);
      } else {
        reject(err || new Error('screenshot file missing or empty'));
      }
    });
  });
}

try {
  if (!only || only === '--smoke') await smoke();
  if (!only || only === '--mcp') await mcpSmoke();
  if (!only || only === '--shot') await screenshot();
  console.log('[driver] DONE');
} catch (e) {
  console.error('[driver] FAILED:', e.message);
  process.exit(1);
}
