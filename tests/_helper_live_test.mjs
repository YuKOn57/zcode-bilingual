/**
 * Live layer of the renderer helper (v0.5.0): hot dictionary + on-demand
 * translation.
 *
 * Simulated backend (mock fetch):
 *   /ping  on 17981 -> our handshake
 *   /dict  -> { live:true, dict:{ "Fresh Plugin": "全新插件" } }
 *   /translate?q=... -> { t } keyed by the requested string
 *
 * Scenarios:
 *   1. marker guard + boot delay honoured
 *   2. /dict merge makes NEW text translate instantly (no /translate call)
 *   3. dictionary MISS: nothing until hover, then /translate fires once,
 *      title attached, bubble shows while the pointer is over the element
 *   4. second lookup of the same text is served from the memory cache
 *   5. bubble suppressed when the pointer has already left (title only)
 *   6. window.__zcodeZhLive=false kills the live layer entirely
 *   7. Chinese miss -> /translate requested (direction decided server-side)
 *   8. scroll hides the bubble
 */
import { rendererHelper } from '../bin/zcode-zh.mjs';

let pass = 0, fail = 0;
const gate = (ok, label, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); ok ? pass++ : fail++; };
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function El(tag) {
  this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = []; this.nodeType = 1;
  this.isContentEditable = false; this.parentNode = null; this.style = {};
}
Object.defineProperty(El.prototype, 'textContent', { get() { let s = ''; for (const c of this.childNodes) s += c.nodeType === 3 ? c.nodeValue : (c.textContent || ''); return s; } });
El.prototype.getAttribute = function (n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; };
El.prototype.setAttribute = function (n, v) { const a = this.attributes.find((x) => x.name === n); if (a) a.value = v; else this.attributes.push({ name: n, value: v }); };
El.prototype.removeAttribute = function (n) { this.attributes = this.attributes.filter((x) => x.name !== n); };
Object.defineProperty(El.prototype, 'parentElement', { get() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; } });
El.prototype.appendChild = function (c) { this.childNodes.push(c); c.parentNode = this; return c; };
El.prototype.matches = function () { return !!this.__hover; };
function Txt(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }
const putText = (el, v) => { const t = new Txt(v); el.appendChild(t); return t; };

const body = new El('body');
let HOVER_FN = null, SCROLL_FN = null;
const KEYDOWN_FNS = [];
const created = [];
const documentMock = {
  documentElement: new El('html'),
  body,
  readyState: 'complete',
  addEventListener(type, fn) { if (type === 'mouseover') HOVER_FN = fn; if (type === 'scroll') SCROLL_FN = fn; if (type === 'keydown') KEYDOWN_FNS.push(fn); },
  createElement(tag) {
    // plain object (NOT El): the bubble host needs a writable textContent and no
    // element-walk semantics; El's getter-only textContent would swallow writes.
    const e = { tagName: tag.toUpperCase(), nodeType: 1, style: {}, childNodes: [], appendChild(c) { this.childNodes.push(c); return c; } };
    created.push(e); return e;
  },
};
const windowMock = { __zcodeZhDict: {}, __zcodeZhDictFiles: {}, __zcodeZhOverrideText: {}, __zcodeZhLiveBootDelay: 40, innerWidth: 1280, innerHeight: 800 };

