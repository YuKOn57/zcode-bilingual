import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DICT_PATH = 'C:/Users/YuKOn/Documents/zcode/zcode-bilingual-plugin/dictionary.json';
const normalize = (s) => String(s).replace(/\s+/g, ' ').trim();

const dict = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'));
const covered = new Set(Object.keys(dict).map(normalize));

// Candidate roots containing skills
const roots = [
  'C:/Users/YuKOn/.zcode/cli/plugins/cache',
  'C:/Users/YuKOn/.zcode/v2/plugins/cache',
  'C:/Users/YuKOn/.zcode/skills',
  'C:/Users/YuKOn/Documents/zcode/zcode-bilingual-plugin/skills',
  'C:/Users/YuKOn/Documents/zcode/.zcode/skills',
];

function findSkillMds(dir, depth, out) {
  if (depth > 7) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findSkillMds(p, depth + 1, out);
    else if (e.name === 'SKILL.md') out.push(p);
  }
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

const all = [];
const seen = new Set();
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  const files = [];
  findSkillMds(r, 0, files);
  for (const f of files) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      if (!fm) continue;
      const key = (fm.name || '') + '\u0000' + (fm.description || '');
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ file: f, name: fm.name || '', description: fm.description || '' });
    } catch {}
  }
}

console.log('total skills found:', all.length);
const missingNames = [];
const missingDescs = [];
for (const s of all) {
  if (s.name && !covered.has(normalize(s.name))) missingNames.push(s);
  if (s.description && !covered.has(normalize(s.description))) missingDescs.push(s);
}
console.log('\n=== MISSING NAMES ===');
for (const s of missingNames) console.log(JSON.stringify(s.name), '  <-', s.file.replace(/C:\\Users\\YuKOn[\\/]/g, ''));
console.log('\n=== MISSING DESCRIPTIONS ===');
for (const s of missingDescs) console.log(JSON.stringify(s.description), '\n  <-', s.file.replace(/C:\\Users\\YuKOn[\\/]/g, ''));
