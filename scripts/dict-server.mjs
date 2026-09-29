#!/usr/bin/env node
/**
 * dict-server — the live layer of zcode-bilingual (v0.5.0).
 *
 * Why this exists
 * ---------------
 * The asar patch bakes the dictionary at patch time and matches EXACTLY, so any
 * text that appears later -- a freshly installed plugin, a new marketplace card,
 * a new settings surface -- has no tooltip at all. This service turns the patch
 * into a real hover translator:
 *
 *   GET /ping                 handshake + liveness        -> { svc, live, learned, up }
 *   GET /dict                 HOT dictionary              -> base (bin/zcode-zh.mjs buildDictionary)
 *                                                            merged with everything LEARNED so far
 *   GET /translate?q=<text>   on-demand translation       -> { t }  (LLM backend, cached forever)
 *
 * The renderer helper (baked by bin/zcode-zh.mjs) discovers the port by probing
 * 127.0.0.1:17981-17985, refreshes /dict every 5 minutes, and fires /translate
 * only when the user actually hovers a string no offline source covered.
 *
 * Harvest: at startup (and every 10 min) the service scans the installed plugin
 * manifests (plugin.json + skills/commands/agents frontmatter across the plugin
 * cache, marketplaces, plugins.dirs and ~/.zcode/agents) and quietly translates
 * the strings that are still unknown, a small batch at a time, ONLY while the
 * user is not hovering anything. New plugin text therefore translates instantly
 * (from the hot dictionary) a few minutes after install -- without waiting for
 * a re-patch. Every answer lands in learned.json, which the patcher also bakes
 * into app.asar on the next re-patch, so the knowledge survives offline.
 *
 * Lifecycle (mirrors the wb2api gateway policy on this machine): spawned
 * detached by the hooks; exits when ZCode has been gone for 3 minutes, after
 * 2h without any request, or after 24h; the hooks revive it on the next session.
 *
 * Config: %LOCALAPPDATA%\zcode-bilingual\live-config.json
 *   { "disabled": false, "port": 17981, "translateDisabled": false,
 *     "model": "deepseek-v4.1-flash",                       // model knob, see below
 *     "backend": { "baseURL": "http://127.0.0.1:7863", "apiKey": "...", "model": "..." } }
 * Without a backend block the service auto-detects the local wb2api gateway
 * (~/.dsh/wb2api/config.json); with no backend at all it still serves /dict
 * (hot dictionary) but cannot translate misses.
 *
 * The translation model is never fixed: pick it by hand in live-config.json —
 * top-level "model" (or "backend.model" for a custom backend) — save the file
 * and the choice is live for the next translation, no restart needed (/translate
 * re-reads the config every request and /ping reports whatever is current).
 * Delete the key to go back to "no preference" (gateway config, then fallback).
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SELF), '..');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_DIR = process.env.ZCB_DATA_DIR || path.join(LOCAL, 'zcode-bilingual');
const LEARNED_FILE = path.join(DATA_DIR, 'learned.json');
const LOG_FILE = path.join(DATA_DIR, 'dict-server.log');
const CONFIG_FILE = path.join(DATA_DIR, 'live-config.json');
const PID_FILE = path.join(DATA_DIR, 'live-server.pid');
const INFO_FILE = path.join(DATA_DIR, 'live-server.json');
const HARVEST_STATE_FILE = path.join(DATA_DIR, 'harvest-state.json');

const PORT_BASE = Number(process.env.ZCB_LIVE_PORT) || 17981;
const PORTS = [PORT_BASE, PORT_BASE + 1, PORT_BASE + 2, PORT_BASE + 3, PORT_BASE + 4];
const LEARNED_CAP = 5000;
const MAX_Q_LEN = 600;
const RATE_LIMIT_PER_MIN = 30;
const HARVEST_BATCH = 12;
const HARVEST_IDLE_MS = 10 * 1000; // pause harvesting shortly after any hover request
const LLM_TIMEOUT_MS = 60 * 1000;

const EXE_NAME = process.env.ZCB_EXE_NAME || (process.platform === 'win32' ? 'ZCode.exe' : 'ZCode');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const normalizeKey = (s) => String(s).replace(/\s+/g, ' ').trim();
const hasCJK = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s);
const iso = () => new Date().toISOString();

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* best effort */ }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function logLine(msg) {
  try {
    ensureDataDir();
    try { if (fs.statSync(LOG_FILE).size > 128 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch { /* first run */ }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* logging must never kill the server */ }
}

function safeReaddir(d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

// ---------------------------------------------------------------------------
// config + LLM backend
// ---------------------------------------------------------------------------

function loadConfig() {
  const defaults = { disabled: false, translateDisabled: false, port: PORT_BASE, backend: null, modelHistory: [] };
  const j = readJson(CONFIG_FILE);
  if (!j || typeof j !== 'object') return defaults;
  return { ...defaults, ...j };
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch { /* best effort: a failed write surfaces as a 400-free no-op */ }
}

/** LRU-ish history of models the picker has used (dedup, newest first). */
export function pushModelHistory(list, id, cap = 12) {
  const out = (Array.isArray(list) ? list : []).filter((x) => String(x || '') !== id);
  out.unshift(id);
  return out.slice(0, cap);
}

/**
 * Apply a picker POST to live-config.json. Accepts {model:"<id>"} or
 * {default:true} (remove the knob). Returns { ok, model, where } where `where`
 * is 'backend.model' | 'model' | 'removed' — the same priority the resolver
 * uses, so what the picker writes is always what the resolver reads.
 */
export function applyModelChoice(post) {
  if (!post || typeof post !== 'object') return { ok: false, error: 'bad body' };
  const cfg = loadConfig();
  if (post.default) {
    delete cfg.model;
    if (cfg.backend && typeof cfg.backend === 'object') delete cfg.backend.model;
    writeConfig(cfg);
    return { ok: true, model: null, where: 'removed' };
  }
  const id = String(post.model || '').trim();
  if (!/^[A-Za-z0-9._:@/-]{1,120}$/.test(id)) return { ok: false, error: 'bad model id' };
  let where;
  if (cfg.backend && typeof cfg.backend === 'object' && cfg.backend.baseURL) { cfg.backend.model = id; where = 'backend.model'; }
  else { cfg.model = id; where = 'model'; }
  cfg.modelHistory = pushModelHistory(cfg.modelHistory, id);
  writeConfig(cfg);
  return { ok: true, model: id, where };
}

/** Static suggestions shown when gateway/history have nothing (known-good IDs on
 *  this machine's wb2api pool; NOT authoritative — the gateway list and the
 *  picker's free-text input cover everything else). */
const SUGGESTED_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3-2-volc', 'glm-5.3-flash'];

/** Dedup'd picker list: current first, then recently used, gateway catalog, suggestions. */
export function modelsCatalog(cfg, backend, gatewayList) {
  const out = [];
  const seen = new Set();
  const push = (id, source) => {
    const s = String(id || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push({ id: s, source });
  };
  if (backend) push(backend.model, 'current');
  for (const h of cfg.modelHistory || []) push(h, 'history');
  for (const g of gatewayList || []) push(g, 'gateway');
  for (const s of SUGGESTED_MODELS) push(s, 'suggestion');
  return out;
}

/** Probe the backend's /v1/models for a picker catalog (10 min cache, fail-silent:
 *  several gateways answer with an empty list — the suggestions/history cover that). */
let GW_CACHE = { at: 0, list: [] };
async function gatewayModels(backend) {
  if (!backend || !backend.baseURL) return [];
  if (Date.now() - GW_CACHE.at < 600000) return GW_CACHE.list;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${backend.baseURL}/v1/models`, { headers: { Authorization: `Bearer ${backend.apiKey}` }, signal: ctl.signal });
    clearTimeout(t);
    const j = res.ok ? await res.json() : null;
    const list = j && Array.isArray(j.data) ? j.data.map((m) => (m && m.id) || '').filter(Boolean) : [];
    GW_CACHE = { at: Date.now(), list };
    return list;
  } catch {
    GW_CACHE = { at: Date.now(), list: [] };
    return [];
  }
}

/**
 * Backend resolution order:
 *   1. live-config.json -> backend
 *   2. auto-detect the local wb2api gateway (~/.dsh/wb2api/config.json:
 *      listen "127.0.0.1:7863" + api_key, OpenAI-compatible)
 * null -> translation disabled; the hot dictionary still works.
 *
 * `wbOverride` replaces the gateway config file (tests pass a fake object, or
 * null to simulate "no gateway"); production callers omit it.
 *
 * Model choice order (applies to whichever backend wins):
 *   1. live-config.json -> backend.model      (explicit, custom backend)
 *   2. live-config.json -> model              (simple knob over the auto-detected gateway)
 *   3. wb2api config -> model / defaultModel  (if the gateway config ever carries one)
 *   4. built-in fallback "deepseek-v4.1-flash" (known-good on this machine's gateway)
 * The chosen model rides along as `model`, with its origin in `modelSource`.
 */
export function modelChoice(cfg, wb, customBackend) {
  if (customBackend && cfg.backend && cfg.backend.model) return { model: String(cfg.backend.model), source: 'live-config.json backend.model' };
  if (cfg.model) return { model: String(cfg.model), source: 'live-config.json model' };
  if (wb && (wb.model || wb.defaultModel)) return { model: String(wb.model || wb.defaultModel), source: 'wb2api config' };
  return { model: 'deepseek-v4.1-flash', source: 'built-in default' };
}

export function resolveBackend(cfg, wbOverride) {
  if (cfg.translateDisabled) return null;
  if (cfg.backend && cfg.backend.baseURL && cfg.backend.apiKey) {
    const m = modelChoice(cfg, null, true);
    return {
      baseURL: String(cfg.backend.baseURL).replace(/\/+$/, ''),
      apiKey: String(cfg.backend.apiKey),
      model: m.model,
      modelSource: m.source,
      source: 'live-config.json',
    };
  }
  let wb = wbOverride;
  if (wb === undefined) wb = readJson(path.join(os.homedir(), '.dsh', 'wb2api', 'config.json'));
  try {
    if (wb && wb.listen && wb.api_key) {
      const host = String(wb.listen).startsWith('0.0.0.0') ? '127.0.0.1' : String(wb.listen).split(':')[0] || '127.0.0.1';
      const port = String(wb.listen).split(':')[1] || '7863';
      const key = Array.isArray(wb.api_key) ? wb.api_key[0] : wb.api_key;
      if (key) {
        const m = modelChoice(cfg, wb, false);
        return { baseURL: `http://${host}:${port}`, apiKey: String(key), model: m.model, modelSource: m.source, source: 'wb2api' };
      }
    }
  } catch { /* no gateway: fall through */ }
  return null;
}

/** One chat call. Injectable fetch keeps this testable. */
async function chatWith(impl, backend, messages, timeoutMs = LLM_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await impl(`${backend.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${backend.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: backend.model, messages }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const j = await res.json();
    const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return typeof txt === 'string' ? txt : '';
  } finally {
    clearTimeout(timer);
  }
}

/** Build the chat message(s) for a translation request. Exported for tests. */
export function translationPrompt(items) {
  const target = hasCJK(items.join(' ')) ? 'English' : 'Simplified Chinese';
  if (items.length === 1) {
    return {
      role: 'user',
      content:
        `Translate this desktop-app UI string into concise ${target}. ` +
        'Keep {placeholders}, URLs, file paths, code identifiers and file extensions unchanged. ' +
        'Reply with ONLY the translation, no quotes, no explanation:\n\n' + items[0],
    };
  }
  return {
    role: 'user',
    content:
      `Translate each of these desktop-app UI strings into concise ${target}. ` +
      'Keep {placeholders}, URLs, file paths, code identifiers and file extensions unchanged. ' +
      'Reply with ONLY a JSON object mapping each original string to its translation; no markdown fences:\n\n' +
      JSON.stringify(items),
  };
}

/** Translate a batch of strings. Returns Map(original -> translation). Exported for tests. */
export async function translateBatchWith(impl, backend, items) {
  const out = new Map();
  if (!items.length) return out;
  const txt = await chatWith(impl, backend, [
    { role: 'system', content: 'You are a translation engine for desktop app UI text. Output only what was asked for.' },
    translationPrompt(items),
  ]);
  if (items.length === 1) {
    const t = txt.trim().replace(/^["']+|["']+$/g, '');
    if (t) out.set(items[0], t);
    return out;
  }
  const a = txt.indexOf('{');
  const b = txt.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(txt.slice(a, b + 1));
      for (const item of items) {
        const t = obj[item];
        if (typeof t === 'string' && t.trim()) out.set(item, t.trim());
      }
    } catch { /* batch parse failed; caller retries later */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// learned cache (persistent, shared with the patcher via buildDictionary)
// ---------------------------------------------------------------------------

let learned = {};          // key -> { t, at }
let learnedDirty = false;
let learnedSaveTimer = null;

function loadLearned() {
  const j = readJson(LEARNED_FILE);
  learned = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  // drop malformed rows
  for (const k of Object.keys(learned)) {
    const v = learned[k];
    if (!v || typeof v !== 'object' || typeof v.t !== 'string' || !v.t) delete learned[k];
  }
}
export { loadLearned };

function learnedView() {
  const out = {};
  for (const [k, v] of Object.entries(learned)) out[normalizeKey(k)] = v.t;
  return out;
}

function learn(key, t) {
  const k = normalizeKey(key);
  if (!k || !t) return;
  learned[k] = { t, at: iso() };
  learnedDirty = true;
  scheduleLearnedSave();
}

function scheduleLearnedSave() {
  if (learnedSaveTimer) return;
  learnedSaveTimer = setTimeout(() => {
    learnedSaveTimer = null;
    saveLearned();
  }, 2000);
}

function saveLearned() {
  try {
    ensureDataDir();
    const keys = Object.keys(learned);
    if (keys.length > LEARNED_CAP) {
      keys.sort((a, b) => String(learned[a].at || '').localeCompare(String(learned[b].at || '')));
      for (const k of keys.slice(0, keys.length - LEARNED_CAP)) delete learned[k];
    }
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(learned, null, 1), 'utf8');
    learnedDirty = false;
  } catch (e) {
    logLine(`saveLearned failed: ${(e && e.message) || e}`);
  }
}

// ---------------------------------------------------------------------------
// manifest harvest -- collect UI-visible strings from installed plugins
// ---------------------------------------------------------------------------

/** YAML frontmatter `name`/`description` from a SKILL/agent/command markdown. */
export function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  let cur = null;
  const buf = [];
  const flush = () => {
    if (!cur) return;
    const v = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (v) out[cur] = v;
    cur = null;
    buf.length = 0;
  };
  for (const ln of lines) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(ln);
    if (kv) {
      flush();
      if (/^[>|][+-]?\s*$/.test(kv[2])) { cur = kv[1]; continue; }
      out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    } else if (cur && (ln.startsWith(' ') || ln.startsWith('\t'))) {
      buf.push(ln.trim());
    }
  }
  flush();
  return out;
}

/**
 * Every UI-visible string a plugin tree can show in ZCode:
 * plugin.json name/description, skill/agent name+description, command
 * description. Established exclusions (author, argument-hint, ids) and
 * already-bilingual strings (they contain CJK -> the inline path covers them).
 */
export function collectStringsFromPluginDir(pluginDir, out) {
  let manifest = null;
  for (const mf of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
    const p = path.join(pluginDir, mf);
    try {
      if (fs.statSync(p).isFile()) { manifest = readJson(p); break; }
    } catch { /* try next */ }
  }
  if (manifest) {
    if (typeof manifest.name === 'string') out.add(normalizeKey(manifest.name));
    if (typeof manifest.description === 'string') out.add(normalizeKey(manifest.description));
  }
  for (const sub of ['skills', 'agents', 'commands']) {
    const dir = path.join(pluginDir, sub);
    let entries = [];
    try { entries = fs.readdirSync(dir, { recursive: true }); } catch { continue; }
    for (const rel of entries) {
      if (!/\.md$/i.test(String(rel))) continue;
      if (sub === 'skills' && !/SKILL\.md$/i.test(String(rel))) continue;
      const f = path.join(dir, String(rel));
      try {
        if (!fs.statSync(f).isFile()) continue;
        const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
        if (!fm.description) continue;
        out.add(normalizeKey(fm.description));
        if (sub !== 'commands' && typeof fm.name === 'string') out.add(normalizeKey(fm.name));
      } catch { /* tolerate one bad file */ }
    }
  }
}

/** All roots that can carry plugin manifests on this machine. */
export function manifestRoots() {
  const home = os.homedir();
  const roots = [];
  const mk = path.join(home, '.zcode', 'cli', 'plugins', 'marketplaces');
  for (const m of safeReaddir(mk)) {
    const dir = path.join(mk, m);
    roots.push({ kind: 'marketplace', dir });
    const plugins = path.join(dir, 'plugins');
    for (const p of safeReaddir(plugins)) {
      const pd = path.join(plugins, p);
      try { if (fs.statSync(pd).isDirectory()) roots.push({ kind: 'plugin', dir: pd }); } catch { /* gone */ }
    }
  }
  const cache = path.join(home, '.zcode', 'cli', 'plugins', 'cache');
  for (const m of safeReaddir(cache)) {
    const mdir = path.join(cache, m);
    for (const p of safeReaddir(mdir)) {
      const pdir = path.join(mdir, p);
      for (const v of safeReaddir(pdir)) {
        const vdir = path.join(pdir, v);
        try { if (fs.statSync(vdir).isDirectory()) roots.push({ kind: 'plugin', dir: vdir }); } catch { /* gone */ }
      }
    }
  }
  for (const a of safeReaddir(path.join(home, '.zcode', 'agents'))) {
    if (/\.md$/i.test(a)) roots.push({ kind: 'user-agent', dir: path.join(home, '.zcode', 'agents', a) });
  }
  try {
    const cfg = readJson(path.join(home, '.zcode', 'cli', 'config.json'));
    for (const d of (cfg && cfg.plugins && cfg.plugins.dirs) || []) {
      roots.push({ kind: 'plugin', dir: String(d) });
    }
  } catch { /* no config */ }
  return roots;
}

/**
 * Keep only translatable single-language strings: EN-only (-> hover shows zh)
 * or ZH-only (-> hover shows en, matching the Chinese-UI direction). Mixed
 * bilingual rows are skipped -- the helper's inline-extraction path already
 * translates those without any lookup.
 */
export function filterTranslatable(strings) {
  const filtered = new Set();
  for (const s of strings) {
    const str = normalizeKey(s);
    if (!str || str.length < 2 || str.length > MAX_Q_LEN) continue;
    const en = /[A-Za-z]/.test(str);
    const zh = hasCJK(str);
    if (!en && !zh) continue;
    if (en && zh) continue;
    filtered.add(str);
  }
  return filtered;
}

/**
 * Collect every candidate UI string from all manifest roots. Returns a Set of
 * raw strings; run filterTranslatable() over the result before harvesting.
 */
export function collectManifestStrings() {
  const out = new Set();
  for (const root of manifestRoots()) {
    try {
      if (root.kind === 'user-agent') {
        const fm = parseFrontmatter(fs.readFileSync(root.dir, 'utf8'));
        if (fm.description) out.add(normalizeKey(fm.description));
        if (fm.name) out.add(normalizeKey(fm.name));
        continue;
      }
      if (root.kind === 'marketplace') {
        const mj = readJson(path.join(root.dir, 'marketplace.json'));
        if (mj && Array.isArray(mj.plugins)) {
          for (const p of mj.plugins) {
            if (typeof p.name === 'string') out.add(normalizeKey(p.name));
            if (typeof p.description === 'string') out.add(normalizeKey(p.description));
            if (typeof p.category === 'string') out.add(normalizeKey(p.category));
          }
        }
        continue;
      }
      collectStringsFromPluginDir(root.dir, out);
    } catch { /* one bad root must not kill the harvest */ }
  }
  return filterTranslatable(out);
}

let harvestAttempts = {};
function loadHarvestState() {
  const j = readJson(HARVEST_STATE_FILE);
  harvestAttempts = j && typeof j === 'object' ? j : {};
}
function saveHarvestState() {
  try {
    ensureDataDir();
    const keys = Object.keys(harvestAttempts);
    if (keys.length > 20000) harvestAttempts = {};
    fs.writeFileSync(HARVEST_STATE_FILE, JSON.stringify(harvestAttempts), 'utf8');
  } catch { /* non-fatal */ }
}

/**
 * Background loop: every TICK_MS, if the user is not mid-hover, translate the
 * next batch of unknown manifest strings. Injectable impl/backend for tests.
 */
export function harvestTick(strings, impl, backend, state = {}) {
  if (!backend) return Promise.resolve(0);
  if (Date.now() - (state.lastRequestAt || 0) < HARVEST_IDLE_MS) return Promise.resolve(0);
  const pending = [];
  for (const s of strings) {
    const key = normalizeKey(s);
    if (learned[key] || baseKeys.has(key)) continue;
    if ((harvestAttempts[key] || 0) >= 2) continue;
    pending.push(s);
    if (pending.length >= HARVEST_BATCH) break;
  }
  if (!pending.length) return Promise.resolve(0);
  return translateBatchWith(impl, backend, pending)
    .then((res) => {
      for (const [orig, t] of res) learn(orig, t);
      if (res.size) saveLearned();
      for (const s of pending) if (!res.has(s)) harvestAttempts[normalizeKey(s)] = (harvestAttempts[normalizeKey(s)] || 0) + 1;
      saveHarvestState();
      logLine(`harvest: +${res.size}/${pending.length} strings (learned total ${Object.keys(learned).length})`);
      return res.size;
    })
    .catch((e) => {
      for (const s of pending) harvestAttempts[normalizeKey(s)] = (harvestAttempts[normalizeKey(s)] || 0) + 1;
      saveHarvestState();
      logLine(`harvest batch failed: ${(e && e.message) || e}`);
      return 0;
    });
}

// ---------------------------------------------------------------------------
// base dictionary (rebuilt periodically so new plugins / dictionary.json edits show up)
// ---------------------------------------------------------------------------

let baseDict = {};
let baseKeys = new Set();

function rebuildBase() {
  try {
    // bin/zcode-zh.mjs exports the exact merge the patcher bakes; importing the
    // module is side-effect safe (its CLI only runs when invoked directly).
    import('../bin/zcode-zh.mjs')
      .then(({ buildDictionary }) => {
        const { dict } = buildDictionary();
        baseDict = dict || {};
        baseKeys = new Set(Object.keys(baseDict).map(normalizeKey));
        logLine(`base dictionary rebuilt: ${baseKeys.size} entries`);
      })
      .catch((e) => logLine(`base rebuild failed: ${(e && e.message) || e}`));
  } catch (e) {
    logLine(`base rebuild threw: ${(e && e.message) || e}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP service
// ---------------------------------------------------------------------------

let server = null;
let startedAt = Date.now();
let lastRequestAt = Date.now(); // idle clock starts at boot; ANY request refreshes it
// (it used to start at 0, which made the first lifecycle tick -- 60s in -- kill
// every instance that had not happened to serve a /translate yet)
let rateWindow = { minute: 0, count: 0 };
let stringCache = new Set();
let stringCacheAt = 0;

function refreshStrings() {
  // time-based cache only: an empty scan result must ALSO wait out the window,
  // otherwise the 30s harvest tick rescans every plugin dir every 30s forever
  if (Date.now() - stringCacheAt < 10 * 60 * 1000) return;
  try {
    stringCache = collectManifestStrings();
    stringCacheAt = Date.now();
    logLine(`manifest strings: ${stringCache.size}`);
  } catch (e) {
    logLine(`manifest scan failed: ${(e && e.message) || e}`);
  }
}

function rateLimited() {
  const minute = Math.floor(Date.now() / 60000);
  if (rateWindow.minute !== minute) { rateWindow = { minute, count: 0 }; }
  rateWindow.count += 1;
  return rateWindow.count > RATE_LIMIT_PER_MIN;
}

function send(res, code, obj) {
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  } catch { /* client gone */ }
}

/**
 * Loopback gate. We bind 127.0.0.1, but that alone still lets ANY web page open
 * in ANY local browser reach the service (and with ACAO:* even read it): drive
 * /translate to burn LLM quota, or POST /model to tamper with the config.
 * Browsers attach an Origin header to cross-site fetches, so: requests without
 * one (curl, hooks, server-side callers) pass; the packaged app's renderer
 * (file:// -> Origin "null", or an app:// scheme) passes; every http(s) origin
 * is a foreign page -> 403. The Host check blocks DNS-rebinding on top.
 */
export function requestAllowed(headers, port) {
  const host = String((headers && headers.host) || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = headers ? headers.origin : undefined;
  if (origin === undefined || origin === null) return true;
  const o = String(origin);
  if (o === 'null') return true; // file:// renderer
  if (/^(file|app):\/\//i.test(o)) return true;
  return false;
}

/** Small JSON body reader for POST /model (capped; garbage resolves to ''). */
function readBody(req, cap = 8192) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > cap) { try { req.destroy(); } catch { /* already gone */ } resolve(''); }
    });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(''));
  });
}

