/**
 * Behaviour test for the CODE/PRE tooltip path (skill / agent NAME chips).
 *
 * Regression covered: skill and subagent names are frequently rendered as a
 * <code> chip, and the deep walk deliberately stops at PRE/CODE -- so a name
 * that IS in the dictionary still showed no tooltip. handleCode() now gives
 * short (<=80 chars) code text a tooltip while leaving real code blocks alone.
 *
 * Runs the REAL helper (imported from the patcher) against a mock DOM.
 *   node _helper_code_test.mjs
 */
import { rendererHelper } from '../bin/zcode-zh.mjs';

let pass = 0, fail = 0;
const gate = (ok, label, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); ok ? pass++ : fail++; };

// ---- minimal DOM (same shape the helper expects) ----
function El(tag) {
  this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = [];
  this.nodeType = 1; this.isContentEditable = false; this.parentNode = null;
}
// Real DOM semantics: textContent is the concatenation of all descendant text.
Object.defineProperty(El.prototype, 'textContent', {
  get() {
    let s = '';
    for (const c of this.childNodes) s += c.nodeType === 3 ? c.nodeValue : (c.textContent || '');
    return s;
  },
});
El.prototype.getAttribute = function (n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; };
El.prototype.setAttribute = function (n, v) { const a = this.attributes.find((x) => x.name === n); if (a) a.value = v; else this.attributes.push({ name: n, value: v }); };
function Txt(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }

function buildDom(spec) {
  const docEl = new El('html'); const body = new El('body'); body.parentNode = docEl;
  const out = [];
  for (const s of spec) {
    const el = new El(s.tag); body.childNodes.push(el); el.parentNode = body;
    if (s.text != null) { const t = new Txt(s.text); el.childNodes.push(t); t.parentNode = el; }
    if (s.nested) { // syntax-highlight shape: <code><span>name</span></code>
      const sp = new El('span'); el.childNodes.push(sp); sp.parentNode = el;
      const t = new Txt(s.nested); sp.childNodes.push(t); t.parentNode = sp;
    }
    out.push(el);
  }
  return { body, docEl, els: out };
}

const DICT = {
  'build-mcpb': '打包 MCPB',
  'scan-loader': '扫描加载器',
  'zcode-bilingual': 'ZCode 中英双语（悬停翻译）',
  'Plain label': '普通标签',
};
const LONG = 'const x = ' + 'a'.repeat(300) + ';';

const dom = buildDom([
  { tag: 'code', text: 'build-mcpb' },          // skill name chip  -> tooltip
  { tag: 'code', nested: 'scan-loader' },        // agent name chip with <span> -> tooltip
  { tag: 'pre', text: LONG },                    // real code block  -> NO tooltip
  { tag: 'div', text: 'Plain label' },           // normal text      -> tooltip
  { tag: 'code', text: 'untranslated_thing' },   // not in dict      -> NO tooltip
]);

const document = { documentElement: dom.docEl, body: dom.body, readyState: 'complete', addEventListener() {} };
const window = { __zcodeZhDict: DICT, __zcodeZhDictFiles: {}, __zcodeZhOverrideText: {} };
global.window = window; global.document = document;
global.MutationObserver = function () { this.observe = function () {}; };

// boot() runs -> walk(body)
// eslint-disable-next-line no-eval
eval(rendererHelper('{}'));

const [codeChip, codeNested, preBlock, divText, codeUnknown] = dom.els;
// A tooltip may land on the element itself or on the inner element carrying the
// text node (applyTo sets it on the text node's parent) -- both show on hover.
const tipOf = (el) => el.getAttribute('title') || (el.childNodes.find?.((c) => c.nodeType === 1)?.getAttribute('title') ?? null);
gate(codeChip.getAttribute('title') === '打包 MCPB', 'code chip (skill name) got tooltip', String(codeChip.getAttribute('title')));
gate(codeChip.childNodes[0].nodeValue === 'build-mcpb', 'code chip visible text unchanged');
gate(tipOf(codeNested) === '扫描加载器', 'code chip with nested <span> got tooltip', String(tipOf(codeNested)));
gate(preBlock.getAttribute('title') === null, 'long <pre> code block got NO tooltip');
gate(divText.getAttribute('title') === '普通标签', 'normal text still gets tooltip');
gate(codeUnknown.getAttribute('title') === null, 'unknown code text got NO tooltip');

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
