// Merge the 8 translated batches back into dictionary.json, with integrity checks.
// Rerunnable: only adds keys that are not already present.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/YuKOn/Documents/zcode/zcode-bilingual-plugin';
const missing = JSON.parse(fs.readFileSync(path.join(ROOT, '_new_market_missing.json'), 'utf8'));
const dictPath = path.join(ROOT, 'dictionary.json');

const pairs = new Map(); // en -> zh
for (let i = 1; i <= 8; i++) {
  const arr = JSON.parse(fs.readFileSync(path.join(ROOT, '_batch_out', `batch-${i}-output.json`), 'utf8'));
  for (const { en, zh } of arr) {
    if (typeof en !== 'string' || typeof zh !== 'string' || !zh.trim()) {
      throw new Error(`batch-${i}: bad entry ${JSON.stringify(String(en).slice(0, 60))}`);
    }
    if (pairs.has(en)) throw new Error(`duplicate en across batches: ${en.slice(0, 60)}`);
    pairs.set(en, zh);
  }
}

const uncovered = missing.filter(m => !pairs.has(m.en));
if (uncovered.length) {
  console.error(`FAIL: ${uncovered.length} missing-list entries not covered by batches`);
  for (const u of uncovered.slice(0, 5)) console.error(' -', u.en.slice(0, 80));
  process.exit(1);
}
console.log(`batches cover all ${missing.length} missing strings (${pairs.size} unique)`);

const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
fs.copyFileSync(dictPath, path.join(ROOT, 'dictionary.json.bak-pre-ccw-market'));

let added = 0, skipped = 0;
for (const [en, zh] of pairs) {
  if (en in dict) { skipped++; continue; } // race with another entry — keep existing
  dict[en] = zh;
  added++;
}
fs.writeFileSync(dictPath, JSON.stringify(dict, null, 1) + '\n', 'utf8');
console.log(`dictionary: added=${added} skipped(existing)=${skipped} total=${Object.keys(dict).length}`);
console.log('backup: dictionary.json.bak-pre-ccw-market');