function handleTranslate(req, res, q) {
  const key = normalizeKey(q);
  if (!key || key.length > MAX_Q_LEN || (!/[A-Za-z]/.test(key) && !hasCJK(key))) {
    return send(res, 400, { svc: 'zcode-bilingual', error: 'bad q' });
  }
  if (rateLimited()) return send(res, 429, { svc: 'zcode-bilingual', error: 'rate' });
  lastRequestAt = Date.now();
  const hit = learned[key] || (baseKeys.has(key) ? { t: baseDict[key] || learned[key] } : null);
  if (hit && hit.t) return send(res, 200, { svc: 'zcode-bilingual', t: hit.t });
  const backend = resolveBackend(loadConfig());
  if (!backend) return send(res, 200, { svc: 'zcode-bilingual', t: '' });
  translateBatchWith(fetch, backend, [key])
    .then((res2) => {
      const t = res2.get(key) || '';
      if (t) learn(key, t);
      send(res, 200, { svc: 'zcode-bilingual', t });
    })
    .catch((e) => {
      logLine(`translate failed: ${(e && e.message) || e}`);
      send(res, 200, { svc: 'zcode-bilingual', t: '' });
    });
}

function startServer(cfg) {
  return new Promise((resolve, reject) => {
    const tryPort = (i) => {
      if (i >= PORTS.length) return reject(new Error('all live ports in use'));
      const port = PORTS[i];
      const srv = http.createServer(async (req, res) => {
        try {
          if (!requestAllowed(req.headers, port)) return send(res, 403, { svc: 'zcode-bilingual', error: 'forbidden origin' });
          const u = new URL(req.url, `http://127.0.0.1:${port}`);
          if (req.method === 'OPTIONS') return send(res, 200, {});
          lastRequestAt = Date.now(); // helper polls /dict every 5 min -> alive while ZCode runs
          if (u.pathname === '/ping') {
            // resolve fresh so the reported model mirrors what /translate would
            // use right now — a hand-edited live-config.json shows up immediately
            const b = resolveBackend(loadConfig());
            return send(res, 200, {
              svc: 'zcode-bilingual', live: !cfg.disabled, port,
              learned: Object.keys(learned).length, base: baseKeys.size,
              model: b ? b.model : null, modelSource: b ? b.modelSource : null,
              up: Math.round((Date.now() - startedAt) / 1000),
            });
          }
          if (u.pathname === '/dict') {
            return send(res, 200, { svc: 'zcode-bilingual', live: true, at: iso(), dict: { ...baseDict, ...learnedView() } });
          }
          if (u.pathname === '/models') {
            const b = resolveBackend(loadConfig());
            let gw = [];
            try { gw = await gatewayModels(b); } catch { /* catalog is best-effort */ }
            return send(res, 200, {
              svc: 'zcode-bilingual',
              current: b ? b.model : null,
              modelSource: b ? b.modelSource : null,
              models: modelsCatalog(loadConfig(), b, gw),
            });
          }
          if (u.pathname === '/model' && req.method === 'POST') {
            const body = await readBody(req);
            let post = null;
            try { post = JSON.parse(body); } catch { /* handled below */ }
            const out = applyModelChoice(post);
            if (!out.ok) return send(res, 400, { svc: 'zcode-bilingual', ok: false, error: out.error });
            logLine(`model choice via picker: ${out.model || '(default)'} -> ${out.where}`);
            const b = resolveBackend(loadConfig());
            return send(res, 200, { svc: 'zcode-bilingual', ok: true, model: b ? b.model : null, modelSource: b ? b.modelSource : null });
          }
          if (u.pathname === '/translate') {
            return handleTranslate(req, res, u.searchParams.get('q') || '');
          }
          send(res, 404, { svc: 'zcode-bilingual', error: 'not found' });
        } catch (e) {
          send(res, 500, { svc: 'zcode-bilingual', error: String((e && e.message) || e) });
        }
      });
      srv.on('error', () => tryPort(i + 1));
      srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
    };
    tryPort(0);
  });
}