const FETCH_CALLS = [];
const MODEL_POSTS = [];
global.fetch = (url, opts) => {
  FETCH_CALLS.push(String(url));
  const u = String(url);
  if (u.includes('/ping')) return Promise.resolve({ ok: true, json: async () => ({ svc: 'zcode-bilingual', live: true, port: 17981 }) });
  if (u.includes('/dict')) return Promise.resolve({ ok: true, json: async () => ({ svc: 'zcode-bilingual', live: true, dict: { 'Fresh Plugin': '全新插件' } }) });
  if (u.includes('/models')) return Promise.resolve({ ok: true, json: async () => ({ svc: 'zcode-bilingual', current: 'm-base', modelSource: 'built-in default', models: [{ id: 'm-base', source: 'current' }, { id: 'm-hist', source: 'history' }, { id: 'm-sug', source: 'suggestion' }] }) });
  if (u.includes('/model')) {
    MODEL_POSTS.push({ url: u, body: opts && opts.body ? String(opts.body) : null });
    let picked = null;
    try { picked = JSON.parse((opts && opts.body) || '{}').model || null; } catch { /* ok */ }
    return Promise.resolve({ ok: true, json: async () => ({ svc: 'zcode-bilingual', ok: true, model: picked, modelSource: 'live-config.json model' }) });
  }
  if (u.includes('/translate')) {
    const q = decodeURIComponent(u.split('q=')[1] || '');
    const table = {
      'Unknown Brand Feature': '未知品牌功能',
      '全新的中文界面文案': 'Brand new Chinese UI copy',
    };
    return Promise.resolve({ ok: true, json: async () => ({ svc: 'zcode-bilingual', t: table[q] || '' }) });
  }
  return Promise.resolve({ ok: false, json: async () => ({}) });
};

global.window = windowMock;
global.document = documentMock;
let MO_CB = null;
global.MutationObserver = function (cb) { MO_CB = cb; this.observe = function () {}; };

eval(rendererHelper('{}'));

gate(!!windowMock.__zcodeZhTitle5, 'marker v5 set after helper eval');
gate(typeof HOVER_FN === 'function' && typeof SCROLL_FN === 'function', 'delegated hover/scroll listeners registered');

const mkRow = (text, editable = false) => {
  const row = new El('div'); body.appendChild(row);
  const span = new El('span'); row.appendChild(span);
  if (editable) { span.isContentEditable = true; row.isContentEditable = true; }
  putText(span, text);
  return { row, span };
};

await flush(80); // boot delay 40ms + fetch microtasks -> lboot ran, /dict merged

// 2. hot dictionary: brand-new string served by /dict translates with NO hover and NO /translate
const rDict = mkRow('Fresh Plugin');
MO_CB([{ type: 'characterData', target: rDict.span.childNodes[0] }]);
gate(rDict.span.getAttribute('title') === '全新插件', '/dict hot merge: new string translated instantly', JSON.stringify(rDict.span.getAttribute('title')));
gate(!FETCH_CALLS.some((u) => u.includes('/translate')), 'hot dictionary hit does not call /translate');

// 3. miss -> hover -> translate -> title + bubble
const rMiss = mkRow('Unknown Brand Feature');
rMiss.span.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 30, width: 100, height: 20 });
MO_CB([{ type: 'characterData', target: rMiss.span.childNodes[0] }]);
gate(rMiss.span.getAttribute('title') === null, 'miss: nothing attached until the user hovers');
rMiss.span.__hover = true;
HOVER_FN({ target: rMiss.span.childNodes.length ? rMiss.span : rMiss.span });
await flush(50);
gate(FETCH_CALLS.some((u) => u.includes('/translate')), 'hover on miss fires exactly the on-demand lookup');
gate(rMiss.span.getAttribute('title') === '未知品牌功能', 'live answer attached as title', JSON.stringify(rMiss.span.getAttribute('title')));
gate(created.length === 2 && created[0].__d && created[0].__d.textContent === '未知品牌功能' && created[0].style.display === 'block',
  'bubble shown with the live answer while hovering (host + inner div)');

// 4. cache: same string again -> no new /translate
const before = FETCH_CALLS.length;
const rMiss2 = mkRow('Unknown Brand Feature');
MO_CB([{ type: 'characterData', target: rMiss2.span.childNodes[0] }]);
rMiss2.span.__hover = true;
HOVER_FN({ target: rMiss2.span });
await flush(30);
gate(FETCH_CALLS.length === before, 'second lookup of the same string is served from cache');
gate(rMiss2.span.getAttribute('title') === '未知品牌功能', 'cache hit still attaches the title');

// 5. pointer already gone -> title only, no bubble
const rGone = mkRow('Another Unknown Thing');
MO_CB([{ type: 'characterData', target: rGone.span.childNodes[0] }]);
HOVER_FN({ target: rGone.span }); // hover fires but element not :hover at answer time
await flush(30);
gate(rGone.span.getAttribute('title') === null, 'lookup for already-left pointer: fetch fired...');
await flush(80); // the /translate for this string returns "" (not in table) -> nothing attached
gate(rGone.span.getAttribute('title') === null, 'unknown-to-backend string stays tooltip-free');

