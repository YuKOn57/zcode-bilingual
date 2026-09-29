// CDP probe for the in-window model picker: diag | pick <id> | default | rows
const targets = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = targets.find((t) => t.type === 'page' && /ZCode/i.test(t.title || ''));
if (!page) { console.log('NO PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev2 = (expr) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));

const FIND = "var all=document.querySelectorAll('div');var h=null;for(var i=0;i<all.length;i++){if(all[i].style&&all[i].style.zIndex==='2147483646'){h=all[i];break;}}";
const action = process.argv[2] || 'pick';
const modelId = process.argv[3] || 'cn:deepseek-v4-flash';

if (action === 'diag') {
  const r = await ev2("(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));return 'dispatched';})()");
  console.log('key:', r.result?.result?.value);
  await sleep(1200);
  const r2 = await ev2("(function(){var out=[];var kids=document.documentElement.children;for(var i=0;i<kids.length;i++){var k=kids[i];if(k.tagName==='DIV'&&k.style&&k.style.position==='fixed')out.push('z='+k.style.zIndex+' shadow='+(k.shadowRoot?'Y':'N'));}return out.join(' ; ')||'NO-FIXED-DIVS';})()");
  console.log('overlays:', r2.result?.result?.value);
} else if (action === 'pick') {
  // open the panel only if it is not already up (a second Ctrl+Alt+M would close it)
  const open = await ev2("(function(){" + FIND + "return h&&h.shadowRoot?'OPEN':'CLOSED';})()");
  if ((open.result?.result?.value) !== 'OPEN') {
    await ev2("(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));return 1;})()");
    await sleep(1500);
  }
  const r2 = await ev2("(function(){" + FIND + "if(!h||!h.shadowRoot)return 'NO-PANEL';var ds=h.shadowRoot.querySelectorAll('div');for(var k=0;k<ds.length;k++){if(ds[k].__pkId===" + JSON.stringify(modelId) + "){ds[k].click();return 'CLICKED';}}return 'ROW-NOT-FOUND';})()");
  console.log('pick:', r2.result?.result?.value);
} else if (action === 'rows') {
  const r = await ev2("(function(){" + FIND + "if(!h||!h.shadowRoot)return 'NO-PANEL';var ds=h.shadowRoot.querySelectorAll('div');var n=[];for(var k=0;k<ds.length;k++){if(ds[k].__pkId)n.push(ds[k].__pkId);}return 'COUNT='+n.length+' FIRST='+n.slice(0,6).join('|');})()");
  console.log('rows:', r.result?.result?.value);
} else if (action === 'default') {
  const r = await ev2("(function(){" + FIND + "if(!h||!h.shadowRoot)return 'NO-PANEL';var ds=h.shadowRoot.querySelectorAll('div');for(var k=0;k<ds.length;k++){if(ds[k].textContent==='恢复默认（不指定）'){ds[k].click();return 'DEFAULT-CLICKED';}}return 'DEFAULT-NOT-FOUND';})()");
  console.log('default:', r.result?.result?.value);
}
process.exit(0);
