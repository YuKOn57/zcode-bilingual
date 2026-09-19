import os, re, sys

base = r'C:\Users\YuKOn\.zcode\cli\plugins\cache'
pat = re.compile(r'name:\s*["\']([a-z][a-z0-9_-]{2,40})["\']')
for dp, dn, fn in os.walk(base):
    for f in fn:
        if f in ('server.js', 'server.mjs') and 'mcp' in dp.replace('\\', '/'):
            p = os.path.join(dp, f)
            try:
                s = open(p, encoding='utf8', errors='replace').read()
            except Exception:
                continue
            names = sorted(set(pat.findall(s)))
            # keep only plausible tool names (snake/kebab with verb-ish prefix)
            tools = [n for n in names if re.match(r'^[a-z]+[_-][a-z0-9_-]+$', n)]
            print(p.replace(base, ''), '| names:', len(names), '| tool-ish:', len(tools))
            for n in tools[:60]:
                print('   ', n)
