import fs from 'node:fs';

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
const item = L.find((x) => x.path.includes('skillStore'));
if (!item) { console.log('skillStore not found'); process.exit(0); }
const size = Number(item.entry.size);
const off = Number(item.entry.offset);
const s = all.subarray(dataStart + off, dataStart + off + size).toString('utf8');
console.log('skillStore chunk:', item.path, size, 'bytes');
for (const pat of ['pluginName', 'displayName', 'scope', 'description', 'enabled']) {
  console.log(pat, '->', s.indexOf(pat));
}
// find how the skill name/description shape is built: look for object literal patterns
let i = s.indexOf('description');
if (i >= 0) console.log('ctx1:', JSON.stringify(s.slice(Math.max(0, i - 400), i + 700)));
