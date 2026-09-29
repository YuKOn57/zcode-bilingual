// Retry: attach the setup zip to the existing v0.5.2 release (buffer body).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = 'YuKOn57/zcode-bilingual';
const TAG = 'v0.5.2';
const ZIP = 'C:/Users/YuKOn/Documents/zcode/dist/zcode-bilingual-setup-v0.5.2.zip';

const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const tok = (out.split('\n').find((l) => l.startsWith('password=')) || '').slice('password='.length).trim();
if (!tok) { console.error('no credential'); process.exit(1); }
const auth = { Authorization: `Bearer ${tok}`, 'User-Agent': 'zcode-bilingual-release' };

const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: auth });
const rel = await relRes.json();
if (!relRes.ok) { console.error('release fetch failed:', relRes.status); process.exit(1); }
console.log('release:', rel.id, rel.html_url);

const existing = (rel.assets || []).find((a) => a.name === 'zcode-bilingual-setup-v0.5.2.zip');
if (existing) { console.log('asset already present:', existing.name, existing.state); process.exit(0); }

const buf = fs.readFileSync(ZIP);
const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=zcode-bilingual-setup-v0.5.2.zip`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) },
  body: buf,
});
const asset = await up.json();
if (!up.ok) { console.error('upload failed:', up.status, JSON.stringify(asset).slice(0, 300)); process.exit(1); }
console.log('asset uploaded:', asset.name, (asset.size / 2 ** 20).toFixed(1) + 'MB', 'state=' + asset.state);
