#!/usr/bin/env node
/**
 * Double-click friendly driver for the zcode-bilingual plugin (Windows .cmd
 * wrappers call this). Keeping the logic here instead of in .cmd avoids
 * cmd.exe parsing pitfalls and gives clear bilingual messages.
 *
 *   node scripts/run.mjs install     # register plugin + apply patch + launch ZCode
 *   node scripts/run.mjs apply       # apply patch only
 *   node scripts/run.mjs repair      # arm self-heal: patch + relaunch after ZCode is quit
 *   node scripts/run.mjs restore     # restore original app.asar
 *   node scripts/run.mjs status      # show status (works while ZCode runs)
 *   node scripts/run.mjs uninstall   # restore + unregister plugin + remove self-heal/watchdog
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const patcher = path.join(pluginRoot, 'bin', 'zcode-zh.mjs');
const installer = path.join(pluginRoot, 'scripts', 'install.mjs');
const selfHeal = path.join(pluginRoot, 'scripts', 'self-heal.mjs');

const mode = process.argv[2] || 'status';

function isZCodeRunning() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/fi', 'imagename eq ZCode.exe'], { encoding: 'utf8', windowsHide: true });
      return /zcode\.exe/i.test((r.stdout || '') + (r.stderr || ''));
    }
    const r = spawnSync('pgrep', ['-x', 'ZCode'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 && /\d/.test(r.stdout || '');
  } catch {
    return false;
  }
}

function zcodeExe() {
  const cands = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    cands.push(path.join(local, 'Programs', 'ZCode', 'ZCode.exe'));
    cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'ZCode.exe'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/ZCode.app');
  }
  return cands.find((p) => fs.existsSync(p)) || null;
}

function runNode(script, args = []) {
  console.log('');
  // stdio:'inherit' is deliberate: this runs from a user-double-clicked .cmd and the
  // child's bilingual messages must land in that already-visible console.
  // Do NOT add windowsHide here — it would not help and invites confusion.
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  return r.status === 0 ? 0 : r.status || 1;
}

function requireClosed() {
  if (isZCodeRunning()) {
    console.log('');
    console.log('  [!] ZCode 正在运行，app.asar 被占用，无法写入。');
    console.log('  [!] ZCode is running, so app.asar is locked.');
    console.log('');
    console.log('  请完全退出 ZCode（包括右下角托盘 / 菜单栏图标），然后重新双击本文件。');
    console.log('  Please fully quit ZCode (including the tray / menu-bar icon), then run this again.');
    console.log('');
    return false;
  }
  return true;
}

function launchZCode() {
  const exe = zcodeExe();
  if (!exe) {
    console.log('  请手动启动 ZCode。/ Please start ZCode manually.');
    return;
  }
  console.log(`  正在启动 ZCode... / Starting ZCode: ${exe}`);
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    console.log('  自动启动失败，请手动启动。/ Auto-launch failed, start it manually.');
  }
}

let code = 0;
switch (mode) {
  case 'status':
    code = runNode(patcher, ['status']);
    break;

  case 'apply':
    if (!requireClosed()) { code = 1; break; }
    code = runNode(patcher, ['apply']);
    if (code === 0) launchZCode();
    break;

  case 'repair':
    // Works while ZCode is running: arms the resident sentinel, which patches and
    // relaunches as soon as ZCode is fully quit -- and stays armed to catch the
    // next ZCode update too. No manual re-run needed.
    console.log('');
    console.log('  安排自动修复... / Arming self-heal...');
    code = runNode(selfHeal, ['schedule', '--reason', 'manual', '--sentinel']);
    if (code === 0) {
      console.log('');
      console.log('  已安排。现在起完全退出 ZCode（含托盘图标）后，会自动打补丁并重新打开 ZCode。');
      console.log('  Armed. Fully quit ZCode (incl. tray icon); it will re-patch and relaunch itself.');
    }
    break;

  case 'restore':
    runNode(selfHeal, ['cancel']); // never let a pending heal undo an explicit restore
    if (!requireClosed()) { code = 1; break; }
    code = runNode(patcher, ['restore']);
    break;

  case 'install': {
    if (!requireClosed()) { code = 1; break; }
    console.log('=== 1/2 注册插件 / Registering plugin ===');
    code = runNode(installer, ['install']);
    if (code !== 0) break;
    console.log('');
    console.log('=== 2/2 应用界面补丁 / Applying UI patch ===');
    code = runNode(patcher, ['apply']);
    if (code === 0) {
      // Logon backstop: re-arms self-heal even if the SessionStart hook never fires.
      runNode(selfHeal, ['arm-watchdog']);
      console.log('');
      console.log('完成。 / Done.');
      launchZCode();
    }
    break;
  }

  case 'uninstall': {
    runNode(selfHeal, ['cancel']); // stop any pending self-heal first
    runNode(selfHeal, ['unwatch']); // remove the logon watchdog
    if (!requireClosed()) { code = 1; break; }
    console.log('=== 1/2 还原界面 / Restoring original UI ===');
    code = runNode(patcher, ['restore']);
    console.log('');
    console.log('=== 2/2 注销插件 / Unregistering plugin ===');
    const c2 = runNode(installer, ['uninstall']);
    if (code === 0) code = c2;
    break;
  }

  default:
    console.log(`未知操作 / Unknown mode: ${mode}`);
    code = 2;
}

process.exitCode = code;
