#!/usr/bin/env node
/**
 * zcode-bilingual self-heal worker — makes the UI translation survive ZCode updates.
 *
 * Why this exists
 * ---------------
 * The bilingual patch lives inside ZCode's `app.asar`, and every ZCode update
 * replaces that file wholesale, wiping the patch. `app.asar` is locked while
 * ZCode runs, so re-patching can only happen after ZCode fully exits. This
 * script closes that gap without any manual step:
 *
 *   1. Something notices the patch is gone (the SessionStart hook, the logon
 *      watchdog, or the user via /zcode-bilingual:repair or repair.cmd) and runs
 *      `self-heal.mjs schedule` — that drops a small request file and spawns a
 *      detached worker.
 *   2. The worker waits until no ZCode process is running and app.asar has
 *      stopped changing (so we never collide with a half-finished update).
 *   3. It runs the patcher (`bin/zcode-zh.mjs apply`), records the outcome in
 *      `self-heal-result.json`, consumes the request, and — when ZCode had to be
 *      closed for this — relaunches ZCode so the user comes back to a translated
 *      UI. A logon-time watchdog never relaunches on its own.
 *
 * Subcommands
 * -----------
 *   schedule --reason <update|manual|repair|watchdog|dictionary> [--sentinel]   arm (or re-arm) self-heal
 *   run                                                 one-shot worker loop (spawned by schedule)
 *   sentinel                                            resident worker: survives ZCode exits and
 *                                                       re-patches the moment an update swaps app.asar
 *   cancel                                              clear the request and stop the worker
 *   watchdog                                            logon self-check (called by the Startup .vbs)
 *   arm-watchdog / unwatch                              install / remove the Startup .vbs
 *   status                                              dump request/result/worker/watchdog state
 *
 * Files (under %LOCALAPPDATA%\zcode-bilingual unless ZCB_DATA_DIR overrides)
 * --------------------------------------------------------------------------
 *   self-heal-request.json   pending heal (consumed on success, kept on failure)
 *   self-heal-result.json    last outcome; failCount per app.asar signature backs off
 *   self-heal-worker.lock\   single-instance lock (pid.json inside)
 *   self-heal.log            forensic log, capped at ~256 KB
 *   self-heal-config.json    optional { "autoHeal": false, "relaunch": false }
 *
 * Test hooks (env): ZCB_DATA_DIR, ZCB_POLL_MS, ZCB_DEADLINE_MS, ZCB_EXE_NAME,
 * ZCB_NO_RELAUNCH, plus the patcher's ZCODE_ASAR.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SELF), '..');
const PATCHER = path.join(PLUGIN_ROOT, 'bin', 'zcode-zh.mjs');
const CURRENT_MARKER = '__zcodeZhTitle3';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_DIR = process.env.ZCB_DATA_DIR || path.join(LOCAL, 'zcode-bilingual');
const REQUEST_FILE = path.join(DATA_DIR, 'self-heal-request.json');
const RESULT_FILE = path.join(DATA_DIR, 'self-heal-result.json');
const LOCK_DIR = path.join(DATA_DIR, 'self-heal-worker.lock');
const LOG_FILE = path.join(DATA_DIR, 'self-heal.log');
const CONFIG_FILE = path.join(DATA_DIR, 'self-heal-config.json');
const WATCHDOG_VBS = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
  'zcode-bilingual-watchdog.vbs',
);

const POLL_MS = Math.max(200, Number(process.env.ZCB_POLL_MS) || 5000);
const DEADLINE_MS = Number(process.env.ZCB_DEADLINE_MS) || 72 * 3600 * 1000;
const EXE_NAME = process.env.ZCB_EXE_NAME || (process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const iso = () => new Date().toISOString();

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* best effort */
  }
}

function readJson(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function writeJson(p, v) {
  try {
    ensureDataDir();
    fs.writeFileSync(p, JSON.stringify(v, null, 2));
    return true;
  } catch {
    return false;
  }
}

function removeFile(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* non-fatal */
  }
}

