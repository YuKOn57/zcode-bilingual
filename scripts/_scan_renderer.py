import json, re, os, sys

ASAR = r'C:\Users\YuKOn\AppData\Local\Programs\ZCode\resources\app.asar'

def read_asar(p):
    allb = open(p, 'rb').read()
    hpl = int.from_bytes(allb[4:8], 'little')
    hp = allb[8:8+hpl]
    jl = int.from_bytes(hp[4:8], 'little')
    header = json.loads(hp[8:8+jl].decode('utf8'))
    return allb, header, 8+hpl

def leaves(header, prefix=''):
    out = []
    for name, val in (header.get('files') or {}).items():
        p = prefix + '/' + name
        if 'files' in val:
            out += leaves(val, p)
        else:
            out.append((p, val))
    return out

allb, header, ds = read_asar(ASAR)
lv = leaves(header)
targets = [(p, n) for p, n in lv if p.startswith('/out/renderer/') and p.endswith('.js') and not n.get('unpacked')]
print('renderer js chunks:', len(targets))

KEYWORDS = sys.argv[1:] or ['UserPromptSubmit']
CTX = 500
hits = {}
for p, n in targets:
    size = int(n.get('size', 0))
    if size > 12 * 1024 * 1024:
        continue
    off = int(n.get('offset', 0))
    s = allb[ds+off: ds+off+size].decode('utf8', 'replace')
    for kw in KEYWORDS:
        for m in re.finditer(re.escape(kw), s):
            i = m.start()
            hits.setdefault(kw, []).append((p, i, s[max(0, i-CTX):i+CTX]))

for kw, arr in hits.items():
    print('===', kw, 'hits:', len(arr))
    for p, i, ctx in arr[:6]:
        print('  @', p, i)
        print('  ', ctx.replace('\n', ' ')[:1000])
        print()
