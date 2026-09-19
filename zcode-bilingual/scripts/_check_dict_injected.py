import json, re, os

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

for p, n in leaves(header):
    if p == '/out/renderer/assets/IntlProvider-DvAen4Dk.js':
        size = int(n['size']); off = int(n['offset'])
        s = allb[ds+off:ds+off+size].decode('utf8')
        i = s.find('window.__zcodeZhDict=Object.assign')
        print('inject at', i, 'bundle len', len(s))
        j = s.find('{', i)
        # find matching close brace of the JSON arg
        depth = 0; k = j; in_str = None; esc = False
        while k < len(s):
            c = s[k]
            if in_str:
                if esc: esc = False
                elif c == '\\': esc = True
                elif c == in_str: in_str = None
            else:
                if c in '"\'`': in_str = c
                elif c == '{': depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0: break
            k += 1
        raw = s[j:k+1]
        d = json.loads(raw)
        print('injected dict entries:', len(d))
        tests = ['SessionStart', 'PreToolUse', 'browser-use', 'Hooks', 'Shell', 'Slug']
        for t in tests:
            print(f'  {t!r} in dict:', t in d)
        # skill descriptions
        desc_hits = [k for k in d if k.startswith('Provides ') or 'skills' in k.lower()][:5]
        print('sample keys:', json.dumps(list(d.keys())[:8], ensure_ascii=False)[:800])
        # check a couple of long descriptions
        long_keys = [k for k in d if len(k) > 100]
        print('long keys:', len(long_keys))
        print('e.g.', json.dumps(long_keys[:2], ensure_ascii=False)[:600])
