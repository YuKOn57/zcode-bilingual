"""Find hardcoded English literals rendered as JSX children / placeholders in the
renderer, i.e. strings that never go through formatMessage and therefore can never
be translated by the i18n catalog. Only the dynamic dictionary can cover them.

Usage: python scripts/_scan_hardcoded.py [chunk-substring]
"""
import json, re, os, sys

ASAR = r'C:\Users\YuKOn\AppData\Local\Programs\ZCode\resources\app.asar'
CAT = os.path.join(os.environ.get('TEMP', r'C:\Windows\Temp'), 'zcode-i18n', 'catalog.json')
DICT = r'C:\Users\YuKOn\Documents\zcode\zcode-bilingual-plugin\dictionary.json'

cat = json.load(open(CAT, encoding='utf8'))
known_en = set(cat['en'].values()) | set(cat['zh'].values())
d = json.load(open(DICT, encoding='utf8'))
known_dict = set(d.keys())

allb = open(ASAR, 'rb').read()
hpl = int.from_bytes(allb[4:8], 'little'); hp = allb[8:8+hpl]
jl = int.from_bytes(hp[4:8], 'little')
header = json.loads(hp[8:8+jl].decode('utf8')); ds = 8+hpl

def leaves(n, pre=''):
    out = []
    for k, v in (n.get('files') or {}).items():
        p = pre+'/'+k
        out += leaves(v, p) if 'files' in v else [(p, v)]
    return out

filter_chunk = sys.argv[1] if len(sys.argv) > 1 else None

# JSX children:"..." or placeholder:"..." or title:"..." with plain English words
pat = re.compile(r'(?:children|placeholder|title|aria-label|alt):\s*(["\'`])([A-Za-z][A-Za-z0-9 ,.;:()/+_&#\'-]{1,60})\1')
skip = re.compile(r'^(?:[a-z]+-[a-z-]+|\s*|true|false|null|[a-z]+\.(?:svg|png|ico))$')

found = {}
for p, n in leaves(header):
    if not (p.startswith('/out/renderer/') and p.endswith('.js')):
        continue
    if filter_chunk and filter_chunk not in p:
        continue
    if n.get('unpacked') or int(n.get('size', 0)) > 12*1024*1024:
        continue
    off = int(n['offset']); size = int(n['size'])
    s = allb[ds+off:ds+off+size].decode('utf8', 'replace')
    for m in pat.finditer(s):
        v = m.group(2).strip()
        if not v or skip.match(v):
            continue
        if not re.search(r'[A-Za-z]{2}', v):
            continue
        if any(ch.isdigit() for ch in v[:2]):
            continue
        if v in known_en or v in known_dict:
            continue
        key = re.sub(r'\s+', ' ', v)
        found.setdefault(key, []).append((p, m.start()))

print('candidate hardcoded strings:', len(found))
out = []
for k in sorted(found, key=lambda x: (len(x), x)):
    srcs = found[k]
    out.append((k, len(srcs), srcs[0][0].split('/')[-1]))
for k, c, f in out[:120]:
    print(f'{c:3}x  {k!r}   [{f}]')
