#!/usr/bin/env node
/**
 * live-ctl — start/inspect/stop the live-translation service (scripts/dict-server.mjs).
 *
 * `ensure` is what the hooks call (SessionStart directly, UserPromptSubmit after a
 * cheap pid check): probe 127.0.0.1:17981-17985 for our handshake; if none answers
 * and no live process holds the pid file, spawn the server detached (it survives
 * ZCode by design and exits on its own when ZCode has been gone for 3 minutes —
 * same lifecycle policy as the wb2api gateway on this machine).
 *
 *   node scripts/live-ctl.mjs ensure        # hooks: start if not running (fast, silent)
 *   node scripts/live-ctl.mjs status        # JSON: { running, port, pid, learned, up, model }
 *   node scripts/live-ctl.mjs stop          # kill the pid from the pid file
 *
 * Model choice is a hand edit, not a command: put "model": "<id>" into
 * %LOCALAPPDATA%\zcode-bilingual\live-config.json and save — /translate re-reads
 * the config per request and /ping reports the current choice, so it is live at
 * once with no restart. Remove the key to unpin (gateway config, then fallback).
 *
 * Prints one JSON line; exit 0 unless `ensure` could not reach/spawn anything.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PLUGIN_ROOT, 'scripts', 'dict-server.mjs');
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_DIR = process.env.ZCB_DATA_DIR || path.join(LOCAL, 'zcode-bilingual');
const PID_FILE = path.join(DATA_DIR, 'live-server.pid');
const STAMP_FILE = path.join(DATA_DIR, 'live-arm.stamp');
const THROTTLE_MS = Number(process.env.ZCB_LIVE_THROTTLE_MS) || 60 * 1000;

const PORTS = [17981, 17982, 17983, 17984, 17985];

function ping(port) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, path: '/ping', method: 'GET', timeout: 400 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4096) res.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          fin(j && j.svc === 'zcode-bilingual' ? j : null);
        } catch { fin(null); }
      });
      res.on('error', () => fin(null));
    });
    req.on('timeout', () => { req.destroy(); fin(null); });
    req.on('error', () => fin(null));
    req.end();
  });
}

async function findService() {
  for (const port of PORTS) {
    // eslint-disable-next-line no-await-in-loop -- first hit wins, misses are instant refusals
    const hit = await ping(port);
    if (hit) return { ...hit, port };
  }
  return null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function spawnServer() {
  try {
    const child = spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return child.pid;
  } catch { return null; }
}

async function cmdEnsure() {
  const found = await findService();
  if (found) {
    console.log(JSON.stringify({ ok: true, running: true, port: found.port, learned: found.learned }));
    return 0;
  }
  const pid = readPid();
  if (pid && pidAlive(pid)) {
    // process exists but is not listening yet (still booting) — give it this run
    console.log(JSON.stringify({ ok: true, running: true, pid, starting: true }));
    return 0;
  }
  try { if (Date.now() - fs.statSync(STAMP_FILE).mtimeMs < THROTTLE_MS) { console.log(JSON.stringify({ ok: true, throttled: true })); return 0; } } catch { /* no stamp */ }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STAMP_FILE, new Date().toISOString(), 'utf8'); } catch { /* best effort */ }
  const newPid = spawnServer();
  console.log(JSON.stringify({ ok: !!newPid, spawned: !!newPid, pid: newPid }));
  return newPid ? 0 : 1;
}

async function cmdStatus() {
  const found = await findService();
  const pid = readPid();
  console.log(JSON.stringify({
    running: !!found,
    port: found ? found.port : null,
    pid: found ? null : (pid && pidAlive(pid) ? pid : null),
    learned: found ? found.learned : null,
    base: found ? found.base : null,
    up: found ? found.up : null,
    live: found ? found.live : null,
    model: found ? found.model : null,
  }));
  return 0;
}

function cmdStop() {
  const pid = readPid();
  if (!pid) { console.log(JSON.stringify({ ok: true, stopped: false, reason: 'no pid file' })); return 0; }
  try { process.kill(pid); console.log(JSON.stringify({ ok: true, stopped: true, pid })); } catch (e) {
    console.log(JSON.stringify({ ok: true, stopped: false, reason: String((e && e.message) || e) }));
  }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* best effort */ }
  return 0;
}

const cmd = process.argv[2] || 'status';
const run = async () => {
  if (cmd === 'ensure') return cmdEnsure();
  if (cmd === 'stop') return cmdStop();
  return cmdStatus();
};
run().then((code) => { process.exitCode = code; }).catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exitCode = 1;
});
