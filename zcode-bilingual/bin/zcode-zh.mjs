#!/usr/bin/env node
/**
 * zcode-zh — bilingual (English + Chinese) subtitle patcher for ZCode Desktop.
 *
 * What it does
 * ------------
 * ZCode Desktop is an Electron app whose renderer bundle holds a single i18n
 * choke point:
 *
 *     function w(e){let t=g[e]??g[`zh-CN`];return{formatMessage({id:e},n){ ... }}}
 *
 * where `g = { "zh-CN": p, "en-US": m }` maps locale -> message catalog. Every
 * translatable UI string (settings labels, quick-pick items, dialogs, ...) is
 * produced by that one `formatMessage`.
 *
 * This tool rewrites that function so it returns
 *
 *     <English>\u2063<中文>
 *
 * (U+2063 INVISIBLE SEPARATOR between the two) and injects a small renderer
 * helper that immediately strips the hidden Chinese back out of the DOM text,
 * leaving the visible text EXACTLY the original English -- so layout is never
 * changed. The Chinese is attached to the element as `data-zcode-zh` and shown in
 * a floating tooltip while the pointer hovers that English text.
 *
 * Runtime cost (the helper is injected into a long-lived renderer, so it must stay
 * cheap and must not leak). Measured under a synthetic 60fps full-remount churn
 * (see _zh_test/stress.mjs): heap returns to baseline after GC in every run, zero
 * runtime errors, and the helper's share of main-thread time stays around 1s per
 * 45s of pathological churn.
 *   - Every callback body is wrapped in try/catch and the DOM walk is depth-capped,
 *     so a single hostile subtree can neither throw out of the observer nor blow
 *     the stack.
 *   - `title` injection is idempotent and self-replacing (`el.__zzhT`), so re-renders
 *     cannot accumulate text.
 *   - No timers, no per-node listeners, no growing arrays. Nothing is retained.
 *   - Note: `attributeFilter` was tried and REMOVED. Chromium already coalesces
 *     mutations per microtask, so filtering did not reduce observer wake-ups at all
 *     (6.6k vs 6.6k in the harness) and made no measurable wall-clock difference,
 *     while silently dropping coverage for attribute names not on the list. Full
 *     `attributes:true` coverage is kept on purpose.
 *   - Set `window.__zcodeZhMetrics = 1` before load to expose `window.__zcodeZhStats`
 *     (callback / mutation / node counters + ms spent) for profiling.
 *
 * Safety
 * ------
 * - The original app.asar is copied to `app.asar.zcode-zh.bak` before any write.
 * - `--restore` puts the backup back byte-for-byte.
 * - Electron's ASAR integrity fuse is verified off before patching; if it were on,
 *   the patch refuses to run (it would brick the app).
 * - No file inside the archive is modified except the single i18n bundle.
 * - The backup is ROTATED whenever the installed ZCode build changes: a ZCode
 *   update replaces app.asar, so a backup kept from the previous version would
 *   restore the WRONG build. The stale copy is set aside as `.bak.previous`.
 *
 * Usage
 * -----
 *   node bin/zcode-zh.mjs status
 *   node bin/zcode-zh.mjs apply
 *   node bin/zcode-zh.mjs restore
 *   node bin/zcode-zh.mjs apply --asar <path-to-app.asar>   # custom/portable install
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MARKER = '__zcodeZhTitle3';
const LEGACY_MARKERS = ['__zcodeZhTitle2', '__zcodeZhInline', '__zcodeZhTitle', '__zcodeZhHover4', '__zcodeZhHover3', '__zcodeZhHover2', '__zcodeZhHover', '__zcodeZhBilingual'];
const SEP_ESCAPED = '\\u2063'; // emitted into the bundle as an escape sequence
const BACKUP_SUFFIX = '.zcode-zh.bak';

// ---------------------------------------------------------------------------
// asar primitives
// ---------------------------------------------------------------------------

function readAsar(asarPath) {
  const all = fs.readFileSync(asarPath);
  if (all.length < 16) throw new Error('not an asar file (too small)');
  // Layout: [u32 4][u32 headerPickleLength] [u32 payloadSize][u32 jsonLength][json...][pad]
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

function sha256Integrity(buf) {
  const blockSize = 4194304;
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + blockSize)).digest('hex'));
  }
  const hash = crypto.createHash('sha256').update(blocks.join('')).digest('hex');
  return { algorithm: 'SHA256', hash, blockSize, blocks };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/** Rebuild an asar from a parsed header + a map of path -> replacement Buffer. */
function buildAsar(archive, replacements, outPath) {
  const entries = leafEntries(archive.header);
  const chunks = [];
  let offset = 0;

  for (const { path: p, entry } of entries) {
    if (entry.unpacked) continue; // data lives in app.asar.unpacked, untouched
    const content = replacements.has(p) ? replacements.get(p) : readEntry(archive, entry);
    if (replacements.has(p)) {
      entry.size = content.length;
      entry.integrity = sha256Integrity(content);
    }
    entry.offset = String(offset);
    chunks.push(content);
    offset += content.length;
  }

  const jsonBuf = Buffer.from(JSON.stringify(archive.header), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const inner = Buffer.concat([u32(jsonBuf.length), jsonBuf, Buffer.alloc(pad)]); // pickle payload (size+string)
  const headerPickle = Buffer.concat([u32(inner.length), inner]); // prepend payload-size word
  const sizePickle = Buffer.concat([u32(4), u32(headerPickle.length)]); // outer pickle holding headerPickle length

  fs.writeFileSync(outPath, Buffer.concat([sizePickle, headerPickle, ...chunks]));
}

// ---------------------------------------------------------------------------
// Electron fuse check (EnableEmbeddedAsarIntegrityValidation must be off)
// ---------------------------------------------------------------------------

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];

function appRootFromAsar(asarPath) {
  // <root>/resources/app.asar  ->  <root>
  return path.dirname(path.dirname(asarPath));
}

