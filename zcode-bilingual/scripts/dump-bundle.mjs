import fs from 'node:fs';
import path from 'node:path';

const asarPath = 'C:/Users/YuKOn/AppData/Local/Programs/ZCode/resources/app.asar';
const all = fs.readFileSync(asarPath);
const hpl = all.readUInt32LE(4);
const hp = all.subarray(8, 8 + hpl);
const jl = hp.readUInt32LE(4);
const header = JSON.parse(hp.subarray(8, 8 + jl).toString('utf8'));
const dataStart = 8 + hpl;

function leaves(node, prefix, out) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (val.files) leaves(val, p, out);
    else out.push({ path: p, entry: val });
  }
  return out;
}
const L = leaves(header, '', []);
const js = L.filter(({ path: p, entry }) => !entry.unpacked && /\.js$/.test(p) && p.startsWith('/out/renderer/'));

const NEEDLES = ['settings.hooks.event', 'settings.hooks.add', 'settings.skills.searchPlaceholder', 'settings.plugin.skills.newSkill'];
for (const n of NEEDLES) {
  const hits = [];
  for (const item of js) {
    const size = Number(item.entry.size);
    if (size > 8 * 1024 * 1024) continue;
    const off = Number(item.entry.offset);
    const src = all.subarray(dataStart + off, dataStart + off + size).toString('utf8');
    if (src.includes(n)) hits.push(item.path.replace('/out/renderer/', '') + `(${size})`);
  }
  console.log(n, '->', hits.join(' | '));
}
