#!/usr/bin/env node
/**
 * SessionStart hook for zcode-bilingual.
 *
 * Reads the tiny state file written by bin/zcode-zh.mjs (never scans the 300 MB
 * archive) and injects a one-line, bilingual status note.
 *
 * When it sees that a ZCode update has wiped the UI patch (state file says
 * patched, but app.asar is newer than the state file), it arms the self-heal
 * worker (scripts/self-heal.mjs schedule) instead of just complaining: the
 * worker waits for ZCode to fully exit, re-applies the patch, and relaunches
 * ZCode — no manual step. Repeated failures on the same build stop auto-arming
 * (backoff) and surface as a "needs attention" note.
 *
 * Manual smoke test:
 *   echo {"hook_event_name":"SessionStart","source":"startup"} | node hooks/session-start.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_HEAL = path.join(PLUGIN_ROOT, 'scripts', 'self-heal.mjs');
const CURRENT_MARKER = '__zcodeZhTitle3';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_DIR = process.env.ZCB_DATA_DIR || path.join(LOCAL, 'zcode-bilingual');
const REQUEST_FILE = path.join(DATA_DIR, 'self-heal-request.json');
const RESULT_FILE = path.join(DATA_DIR, 'self-heal-result.json');
const CONFIG_FILE = path.join(DATA_DIR, 'self-heal-config.json');
const LOCK_PID_FILE = path.join(DATA_DIR, 'self-heal-worker.lock', 'pid.json');

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  input = {};
}
const eventName = input.hook_event_name || input.hookEventName || 'SessionStart';

function readJson(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function candidates() {
  const home = os.homedir();
  const out = [];
  if (process.platform === 'win32') {
    out.push(path.join(LOCAL, 'Programs', 'ZCode', 'resources', 'app.asar'));
    out.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'resources', 'app.asar'));
  } else if (process.platform === 'darwin') {
    out.push('/Applications/ZCode.app/Contents/Resources/app.asar');
  } else {
    out.push('/opt/ZCode/resources/app.asar');
  }
  return out;
}

function stateFor(asar) {
  return readJson(asar + '.zcode-zh.json');
}

/**
 * Leave a breadcrumb in %LOCALAPPDATA%\zcode-bilingual\hook.log.
 *
 * The SessionStart hook used to be a total black box: when self-heal failed to
 * arm there was no way to tell whether the hook never ran, which branch it took,
 * or whether the child spawn failed. That made a real incident (2026-09-19:
 * "restarted ZCode and the dictionary still wasn't refreshed") undiagnosable
 * from the outside. Diagnostics must never break the hook, hence the try/catch.
 */
function diag(line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const p = path.join(DATA_DIR, 'hook.log');
    try {
      if (fs.statSync(p).size > 256 * 1024) fs.writeFileSync(p, '');
    } catch { /* first run / unreadable: ignore */ }
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* never let diagnostics break the hook */ }
}

/**
 * True when a patch input is NEWER than the patch state file.
 *
 * dictionary.json and bin/zcode-zh.mjs (which carries the injected renderer
 * helper) are compiled into app.asar at patch time, so editing either one does
 * NOT change the running build until a forced re-patch. Comparing mtimes is a
 * pure fs check — no process spawn, safe inside the hook's 3 s budget.
 */
function inputsNewerThanState(asar) {
  const inputs = [
    path.join(PLUGIN_ROOT, 'dictionary.json'),
    path.join(PLUGIN_ROOT, 'bin', 'zcode-zh.mjs'),
  ];
  let newest = 0;
  for (const f of inputs) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      /* missing input never counts as newer */
    }
  }
  try {
    return newest > fs.statSync(asar + '.zcode-zh.json').mtimeMs;
  } catch {
    return false;
  }
}