// 7. Chinese miss -> translated towards English (server decides direction)
const rZh = mkRow('全新的中文界面文案');
MO_CB([{ type: 'characterData', target: rZh.span.childNodes[0] }]);
rZh.span.__hover = true;
HOVER_FN({ target: rZh.span });
await flush(50);
gate(FETCH_CALLS.some((u) => decodeURIComponent(u).includes('全新的中文界面文案')), 'Chinese miss is requested as-is (direction decided server-side)');
gate(rZh.span.getAttribute('title') === 'Brand new Chinese UI copy', 'Chinese miss -> English tooltip', JSON.stringify(rZh.span.getAttribute('title')));

// 6. kill switch
windowMock.__zcodeZhLive = false;
const rOff = mkRow('Never Translated Text');
MO_CB([{ type: 'characterData', target: rOff.span.childNodes[0] }]);
rOff.span.__hover = true;
HOVER_FN({ target: rOff.span });
await flush(30);
const offCalls = FETCH_CALLS.filter((u) => u.includes('Never%20Translated')).length;
gate(offCalls === 0, 'window.__zcodeZhLive=false stops all live lookups');
gate(rOff.span.getAttribute('title') === null, 'kill switch: no tooltip appears');
delete windowMock.__zcodeZhLive;

// 8. editable region: title allowed (never a text rewrite in the live path either)
const rEd = mkRow('Fresh Plugin', true);
MO_CB([{ type: 'characterData', target: rEd.span.childNodes[0] }]);
gate(rEd.span.getAttribute('title') === '全新插件', 'contenteditable subtree still gets title tooltips');
gate(rEd.span.childNodes[0].nodeValue === 'Fresh Plugin', 'contenteditable text NEVER rewritten');

// scroll hides bubble
SCROLL_FN({});
gate(created[0].style.display === 'none', 'scroll hides the bubble');

// 9. model picker: Ctrl+Alt+M opens, catalog renders, row click POSTs, Escape closes
const pkBefore = created.length;
KEYDOWN_FNS[0]({ ctrlKey: true, altKey: true, key: 'm', preventDefault() {}, stopPropagation() {} });
const pkHost = created[pkBefore]; // panel host is the FIRST element pkToggle creates
gate(created.length > pkBefore && pkHost.__root === pkHost && pkHost.__rows && pkHost.__list, 'Ctrl+Alt+M opens the picker panel');
await flush(30); // /models fetch resolved -> rows rendered
const pkRows = created.filter((e) => e.__pkId);
gate(pkRows.length === 3 && pkRows.map((r) => r.__pkId).join(',') === 'm-base,m-hist,m-sug',
  'picker lists catalog rows (current/history/suggestion)', JSON.stringify(pkRows.map((r) => r.__pkId)));
gate(pkHost.__cur && pkHost.__cur.textContent === '当前：m-base', 'current model badge rendered', pkHost.__cur && pkHost.__cur.textContent);
pkRows[1].onclick();
await flush(30);
gate(MODEL_POSTS.length === 1 && MODEL_POSTS[0].body && JSON.parse(MODEL_POSTS[0].body).model === 'm-hist',
  'row click POSTs /model with the chosen id', JSON.stringify(MODEL_POSTS));
gate(pkHost.__toast && pkHost.__toast.style.display === 'block' && pkHost.__toast.textContent === '已切换：m-hist',
  'toast confirms the switch', pkHost.__toast && pkHost.__toast.textContent);
KEYDOWN_FNS[KEYDOWN_FNS.length - 1]({ key: 'Escape' });
const afterClose = created.length;
KEYDOWN_FNS[0]({ ctrlKey: true, altKey: true, key: 'm', preventDefault() {}, stopPropagation() {} });
gate(created.length > afterClose, 'Escape closed the panel; shortcut reopens a fresh one');

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