function logLine(msg) {
  try {
    ensureDataDir();
    try {
      if (fs.statSync(LOG_FILE).size > 262144) {
        const tail = fs.readFileSync(LOG_FILE, 'utf8').slice(-131072);
        fs.writeFileSync(LOG_FILE, tail);
      }
    } catch {
      /* fresh log */
    }
    fs.appendFileSync(LOG_FILE, `[${iso()}] ${msg}\n`);
  } catch {
    /* logging must never break the worker */
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function asarSig(asar) {
  try {
    const s = fs.statSync(asar);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

// ---------------------------------------------------------------------------
// single-instance lock
// ---------------------------------------------------------------------------

function workerState() {
  const j = readJson(path.join(LOCK_DIR, 'pid.json'));
  if (j && pidAlive(j.pid)) return { alive: true, pid: j.pid, since: j.at || null };
  return { alive: false };
}

function acquireLock() {
  ensureDataDir();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR); // atomic on NTFS
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      if (workerState().alive) return false; // a live worker owns it
      try {
        fs.rmSync(LOCK_DIR, { recursive: true, force: true }); // stale lock
      } catch {
        /* retry once */
      }
      continue;
    }
    writeJson(path.join(LOCK_DIR, 'pid.json'), { pid: process.pid, at: iso() });
    return true;
  }
  return false;
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// environment probes
// ---------------------------------------------------------------------------

function isTargetRunning() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/fi', `imagename eq ${EXE_NAME}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      return (r.stdout || '').toLowerCase().includes(`"${EXE_NAME.toLowerCase()}"`);
    }
    const r = spawnSync('pgrep', ['-x', EXE_NAME], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return r.status === 0 && /\d/.test(r.stdout || '');
  } catch {
    return false;
  }
}

