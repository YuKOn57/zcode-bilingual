import json, re, os

OUT = os.path.join(os.environ.get('TEMP', r'C:\Windows\Temp'), 'zcode-i18n')
src = open(os.path.join(OUT, 'bundle.js'), encoding='utf8').read()

# strip the injected helper (tail) so it does not pollute
cut = src.find(';try{window.__zcodeZhDict=')
if cut > 0:
    src = src[:cut]

KV = re.compile(r'"([A-Za-z][\w.-]*)":\s*`((?:[^`\\]|\\.)*)`')
rows = []
for m in KV.finditer(src):
    rows.append((m.start(), m.group(1), m.group(2)))

print('total kv pairs:', len(rows))
# cluster by index gap
idx = [r[0] for r in rows]
# find big gaps
gaps = [(idx[i-1], idx[i], idx[i]-idx[i-1]) for i in range(1, len(idx)) if idx[i]-idx[i-1] > 5000]
print('big gaps:', gaps[:10])

# assume zh block = before 300000, en block = after
zh = {k: v for (i, k, v) in rows if i < 300000}
en = {k: v for (i, k, v) in rows if i >= 300000}
print('zh keys:', len(zh), 'en keys:', len(en))

missing = [k for k in en if k not in zh]
same = [k for k in en if k in zh and zh[k] == en[k]]
print('en-only (no zh at all):', len(missing))
print('zh == en (untranslated):', len(same))

def unescape(s):
    return s.replace('\\`', '`').replace('\\\\', '\\').replace('\\n', '\n')

os.makedirs(OUT, exist_ok=True)
json.dump({'zh': zh, 'en': en}, open(os.path.join(OUT, 'catalog.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
with open(os.path.join(OUT, 'gaps.txt'), 'w', encoding='utf8') as f:
    for k in sorted(missing):
        f.write(f'[NO-ZH] {k} = {unescape(en[k])}\n')
    for k in sorted(same):
        f.write(f'[SAME ] {k} = {unescape(en[k])}\n')
print('written', OUT)
