// v2: brace-match the en-US / zh-CN catalog template literals out of the
// IntlProvider bundle and dump them as real JSON objects for inspection.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ASAR = process.argv[2] || 'C:\\Users\\YuKOn\\AppData\\Local\\Programs\\ZCode\\resources\\app.asar';
const OUT = path.join(os.tmpdir(), 'zcode-bilingual-extract');
fs.mkdirSync(OUT, { recursive: true });

function readAsar(asarPath) {
  const all = fs.readFileSync(asarPath);
  const headerPickleLength = all.readUInt32LE(4);
  const headerPickle = all.subarray(8, 8 + headerPickleLength);
  const jsonLength = headerPickle.readUInt32LE(4);
  const header = JSON.parse(headerPickle.subarray(8, 8 + jsonLength).toString('utf8'));
  const dataStart = 8 + headerPickleLength;
  return { all, header, dataStart };
}
function leafEntries(header) {
  const out = [];
  (function walk(node, prefix) {
    for (const [name, val] of Object.entries(node.files || {})) {
      const p = prefix + '/' + name;
      if (val.files) walk(val, p);
      else out.push({ path: p, entry: val });
    }
  })(header, '');
  return out;
}
function readEntry(archive, node) {
  const size = Number(node.size) || 0;
  const offset = Number(node.offset) || 0;
  const buf = Buffer.alloc(size);
  archive.all.copy(buf, 0, archive.dataStart + offset, archive.dataStart + offset + size);
  return buf;
}

const archive = readAsar(ASAR);
const leaves = leafEntries(archive.header);
const bundlePath = leaves.find(({ path: p, entry }) => !entry.unpacked && /IntlProvider.*\.js$/.test(p))?.path;
if (!bundlePath) { console.error('IntlProvider bundle not found'); process.exit(1); }
const entry = leaves.find(({ path: p }) => p === bundlePath).entry;
const src = readEntry(archive, entry).toString('utf8');
console.log('bundle:', bundlePath, 'bytes:', src.length);

// Locate the g={"zh-CN":X,"en-US":Y} assignment.
const gRe = /\bg\s*=\s*\{\s*["']zh-CN["']\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*["']en-US["']\s*:\s*([A-Za-z_$][\w$]*)\s*\}/;
const gm = gRe.exec(src);
if (!gm) { console.error('g assignment not found'); process.exit(1); }
const zhVar = gm[1], enVar = gm[2];
console.log('zh var =', zhVar, '| en var =', enVar, '| at', gm.index);

// Find "enVar=..." declaration (object literal, likely template-quoted values).
function findDecl(varName, from, dir) {
  const re = new RegExp('\\b' + varName + '\\s*=\\s*(\\{|`\\{)', 'g');
  if (dir < 0) {
    // search backwards: last occurrence before index
    let found = null;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (dir < 0 && m.index >= from) break;
      found = m;
    }
    return found ? found.index + m[0].length - 1 : -1; // index of '{' or '`{'
  }
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? m.index + m[0].length - 1 : -1;
}

function braceMatchFromOpen(openIdx) {
  // openIdx points at '{'. Match to its closing '}', skipping string literals.
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === '`') {
      // skip template literal
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function evalLiteral(text) {
  // text is like `{...}` — a template literal. Evaluate safely.
  return Function('"use strict";return (' + text + ')')();
}

function extract(varName) {
  // decl may be "var m={`" etc. Search whole file; take occurrences and try.
  const re = new RegExp('\\b' + varName + '\\s*=\\s*(`)', 'g');
  let m;
  const results = [];
  while ((m = re.exec(src)) !== null) {
    const backtickIdx = m.index + m[0].length - 1;
    const openIdx = src.indexOf('{', backtickIdx);
    if (openIdx < 0 || openIdx - backtickIdx > 3) continue;
    const closeIdx = braceMatchFromOpen(openIdx);
    if (closeIdx < 0) continue;
    const lit = src.slice(backtickIdx, closeIdx + 2); // include closing ` and }
    try {
      const obj = evalLiteral(lit);
      if (obj && typeof obj === 'object') {
        results.push({ obj, lit, at: m.index });
      }
    } catch (e) { /* not the catalog */ }
  }
  return results;
}

for (const [label, varName] of [['zh-CN', zhVar], ['en-US', enVar]]) {
  const cands = extract(varName);
  console.log(`=== ${label} (${varName}) candidates:`, cands.length);
  for (const c of cands) {
    const keys = Object.keys(c.obj);
    console.log(`  at=${c.at} keys=${keys.length}`);
    if (keys.length > 100) {
      const f = path.join(OUT, 'catalog.' + label + '.json');
      fs.writeFileSync(f, JSON.stringify(c.obj, null, 1));
      console.log('  written:', f);
    }
  }
}
