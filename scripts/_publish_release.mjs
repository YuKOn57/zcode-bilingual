// Publish the current version's setup zip to a GitHub Release.
// Version, tag and zip name are derived from .zcode-plugin/plugin.json, so a
// new release needs no edits here: bump the manifest, run build.mjs, then
//
//   node scripts/_publish_release.mjs             # create release if missing, upload asset
//   node scripts/_publish_release.mjs --replace   # swap an existing asset
//
// The token comes from `git credential fill` (whatever git itself would use)
// and is never printed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'YuKOn57/zcode-bilingual';
const SELF = fileURLToPath(import.meta.url);
const PLUGIN = path.resolve(path.dirname(SELF), '..');
const DIST = path.resolve(PLUGIN, '..', 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.zcode-plugin', 'plugin.json'), 'utf8'));
const TAG = `v${manifest.version}`;
const ASSET = `zcode-bilingual-setup-${TAG}.zip`;
const ZIP = path.join(DIST, ASSET);
if (!fs.existsSync(ZIP)) { console.error('zip missing:', ZIP, '- run dist_src/build.mjs first'); process.exit(1); }

const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
const tok = (out.split('\n').find((l) => l.startsWith('password=')) || '').slice('password='.length).trim();
if (!tok) { console.error('no credential'); process.exit(1); }
const auth = { Authorization: `Bearer ${tok}`, 'User-Agent': 'zcode-bilingual-release' };

// Reuse the release for this tag; create it (pointing at the pushed tag) if absent.
const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: auth });
let rel = relRes.ok ? await relRes.json() : null;
if (!rel || !rel.id) {
  console.log('release for', TAG, 'not found; creating it on the pushed tag');
  const cr = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: TAG, name: TAG, body: `zcode-bilingual ${TAG} - see CHANGELOG.md in the repo for details.`, draft: false, prerelease: false }),
  });
  rel = await cr.json();
  if (!cr.ok) { console.error('release create failed:', cr.status, JSON.stringify(rel).slice(0, 300)); process.exit(1); }
}
console.log('release:', rel.id, rel.html_url);

const existing = (rel.assets || []).find((a) => a.name === ASSET);
if (existing) {
  if (process.argv[2] !== '--replace') { console.log('asset already present:', existing.name, existing.state); process.exit(0); }
  const del = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${existing.id}`, { method: 'DELETE', headers: auth });
  console.log('old asset deleted:', del.status === 204 ? 'ok' : del.status);
}

const buf = fs.readFileSync(ZIP);
const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${ASSET}`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) },
  body: buf,
});
const asset = await up.json();
if (!up.ok) { console.error('upload failed:', up.status, JSON.stringify(asset).slice(0, 300)); process.exit(1); }
console.log('asset uploaded:', asset.name, (asset.size / 2 ** 20).toFixed(1) + 'MB', 'state=' + asset.state);
