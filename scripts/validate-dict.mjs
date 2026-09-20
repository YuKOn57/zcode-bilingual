import fs from 'node:fs';

const DICT_PATH = 'C:/Users/YuKOn/Documents/zcode/zcode-bilingual-plugin/dictionary.json';
const normalize = (s) => String(s).replace(/\s+/g, ' ').trim();

const raw = fs.readFileSync(DICT_PATH, 'utf8');
let dict;
try {
  dict = JSON.parse(raw);
} catch (e) {
  console.error('JSON PARSE FAILED:', e.message);
  process.exit(1);
}
console.log('JSON OK, entries:', Object.keys(dict).length);

// Simulate patcher merge logic (buildDictionary): skip "_" keys, normalize keys.
const seen = new Map();
let dupes = 0;
for (const [k, v] of Object.entries(dict)) {
  if (k.startsWith('_')) continue;
  const nk = normalize(k);
  if (seen.has(nk)) {
    dupes++;
    console.log('DUPLICATE normalized key:', JSON.stringify(nk));
    console.log('  first ->', JSON.stringify(seen.get(nk)));
    console.log('  now   ->', JSON.stringify(v));
  } else {
    seen.set(nk, v);
  }
}
console.log('duplicate normalized keys:', dupes);
