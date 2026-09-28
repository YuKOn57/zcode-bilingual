/**
 * Truncation fallback + inline bilingual extraction (2026-09-28 user reports):
 *
 *   Report 1: plugin-authored bilingual descriptions ("English / 中文") never
 *   match the dictionary, so CSS-truncated rows (span.truncate) showed NO tooltip
 *   and the Chinese tail was unreachable -- /mimosa-deep-audit showed
 *   "Reproducible, sealed Mimosa deep security audit. / 运行可复核的 Mi…".
 *   -> truncFull(): on a dictionary miss, if the element (or a row-like ancestor)
 *      is actually clipped (scroll > client), attach its FULL text as the tooltip.
 *
 *   Report 2 (same day): even a FULLY visible inline Chinese half should come out
 *   as a hover tooltip -- the app renders it in a dim color that is hard to read
 *   (/apply: "Enable hover-to-translate tooltips in ZCode / 启用界面悬停翻译（…）").
 *   -> inlineZh(): extract the Chinese half after the last " / " directly from the
 *      text (no dictionary), for clipped, fully visible and unrendered rows alike.
 *
 * DOM shape per the REAL picker (captured over CDP, see _helper_picker_test.mjs):
 *   div listbox (overflow-y-auto, may be scrolled)
 *     div > button            (row)
 *       span.truncate  "/name"
 *       span.truncate  "插件 · <desc>"   <-- clipped by CSS
 */
import { rendererHelper } from '../bin/zcode-zh.mjs';

let pass = 0, fail = 0;
const gate = (ok, label, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); ok ? pass++ : fail++; };

function El(tag) { this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = []; this.nodeType = 1; this.isContentEditable = false; this.parentNode = null; }
Object.defineProperty(El.prototype, 'textContent', { get() { let s = ''; for (const c of this.childNodes) s += c.nodeType === 3 ? c.nodeValue : (c.textContent || ''); return s; } });
El.prototype.getAttribute = function (n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; };
El.prototype.setAttribute = function (n, v) { const a = this.attributes.find((x) => x.name === n); if (a) a.value = v; else this.attributes.push({ name: n, value: v }); };
El.prototype.removeAttribute = function (n) { this.attributes = this.attributes.filter((x) => x.name !== n); };
Object.defineProperty(El.prototype, 'parentElement', { get() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; } });
function Txt(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }
/** lay(e, sw, cw, sh, ch): fake layout numbers. omitted -> undefined (never clipped) */
const lay = (e, sw, cw, sh, ch) => { if (sw != null) { e.scrollWidth = sw; e.clientWidth = cw; e.scrollHeight = sh; e.clientHeight = ch; } };
const el = (tag, parent, text) => { const e = new El(tag); if (parent) { parent.childNodes.push(e); e.parentNode = parent; } if (text != null) { const t = new Txt(text); e.childNodes.push(t); t.parentNode = e; } return e; };

const BILINGUAL_A = 'Reproducible, sealed Mimosa deep security audit. / 运行可复核的 Mimosa 深度安全审计。';
const ZH_A = '运行可复核的 Mimosa 深度安全审计。';
const BILINGUAL_B = 'Enable hover-to-translate tooltips in ZCode / 启用界面悬停翻译（原文与排版不变）';
const ZH_B = '启用界面悬停翻译（原文与排版不变）';
const LONG_EN = 'A very long English-only description with no inline Chinese and no dictionary entry whatsoever.';
const LONG_ZH = '这是一个很长的纯中文描述没有任何英文也没有词典条目因此只能靠截断兜底把全文挂上悬浮提示的测试用例。';
const SHORT = '插件 · 短描述';

const body = new El('body');
const popup = el('div', body);
const listbox = el('div', popup); // scrolled: clipped, but a plain div -> must never become a tooltip
lay(listbox, 400, 400, 500, 224);
const mkRow = (name) => {
  const rowWrap = el('div', listbox);
  const button = el('button', rowWrap); lay(button, 420, 420, 32, 32);
  const nameSpan = el('span', button); lay(nameSpan, 120, 120, 20, 20);
  const desc = el('span', button); lay(desc, 120, 120, 20, 20);
  nameSpan.childNodes.push(new Txt(name)); nameSpan.childNodes[0].parentNode = nameSpan;
  desc.childNodes.push(new Txt('')); desc.childNodes[0].parentNode = desc;
  return { rowWrap, button, nameSpan, desc };
};
const setDesc = (r, text) => { r.desc.childNodes[0].nodeValue = text; };