function asarSig(asar) {
  try {
    const s = fs.statSync(asar);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

function workerAlive() {
  const j = readJson(LOCK_PID_FILE);
  if (!j || typeof j.pid !== 'number') return false;
  try {
    process.kill(j.pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

/**
 * Arm self-heal. Fast (~200 ms): schedule spawns detached and exits.
 *
 * `sentinel` arms the RESIDENT worker (scripts/self-heal.mjs sentinel) which
 * outlives ZCode and re-patches the moment electron-updater swaps app.asar --
 * that is what makes an update self-healing without the user closing ZCode at
 * the right moment.
 */
function armSelfHeal(reason, sentinel) {
  const args = [SELF_HEAL, 'schedule', '--reason', reason];
  if (sentinel) args.push('--sentinel');
  try {
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const ok = r.status === 0 && fs.existsSync(REQUEST_FILE);
    diag(
      `armSelfHeal(${reason}${sentinel ? ', sentinel' : ''}) status=${r.status} ` +
        `signal=${r.signal || ''} request=${fs.existsSync(REQUEST_FILE)} ok=${ok} ` +
        `out=${String(r.stdout || '').replace(/\s+/g, ' ').slice(0, 200)}`,
    );
    return ok;
  } catch (e) {
    diag(`armSelfHeal(${reason}) THREW ${(e && e.message) || e}`);
    return false;
  }
}

let note;
let found = false;
for (const asar of candidates()) {
  if (!fs.existsSync(asar)) continue;
  found = true;
  const st = stateFor(asar);
  // Cheap staleness probe: a ZCode update replaces app.asar, so the archive becomes
  // newer than the state file we wrote after patching. stat() only -- never scan the
  // archive from a hook.
  let replaced = false;
  try {
    replaced = fs.statSync(asar).mtimeMs > fs.statSync(asar + '.zcode-zh.json').mtimeMs;
  } catch {
    /* no state file; handled below */
  }

  const result = readJson(RESULT_FILE);

  const staleInputs = !!(st && st.patched && st.marker === CURRENT_MARKER && !replaced && inputsNewerThanState(asar));
  diag(
    `SessionStart source=${input.source || input.hook_event_name || '?'} asar=${asar} ` +
      `st=${st ? 'ok' : 'NONE'} patched=${st ? !!st.patched : '?'} marker=${st ? st.marker : '-'} ` +
      `replaced=${replaced} staleInputs=${staleInputs} worker=${workerAlive()}`,
  );

  if (st && st.patched && st.marker === CURRENT_MARKER && !replaced) {
    const stale = inputsNewerThanState(asar);
    // ALWAYS keep a resident sentinel armed -- not just when something looks stale.
    // electron-updater replaces app.asar while ZCode is closed and then relaunches
    // the app itself; only a worker that is already alive at that moment can
    // re-patch in time, so the relaunched app comes up translated with no user
    // action. schedule() is idempotent, so this costs ~200 ms per session.
    //
    // NOTE: no `workerAlive() ||` short-circuit here. That guard looked like a
    // cheap optimisation but it reintroduced the very bug we are fixing: a worker
    // that is alive-but-doomed suppressed every future arm attempt, so the refresh
    // silently never happened.
    const armed = armSelfHeal(stale ? 'dictionary' : 'sentinel', true);
    if (stale) {
      diag(`stale dictionary/patcher -> armSelfHeal('dictionary', sentinel) -> armed=${armed}`);
      note = armed
        ? 'zcode-bilingual: 插件（词典/补丁器）已更新，自动刷新已待命——完全退出 ZCode（含托盘图标）后' +
          '会自动重新打补丁并重新打开 ZCode，无需手动操作。' +
          'The plugin (dictionary/patcher) changed; a refresh is armed: fully quit ZCode and it will' +
          ' re-patch and relaunch itself.'
        : 'zcode-bilingual: 插件已更新，但自动刷新未能启动。完全退出 ZCode 后运行插件目录下的 repair.cmd。' +
          'The plugin changed but the refresh could not be armed; quit ZCode fully, then run repair.cmd.';
    } else {
      note =
        'zcode-bilingual: 界面悬停翻译已启用（英文界面悬停出中文，中文界面悬停出英文）。' +
        'Hover-to-translate is active.';
      if (result && result.ok && result.autoHeal && result.at) {
        const ageMs = Date.now() - Date.parse(result.at);
        if (Number.isFinite(ageMs) && ageMs < 3 * 24 * 3600 * 1000) {
          note +=
            `（上次 ZCode 更新已于 ${new Date(result.at).toLocaleString()} 自动修复，无需手动操作。` +
            ' The last ZCode update was re-patched automatically.）';
        }
      }
    }
  } else if (st && st.patched && !replaced) {
    note =
      `zcode-bilingual: 已打的是旧版补丁（${st.marker || 'unknown'}），不是当前版本。` +
      '完全退出 ZCode 后重新运行 install.cmd / apply.cmd 即可升级。' +
      `An older patch (${st.marker || 'unknown'}) is applied; re-run install.cmd to upgrade.`;
  } else if (st && st.patched && replaced) {
    // A ZCode update wiped an active patch -> arm self-heal instead of only telling.
    const cfg = readJson(CONFIG_FILE) || {};
    const sig = asarSig(asar);
    const blocked = result && !result.ok && (result.failCount || 0) >= 2 && result.asarSig === sig;
    if (cfg.autoHeal === false) {
      note =
        'zcode-bilingual: ZCode 已更新，界面补丁已被覆盖失效；自动修复已在配置中禁用。' +
        '完全退出 ZCode 后运行 install.cmd / apply.cmd，或运行 /zcode-bilingual:repair。' +
        'ZCode was updated and the patch is gone; auto-heal is disabled in self-heal-config.json.';
    } else if (blocked) {
      note =
        'zcode-bilingual: ZCode 已更新导致补丁失效，且自动修复在此版本上已连续失败两次' +
        '（当前版本可能不兼容）。请运行 /zcode-bilingual:status 查看，或检查 ' +
        '%LOCALAPPDATA%\\zcode-bilingual\\self-heal.log。' +
        'Auto-heal failed twice on this build; not retrying automatically.';
    } else {
      const armed = workerAlive() || armSelfHeal('update');
      if (armed) {
        note =
          'zcode-bilingual: 检测到 ZCode 已更新，界面翻译暂时失效。自动修复已待命——' +
          '当你完全退出 ZCode（含托盘图标）后，会自动重新打补丁并重新打开 ZCode，无需手动操作。' +
          'ZCode was updated and the UI translation is temporarily gone. Self-heal is armed: ' +
          'fully quit ZCode and it will re-patch and relaunch automatically.';
      } else {
        note =
          'zcode-bilingual: ZCode 已更新，界面补丁已被覆盖失效，且自动修复启动失败。' +
          '请完全退出 ZCode 后重新运行 install.cmd / apply.cmd。' +
          'Self-heal could not be armed; quit ZCode fully and re-run install.cmd / apply.cmd.';
      }
    }
  } else if (st) {
    // patched:false state — the user restored on purpose (or never applied). A restore
    // is an explicit opt-out, so we never auto-arm here, only inform.
    note =
      'zcode-bilingual: 中英字幕当前未启用。需完全退出 ZCode 后运行插件目录下的 install.cmd / apply.cmd，' +
      '或直接运行 /zcode-bilingual:repair 安排自动修复。' +
      'Subtitles are currently OFF; quit ZCode fully, then run install.cmd / apply.cmd, or use /zcode-bilingual:repair.';
  } else {
    note =
      'zcode-bilingual: 未检测到补丁状态文件（可能尚未启用，或 ZCode 运行中无法写入）。' +
      'No patch state file found; the patch is likely not applied yet.';
  }
  break;
}
if (!found) {
  note = 'zcode-bilingual: 未找到 ZCode 安装，跳过字幕状态检查。No ZCode install found.';
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: note },
  }),
);
