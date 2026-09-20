#!/usr/bin/env node
/**
 * Cheap insurance: make sure the RESIDENT sentinel is armed.
 *
 * Why this exists
 * ---------------
 * SessionStart alone proved unreliable on this machine: on 2026-09-19 a ZCode
 * relaunch created a session (`session_create.completed`) yet the SessionStart
 * hook never ran -- hooks/session-start.mjs left no trace in hook.log.
 *
 * The sentinel MUST already be alive the moment electron-updater swaps app.asar
 * (it replaces the archive while ZCode is closed and then relaunches the app), so
 * arming cannot depend on one event that may or may not fire. This runs on
 * UserPromptSubmit as well, which is guaranteed to fire whenever the user
 * actually talks to ZCode.
 *
 * Cost when everything is already fine: one small file read + one
 * `process.kill(pid, 0)` -- no child process, no spawn, silent exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_HEAL = path.join(PLUGIN_ROOT, 'scripts', 'self-heal.mjs');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_DIR = process.env.ZCB_DATA_DIR || path.join(LOCAL, 'zcode-bilingual');
const LOCK_PID_FILE = path.join(DATA_DIR, 'self-heal-worker.lock', 'pid.json');
const REQUEST_FILE = path.join(DATA_DIR, 'self-heal-request.json');
const STAMP_FILE = path.join(DATA_DIR, 'sentinel-arm.stamp');
const THROTTLE_MS = Number(process.env.ZCB_ARM_THROTTLE_MS) || 60 * 1000;

// Hook contract: the payload arrives on stdin. Drain it so the parent never
// blocks on a full pipe. We do not need its contents.
try {
  process.stdin.setEncoding('utf8');
  for await (const _chunk of process.stdin) {
    /* discard */
  }
} catch {
  /* stdin may be closed; nothing to do */
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

// Fast path: a worker already holds the lock -> nothing to do, stay silent.
try {
  const j = JSON.parse(fs.readFileSync(LOCK_PID_FILE, 'utf8'));
  if (j && typeof j.pid === 'number' && pidAlive(j.pid)) process.exit(0);
} catch {
  /* no lock / unreadable: fall through and (re)arm */
}

// Throttle: never let a persistently dying worker turn into a spawn storm.
try {
  if (Date.now() - fs.statSync(STAMP_FILE).mtimeMs < THROTTLE_MS) process.exit(0);
} catch {
  /* no stamp yet */
}
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STAMP_FILE, new Date().toISOString(), 'utf8');
} catch {
  /* best effort */
}

let ok = false;
let detail = '';
try {
  const r = spawnSync(process.execPath, [SELF_HEAL, 'schedule', '--reason', 'hook', '--sentinel'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  ok = r.status === 0 && fs.existsSync(REQUEST_FILE);
  detail = `status=${r.status} ${String(r.stdout || '').replace(/\s+/g, ' ').slice(0, 160)}`;
} catch (e) {
  detail = `threw ${(e && e.message) || e}`;
}
try {
  fs.appendFileSync(
    path.join(DATA_DIR, 'hook.log'),
    `[${new Date().toISOString()}] UserPromptSubmit armSentinel ok=${ok} ${detail}\n`,
    'utf8',
  );
} catch {
  /* diagnostics must never break the hook */
}

// Only speak up when we failed -- otherwise this would add noise to every prompt.
if (!ok) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          'zcode-bilingual: 自动修复哨兵未能启动，翻译在 ZCode 更新后可能不会自动恢复；' +
          '可运行插件目录下的 repair.cmd。/ self-heal sentinel could not be armed; run repair.cmd.',
      },
    }) + '\n',
  );
}
process.exit(0);
