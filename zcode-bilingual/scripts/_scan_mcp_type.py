import json, re

ASAR = r'C:\Users\YuKOn\AppData\Local\Programs\ZCode\resources\app.asar'
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

# 1) arrays containing stdio
arr = re.compile(r'\[\s*`stdio`[^\]]{0,120}\]')
# 2) any usage of the i18n key template
tpl = re.compile(r'mcp\.form\.type')
seen = 0
for p, n in leaves(header):
    if not (p.startswith('/out/renderer/') and p.endswith('.js')):
        continue
    if n.get('unpacked') or int(n.get('size', 0)) > 12*1024*1024:
        continue
    off = int(n['offset']); size = int(n['size'])
    s = allb[ds+off:ds+off+size].decode('utf8', 'replace')
    for m in arr.finditer(s):
        print('[ARRAY]', p, m.start(), m.group(0))
    for m in tpl.finditer(s):
        i = m.start()
        ctx = s[max(0, i-200):i+260]
        if 'settings.mcp.form.type.' in ctx and '`' not in ctx[:60]:
            continue  # catalog entries
        print('[TPL]', p, i)
        print('   ', ctx.replace('\n', ' '))
        seen += 1
        if seen > 12:
            raise SystemExit
