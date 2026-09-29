// Hot-inject the CURRENT helper into the RUNNING ZCode renderer (temporary bridge
// until the next natural re-patch bakes it). Usage: node scripts/hot-inject.mjs
import { rendererHelper } from '../bin/zcode-zh.mjs';

const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find((t) => t.type === 'page' && /ZCode/i.test(t.title || ''));
if (!page) { console.log('NO PAGE TARGET'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function evalJs(expression) {
  return new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

// 1. inject the new helper (marker v5 not yet in the running build -> it boots)
const src = rendererHelper('{}');
const inj = await evalJs(src);
console.log('inject:', JSON.stringify(inj.result?.result?.value ?? inj.result?.result?.description ?? 'ok').slice(0, 120));

// 2. wait for boot (helper default 4s) + /dict fetch
await new Promise((r) => setTimeout(r, 5200));
const state = await evalJs(`(function(){
  return { marker5: !!window.__zcodeZhTitle5, dictKeys: Object.keys(window.__zcodeZhDict||{}).length };
})()`);
console.log('state after boot:', JSON.stringify(state.result?.result?.value));

// 3. in-page live test: unknown English string -> mouseover -> /translate -> title
const test = await evalJs(`(async function(){
  const el = document.createElement('div');
  el.id = 'zcb-live-test';
  el.style.cssText = 'position:fixed;left:40px;bottom:8px;z-index:1;font-size:12px;color:#888;pointer-events:none;';
  el.textContent = 'Zephyr Quorum Resonator Probe';
  document.body.appendChild(el);
  await new Promise((r) => setTimeout(r, 300));
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (el.getAttribute('title')) break;
  }
  const out = { title: el.getAttribute('title'), rowTitle: el.parentElement ? el.parentElement.getAttribute('title') : null };
  el.remove();
  return out;
})()`);
console.log('in-page live translate:', JSON.stringify(test.result?.result?.value));
ws.close();