// ---------------------------------------------------------------------------
// lifecycle: exit when ZCode is gone (3 min), idle (2h), or old (24h)
// ---------------------------------------------------------------------------

function zcodeRunning() {
  if (process.env.ZCB_ASSUME_CLOSED === '1') return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      });
      return out.toLowerCase().includes(`"${EXE_NAME.toLowerCase()}"`);
    }
    execFileSync('pgrep', ['-x', EXE_NAME], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return true;
  } catch (e) {
    // pgrep exit 1 = "not found" (reliably means ZCode is gone); anything else
    // (tasklist failure etc.) is indistinguishable -> assume alive, never exit while unsure.
    if (process.platform !== 'win32' && e && e.status === 1) return false;
    return true;
  }
}

function lifecycleWatch() {
  let absentChecks = 0;
  return setInterval(() => {
    if (Date.now() - startedAt > 24 * 3600 * 1000) { logLine('lifecycle: 24h reached; exiting'); return shutdown(0); }
    if (Date.now() - lastRequestAt > 2 * 3600 * 1000) { logLine('lifecycle: idle 2h; exiting'); return shutdown(0); }
    if (zcodeRunning()) { absentChecks = 0; return; }
    absentChecks += 1;
    if (absentChecks >= 3) { logLine('lifecycle: ZCode gone 3 min; exiting'); return shutdown(0); }
  }, 60 * 1000);
}

