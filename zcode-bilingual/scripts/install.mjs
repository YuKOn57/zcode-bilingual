#!/usr/bin/env node
/**
 * Register / unregister the zcode-bilingual plugin with ZCode (user scope).
 *
 *   node scripts/install.mjs install
 *   node scripts/install.mjs uninstall
 *
 * ZCode supports "inline" plugin directories: a path listed in
 * ~/.zcode/cli/config.json under `plugins.dirs` is discovered directly and gets
 * the plugin id `<name>@inline`. This is the documented-safe equivalent of a
 * marketplace install, and needs no file copying or marketplace registry.
 *
 * Only `~/.zcode/cli/config.json` is touched, and it is backed up first to
 * config.json.zcode-zh.bak.
 *
 * v0.4.0: registration is keyed on the PLUGIN NAME, not on this directory's path.
 * That way an uninstall removes every stale entry pointing at any other copy of
 * the plugin (e.g. a hand-registered source checkout), and installing never
 * leaves two zcode-bilingual dirs registered at once.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'zcode-bilingual';
const PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const BACKUP = '.zcode-zh.bak';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

function cliRoot() {
  return process.env.ZCODE_CLI_HOME || process.env.ZCODE_STORAGE_DIR || path.join(os.homedir(), '.zcode', 'cli');
}

const configFile = () => path.join(cliRoot(), 'config.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function backupOnce(file) {
  if (!fs.existsSync(file)) return null;
  const bak = file + BACKUP;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const normPath = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const samePath = (a, b) => normPath(a) === normPath(b);

/** Plugin name declared by a plugin directory (falls back to the folder name). */
function pluginNameOf(dir) {
  for (const mf of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    const p = path.join(dir, mf);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.name) return j.name;
    } catch {
      /* fall through */
    }
  }
  return path.basename(dir);
}

const isThisPlugin = (dir) => typeof dir === 'string' && pluginNameOf(dir) === PLUGIN_NAME;

function install() {
  const file = configFile();
  const config = readJson(file, {});
  if (typeof config !== 'object' || config === null) throw new Error('config.json is not an object; aborting');
  if (typeof config.plugins !== 'object' || config.plugins === null) config.plugins = {};
  if (!Array.isArray(config.plugins.dirs)) config.plugins.dirs = [];
  if (typeof config.plugins.enabledPlugins !== 'object' || config.plugins.enabledPlugins === null) {
    config.plugins.enabledPlugins = {};
  }

  backupOnce(file);

  // Drop any other registered copy of this plugin so it is not loaded twice.
  const stale = config.plugins.dirs.filter((d) => isThisPlugin(d) && !samePath(d, pluginRoot));
  config.plugins.dirs = config.plugins.dirs.filter((d) => !isThisPlugin(d));
  config.plugins.dirs.push(pluginRoot);

  for (const k of Object.keys(config.plugins.enabledPlugins)) {
    if (k.startsWith(PLUGIN_NAME + '@') && k !== PLUGIN_ID) delete config.plugins.enabledPlugins[k];
  }
  config.plugins.enabledPlugins[PLUGIN_ID] = true;

  writeJson(file, config);
  console.log(`Registered inline plugin dir: ${pluginRoot}`);
  console.log(`Enabled plugin id:          ${PLUGIN_ID}`);
  if (stale.length) {
    console.log(`Replaced stale registration(s):`);
    for (const s of stale) console.log(`  - ${s}`);
  }
  console.log(`Config written:             ${file}`);
  if (fs.existsSync(file + BACKUP)) console.log(`Backup:                     ${file + BACKUP}`);
  console.log('\nRestart ZCode for the plugin to load. Then apply the UI patch (ZCode must be quit):');
  console.log(`  node "${path.join(pluginRoot, 'bin', 'zcode-zh.mjs')}" apply --force`);
}

function uninstall() {
  const file = configFile();
  const config = readJson(file, null);
  if (!config || typeof config !== 'object') {
    console.log('No config.json found; nothing to uninstall.');
    return;
  }
  const plugins = config.plugins || {};
  const removedDirs = [];
  let changed = false;

  if (Array.isArray(plugins.dirs)) {
    const before = plugins.dirs.length;
    const kept = [];
    for (const d of plugins.dirs) {
      if (isThisPlugin(d)) { removedDirs.push(d); continue; }
      kept.push(d);
    }
    plugins.dirs = kept;
    if (plugins.dirs.length !== before) changed = true;
  }
  if (plugins.enabledPlugins) {
    for (const k of Object.keys(plugins.enabledPlugins)) {
      if (k.startsWith(PLUGIN_NAME + '@')) { delete plugins.enabledPlugins[k]; changed = true; }
    }
  }

  if (!changed) {
    console.log('Plugin was not registered; nothing to remove.');
    return;
  }
  backupOnce(file);
  writeJson(file, config);
  console.log(`Unregistered from ${file}`);
  for (const d of removedDirs) console.log(`  - ${d}`);
  console.log('\nRestore the original English-only UI with:');
  console.log(`  node "${path.join(pluginRoot, 'bin', 'zcode-zh.mjs')}" restore`);
}

const cmd = process.argv[2] || 'install';
try {
  if (cmd === 'install') install();
  else if (cmd === 'uninstall') uninstall();
  else {
    console.error(`Unknown command: ${cmd} (use install | uninstall)`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(String((err && err.stack) || err));
  process.exitCode = 1;
}
