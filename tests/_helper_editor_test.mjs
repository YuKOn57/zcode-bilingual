/**
 * Reproduces the "in-composer slash/skill/agent picker has no tooltip" bug.
 *
 * Root cause hypothesis (from the shipped bundle): the composer is a
 * Lexical-style rich-text editor. Its autocomplete popup is rendered as a
 * decorator INSIDE the contenteditable root, with contentEditable="false" on the
 * decorator node. The helper skipped every element whose `isContentEditable`
 * was true (the property is INHERITED, so the whole editor subtree) -> the popup
 * was never processed.
 *
 * Constraints the fix must respect:
 *   - tooltips inside the editor ARE wanted (that's the popup)
 *   - text inside the editor must NEVER be rewritten (the editor owns that DOM;
 *     mutating it can desync the document model) -> no separator stripping there
 *
 *   node _helper_editor_test.mjs      (run with the CURRENT helper checked out)
 */
import { rendererHelper } from '../bin/zcode-zh.mjs';

let pass = 0, fail = 0;
const gate = (ok, label, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); ok ? pass++ : fail++; };

function El(tag, ce = false) {
  this.tagName = tag.toUpperCase(); this.childNodes = []; this.attributes = [];
  this.nodeType = 1; this.isContentEditable = ce; this.parentNode = null;
  if (ce) { /* mark subtree inherited below */ }
}
Object.defineProperty(El.prototype, 'textContent', {
  get() { let s = ''; for (const c of this.childNodes) s += c.nodeType === 3 ? c.nodeValue : (c.textContent || ''); return s; },
});
El.prototype.getAttribute = function (n) { const a = this.attributes.find((x) => x.name === n); return a ? a.value : null; };
El.prototype.setAttribute = function (n, v) { const a = this.attributes.find((x) => x.name === n); if (a) a.value = v; else this.attributes.push({ name: n, value: v }); };
function Txt(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; }

/** Real DOM: isContentEditable is inherited from the nearest contenteditable ancestor. */
function inheritCE(el, ce) {
  for (const c of el.childNodes) {
    if (c.nodeType !== 1) continue;
    if (c.__ceExplicit != null) inheritCE(c, c.__ceExplicit);
    else { c.isContentEditable = ce; inheritCE(c, ce); }
  }
}
function markCE(el, value) { el.__ceExplicit = value; el.isContentEditable = value; inheritCE(el, value); }

const DESC = 'Create, list, connect to, stop, or delete GitHub Codespaces. Use when the user explicitly wants to manage a remote Codespaces environment.';
const DICT = { codespace: '代码空间（Codespace）', [DESC]: '创建、列出、连接、停止或删除 GitHub Codespace。' };
const SEP = '\u2063';

// ---- build: body > div.composer[contenteditable] { p draft, div.decorator[ce=false] { code chip, span desc } } ----
const body = new El('body');
const composer = new El('div'); body.childNodes.push(composer); composer.parentNode = body;
const draft = new El('p'); composer.childNodes.push(draft); draft.parentNode = composer;
const draftTxt = new Txt('hello draft'); draft.childNodes.push(draftTxt); draftTxt.parentNode = draft;
const sepHost = new El('p'); composer.childNodes.push(sepHost); sepHost.parentNode = composer;
const sepTxt = new Txt('Settings' + SEP + '设置'); sepHost.childNodes.push(sepTxt); sepTxt.parentNode = sepHost;

const decorator = new El('div'); composer.childNodes.push(decorator); decorator.parentNode = composer;
decorator.setAttribute('role', 'option');
const chip = new El('code'); decorator.childNodes.push(chip); chip.parentNode = decorator;
const chipTxt = new Txt('codespace'); chip.childNodes.push(chipTxt); chipTxt.parentNode = chip;
const descEl = new El('span'); decorator.childNodes.push(descEl); descEl.parentNode = decorator;
const descTxt = new Txt(DESC); descEl.childNodes.push(descTxt); descTxt.parentNode = descEl;

markCE(composer, true);       // editor root editable -> whole subtree inherits true
markCE(decorator, false);     // decorator node: contentEditable="false"

const document = { documentElement: new El('html'), body, readyState: 'complete', addEventListener() {} };
const window = { __zcodeZhDict: DICT, __zcodeZhDictFiles: {}, __zcodeZhOverrideText: {} };
global.window = window; global.document = document;
global.MutationObserver = function () { this.observe = function () {}; };

eval(rendererHelper('{}'));   // boot() -> walk(body)

const tipOf = (el) => el.getAttribute('title') || (el.childNodes.find?.((c) => c.nodeType === 1)?.getAttribute('title') ?? null);

gate(!!chip.isContentEditable === false, 'mock: decorator node reports isContentEditable=false', String(chip.isContentEditable));
gate(tipOf(decorator) === '代码空间（Codespace）' || decorator.getAttribute('title') === '代码空间（Codespace）',
     'popup inside the EDITOR: name chip got a tooltip', String(tipOf(decorator) || decorator.getAttribute('title')));
gate(tipOf(descEl) === DICT[DESC] || decorator.getAttribute('title') === DICT[DESC],
     'popup inside the EDITOR: description got a tooltip', String(tipOf(descEl) || decorator.getAttribute('title')));
gate(draftTxt.nodeValue === 'hello draft', 'editable draft text NOT modified', JSON.stringify(draftTxt.nodeValue));
gate(sepTxt.nodeValue === 'Settings' + SEP + '设置', 'SEP text inside the editor NOT rewritten (editor owns that DOM)',
     JSON.stringify(sepTxt.nodeValue));

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