function checkFuses(asarPath) {
  const root = appRootFromAsar(asarPath);
  const exeName = process.platform === 'win32' ? 'ZCode.exe' : 'ZCode';
  const exePath = path.join(root, exeName);
  if (!fs.existsSync(exePath)) return { checked: false, reason: `executable not found at ${exePath}` };
  const buf = fs.readFileSync(exePath);
  const idx = buf.indexOf(FUSE_SENTINEL);
  if (idx < 0) return { checked: false, reason: 'fuse sentinel not found' };
  const count = buf[idx + FUSE_SENTINEL.length + 1];
  const vals = [];
  for (let i = 0; i < count; i++) vals.push(buf[idx + FUSE_SENTINEL.length + 2 + i]);
  const valueOf = (name) => {
    const i = FUSE_NAMES.indexOf(name);
    if (i < 0 || i >= vals.length) return null;
    return vals[i] === 49 ? 'enabled' : vals[i] === 48 ? 'disabled' : 'unset';
  };
  const integrity = valueOf('EnableEmbeddedAsarIntegrityValidation');
  return { checked: true, integrity, onlyLoadAppFromAsar: valueOf('OnlyLoadAppFromAsar') };
}

// ---------------------------------------------------------------------------
// Locate the install
// ---------------------------------------------------------------------------

const SIDECAR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'zcode-bilingual',
  'zcode-path.txt',
);

function candidateAsarPaths() {
  const home = os.homedir();
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };
  const bases = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    // Typical Electron installs, then anywhere the user may have unpacked it.
    bases.push(path.join(local, 'Programs'), pf, pfx86, local, roaming, 'C:\\', 'D:\\', 'E:\\', 'F:\\');
  } else if (process.platform === 'darwin') {
    push('/Applications/ZCode.app/Contents/Resources/app.asar');
    push(path.join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'app.asar'));
    return cands;
  } else {
    push('/opt/ZCode/resources/app.asar');
    push('/usr/lib/zcode/resources/app.asar');
    push('/usr/share/zcode/resources/app.asar');
    push(path.join(home, '.local', 'share', 'zcode', 'resources', 'app.asar'));
    return cands;
  }
  const seen = new Set();
  for (const base of bases) {
    for (const rel of [
      ['ZCode', 'resources', 'app.asar'],
      ['ZCode', 'app.asar'],
      ['Programs', 'ZCode', 'resources', 'app.asar'],
      ['ZCode-win32-x64', 'resources', 'app.asar'],
      ['ZCode', 'ZCode.exe'],
    ]) {
      const p = path.join(base, ...rel);
      const asar = p.endsWith('.exe') ? path.join(path.dirname(p), 'resources', 'app.asar') : p;
      if (!seen.has(asar)) { seen.add(asar); cands.push(asar); }
    }
  }
  return cands;
}

function findAsar(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`app.asar not found: ${explicit}`);
    return path.resolve(explicit);
  }
  if (process.env.ZCODE_ASAR && fs.existsSync(process.env.ZCODE_ASAR)) {
    return path.resolve(process.env.ZCODE_ASAR);
  }
  try {
    const p = fs.readFileSync(SIDECAR, 'utf8').trim().replace(/^"|"$/g, '');
    if (p && fs.existsSync(p)) return path.resolve(p);
  } catch {
    /* no sidecar pinned path */
  }
  const found = candidateAsarPaths().filter((p) => fs.existsSync(p));
  if (!found.length) {
    throw new Error(
      'could not locate ZCode app.asar.\n' +
        'Re-run with the path:  zcode-zh <status|apply> --asar "<...>\\ZCode\\resources\\app.asar"\n' +
        'or set the ZCODE_ASAR environment variable.',
    );
  }
  // Prefer a real install (an Electron app sits next to its own .exe); then the largest.
  const scored = found.map((p) => ({
    p,
    real: fs.existsSync(path.join(appRootFromAsar(p), process.platform === 'win32' ? 'ZCode.exe' : 'ZCode')) ? 1 : 0,
    size: fs.statSync(p).size,
  }));
  scored.sort((a, b) => b.real - a.real || b.size - a.size);
  return scored[0].p;
}

// ---------------------------------------------------------------------------
// The patch itself
// ---------------------------------------------------------------------------

const ORIGINAL_FN =
  'function w(e){let t=g[e]??g[`zh-CN`];return{formatMessage({id:e},n){let r=t[e]??e;' +
  'if(n)for(let[e,t]of Object.entries(n))r=r.replaceAll(`{${e}}`,String(t));return r}}}';

// Identifiers the current build minifies to. `map` is the locale→catalog map the
// function reads; `snap` is the per-call snapshot it declares (`let t=g[e]??…`).
// They are DIFFERENT names, and confusing them yields `let g=g[e]…` -- a TDZ
// crash -- so the rebuild keeps them separate.
const EXACT_IDS = { fn: 'w', arg: 'e', map: 'g', snap: 't', n: 'n', r: 'r', k: 'e', v: 't' };

// Regex fallback in case a future build minifies the identifiers differently.
// Named groups on purpose: the replacement function is REBUILT from whatever
// identifiers this build actually uses. A fixed replacement that hardcodes
// `g`/`e` would reference undefined names on a differently-minified build and
// crash the app's i18n on every message -- precisely the failure a ZCode
// upgrade must never cause.
const FN_PATTERN =
  /function\s+(?<fn>[\w$]+)\((?<arg>[\w$]+)\)\{let\s+(?<snap>[\w$]+)=(?<map>[\w$]+)\[(?<arg2>[\w$]+)\]\?\?(?<map2>[\w$]+)\[`zh-CN`\];return\{formatMessage\(\{id:(?<arg3>[\w$]+)\},(?<n>[\w$]+)\)\{let\s+(?<r>[\w$]+)=(?<snap2>[\w$]+)\[(?<arg4>[\w$]+)\]\?\?(?<arg5>[\w$]+);if\((?<n2>[\w$]+)\)for\(let\[(?<k>[\w$]+),(?<v>[\w$]+)\]of Object\.entries\((?<n3>[\w$]+)\)\)(?<r2>[\w$]+)=(?<r3>[\w$]+)\.replaceAll\(`\{\$\{(?<k2>[\w$]+)\}\}`,String\((?<v2>[\w$]+)\)\);return\s+(?<r4>[\w$]+)\}\}\}/;

function idsFromRegex(m) {
  const g = m.groups;
  const same = (...xs) => xs.every((x) => x === xs[0]);
  if (!same(g.snap, g.snap2)) return null;
  if (!same(g.map, g.map2)) return null;
  if (!same(g.arg, g.arg2, g.arg3, g.arg4, g.arg5)) return null;
  if (!same(g.n, g.n2, g.n3)) return null;
  if (!same(g.r, g.r2, g.r3, g.r4)) return null;
  if (!same(g.k, g.k2) || !same(g.v, g.v2)) return null;
  return { fn: g.fn, arg: g.arg, map: g.map, snap: g.snap, n: g.n, r: g.r, k: g.k, v: g.v };
}

