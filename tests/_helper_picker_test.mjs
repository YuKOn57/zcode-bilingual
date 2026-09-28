/**
 * Reproduces the REAL picker DOM captured over CDP from the live app:
 *
 *   div.absolute.inset-x-0.bottom-full          (popup container)
 *     div.max-h-56.overflow-y-auto              (scrolling listbox -- MANY rows)
 *       div > button                            (row; recycled by the virtual list)
 *         span.truncate  "$codespace"           (name chip: sigil $)
 *         span.truncate  "插件 · Create, list, ..."  (label + desc in ONE text node)
 *
 * Defects pinned down (all observed live):
 *   1. description prefixed with "<label> · "  -> exact match failed
 *   2. name prefixed with "$" / "/"            -> exact match failed
 *   3. recycled rows kept the PREVIOUS row's tooltip
 *   4. the big scrolling listbox inherited a row's tooltip (ancestor walk too wide)
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
const el = (tag, parent, text) => { const e = new El(tag); if (parent) { parent.childNodes.push(e); e.parentNode = parent; } if (text != null) { const t = new Txt(text); e.childNodes.push(t); t.parentNode = e; } return e; };

const DESC1 = 'Create, list, connect to, stop, or delete GitHub Codespaces. Use when the user explicitly wants to manage a remote Codespaces development environment, not for cloning a repository locally.';
const DESC2 = 'Create a local Git commit from staged changes using a conventional commit message. Use when the user wants to record already prepared changes locally.';
const DICT = {
  codespace: '代码空间（Codespace）',
  commit: '本地提交',
  [DESC1]: '创建、列出、连接、停止或删除 GitHub Codespace。',
  [DESC2]: '用规范的提交信息把已暂存的改动做成一次本地提交。',
};
const TR1 = '创建、列出、连接、停止或删除 GitHub Codespace。';

const body = new El('body');
const popup = el('div', body); popup.className = 'absolute inset-x-0 bottom-full z-20';
const listbox = el('div', popup); listbox.className = 'max-h-56 overflow-y-auto px-1';
const rowWrap = el('div', listbox);
const button = el('button', rowWrap); button.className = 'flex h-8 w-full items-center gap-3 rounded-xl px-3';
const nameSpan = el('span', button, '$codespace'); nameSpan.className = 'truncate';
const descSpan = el('span', button, '插件 · ' + DESC1); descSpan.className = 'truncate flex-1';
const rowWrap2 = el('div', listbox);
const button2 = el('button', rowWrap2);
el('span', button2, '$commit');
const descSpan2 = el('span', button2, '插件 · ' + DESC2);

const document = { documentElement: new El('html'), body, readyState: 'complete', addEventListener() {} };
const window = { __zcodeZhDict: DICT, __zcodeZhDictFiles: {}, __zcodeZhOverrideText: {} };
let MO_CB = null;
global.window = window; global.document = document;
global.MutationObserver = function (cb) { MO_CB = cb; this.observe = function () {}; };

eval(rendererHelper('{}'));

gate(descSpan.getAttribute('title') === TR1, 'description with "<label> · " prefix now gets a tooltip', String(descSpan.getAttribute('title')));
gate(nameSpan.getAttribute('title') === '代码空间（Codespace）', 'name chip "$codespace" now gets a tooltip (sigil stripped)', String(nameSpan.getAttribute('title')));
gate(button.getAttribute('title') === TR1, 'row <button> also carries the tooltip (easy hover target)', String(button.getAttribute('title')));
gate(descSpan2.getAttribute('title') === DICT[DESC2], 'second row matched its own entry', String(descSpan2.getAttribute('title')));
gate(listbox.getAttribute('title') === null, 'big scrolling listbox did NOT inherit a row tooltip', String(listbox.getAttribute('title')));

// ---- row recycling: same DOM node, text swapped to an item with no entry ----
if (!MO_CB) { console.log('  FAIL  could not capture the observer callback'); fail++; }
else {
  descSpan.childNodes[0].nodeValue = '插件 · Brand new item with no dictionary entry';
  MO_CB([{ type: 'characterData', target: descSpan.childNodes[0] }]);
  gate(descSpan.getAttribute('title') === null, 'recycled row DROPPED the stale tooltip on the span', String(descSpan.getAttribute('title')));
  gate(button.getAttribute('title') === null, 'recycled row ALSO dropped the stale tooltip on the ancestor <button>', String(button.getAttribute('title')));
  // and recycling back into a known item restores it
  descSpan.childNodes[0].nodeValue = '插件 · ' + DESC2;
  MO_CB([{ type: 'characterData', target: descSpan.childNodes[0] }]);
  gate(descSpan.getAttribute('title') === DICT[DESC2], 'recycled row then got the CORRECT new tooltip', String(descSpan.getAttribute('title')));
  gate(button.getAttribute('title') === DICT[DESC2], 'ancestor <button> re-acquired the correct tooltip', String(button.getAttribute('title')));
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
