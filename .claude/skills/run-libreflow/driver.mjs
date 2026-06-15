#!/usr/bin/env node
// LibreFlow driver — smoke-tests the backend execution engine over HTTP
// and screenshots the running frontend with headless Chrome.
//
// Prereq: servers already running via `npm run dev` (backend :3000, frontend :5173).
// Usage:
//   node .claude/skills/run-libreflow/driver.mjs            # smoke + screenshot
//   node .claude/skills/run-libreflow/driver.mjs --smoke    # API smoke only
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
const only = args.find((a) => a === '--smoke' || a === '--shot');

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

async function smoke() {
  // trigger -> set (defines a var) -> log (resolves it via expression)
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
  if (only !== '--shot') await smoke();
  if (only !== '--smoke') await screenshot();
  console.log('[driver] DONE');
} catch (e) {
  console.error('[driver] FAILED:', e.message);
  process.exit(1);
}
