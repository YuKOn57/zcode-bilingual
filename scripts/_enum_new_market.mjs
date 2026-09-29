// Enumerate every English string the claude-code-workflows marketplace can show in the UI,
// and diff it against dictionary.json. Report to stdout only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MK_DIR = path.join(os.homedir(), '.zcode', 'cli', 'plugins', 'marketplaces', 'claude-code-workflows');
const PLUGIN_ROOT = 'C:/Users/YuKOn/Documents/zcode/zcode-bilingual-plugin';
const dict = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'dictionary.json'), 'utf8'));

const strings = new Map(); // text -> Set(sources)
function add(text, src) {
  if (typeof text !== 'string') return;
  const t = text.trim();
  if (!t || !/[A-Za-z]/.test(t)) return; // skip empty / pure-CJK
  if (!strings.has(t)) strings.set(t, new Set());
  strings.get(t).add(src);
}

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  let cur = null, buf = [], mode = 'plain'; // folded|literal|plain
  const fold = (arr) => arr.join(' ').replace(/\s+/g, ' ').trim();
  const flush = () => {
    if (!cur) return;
    let v;
    if (mode === 'literal') v = buf.join('\n').trim();
    else v = fold(buf); // folded and plain continuation both collapse whitespace;
                        // the helper matches ignoring leading/trailing/consecutive whitespace anyway
    if (v || mode !== 'plain') out[cur] = v;
    cur = null; buf = []; mode = 'plain';
  };
  for (const ln of lines) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(ln);
    if (kv) {
      flush();
      if (/^>\s*[+-]?\s*$/.test(kv[2])) { cur = kv[1]; mode = 'folded'; continue; }
      if (/^\|\s*[+-]?\s*$/.test(kv[2])) { cur = kv[1]; mode = 'literal'; continue; }
      out[kv[1]] = kv[2].trim();
    } else if (cur && (ln.startsWith(' ') || ln.startsWith('\t') || ln.trim() === '')) {
      buf.push(ln.trim());
    }
  }
  flush();
  return out;
}

// 1. marketplace.json entries
const mk = JSON.parse(fs.readFileSync(path.join(MK_DIR, 'marketplace.json'), 'utf8'));
if (mk.metadata && mk.metadata.description) add(mk.metadata.description, 'marketplace.desc');
add(mk.description, 'marketplace.desc');
const cats = new Set();
for (const p of mk.plugins) {
  add(p.name, 'market.plugin.name');
  add(p.description, 'market.plugin.desc');
  if (p.category) cats.add(p.category);
}
for (const c of cats) add(c, 'market.category');

// 2. per-plugin metadata
const pluginsDir = path.join(MK_DIR, 'plugins');
const stats = { pluginJson: 0, skills: 0, agents: 0, commands: 0 };
for (const dir of fs.readdirSync(pluginsDir)) {
  const pd = path.join(pluginsDir, dir);
  if (!fs.statSync(pd).isDirectory()) continue;
  const pjPath = path.join(pd, '.claude-plugin', 'plugin.json');
  if (fs.existsSync(pjPath)) {
    try {
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      add(pj.name, 'plugin.name');
      add(pj.description, 'plugin.desc');
      stats.pluginJson++;
    } catch { /* tolerate */ }
  }
  for (const sub of ['skills', 'agents', 'commands']) {
    const sd = path.join(pd, sub);
    if (!fs.existsSync(sd)) continue;
    for (const entry of fs.readdirSync(sd, { recursive: true })) {
      const f = path.join(sd, entry);
      if (!/SKILL\.md$|\.md$/.test(entry) || !fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      if (sub === 'skills' && !/SKILL\.md$/.test(entry)) continue;
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      if (sub !== 'commands' && (!fm.name || !fm.description)) {
        console.log(`!! parse gap: ${sub}/${entry} name=${JSON.stringify(fm.name ?? null)} desc=${fm.description ? 'ok' : 'MISSING'}`);
        continue;
      }
      if (!fm.description) continue; // commands have no name in frontmatter; description is what the UI shows
      if (sub !== 'commands') add(fm.name, `${sub}.name`);
      add(fm.description, `${sub}.desc`);
      stats[sub]++;
    }
  }
}

// 3. diff against dictionary
const missing = [...strings.entries()]
  .filter(([t]) => !(t in dict))
  .map(([t, srcs]) => ({ t, srcs: [...srcs], len: t.length }));
const missingTotalLen = missing.reduce((a, m) => a + m.len, 0);

console.log('== coverage report: claude-code-workflows marketplace ==');
console.log('unique candidate strings:', strings.size);
console.log('missing from dictionary :', missing.length, `(total ${missingTotalLen} chars)`);
console.log('metadata units:', JSON.stringify(stats));
const bySrc = {};
for (const m of missing) for (const s of m.srcs) bySrc[s] = (bySrc[s] || 0) + 1;
console.log('missing by source:', JSON.stringify(bySrc, null, 2));

const OUT = path.join(PLUGIN_ROOT, '_new_market_missing.json');
fs.writeFileSync(OUT, JSON.stringify(missing.map(m => ({ en: m.t, srcs: m.srcs })), null, 2), 'utf8');
console.log('full list written to', OUT);
console.log('--- sample of first 12 missing ---');
for (const m of missing.slice(0, 12)) {
  console.log(`[${m.srcs.join(',')}] (${m.len}ch) ${m.t.slice(0, 140).replace(/\n/g, ' ')}`);
}