const rA = mkRow('/mimosa-deep-audit');
setDesc(rA, '插件 · ' + BILINGUAL_A);
lay(rA.desc, 300, 200, 20, 20); // <-- CSS-truncated
const rB = mkRow('/apply');
setDesc(rB, '插件 · ' + BILINGUAL_B); // fully visible, nothing clipped (layout undefined)
const rC = mkRow('/pure-zh');
setDesc(rC, LONG_ZH);
lay(rC.desc, 5, 0, 5, 0); // zero client size (not rendered) -> truncFull must ignore
const rD = mkRow('/row-clipped');
setDesc(rD, '插件 · ' + LONG_EN); // desc not clipped, but the ROW button is (real rows carry the label prefix)
lay(rD.button, 300, 200, 32, 32);
const rE = mkRow('/zh-clipped');
setDesc(rE, LONG_ZH);
lay(rE.desc, 300, 200, 20, 20); // clipped pure Chinese -> truncFull full text
const rF = mkRow('/no-false-positive');
setDesc(rF, '插件 · TCP / IP, on / off, 设置 / 语言, path C:/Users/foo, https://example.com/a');
const rG = mkRow('/unrendered');
setDesc(rG, '插件 · ' + BILINGUAL_A); // zero-size but bilingual -> inlineZh ignores layout
lay(rG.desc, 5, 0, 5, 0);

const document = { documentElement: new El('html'), body, readyState: 'complete', addEventListener() {} };
const window = { __zcodeZhDict: {}, __zcodeZhDictFiles: {}, __zcodeZhOverrideText: {} };
let MO_CB = null;
global.window = window; global.document = document;
global.MutationObserver = function (cb) { MO_CB = cb; this.observe = function () {}; };

eval(rendererHelper('{}'));

// initial walk (readyState complete -> boot() walked body immediately)
gate(rA.desc.getAttribute('title') === ZH_A, 'clipped bilingual desc -> hover shows the CHINESE half', JSON.stringify(rA.desc.getAttribute('title')));
gate(rA.button.getAttribute('title') === ZH_A, 'row <button> widened as the hover target');
gate(rB.desc.getAttribute('title') === ZH_B, 'FULLY VISIBLE bilingual desc ALSO shows the Chinese half (the /apply report)', JSON.stringify(rB.desc.getAttribute('title')));
gate(rB.button.getAttribute('title') === ZH_B, 'fully visible row: <button> hover target too');
gate(rC.desc.getAttribute('title') === null, 'zero-size (unrendered) element: truncFull guard holds');
gate(rD.button.getAttribute('title') === LONG_EN && rD.desc.getAttribute('title') === null, 'clipped row-like ancestor carries the full ENGLISH text (no Chinese to extract)', JSON.stringify(rD.button.getAttribute('title')));
gate(rE.desc.getAttribute('title') === LONG_ZH, 'clipped pure-Chinese desc -> full text via truncFull', JSON.stringify(rE.desc.getAttribute('title')));
gate(rF.desc.getAttribute('title') === null, 'TCP/IP, on/off, 设置/语言, C:/path, URLs do NOT grow a tooltip', JSON.stringify(rF.desc.getAttribute('title')));
gate(listbox.getAttribute('title') === null, 'clipped scrolling listbox (plain div) never becomes a tooltip');
gate(rG.desc.getAttribute('title') === ZH_A, 'inline bilingual works even on a not-yet-rendered element (layout-independent)');

// ---- recycling: virtual list reuses the row for another item ----
if (!MO_CB) { console.log('  FAIL  could not capture the observer callback'); fail++; }
else {
  setDesc(rA, '插件 · ' + BILINGUAL_B);
  MO_CB([{ type: 'characterData', target: rA.desc.childNodes[0] }]);
  gate(rA.desc.getAttribute('title') === ZH_B && rA.button.getAttribute('title') === ZH_B, 'recycled row: Chinese tooltip replaced with the new item translation');
  setDesc(rA, SHORT);
  MO_CB([{ type: 'characterData', target: rA.desc.childNodes[0] }]);
  gate(rA.desc.getAttribute('title') === null && rA.button.getAttribute('title') === null, 'recycled to a short plain text: tooltip dropped entirely');
  setDesc(rA, '插件 · ' + BILINGUAL_A);
  MO_CB([{ type: 'characterData', target: rA.desc.childNodes[0] }]);
  gate(rA.desc.getAttribute('title') === ZH_A, 'recycled back: Chinese tooltip restored');
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