function shutdown(code) {
  try { if (learnedDirty) saveLearned(); } catch { /* best effort */ }
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* best effort */ }
  try { if (server) server.close(() => process.exit(code)); else process.exit(code); } catch { process.exit(code); }
  setTimeout(() => process.exit(code), 1500).unref();
}

// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  if (cfg.disabled) {
    logLine('live layer disabled via live-config.json; exiting');
    return;
  }
  ensureDataDir();
  loadLearned();
  loadHarvestState();
  rebuildBase();
  refreshStrings();

  const backend = resolveBackend(cfg);
  logLine(`dict-server starting: ports=${PORTS[0]}-${PORTS[PORTS.length - 1]} backend=${backend ? `${backend.source}:${backend.model}` : 'none'}${backend ? ` (model from ${backend.modelSource})` : ''} learned=${Object.keys(learned).length}`);

  let port;
  try {
    ({ srv: server, port } = await startServer(cfg));
  } catch (e) {
    // someone else already owns the port range: is it us?
    logLine(`bind failed: ${(e && e.message) || e}`);
    process.exit(0);
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  fs.writeFileSync(INFO_FILE, JSON.stringify({ port, pid: process.pid, at: iso(), backend: backend ? backend.model : null }), 'utf8');
  logLine(`listening on 127.0.0.1:${port} pid=${process.pid}`);

  lifecycleWatch();

  const impl = fetch;
  const harvestState = { get lastRequestAt() { return lastRequestAt; } };
  let harvestBusy = false; // one batch may outlive the 30s tick (60s LLM timeout) — never stack them
  const harvest = setInterval(() => {
    if (!resolveBackend(loadConfig())) return;
    refreshStrings();
    if (harvestBusy) return;
    harvestBusy = true;
    Promise.resolve(harvestTick(stringCache, impl, resolveBackend(loadConfig()), harvestState))
      .catch(() => { /* logged inside */ })
      .finally(() => { harvestBusy = false; });
  }, 30 * 1000);
  harvest.unref?.();

  const rebuild = setInterval(rebuildBase, 10 * 60 * 1000);
  rebuild.unref?.();

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => { try { if (learnedDirty) saveLearned(); } catch { /* best effort */ } });
}

const isMainCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainCli) main();