/** Pull the identifiers out of an anchor-matched function body. */
function idsFromText(text) {
  const head = /function\s+([\w$]+)\(([\w$]+)\)\{let\s+([\w$]+)=([\w$]+)\[/.exec(text);
  if (!head) return null;
  const fmt = /formatMessage\(\{id:([\w$]+)\},([\w$]+)\)\{let\s+([\w$]+)=/.exec(text);
  const loop = /for\(let\[([\w$]+),([\w$]+)\]of Object\.entries\(/.exec(text);
  if (!fmt || !loop) return null;
  if (fmt[1] !== head[2]) return null; // {id:X} must shadow the locale parameter
  return { fn: head[1], arg: head[2], map: head[4], snap: head[3], n: fmt[2], r: fmt[3], k: loop[1], v: loop[2] };
}

/**
 * Build the bilingual replacement for the i18n choke point, using the
 * identifiers THIS build actually uses. `catalogExpr` is an expression that
 * evaluates to `{"en-US":…,"zh-CN":…}` inside the same module (see
 * catalogExprFor); when it is unavailable the bilingual branch degrades to the
 * original behaviour instead of producing broken code.
 */
function buildPatchedFn(ids, catalogExpr) {
  const { fn, arg, map, snap, n, r, k, v } = ids;
  const enMap = catalogExpr ? `((${catalogExpr})["en-US"]||{})` : '({})';
  const zhMap = catalogExpr ? `((${catalogExpr})["zh-CN"]||{})` : '({})';
  return (
    `function ${fn}(${arg}){let ${snap}=${map}[${arg}]??${map}[\`zh-CN\`],_loc=String(${arg});` +
    `return{formatMessage({id:${arg}},${n}){let ${r}=${snap}[${arg}]??${arg};` +
    `if(${n})for(let[${k},${v}]of Object.entries(${n}))${r}=${r}.replaceAll(\`{\${${k}}}\`,String(${v}));` +
    `let _en=${enMap}[${arg}],_zh=${zhMap}[${arg}];` +
    `try{let _ov=window.__zcodeZhOverride&&window.__zcodeZhOverride[${arg}];if(_ov)_zh=_ov;}catch(e2){}` +
    `if(_en&&_zh&&_en!==_zh){let _zl=_loc.indexOf("zh")===0,_f=_v=>{if(${n})for(let[_k,_w]of Object.entries(${n}))_v=_v.replaceAll(\`{\${_k}}\`,String(_w));return _v};` +
    `return _f(_zl?_zh:_en)+"${SEP_ESCAPED}"+_f(_zl?_en:_zh)}return ${r}}}}`
  );
}

// Byte-identical to buildPatchedFn(EXACT_IDS, 'g') output on today's build; kept
// verbatim so the proven-good exact path does not depend on the builder.
const PATCHED_FN = buildPatchedFn(EXACT_IDS, 'g');

// Third fallback: anchor on the `X[locale] ?? X[`zh-CN`]; return { formatMessage({id:`
// shape and walk outwards with brace matching. Deliberately conservative -- it only
// fires when both literal patterns miss, and the match MUST still reference the zh-CN
// catalog and formatMessage, otherwise we bail out instead of corrupting the bundle.
const ANCHOR_PATTERN =
  /=\s*([A-Za-z_$][\w$]*)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*\?\?\s*\1\s*\[\s*`zh-CN`\s*\]\s*;\s*return\s*\{\s*formatMessage\s*\(\s*\{\s*id\s*:/;

/** @returns {{start:number,end:number,how:string,ids:object}|null} */
function locateChokePoint(src) {
  const exact = src.indexOf(ORIGINAL_FN);
  if (exact >= 0) return { start: exact, end: exact + ORIGINAL_FN.length, how: 'exact', ids: EXACT_IDS };
  const m = FN_PATTERN.exec(src);
  if (m) {
    const ids = idsFromRegex(m);
    if (ids) return { start: m.index, end: m.index + m[0].length, how: 'regex', ids };
  }
  const a = ANCHOR_PATTERN.exec(src);
  if (!a) return null;
  const start = src.lastIndexOf('function', a.index);
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 123) depth++;
    else if (c === 125) {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) return null;
  const text = src.slice(start, i);
  if (!text.includes('formatMessage') || !text.includes('zh-CN')) return null;
  if (text.length > 4096) return null; // sanity: the real choke point is tiny
  const ids = idsFromText(text);
  if (!ids) return null; // refuse to guess identifiers -- a wrong guess breaks the app
  return { start, end: i, how: 'anchor', ids };
}

/**
 * Renderer-side helper.
 *
 * `catalogExpr` is a JS expression, evaluated INSIDE the patched module, that
 * yields the locale map `{"en-US":<messages>,"zh-CN":<messages>}`. Passing it as
 * an expression (instead of relying on the patch site) is what lets this patch
 * survive an i18n refactor -- see catalogExprFor().
 */
function rendererHelper(catalogExpr) {
  return String.raw`
;(function(){try{
if(typeof window=="undefined"||window.${MARKER})return;window.${MARKER}=1;
var S="${SEP_ESCAPED}";
var D=window.__zcodeZhDict||{},F=window.__zcodeZhDictFiles||{},REV={},FWD={},OVT=window.__zcodeZhOverrideText||{};
var MET=window.__zcodeZhMetrics?{cb:0,mut:0,text:0,attr:0,node:0,ms:0,since:Date.now()}:null;
try{var _CAT=(${catalogExpr})||{},_EN=_CAT["en-US"]||{},_ZH=_CAT["zh-CN"]||{};
for(var _k in _EN){var _a=_EN[_k],_b=_ZH[_k];if(_a&&_b&&_a!==_b){if(!REV[_a])REV[_a]=_b;if(!FWD[_b])FWD[_b]=_a;}}}catch(e){}
if(MET)window.__zcodeZhStats=MET;
/* dict(text, allowForward)
   allowForward is FALSE for the separator branch on purpose. There the text node
   already carries both languages (visible + SEP + hidden) and the hidden part must
   be translated by the direction that fits: zh UI -> hidden is EN -> D/REV give ZH
   (same as visible, harmless no-op); en UI -> hidden is ZH -> nothing matches, and
   the hidden part itself (ZH) is used as the tooltip. Letting FWD answer for ZH
   there would overwrite that tooltip with English -- i.e. it would silently break
   the tooltip in an English UI. FWD is only for plain text with no separator
   (catalog-only patch mode). */
function dict(t,af){if(!t)return null;var k=t.replace(/\s+/g," ").trim();if(!k||k.length<2||k.length>4000)return null;
if(!/[A-Za-z]/.test(k)&&!/[\u4e00-\u9fff]/.test(k))return null;
var r=D[k]||REV[k]||OVT[k];if(r)return r;if(af&&FWD[k])return FWD[k];
var m2=/([\w.-]+\.(?:mjs|cjs|js|py|sh|ps1|cmd|bat))["']?\s*$/.exec(k);return m2?(F[m2[1]]||null):null;}
function setTitle(el,txt){if(!el||el.nodeType!==1||!txt)return;
var prev=el.__zzhT;
if(prev===txt)return;
var cur=el.getAttribute("title");
if(prev&&cur&&cur.indexOf(prev)>=0){try{el.setAttribute("title",cur.replace(prev,txt));}catch(e){}el.__zzhT=txt;return;}
if(cur){if(cur.indexOf(txt)>=0){el.__zzhT=txt;return;}try{el.setAttribute("title",cur+"\n"+txt);}catch(e){return;}}
else{try{el.setAttribute("title",txt);}catch(e){return;}}
el.__zzhT=txt;}
function applyTo(el,txt){if(!el||el.nodeType!==1||!txt)return;
var t=el.tagName;if(t==="SCRIPT"||t==="STYLE"||t==="TEXTAREA"||t==="OPTION")return;
setTitle(el,txt);
var up=el,d=0;
while(up&&d<4){up=up.parentElement;d++;if(!up)break;var u=up.tagName;
if(u==="BODY"||u==="HTML")break;
var role=up.getAttribute&&up.getAttribute("role");
if(u==="LI"||u==="BUTTON"||u==="A"||u==="LABEL"||u==="TR"||role==="button"||role==="menuitem"||role==="option"||role==="tab"||role==="listitem"){setTitle(up,txt);break;}}}
function handleText(n){try{if(!n||n.nodeType!==3||!n.nodeValue)return;
var p=n.parentNode;if(p&&(p.tagName==="INPUT"||p.tagName==="TEXTAREA"||p.isContentEditable))return;
if(MET)MET.text++;
var v=n.nodeValue;
if(v.indexOf(S)>=0){var i=v.indexOf(S);n.nodeValue=v.slice(0,i);var o=v.slice(i+1);var z2=dict(o);applyTo(n.parentNode,z2||o);return;}
var z=dict(v,1);if(z)applyTo(n.parentNode,z);}catch(e){}}
function cleanAttrs(el){try{if(!el||!el.attributes)return;
for(var j=0;j<el.attributes.length;j++){var a=el.attributes[j];if(!a.value||a.value.indexOf(S)<0)continue;
if(MET)MET.attr++;
var v=a.value,i=v.indexOf(S);el.setAttribute(a.name,v.slice(0,i));applyTo(el,v.slice(i+1));}}catch(e){}}
function walk(el,dep){if(!el||el.nodeType!==1)return;
var d=dep||0;if(d>60)return;
if(MET)MET.node++;
cleanAttrs(el);
var k=el.childNodes;for(var i=k.length-1;i>=0;i--){var n=k[i];
if(n.nodeType===3)handleText(n);
else if(n.nodeType===1){var g2=n.tagName;
if(g2!=="SCRIPT"&&g2!=="STYLE"&&g2!=="PRE"&&g2!=="CODE"&&g2!=="TEXTAREA"&&!n.isContentEditable)walk(n,d+1);}}}
var obs=new MutationObserver(function(ms){var _t0=MET?Date.now():0;
try{if(MET){MET.cb++;MET.mut+=ms.length;}
for(var i=0;i<ms.length;i++){var m=ms[i];
if(m.type==="characterData")handleText(m.target);
else if(m.type==="attributes"){var t2=m.target;
if(t2&&t2.getAttribute&&(t2.getAttribute(m.attributeName)||"").indexOf(S)>=0)cleanAttrs(t2);}
else{for(var j=0;j<m.addedNodes.length;j++){var a=m.addedNodes[j];
if(a.nodeType===3)handleText(a);else if(a.nodeType===1)walk(a,0);}}}
}catch(e){}
if(MET)MET.ms+=Date.now()-_t0;});
function boot(){try{obs.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true});walk(document.body,0);}catch(e){}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
}catch(e){}})();
`;
}

// ---------------------------------------------------------------------------
// Catalog-anchored patch (version-proof fallback)
//
// The choke-point patch above rewrites the minified `w(e)` helper. That has
// survived every ZCode build so far (3 tiers + a directory scan), but it is
// ultimately coupled to CODE SHAPE -- a real i18n refactor would break it and
// `apply` would bail with exit 4, leaving the UI untranslated.
//
// The message catalogs are DATA and much more stable. Observed shape (3.14.0):
//
//     var p={ "startPlan....":`中文…` }, m={ "startPlan....":`English…` }, …
//
// Two big object literals, one with CJK values, both bound to variables in the
// same module. So: find them, classify by CJK density, read the variable each is
// assigned to, and hand those variables to the helper as `{"en-US":m,"zh-CN":p}`.
// That path needs no function match at all.
// ---------------------------------------------------------------------------

/** Spans of every balanced {...}, skipping over strings/templates. */
function scanObjectSpans(src) {
  const out = [];
  const stack = [];
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') stack.push(i);
    else if (c === '}' && stack.length) out.push([stack.pop(), i + 1]);
  }
  return out;
}

/** `"key":\`value\`` pairs inside an object literal body. */
const CAT_KV = /(?:"([^"\\]{1,240})"|'([^'\\]{1,240})')\s*:\s*`((?:[^`\\]|\\.)*)`/g;

/** The identifier an object literal is assigned to (`X={...}` -> "X"). */
function bindingNameBefore(src, at) {
  let i = at - 1;
  const ws = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i >= 0 && ws(src[i])) i--;
  if (i < 0 || src[i] !== '=') return null;
  // reject comparisons / arrows (==, ===, =>, <=, >=, !=)
  const prev = src[i - 1];
  if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === '-') return null;
  i--;
  while (i >= 0 && ws(src[i])) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(src[i])) i--;
  const name = src.slice(i + 1, end);
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

/**
 * Locate the en-US / zh-CN message catalogs.
 * @returns {{enVar:string,zhVar:string,enMap:object,zhMap:object}|null}
 */
function findCatalogs(src) {
  const found = [];
  for (const [a, b] of scanObjectSpans(src)) {
    if (b - a < 20000) continue;
    const body = src.slice(a, b);
    const map = {};
    let m;
    CAT_KV.lastIndex = 0;
    while ((m = CAT_KV.exec(body))) {
      const k = m[1] || m[2];
      if (!(k in map)) map[k] = m[3];
    }
    const n = Object.keys(map).length;
    if (n < 200) continue;
    let cjk = 0;
    for (const v of Object.values(map)) if (/[\u4e00-\u9fff]/.test(v)) cjk++;
    found.push({ ratio: cjk / n, map, n, varName: bindingNameBefore(src, a) });
  }
  if (found.length < 2) return null;
  const zh = found.filter((f) => f.ratio > 0.5).sort((x, y) => y.n - x.n)[0];
  const en = found.filter((f) => f.ratio < 0.05).sort((x, y) => y.n - x.n)[0];
  if (!zh || !en || !zh.varName || !en.varName) return null;
  return { enVar: en.varName, zhVar: zh.varName, enMap: en.map, zhMap: zh.map };
}

/** The variable holding the locale map, e.g. `g` in `g[e] ?? g['zh-CN']`. */
function detectLocaleMapIdent(src) {
  const m = /(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*)\s*\[\s*[`"']zh-CN[`"']\s*\]/.exec(src);
  return m ? m[1] : null;
}

/**
 * Expression evaluating to `{"en-US":…,"zh-CN":…}` inside the patched module.
 * Preference order: the app's own locale map (exactly what it uses) -> the two
 * catalog variables -> null (dictionary-only, no catalog hover).
 */
function catalogExprFor(src) {
  const ident = detectLocaleMapIdent(src);
  if (ident) return ident;
  const cats = findCatalogs(src);
  if (cats) return `{"en-US":${cats.enVar},"zh-CN":${cats.zhVar}}`;
  return null;
}

/**
 * Patch one bundle.
 *
 * @param opts.catalogExpr  expression yielding the locale map (see catalogExprFor)
 * @param opts.overrideText `@{i18n.key}` overrides already resolved to text pairs,
 *                          used when the function patch is unavailable so that the
 *                          hover text still covers those ids
 * @param opts.requireChoke when true, a missing choke point is a hard failure
 *                          (normal path); when false, catalog-only injection is fine
 */
function patchBundle(source, dictJson, filesJson, overrideJson, opts = {}) {
  if (source.includes(MARKER)) return { changed: false, reason: 'already patched' };
  let out = source;
  const loc = locateChokePoint(out);
  if (!loc && opts.requireChoke) {
    return { changed: false, reason: 'i18n choke point not found (unsupported ZCode build)' };
  }
  if (!loc && !opts.catalogExpr) {
    return { changed: false, reason: 'no choke point and no message catalog found' };
  }
  let how = 'catalog-only';
  if (loc) {
    out = out.slice(0, loc.start) + buildPatchedFn(loc.ids, opts.catalogExpr) + out.slice(loc.end);
    how = loc.how;
  }
  const dictAssign =
    '\n;try{window.__zcodeZhDict=Object.assign(window.__zcodeZhDict||{},' + (dictJson || '{}') + ');}catch(e){}' +
    '\n;try{window.__zcodeZhDictFiles=Object.assign(window.__zcodeZhDictFiles||{},' + (filesJson || '{}') + ');}catch(e){}' +
    '\n;try{window.__zcodeZhOverride=Object.assign(window.__zcodeZhOverride||{},' + (overrideJson || '{}') + ');}catch(e){}' +
    '\n;try{window.__zcodeZhOverrideText=Object.assign(window.__zcodeZhOverrideText||{},' +
    (opts.overrideTextJson || '{}') + ');}catch(e){}';
  out = out.trimEnd() + dictAssign + '\n' + rendererHelper(opts.catalogExpr || '{}');
  return { changed: true, how, output: out };
}

/**
 * Locate every renderer bundle that carries the i18n choke point.
 *
 * Preferred: the known `IntlProvider-*.js` chunk. If ZCode renames or re-chunks its
 * renderer (the most likely way an upgrade breaks this tool), fall back to scanning
 * the renderer's own JS chunks for the choke-point shape instead of giving up.
 * Bounded: skips chunks > 8 MB and stops after 64 MB of scanning.
 */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
const RENDERER_PREFIX = '/out/renderer/';
const I18NISH_NAME = /intl|locale|i18n|provider|messages|catalog/i;

/** Every .js entry in the archive, renderer chunks first, i18n-ish names before the rest. */
function jsCandidates(archive) {
  const items = leafEntries(archive.header).filter(
    ({ path: p, entry }) => !entry.unpacked && /\.js$/i.test(p),
  );
  const rank = ({ path: p }) =>
    (p.startsWith(RENDERER_PREFIX) ? 0 : 2) + (I18NISH_NAME.test(p) ? 0 : 1);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i)
    .map((x) => x.it);
}

/**
 * Scan candidate chunks (bounded) with a matcher. A chunk that already carries
 * the marker counts as a hit and flags `already`.
 */
function scanChunks(archive, candidates, match) {
  const hits = [];
  let already = false;
  let scanned = 0;
  for (const item of candidates) {
    const size = Number(item.entry.size) || 0;
    if (size > MAX_CHUNK_BYTES || scanned > SCAN_BUDGET_BYTES) continue;
    let src;
    try {
      src = readEntry(archive, item.entry).toString('utf8');
      scanned += size;
    } catch {
      continue;
    }
    if (src.includes(MARKER)) { already = true; hits.push(item); continue; }
    if (match(src)) hits.push(item);
  }
  return { hits, already };
}

/**
 * Locate every bundle that carries the i18n choke point.
 *
 * Pass 1: the renderer tree, i18n-looking chunks first (the known
 * `IntlProvider-*.js` chunk sorts to the front). Pass 2 -- the layout-proof
 * fallback: if the renderer tree yields nothing, scan the REST of the archive.
 * A ZCode upgrade that moves or renames the renderer output must not disable
 * the patch. Both passes are bounded (8 MB per chunk, 64 MB total each).
 */
function findTargetBundles(archive) {
  const js = jsCandidates(archive);
  let { hits, already } = scanChunks(
    archive,
    js.filter(({ path: p }) => p.startsWith(RENDERER_PREFIX)),
    locateChokePoint,
  );
  if (!hits.length) {
    const second = scanChunks(
      archive,
      js.filter(({ path: p }) => !p.startsWith(RENDERER_PREFIX)),
      locateChokePoint,
    );
    hits = second.hits;
    already = already || second.already;
  }
  const named = hits.filter(({ path: p }) => /IntlProvider/i.test(p));
  return { targets: named.length ? named : hits, already };
}

/**
 * Fallback target discovery: bundles that hold the message catalogs, regardless
 * of what the surrounding i18n code looks like. Used only when no choke point is
 * recognizable anywhere. Same renderer-first + whole-archive fallback strategy.
 */
function findCatalogBundles(archive) {
  const js = jsCandidates(archive);
  let hits = scanChunks(
    archive,
    js.filter(({ path: p }) => p.startsWith(RENDERER_PREFIX)),
    findCatalogs,
  ).hits;
  if (!hits.length) {
    hits = scanChunks(
      archive,
      js.filter(({ path: p }) => !p.startsWith(RENDERER_PREFIX)),
      findCatalogs,
    ).hits;
  }
  return hits;
}

/**
 * Resolve `@{i18n.key}` overrides into {englishText: chineseText}.
 *
 * In the normal path the patched formatMessage applies overrides by id. In the
 * catalog-only fallback there is no wrapper to do that, so the override has to be
 * keyed by the English text the helper will actually see in the DOM.
 */
function resolveOverrideText(overrides, src) {
  const ids = Object.keys(overrides || {});
  if (!ids.length) return {};
  const cats = findCatalogs(src);
  if (!cats) return {};
  const out = {};
  for (const id of ids) {
    const en = cats.enMap[id];
    if (en && en !== overrides[id]) out[en] = overrides[id];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dynamic-text dictionary (plugin / skill / subagent / MCP metadata)
// ---------------------------------------------------------------------------

const normalizeKey = (s) => String(s).replace(/\s+/g, ' ').trim();

function safeReaddir(d) {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}

function readDictionaryFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

/** en -> zh pairs that installed plugins already ship via description_i18n. */
function collectInstalledDictionary() {
  const out = {};
  const home = os.homedir();
  const roots = [
    path.join(home, '.zcode', 'cli', 'plugins', 'cache'),
    path.join(home, '.zcode', 'v2', 'plugins', 'cache'),
  ];
  for (const root of roots) {
    for (const mkt of safeReaddir(root)) {
      const mktDir = path.join(root, mkt);
      for (const plugin of safeReaddir(mktDir)) {
        const pluginDir = path.join(mktDir, plugin);
        for (const ver of safeReaddir(pluginDir)) {
          for (const mf of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
            const p = path.join(pluginDir, ver, mf);
            if (!fs.existsSync(p)) continue;
            try {
              const j = JSON.parse(fs.readFileSync(p, 'utf8'));
              const i18n = (j && j.description_i18n) || {};
              const en = i18n.en || j.description;
              const zh = i18n['zh-CN'] || i18n.zh;
              if (en && zh && en !== zh) out[normalizeKey(en)] = zh;
            } catch {
              /* ignore malformed manifest */
            }
          }
        }
      }
    }
  }
  return out;
}

function buildDictionary(explicitFile) {
  const merged = { ...collectInstalledDictionary() };
  const fileHints = {}; // "~name.mjs": match any text ending with name.mjs (hook / script commands)
  const overrides = {}; // "@i18n.key": replace ZCode's own zh-CN message (official zh may keep English)
  const files = [explicitFile, path.join(PLUGIN_ROOT, 'dictionary.json')].filter(Boolean);
  for (const f of files) {
    const j = readDictionaryFile(f);
    if (!j) continue;
    for (const [k, v] of Object.entries(j)) {
      if (k.startsWith('_')) continue;
      if (typeof v !== 'string' || !v) continue;
      if (k.startsWith('~')) {
        const hint = normalizeKey(k.slice(1));
        if (hint) fileHints[hint] = v;
      } else if (k.startsWith('@')) {
        const key = normalizeKey(k.slice(1));
        if (key) overrides[key] = v;
      } else {
        merged[normalizeKey(k)] = v;
      }
    }
  }
  return { dict: merged, fileHints, overrides };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  return (n / 1048576).toFixed(1) + ' MB';
}

const STATE_SUFFIX = '.zcode-zh.json';

function statePath(asarPath) {
  return asarPath + STATE_SUFFIX;
}

function writeState(asarPath, patched, marker = null, extra = {}) {
  const st = { patched, marker, at: new Date().toISOString(), tool: 'zcode-zh' };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) st[k] = v;
  try {
    fs.writeFileSync(statePath(asarPath), JSON.stringify(st, null, 2));
  } catch {
    /* state file is an optimization only */
  }
}

function readState(asarPath) {
  try {
    const st = JSON.parse(fs.readFileSync(statePath(asarPath), 'utf8'));
    // Trust the cache only if it is newer than the archive itself.
    if (fs.statSync(statePath(asarPath)).mtimeMs >= fs.statSync(asarPath).mtimeMs) return st;
  } catch {
    /* fall through to a scan */
  }
  return null;
}

/**
 * Fingerprint of everything that gets baked into the patched bundle.
 *
 * The dictionary is compiled into app.asar at patch time, so editing
 * dictionary.json does NOT take effect until a forced re-patch. This hash lets
 * `status` report whether the baked dictionary is stale, which is what lets the
 * self-heal worker refresh it automatically instead of reporting "already done".
 */
function dictFingerprint(dict, fileHints, overrides) {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(dict || {}).sort()) h.update(`D${k}\u0000${dict[k]}\u0001`);
  for (const k of Object.keys(fileHints || {}).sort()) h.update(`F${k}\u0000${fileHints[k]}\u0001`);
  for (const k of Object.keys(overrides || {}).sort()) h.update(`O${k}\u0000${overrides[k]}\u0001`);
  return h.digest('hex').slice(0, 16);
}

/**
 * True when a patch INPUT (dictionary.json or the patcher itself) is newer than
 * the state file. Both are compiled into app.asar at patch time, so the baked
 * helper/dictionary is stale even though the marker matches. This is what lets
 * the self-heal worker refresh after a PATCHER upgrade too, not just a
 * dictionary edit -- without it, an improved patcher would never re-bake.
 */
function inputsStale(asarPath) {
  const state = asarPath + STATE_SUFFIX;
  let stateM = 0;
  try {
    stateM = fs.statSync(state).mtimeMs;
  } catch {
    return false; // no state file: the marker check covers everything else
  }
  for (const f of [path.join(PLUGIN_ROOT, 'dictionary.json'), path.join(PLUGIN_ROOT, 'bin', 'zcode-zh.mjs')]) {
    try {
      if (fs.statSync(f).mtimeMs > stateM) return true;
    } catch {
      /* a missing input cannot be newer */
    }
  }
  return false;
}

/** Marker string of the patch found in the archive (null when unpatched). */
function detectMarker(archive) {  const markers = [MARKER, ...LEGACY_MARKERS];
  for (const { entry } of leafEntries(archive.header)) {
    if (entry.unpacked) continue;
    let text;
    try {
      text = readEntry(archive, entry).toString('utf8');
    } catch {
      continue;
    }
    for (const m of markers) if (text.includes(m)) return m;
  }
  return null;
}

/** ZCode's own version, read from the /package.json inside the archive. */
function readZcodeVersion(archive) {
  const hit = leafEntries(archive.header).find(({ path: p }) => p === '/package.json');
  if (!hit) return null;
  try {
    const j = JSON.parse(readEntry(archive, hit.entry).toString('utf8'));
    return j.version || j.name || null;
  } catch {
    return null;
  }
}

function isPatched(archive) {
  return detectMarker(archive) !== null;
}

function cmdStatus(args) {
  const asarPath = findAsar(args.asar);
  const fuses = checkFuses(asarPath);
  const backup = asarPath + BACKUP_SUFFIX;
  const st = fs.statSync(asarPath);
  const bk = fs.existsSync(backup) ? fs.statSync(backup) : null;
  const cached = readState(asarPath);
  let patched;
  let marker = null;
  let source;
  let zcodeVersion = null;
  if (cached) {
    patched = !!cached.patched;
    marker = cached.marker || null;
    zcodeVersion = cached.zcodeVersion || null;
    source = 'state-file';
  } else {
    const archive = readAsar(asarPath);
    marker = detectMarker(archive);
    patched = marker !== null;
    zcodeVersion = readZcodeVersion(archive);
    source = 'scan';
  }
  // A ZCode update replaces app.asar wholesale. `readState` only trusts the cache
  // while it is newer than the archive, so an unpatched archive + a stale backup
  // means "ZCode was updated; the patch is gone and the backup no longer matches".
  const result = {
    asar: asarPath,
    size: fmtBytes(st.size),
    patched,
    marker,
    upToDate: marker === MARKER,
    needsRepatch: marker !== MARKER,
    zcodeVersion,
    detectedVia: source,
    backup: bk ? backup : null,
    backupStale: !!(bk && !patched && bk.mtimeMs < st.mtimeMs),
    integrityFuse: fuses.checked ? fuses.integrity : `unknown (${fuses.reason})`,
  };
  // The dictionary is compiled into app.asar, so a dictionary.json edit is only
  // picked up by a forced re-patch. Report both hashes so a caller can tell
  // whether the baked copy is out of date. Never let this fail `status`.
  result.patchMode = cached ? cached.patchMode || null : null;
  let dictHashNow = null;
  let dictEntriesNow = null;
  try {
    const cur = buildDictionary(args.dict);
    dictHashNow = dictFingerprint(cur.dict, cur.fileHints, cur.overrides);
    dictEntriesNow = Object.keys(cur.dict).length;
  } catch {
    /* leave nulls */
  }
  const bakedHash = cached ? cached.dictHash || null : null;
  result.dictHash = bakedHash;
  result.dictHashNow = dictHashNow;
  result.dictEntriesNow = dictEntriesNow;
  // Only meaningful for the current marker — an older or absent patch is already
  // covered by needsRepatch. A MISSING hash on a current patch means the state
  // file predates the fingerprint, so refresh once and record it.
  result.dictStale =
    marker === MARKER && dictHashNow ? !bakedHash || bakedHash !== dictHashNow : false;
  // Same idea, but for the CODE side: an edited patcher (helper improvements) or
  // dictionary makes the baked copy stale even when the dictionary hash matches.
  result.codeStale = marker === MARKER ? inputsStale(asarPath) : false;
  console.log(JSON.stringify(result, null, 2));
  return marker === MARKER ? 0 : 1;
}

function cmdApply(args) {
  const asarPath = findAsar(args.asar);
  const fuses = checkFuses(asarPath);
  if (fuses.checked && fuses.integrity === 'enabled') {
    console.error(
      'REFUSING TO PATCH: Electron ASAR integrity validation is enabled in this build.\n' +
        'Modifying app.asar would prevent the app from starting.\n' +
        'Nothing was changed.',
    );
    return 3;
  }

  let archive = readAsar(asarPath);
  const foundMarker = detectMarker(archive);
  if (foundMarker === MARKER && !args.force) {
    console.log(`Already patched (up to date): ${asarPath}`);
    console.log('Use --force to re-patch (e.g. after editing dictionary.json).');
    return 0;
  }
  if (foundMarker) {
    // A previous version of the patch is present (e.g. the retired stacked-line
    // build). Roll back to the pristine backup, then re-patch with this version.
    const backup = asarPath + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) {
      console.error(
        `Found an older patch (${foundMarker}) but no backup at ${backup}.\n` +
          'Cannot upgrade safely; restore ZCode by reinstalling it, then apply again.',
      );
      return 9;
    }
    console.log(`Found older patch (${foundMarker}); restoring original, then re-patching...`);
    if (args['dry-run']) {
      console.log(`Dry run: would restore the original and re-patch (${foundMarker} -> ${MARKER}). No files written.`);
      return 0;
    }
    fs.copyFileSync(backup, asarPath);
    archive = readAsar(asarPath);
  }

  const found = findTargetBundles(archive);
  let targets = found.targets;
  let patchMode = 'choke-point';
  if (!targets.length) {
    // Version-proof fallback. No recognizable `w(e)` anywhere means ZCode changed
    // its i18n code shape -- the message catalogs are data and far more stable, so
    // anchor on those instead of giving up (this used to be a hard exit 4).
    targets = findCatalogBundles(archive);
    if (targets.length) {
      patchMode = 'catalog-only';
      console.log('i18n choke point not found; falling back to catalog-anchored injection.');
    }
  }
  if (!targets.length) {
    console.error(
      'Could not locate the i18n choke point OR the message catalogs anywhere in\n' +
        'app.asar (renderer tree first, then the whole archive).\n' +
        'This ZCode build is not supported by this version of the patcher. Nothing was changed.',
    );
    return 4;
  }
  for (const { path: p } of targets) console.log(`i18n target: ${p} (${patchMode})`);

  const { dict, fileHints, overrides } = buildDictionary(args.dict);
  const dictJson = JSON.stringify(dict);
  const filesJson = JSON.stringify(fileHints);
  const overrideJson = JSON.stringify(overrides);
  console.log(
    `Dictionary entries: ${Object.keys(dict).length} (+${Object.keys(fileHints).length} filename hints, ` +
      `${Object.keys(overrides).length} zh overrides)`,
  );

  const replacements = new Map();
  for (const { path: p, entry } of targets) {
    const src = readEntry(archive, entry).toString('utf8');
    const catalogExpr = catalogExprFor(src);
    const res = patchBundle(src, dictJson, filesJson, overrideJson, {
      catalogExpr,
      overrideTextJson: JSON.stringify(resolveOverrideText(overrides, src)),
    });
    if (!res.changed) {
      console.error(`Patch failed for ${p}: ${res.reason}`);
      return 5;
    }
    console.log(
      `Patched ${p} (${res.how}${catalogExpr ? '' : ', dictionary-only: no catalog reference found'})`,
    );
    replacements.set(p, Buffer.from(res.output, 'utf8'));
  }

  if (args['dry-run']) {
    console.log('Dry run: no files written.');
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Restore point.
  //
  // The backup MUST be a copy of the currently-installed ZCode build, otherwise a
  // later `restore` would write an OLD ZCode's app.asar back over a NEW one and
  // brick the installation. So:
  //   - no marker found  -> app.asar is pristine. Either this is a first install,
  //     or ZCode was just updated and replaced app.asar. Either way THIS file is
  //     the correct restore point, so any existing backup is stale: keep it aside
  //     and take a fresh one.
  //   - marker found     -> app.asar is (or was just reverted from backup to) the
  //     pristine build we already have; keep the existing backup.
  // ---------------------------------------------------------------------------
  const backup = asarPath + BACKUP_SUFFIX;
  const zcodeVersion = readZcodeVersion(archive);
  if (!foundMarker) {
    if (fs.existsSync(backup)) {
      const prev = backup + '.previous';
      try {
        fs.rmSync(prev, { force: true });
        fs.renameSync(backup, prev);
        console.log(
          `ZCode build changed (now ${zcodeVersion || 'unknown version'}).\n` +
            `The old backup would have restored the WRONG build, so it was set aside:\n  ${prev}\n` +
            `A fresh restore point is being taken from the current app.asar.`,
        );
      } catch (err) {
        console.error(`Could not rotate the stale backup: ${err && err.message}`);
        return 10;
      }
    }
    fs.copyFileSync(asarPath, backup);
    console.log(`Backup written: ${backup}`);
  } else {
    console.log(`Backup already exists (kept): ${backup}`);
  }

  const tmp = asarPath + '.zcode-zh.tmp';
  buildAsar(archive, replacements, tmp);
  try {
    fs.renameSync(tmp, asarPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      console.error(
        'Could not replace app.asar because it is in use.\n' +
          'Please fully quit ZCode (including the tray/menu-bar icon) and run apply again.',
      );
      return 6;
    }
    throw err;
  }

  // Verify the written archive parses and carries the marker.
  const check = readAsar(asarPath);
  if (detectMarker(check) !== MARKER) {
    console.error('Verification failed after writing; restoring backup.');
    fs.copyFileSync(backup, asarPath);
    writeState(asarPath, false, null);
    return 7;
  }
  writeState(asarPath, true, MARKER, {
    zcodeVersion,
    patchedSize: fs.statSync(asarPath).size,
    i18nTargets: targets.map((t) => t.path),
    patchMode,
    dictHash: dictFingerprint(dict, fileHints, overrides),
    dictEntries: Object.keys(dict).length,
  });
  console.log(
    `Done. Restart ZCode to see bilingual subtitles. ` +
      `(ZCode ${zcodeVersion || 'unknown'}, ${fmtBytes(fs.statSync(asarPath).size)})`,
  );
  return 0;
}

function cmdRestore(args) {
  const asarPath = findAsar(args.asar);
  const backup = asarPath + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    console.error(`No backup found at ${backup}; nothing to restore.`);
    return 8;
  }
  try {
    fs.copyFileSync(backup, asarPath);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      console.error('Could not restore app.asar because it is in use. Quit ZCode and retry.');
      return 6;
    }
    throw err;
  }
  writeState(asarPath, false, null);
  // A restore is an explicit opt-out: cancel any pending self-heal request so the
  // worker does not re-apply the patch right after the user removed it.
  try {
    const reqFile = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'zcode-bilingual',
      'self-heal-request.json',
    );
    fs.rmSync(reqFile, { force: true });
  } catch {
    /* non-fatal */
  }
  console.log(`Restored original app.asar from ${backup}. Restart ZCode.`);
  return 0;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar') args.asar = argv[++i];
    else if (a === '--dict') args.dict = argv[++i];
    else if (a === '--dry-run') args['dry-run'] = true;
    else if (a === '--force') args.force = true;
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  try {
    if (cmd === 'status') return cmdStatus(args);
    if (cmd === 'apply') return cmdApply(args);
    if (cmd === 'restore') return cmdRestore(args);
    console.error(`Unknown command: ${cmd}\nUsage: zcode-zh <status|apply|restore> [--asar <path>] [--dry-run]`);
    return 2;
  } catch (err) {
    console.error(String((err && err.message) || err));
    return 1;
  }
}

// Pure helpers are exported so tests can exercise the patch logic (identifier
// reconstruction, catalog discovery) WITHOUT touching app.asar.
export {
  ORIGINAL_FN,
  EXACT_IDS,
  FN_PATTERN,
  locateChokePoint,
  idsFromRegex,
  idsFromText,
  buildPatchedFn,
  catalogExprFor,
  findCatalogs,
  patchBundle,
  normalizeKey,
  buildDictionary,
};

// Run the CLI only when executed directly, not when imported by a test.
const isMainCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMainCli) process.exitCode = main();
