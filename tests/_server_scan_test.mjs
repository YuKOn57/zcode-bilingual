/**
 * dict-server pure units: manifest harvesting + translation prompting.
 *
 * Harvest rules must match the established dictionary conventions:
 *   - plugin.json name/description in; author out
 *   - skills/agents: frontmatter name + description; commands: description
 *   - argument-hint out; already-bilingual (EN+CJK) strings out of the harvest
 *   - prompt direction: EN-only batch -> Simplified Chinese, CJK batch -> English
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const gate = (ok, label, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`); ok ? pass++ : fail++; };

// dict-server reads DATA_DIR at import time -> point it at a temp dir FIRST
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcb-live-test-'));
process.env.ZCB_DATA_DIR = TMP;
const { parseFrontmatter, collectStringsFromPluginDir, filterTranslatable, translationPrompt, translateBatchWith, harvestTick, loadLearned, resolveBackend, modelChoice, applyModelChoice, pushModelHistory, modelsCatalog, requestAllowed } = await import('../scripts/dict-server.mjs');

// ---- parseFrontmatter ----
const fm = parseFrontmatter([
  '---',
  'name: build-mcpb',
  'description: >',
  '  Build an MCPB package',
  '  from a plugin directory.',
  'argument-hint: <dir>',
  '---',
  '',
].join('\n'));
gate(fm.name === 'build-mcpb', 'frontmatter: name parsed');
gate(fm.description === 'Build an MCPB package from a plugin directory.', 'frontmatter: folded description joined', JSON.stringify(fm.description));
gate(fm['argument-hint'] === '<dir>', 'frontmatter: argument-hint readable (harvest just ignores it)');

// ---- collectStringsFromPluginDir on a fixture plugin ----
const fix = path.join(TMP, 'fixture-plugin');
fs.mkdirSync(path.join(fix, '.zcode-plugin'), { recursive: true });
fs.mkdirSync(path.join(fix, 'skills', 'alpha'), { recursive: true });
fs.mkdirSync(path.join(fix, 'commands'), { recursive: true });
fs.mkdirSync(path.join(fix, 'agents'), { recursive: true });
fs.writeFileSync(path.join(fix, '.zcode-plugin', 'plugin.json'), JSON.stringify({
  name: 'fixture-plugin',
  description: 'A fixture plugin for the harvest test',
  author: { name: 'Some Company' },
}));
fs.writeFileSync(path.join(fix, 'skills', 'alpha', 'SKILL.md'), [
  '---', 'name: alpha-skill', 'description: Builds things quickly and well', '---', 'body',
].join('\n'));
fs.writeFileSync(path.join(fix, 'commands', 'go.md'), [
  '---', 'description: Run the fixture build', 'argument-hint: [target]', '---', 'body',
].join('\n'));
fs.writeFileSync(path.join(fix, 'agents', 'helper.md'), [
  '---', 'name: fixture-agent', 'description: A fixture subagent that helps', '---', 'body',
].join('\n'));

const got = new Set();
collectStringsFromPluginDir(fix, got);
const expect = new Set([
  'fixture-plugin', 'A fixture plugin for the harvest test',
  'alpha-skill', 'Builds things quickly and well',
  'Run the fixture build',
  'fixture-agent', 'A fixture subagent that helps',
]);
let missing = [...expect].filter((x) => !got.has(x));
gate(missing.length === 0, 'harvest: all UI-visible strings collected', JSON.stringify(missing));
gate(![...got].some((s) => /Some Company/.test(s)), 'harvest: author never collected');
gate(![...got].some((s) => s.includes('[target]')), 'harvest: argument-hint never collected');

// ---- filterTranslatable ----
const filt = filterTranslatable(new Set([
  'Pure English string',                       // keep (en -> zh)
  '纯中文的字符串',                              // keep (zh -> en)
  'English / 中文 bilingual line',              // drop (inline path already covers)
  '12345 !!!',                                  // drop (no letters)
  'ab',                                         // keep (>=2)
  '',                                           // drop
  'x'.repeat(601),                              // drop (too long)
]));
gate(filt.has('Pure English string') && filt.has('纯中文的字符串') && filt.has('ab'), 'filter keeps single-language strings');
gate(filt.size === 3, `filter drops bilingual/no-letter/oversized (got ${filt.size}, want 3)`, JSON.stringify([...filt]));

// ---- translationPrompt direction ----
gate(translationPrompt(['Hello world']).content.includes('Simplified Chinese'), 'EN batch targets Simplified Chinese');
gate(translationPrompt(['你好世界']).content.includes('English'), 'CJK batch targets English');

// ---- translateBatchWith: batch JSON parsing ----
const implBatch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const items = JSON.parse(body.messages[1].content.split('\n\n')[1]);
  const map = {};
  for (const it of items) map[it] = '译:' + it;
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(map) } }] }) };
};
const batch = await translateBatchWith(implBatch, { baseURL: 'http://x', apiKey: 'k', model: 'm' }, ['a one', 'b two']);
gate(batch.get('a one') === '译:a one' && batch.get('b two') === '译:b two', 'batch translation maps every item', JSON.stringify([...batch]));

// ---- harvestTick: learn loop + persistence + attempt cap ----
loadLearned();
let calls = 0;
const implCount = async () => {
  calls++;
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      'Brand new plugin description': '全新插件描述',
      'Known string': '已知字符串',
    }) } }] }),
  };
};
const backend = { baseURL: 'http://x', apiKey: 'k', model: 'm' };
const strings = new Set(['Brand new plugin description', 'Known string']);
const n1 = await harvestTick(strings, implCount, backend, { lastRequestAt: 0 });
gate(n1 === 2, 'harvest translates unknown strings', String(n1));
const learnedNow = JSON.parse(fs.readFileSync(path.join(TMP, 'learned.json'), 'utf8'));
gate(learnedNow['Brand new plugin description'] && learnedNow['Brand new plugin description'].t === '全新插件描述', 'harvest result persisted to learned.json');
const n2 = await harvestTick(strings, implCount, backend, { lastRequestAt: 0 });
gate(n2 === 0 && calls === 1, 'harvest skips already-learned strings');

// ---- harvest idle guard ----
const n3 = await harvestTick(strings, implCount, backend, { lastRequestAt: Date.now() });
gate(n3 === 0, 'harvest pauses right after a hover request (idle guard)');

// ---- model choice: knob > gateway field > default (hermetic via wbOverride) ----
const fakeWb = { listen: '127.0.0.1:7863', api_key: 'test-key' };
gate(resolveBackend({ translateDisabled: true }, fakeWb) === null, 'translateDisabled -> no backend');
const rbDefault = resolveBackend({}, fakeWb);
gate(rbDefault && rbDefault.model === 'deepseek-v4.1-flash' && rbDefault.modelSource === 'built-in default' && rbDefault.source === 'wb2api',
  'no model anywhere -> built-in fallback', JSON.stringify(rbDefault));
const rbKnob = resolveBackend({ model: 'my-model' }, fakeWb);
gate(rbKnob && rbKnob.model === 'my-model' && rbKnob.modelSource === 'live-config.json model', 'top-level model knob wins over fallback');
const rbGw = resolveBackend({}, { listen: '127.0.0.1:9999', api_key: 'k', defaultModel: 'gw-model' });
gate(rbGw && rbGw.model === 'gw-model' && rbGw.modelSource === 'wb2api config', 'gateway config model honored when no knob set');
const rbCustom = resolveBackend({ model: 'top', backend: { baseURL: 'http://x/', apiKey: 'k', model: 'custom-m' } }, fakeWb);
gate(rbCustom && rbCustom.model === 'custom-m' && rbCustom.baseURL === 'http://x', 'backend.model beats top-level knob; baseURL trailing slash stripped');
const rbCustomNoModel = resolveBackend({ model: 'top', backend: { baseURL: 'http://x', apiKey: 'k' } }, fakeWb);
gate(rbCustomNoModel && rbCustomNoModel.model === 'top', 'backend block without model falls through to the knob');
gate(resolveBackend({}, null) === null, 'no gateway and no custom backend -> null');
gate(modelChoice({}, null, false).model === 'deepseek-v4.1-flash', 'modelChoice default');

// ---- loopback gate: local app yes, foreign web pages no ----
const H = (host, origin) => (origin === undefined ? { host } : { host, origin });
gate(requestAllowed({ host: '127.0.0.1:17981' }) === true, 'no Origin header (curl/hooks/server) passes');
gate(requestAllowed(H('127.0.0.1:17981', 'null')) === true, 'file:// renderer (Origin null) passes');
gate(requestAllowed(H('127.0.0.1:17981', 'file:///C:/app.asar/index.html')) === true, 'file:// origin string passes');
gate(requestAllowed(H('127.0.0.1:17981', 'app://zcode/index.html')) === true, 'app:// origin passes');
gate(requestAllowed(H('localhost:17982', undefined)) === true, 'localhost host passes');
gate(requestAllowed(H('[::1]:17981', undefined)) === true, 'IPv6 loopback host passes');
gate(requestAllowed(H('127.0.0.1:17981', 'https://evil.example')) === false, 'https origin rejected');
gate(requestAllowed(H('127.0.0.1:17981', 'http://evil.example')) === false, 'http origin rejected');
gate(requestAllowed(H('attacker.example:17981', undefined)) === false, 'rebound Host rejected');
gate(requestAllowed({}, 17981) === true || requestAllowed({}, 17981) === false, 'missing host does not throw');

// ---- picker write path: applyModelChoice persists knob + history to live-config.json ----
const cfgPath = path.join(TMP, 'live-config.json');
fs.writeFileSync(cfgPath, JSON.stringify({}), 'utf8');
const ch1 = applyModelChoice({ model: 'glm-test-model' });
gate(ch1.ok === true && ch1.where === 'model', 'applyModelChoice writes the top-level knob', JSON.stringify(ch1));
let cfgOnDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
gate(cfgOnDisk.model === 'glm-test-model' && Array.isArray(cfgOnDisk.modelHistory) && cfgOnDisk.modelHistory[0] === 'glm-test-model',
  'choice + history persisted', JSON.stringify(cfgOnDisk));
fs.writeFileSync(cfgPath, JSON.stringify({ backend: { baseURL: 'http://x', apiKey: 'k' } }), 'utf8');
const ch2 = applyModelChoice({ model: 'custom-m' });
gate(ch2.ok === true && ch2.where === 'backend.model' && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).backend.model === 'custom-m',
  'custom backend gets backend.model', JSON.stringify(ch2));
const ch3 = applyModelChoice({ default: true });
gate(ch3.ok === true && ch3.where === 'removed' && !JSON.parse(fs.readFileSync(cfgPath, 'utf8')).backend.model,
  'default:true removes the knob', JSON.stringify(ch3));
gate(applyModelChoice({ model: 'bad id!' }).ok === false && applyModelChoice('nope').ok === false, 'invalid choices rejected');
const hist1 = pushModelHistory(['a', 'b', 'c'], 'a', 3);
gate(hist1.join(',') === 'a,b,c', 'history dedupes and moves to front');
gate(pushModelHistory(['a', 'b', 'c'], 'd', 3).join(',') === 'd,a,b', 'history capped at the newest entries');
const cat = modelsCatalog({ modelHistory: ['hist-m'] }, { model: 'cur-m' }, ['gw-m', 'cur-m']);
gate(cat[0].id === 'cur-m' && cat[0].source === 'current' && cat[1].id === 'hist-m' && cat[2].id === 'gw-m'
  && cat.some((x) => x.id === 'deepseek-v4.1-flash'),
  'catalog order: current > history > gateway > suggestions', JSON.stringify(cat));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
