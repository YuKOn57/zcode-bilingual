import json, re, os, sys

ASAR = r'C:\Users\YuKOn\AppData\Local\Programs\ZCode\resources\app.asar'
OUT = os.path.join(os.environ.get('TEMP', r'C:\Windows\Temp'), 'zcode-i18n')

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

def read_entry(allb, data_start, node):
    size = int(node.get('size', 0)); off = int(node.get('offset', 0))
    return allb[data_start+off: data_start+off+size]

allb, header, ds = read_asar(ASAR)
lv = leaves(header)
target = None
for p, node in lv:
    if re.search(r'IntlProvider.*\.js$', p) and not node.get('unpacked'):
        target = (p, node)
print('bundle:', target[0])
src = read_entry(allb, ds, target[1]).decode('utf8')
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, 'bundle.js'), 'w', encoding='utf8').write(src)
print('len', len(src))

for m in re.finditer(r'en-US', src):
    i = m.start()
    print('--- en-US @', i, '---')
    print(repr(src[max(0,i-300):i+120]))
    print()