/** Run the patcher's status command; tolerates its exit code 1 (needs repatch). */
function patcherStatus(asar) {
  const args = [PATCHER, 'status'];
  if (asar) args.push('--asar', asar);
  try {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, windowsHide: true });
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function exeFromAsar(asar) {
  // <root>/resources/app.asar -> <root>/ZCode.exe
  return path.join(path.dirname(path.dirname(asar)), process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');
}

/** Repeated apply failures on the same build mean "unsupported", not "retry forever". */
function backoffAllows(asar) {
  const res = readJson(RESULT_FILE);
  if (res && !res.ok && (res.failCount || 0) >= 2 && res.asarSig && res.asarSig === asarSig(asar)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// logon watchdog (Startup folder .vbs -> `self-heal.mjs watchdog`)
// ---------------------------------------------------------------------------

function armWatchdog() {
  if (process.platform !== 'win32') return false;
  try {
    const q = (s) => '""' + s + '""'; // doubled quotes inside the VBS string literal
    const vbs =
      "' zcode-bilingual watchdog - re-arms UI translation self-heal at Windows logon.\r\n" +
      "' Managed by zcode-bilingual; removed by its uninstall. Delete this file to disable.\r\n" +
      'Set sh = CreateObject("Wscript.Shell")\r\n' +
      'sh.Run "' + q(process.execPath) + ' ' + q(SELF) + ' watchdog", 0, False\r\n';
    fs.mkdirSync(path.dirname(WATCHDOG_VBS), { recursive: true });
    fs.writeFileSync(WATCHDOG_VBS, vbs, 'ascii');
    return true;
  } catch (e) {
    logLine(`armWatchdog failed at ${WATCHDOG_VBS}: ${(e && e.code) || ''} ${(e && e.message) || e}`);
    return false;
  }
}

function disarmWatchdog() {
  removeFile(WATCHDOG_VBS);
}

function resolveAsarForWatchdog() {
  if (process.env.ZCODE_ASAR && fs.existsSync(process.env.ZCODE_ASAR)) return process.env.ZCODE_ASAR;
  try {
    const p = fs.readFileSync(path.join(DATA_DIR, 'zcode-path.txt'), 'utf8').trim().replace(/^"|"$/g, '');
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* no sidecar */
  }
  const cands = [];
  if (process.platform === 'win32') {
    cands.push(path.join(LOCAL, 'Programs', 'ZCode', 'resources', 'app.asar'));
    cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'resources', 'app.asar'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/ZCode.app/Contents/Resources/app.asar');
  } else {
    cands.push('/opt/ZCode/resources/app.asar');
  }
  return cands.find((p) => fs.existsSync(p)) || null;
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function cmdSchedule(reason, opts = {}) {
  ensureDataDir();
  const mode = opts.sentinel ? 'sentinel' : 'run';
  writeJson(REQUEST_FILE, {
    at: iso(),
    reason: reason || 'manual',
    mode,
    pluginRoot: PLUGIN_ROOT,
    asar: process.env.ZCODE_ASAR || undefined,
  });
  armWatchdog(); // keep the logon backstop fresh (node/script paths can change)
  const w = workerState();
  if (w.alive) {
    console.log(JSON.stringify({ scheduled: true, mode, worker: 'already-running', pid: w.pid }));
    return 0;
  }
  releaseLock(); // clear any stale lock so the new worker can take it
  try {
    const child = spawn(process.execPath, [SELF, mode], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.log(JSON.stringify({ scheduled: true, mode, worker: 'spawned', pid: child.pid }));
  } catch (e) {
    console.log(JSON.stringify({ scheduled: true, mode, worker: 'spawn-failed', error: String((e && e.message) || e) }));
  }
  return 0;
}

function cmdWatchdog() {
  // Logon self-check: silent, fast (two stats + one small JSON), never scans the
  // 300 MB archive. Only acts when the patch was active before and is now gone.
  try {
    const cfg = readJson(CONFIG_FILE) || {};
    if (cfg.autoHeal === false) return 0;
    const asar = resolveAsarForWatchdog();
    if (!asar) return 0;
    const stateFile = asar + '.zcode-zh.json';
    const raw = readJson(stateFile);
    if (!raw || !raw.patched) return 0; // patch was off (or never on): respect that
    if (!backoffAllows(asar)) {
      logLine('watchdog: apply already failed twice for this build; not auto-retrying');
      return 0;
    }
    const asarM = asarSig(asar);
    let stateM = null;
    try {
      stateM = Math.round(fs.statSync(stateFile).mtimeMs);
    } catch {
      /* missing state file */
    }
    const asarNewer = asarM && stateM && Number(asarM.split(':')[1]) > stateM;
    if (!asarNewer && raw.marker === CURRENT_MARKER) {
      // Patch intact, but a newer dictionary/patcher means the baked copy is
      // stale even though the archive was not replaced.
      let inputsStale = false;
      try {
        for (const f of [
          path.join(PLUGIN_ROOT, 'dictionary.json'),
          path.join(PLUGIN_ROOT, 'bin', 'zcode-zh.mjs'),
        ]) {
          if (fs.statSync(f).mtimeMs > stateM) { inputsStale = true; break; }
        }
      } catch {
        /* missing input never counts as newer */
      }
      if (!inputsStale) return 0; // healthy
    }
    logLine('watchdog: update wiped the active patch; arming self-heal');
    return cmdSchedule('watchdog');
  } catch {
    return 0; // a logon hook must never pop an error
  }
}

function cmdCancel() {
  removeFile(REQUEST_FILE);
  const w = workerState();
  let killed = false;
  if (w.alive && w.pid) {
    try {
      if (process.platform === 'win32') {
        killed = spawnSync('taskkill', ['/pid', String(w.pid), '/f'], { timeout: 10000, windowsHide: true }).status === 0;
      } else {
        process.kill(w.pid, 'SIGTERM');
        killed = true;
      }
    } catch {
      /* best effort */
    }
  }
  releaseLock();
  logLine(`cancelled (killedWorker=${killed})`);
  console.log(JSON.stringify({ cancelled: true, killedWorker: killed }));
  return 0;
}

function cmdStatus() {
  console.log(
    JSON.stringify(
      {
        request: readJson(REQUEST_FILE),
        result: readJson(RESULT_FILE),
        worker: workerState(),
        watchdogInstalled: fs.existsSync(WATCHDOG_VBS),
        config: readJson(CONFIG_FILE) || {},
        dataDir: DATA_DIR,
      },
      null,
      2,
    ),
  );
  return 0;
}

function recordFailure(req, asar, reason, detail) {
  const sig = asar ? asarSig(asar) : null;
  const prev = readJson(RESULT_FILE);
  const failCount = prev && !prev.ok && prev.asarSig && prev.asarSig === sig ? (prev.failCount || 1) + 1 : 1;
  writeJson(RESULT_FILE, {
    ok: false,
    at: iso(),
    reason,
    detail: String(detail || '').slice(0, 500),
    asarSig: sig,
    failCount,
    requestReason: req && req.reason,
  });
}

function cmdRun(opts) {
  ensureDataDir();
  if (!acquireLock()) {
    logLine('another worker holds the lock; exiting');
    return 0;
  }
  try {
    const req = readJson(REQUEST_FILE);
    if (!req) {
      logLine('no pending request; exiting');
      return 0;
    }
    const reason = req.reason || 'manual';
    logLine(`worker start pid=${process.pid} reason=${reason} poll=${POLL_MS}ms`);

    const sawRunning = opts.noWait ? false : isTargetRunning();
    let st = patcherStatus(req.asar);
    if (!st || !st.asar) {
      recordFailure(req, null, 'status-unavailable', 'patcher status produced no JSON');
      logLine('patcher status unavailable; exiting');
      return 1;
    }
    if (st.patched && st.marker === CURRENT_MARKER && !st.dictStale && !st.codeStale) {
      writeJson(RESULT_FILE, { ok: true, already: true, at: iso(), version: st.zcodeVersion || null });
      removeFile(REQUEST_FILE);
      logLine('already patched with the current marker; nothing to do');
      return 0;
    }
    if (st.patched && st.marker === CURRENT_MARKER && (st.dictStale || st.codeStale)) {
      logLine(
        `patch is current but the baked inputs are stale` +
          `${st.dictStale ? ` (dictionary ${st.dictHash} -> ${st.dictHashNow})` : ''}` +
          `${st.codeStale ? ' (patcher/dictionary newer than the baked copy)' : ''}; ` +
          'will re-patch with --force',
      );
    }
    const asar = st.asar;

    // Wait until ZCode is fully closed AND app.asar stopped changing (an update
    // installer may still be replacing files right after the app exits).
    const deadline = Date.now() + DEADLINE_MS;
    let lastSig = asarSig(asar);
    let stable = 0;
    while (!opts.noWait) {
      if (Date.now() > deadline) {
        writeJson(RESULT_FILE, { ok: false, at: iso(), reason: 'timeout', asarSig: asarSig(asar), requestReason: reason });
        logLine('deadline reached while waiting for ZCode to close; request kept');
        return 1;
      }
      if (isTargetRunning()) {
        stable = 0;
        sleepSync(POLL_MS);
        continue;
      }
      const sig = asarSig(asar);
      if (sig !== lastSig) {
        lastSig = sig;
        stable = 0;
        logLine('app.asar changed while waiting; resetting stability window');
        sleepSync(POLL_MS);
        continue;
      }
      stable++;
      if (stable >= 2) break;
      sleepSync(POLL_MS);
    }

    if (!readJson(REQUEST_FILE)) {
      logLine('request was cancelled while waiting; exiting');
      return 0;
    }
    const stPre = patcherStatus(req.asar);
    if (stPre && stPre.patched && stPre.marker === CURRENT_MARKER && !stPre.dictStale && !stPre.codeStale) {
      writeJson(RESULT_FILE, { ok: true, already: true, at: iso(), version: stPre.zcodeVersion || null });
      removeFile(REQUEST_FILE);
      logLine('patched by someone else while waiting; nothing to do');
      return 0;
    }

    // A dictionary-only refresh needs --force: plain `apply` bails out on
    // "already patched" and would leave the old dictionary baked in.
    // --force restores the pristine backup first, then re-patches it.
    const force = st.marker === CURRENT_MARKER || !!(stPre && stPre.marker === CURRENT_MARKER);
    logLine(
      `ZCode closed and app.asar stable; applying patch${force ? ' (--force: dictionary refresh)' : ''}`,
    );
    const args = [PATCHER, 'apply'];
    if (force) args.push('--force');
    if (req.asar) args.push('--asar', req.asar);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000, windowsHide: true });
    logLine(`apply exit=${r.status} signal=${r.signal || ''}`);
    if (r.stdout) logLine(`apply stdout: ${String(r.stdout).replace(/\s+/g, ' ').slice(0, 2000)}`);
    if (r.stderr) logLine(`apply stderr: ${String(r.stderr).replace(/\s+/g, ' ').slice(0, 2000)}`);

    if (r.status === 0) {
      const st2 = patcherStatus(req.asar) || {};
      writeJson(RESULT_FILE, {
        ok: true,
        autoHeal: true,
        at: iso(),
        version: st2.zcodeVersion || st.zcodeVersion || null,
        asarSig: asarSig(asar),
        requestReason: reason,
      });
      removeFile(REQUEST_FILE);
      const cfg = readJson(CONFIG_FILE) || {};
      const wantRelaunch =
        !opts.noRelaunch &&
        !process.env.ZCB_NO_RELAUNCH &&
        cfg.relaunch !== false &&
        (sawRunning || reason !== 'watchdog');
      const exe = exeFromAsar(asar);
      if (wantRelaunch && fs.existsSync(exe)) {
        logLine(`relaunching ${exe}`);
        try {
          spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } catch (e) {
          logLine(`relaunch failed: ${(e && e.message) || e}`);
        }
      } else {
        logLine(`no relaunch (wantRelaunch=${wantRelaunch}, exe=${exe}, exists=${fs.existsSync(exe)})`);
      }
      return 0;
    }

    recordFailure(req, asar, `apply-exit-${r.status === null ? 'timeout' : r.status}`, `${r.stderr || ''} ${r.stdout || ''}`);
    logLine('apply failed; request kept for the next scheduled attempt');
    return r.status || 1;
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// sentinel: stay resident across ZCode sessions and win the update window
//
// electron-updater swaps app.asar while ZCode is CLOSED and then relaunches the
// app itself. A one-shot worker that only wakes up after the fact cannot help:
// by the time the next session starts the user is already staring at an
// untranslated UI. That is the "每次更新就失效" report.
//
// The sentinel is armed at session start, deliberately OUTLIVES ZCode's exit, and
// re-patches the moment the archive settles -- so the app the updater relaunches
// comes up already translated, with no user action.
//
// It is the same apply path as `run` (apply --force), just in a loop, plus a fast
// watch right after ZCode exits (the update window) and a slow tail after that.
// Exits on: request cancelled, idle (ZCode long gone and the patch verifies),
// deadline, or a lost lock. Never spins without sleeping.
// ---------------------------------------------------------------------------

const WATCH_MS = Number(process.env.ZCB_SENTINEL_WATCH_MS) || 90 * 1000; // fast watch after exit
const WATCH_POLL_MS = Math.max(500, Number(process.env.ZCB_SENTINEL_WATCH_POLL_MS) || 2000);
const IDLE_POLL_MS = Math.max(2000, Number(process.env.ZCB_SENTINEL_IDLE_POLL_MS) || 30000);
const IDLE_EXIT_MS = Number(process.env.ZCB_SENTINEL_IDLE_EXIT_MS) || 30 * 60 * 1000;

function cmdSentinel() {
  ensureDataDir();
  if (!acquireLock()) {
    logLine('sentinel: another worker holds the lock; exiting');
    return 0;
  }
  const deadline = Date.now() + DEADLINE_MS;
  logLine(
    `sentinel start pid=${process.pid} poll=${POLL_MS}ms watch=${WATCH_POLL_MS}/${WATCH_MS}ms ` +
      `idleExit=${Math.round(IDLE_EXIT_MS / 60000)}min deadline=${Math.round(DEADLINE_MS / 3600000)}h`,
  );
  let sawRunning = false;
  let absentSince = 0;
  let lastSig = '';
  let stable = 0;
  let failSig = '';
  let failCount = 0;
  let lastOkLog = 0;
  try {
    while (Date.now() < deadline) {
      const req = readJson(REQUEST_FILE);
      if (!req) {
        logLine('sentinel: request cancelled; exiting');
        return 0;
      }

      if (isTargetRunning()) {
        sawRunning = true;
        absentSince = 0;
        stable = 0;
        lastSig = '';
        sleepSync(POLL_MS);
        continue;
      }
      if (!absentSince) absentSince = Date.now();

      const fast = Date.now() - absentSince < WATCH_MS;
      const interval = fast ? WATCH_POLL_MS : IDLE_POLL_MS;

      const st0 = patcherStatus();
      const asar = (st0 && st0.asar) || resolveAsarForWatchdog();
      if (!asar) {
        sleepSync(interval);
        continue;
      }

      // An update installer is writing the archive right now: only act once the
      // signature has stopped changing for two consecutive checks.
      const sig = asarSig(asar);
      if (sig !== lastSig) {
        lastSig = sig;
        stable = 0;
        sleepSync(interval);
        continue;
      }
      stable++;
      if (stable < 2) {
        sleepSync(interval);
        continue;
      }
      stable = 0;

      const st = patcherStatus(asar);
      if (!st) {
        sleepSync(interval);
        continue;
      }
      const needs = !(st.patched && st.marker === CURRENT_MARKER && !st.dictStale && !st.codeStale);

      if (!needs) {
        if (Date.now() - lastOkLog > 10 * 60 * 1000) {
          logLine(
            `sentinel: ok (mode=${st.patchMode || '?'} dict=${st.dictEntriesNow || '?'} ` +
              `asar=${st.size || '?'}${st.codeStale ? ' codeStale' : ''})`,
          );
          lastOkLog = Date.now();
        }
        if (Date.now() - absentSince > IDLE_EXIT_MS) {
          logLine('sentinel: ZCode long gone and the patch verifies; exiting');
          return 0;
        }
        sleepSync(interval);
        continue;
      }

      if (failSig === sig && failCount >= 2) {
        if (Date.now() - lastOkLog > 10 * 60 * 1000) {
          logLine(`sentinel: backoff (2 failures on ${sig}); waiting for a new archive`);
          lastOkLog = Date.now();
        }
        sleepSync(interval);
        continue;
      }

      logLine(
        `sentinel: patch ${st.patched ? 'stale' : 'missing'} after an archive change` +
          `${st.dictStale ? ' (dictionary out of date)' : ''}; applying --force`,
      );
      const args = [PATCHER, 'apply', '--force'];
      args.push('--asar', asar);
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000, windowsHide: true });
      logLine(`sentinel: apply exit=${r.status} signal=${r.signal || ''}`);
      if (r.stdout) logLine(`sentinel: apply stdout: ${String(r.stdout).replace(/\s+/g, ' ').slice(0, 1200)}`);
      if (r.stderr) logLine(`sentinel: apply stderr: ${String(r.stderr).replace(/\s+/g, ' ').slice(0, 1200)}`);

      if (r.status === 0) {
        failSig = '';
        failCount = 0;
        const st2 = patcherStatus(asar) || {};
        writeJson(RESULT_FILE, {
          ok: true,
          autoHeal: true,
          at: iso(),
          version: st2.zcodeVersion || st.zcodeVersion || null,
          asarSig: asarSig(asar),
          requestReason: 'sentinel',
        });
        const cfg = readJson(CONFIG_FILE) || {};
        const wantRelaunch =
          !process.env.ZCB_NO_RELAUNCH && cfg.relaunch !== false && sawRunning;
        const exe = exeFromAsar(asar);
        if (wantRelaunch && fs.existsSync(exe)) {
          logLine(`sentinel: relaunching ${exe}`);
          try {
            spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          } catch (e) {
            logLine(`sentinel: relaunch failed: ${(e && e.message) || e}`);
          }
        } else {
          logLine(`sentinel: no relaunch (wantRelaunch=${wantRelaunch}, exists=${fs.existsSync(exe)})`);
        }
        // Stay armed: the next update must be caught just as promptly.
        absentSince = Date.now();
        sleepSync(interval);
        continue;
      }

      recordFailure({ reason: 'sentinel' }, asar, `apply-exit-${r.status === null ? 'timeout' : r.status}`,
        `${r.stderr || ''} ${r.stdout || ''}`);
      failSig = sig;
      failCount++;
      sleepSync(interval);
    }
    logLine('sentinel: deadline reached; exiting');
    return 0;
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

function parseOpts(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason') opts.reason = argv[++i];
    else if (a === '--sentinel') opts.sentinel = true;
    else if (a === '--no-wait') opts.noWait = true;
    else if (a === '--no-relaunch') opts.noRelaunch = true;
    else opts._.push(a);
  }
  return opts;
}

function main() {
  const opts = parseOpts(process.argv.slice(2));
  const cmd = opts._[0] || 'status';
  try {
    if (cmd === 'schedule') return cmdSchedule(opts.reason, opts);
    if (cmd === 'run') return cmdRun(opts);
    if (cmd === 'sentinel') return cmdSentinel(opts);
    if (cmd === 'cancel') return cmdCancel();
    if (cmd === 'watchdog') return cmdWatchdog();
    if (cmd === 'arm-watchdog') {
      const ok = armWatchdog();
      console.log(JSON.stringify({ watchdog: ok ? 'installed' : 'failed', path: WATCHDOG_VBS }));
      return ok ? 0 : 1;
    }
    if (cmd === 'unwatch') {
      disarmWatchdog();
      console.log(JSON.stringify({ watchdog: 'removed' }));
      return 0;
    }
    if (cmd === 'status') return cmdStatus();
    console.error(`Unknown command: ${cmd}
Usage: self-heal.mjs <schedule|run|sentinel|cancel|watchdog|arm-watchdog|unwatch|status>`);
    return 2;
  } catch (err) {
    console.error(String((err && err.message) || err));
    return 1;
  }
}

process.exitCode = main();
