import json, os, re, sys

HOME = r'C:\Users\YuKOn'
DICT = r'C:\Users\YuKOn\Documents\zcode\zcode-bilingual-plugin\dictionary.json'
norm = lambda s: re.sub(r'\s+', ' ', str(s)).strip()
d = json.load(open(DICT, encoding='utf8'))
covered = {norm(k) for k in d}

strings = {}   # string -> [sources]

def add(s, src):
    if not s: return
    s = norm(s)
    if len(s) < 2 or len(s) > 4000: return
    if not re.search(r'[A-Za-z]', s): return
    strings.setdefault(s, [])
    if src not in strings[s]: strings[s].append(src)

def fm(text):
    m = re.match(r'^---\r?\n([\s\S]*?)\r?\n---', text)
    if not m: return {}
    out = {}
    for line in m.group(1).splitlines():
        kv = re.match(r'^([A-Za-z_][\w-]*)\s*:\s*(.*)$', line)
        if kv: out[kv.group(1)] = kv.group(2).strip().strip('"\'')
    return out

def read_fm(path):
    try:
        return fm(open(path, encoding='utf8').read())
    except Exception:
        return {}

roots = [
    os.path.join(HOME, '.zcode', 'cli', 'plugins', 'cache'),
    os.path.join(HOME, '.zcode', 'v2', 'plugins', 'cache'),
    os.path.join(HOME, '.zcode', 'cli', 'plugins', 'marketplaces'),
    os.path.join(HOME, '.zcode', 'skills'),
    os.path.join(HOME, '.zcode', 'cli', 'skills'),
]

for root in roots:
    if not os.path.isdir(root):
        print('[missing root]', root); continue
    for market in os.listdir(root):
        mdir = os.path.join(root, market)
        add(market, 'market:' + market)
        if not os.path.isdir(mdir): continue
        for plugin in os.listdir(mdir):
            pdir = os.path.join(mdir, plugin)
            if not os.path.isdir(pdir): continue
            for ver in os.listdir(pdir):
                vdir = os.path.join(pdir, ver)
                if not os.path.isdir(vdir): continue
                add(plugin, 'plugin-id')
                for mf in ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']:
                    fp = os.path.join(vdir, mf)
                    if os.path.exists(fp):
                        try:
                            j = json.load(open(fp, encoding='utf8'))
                            add(j.get('name'), 'plugin.name')
                            add(j.get('description'), 'plugin.desc')
                            author = j.get('author')
                            if isinstance(author, dict): add(author.get('name'), 'plugin.author')
                            elif isinstance(author, str): add(author, 'plugin.author')
                        except Exception as e:
                            print('parse fail', fp, e)
                # skills
                sk_root = os.path.join(vdir, 'skills')
                if os.path.isdir(sk_root):
                    for dirpath, dirnames, filenames in os.walk(sk_root):
                        if 'SKILL.md' in filenames:
                            f = read_fm(os.path.join(dirpath, 'SKILL.md'))
                            add(os.path.basename(dirpath), 'skill-dir')
                            add(f.get('name'), 'skill.name')
                            add(f.get('description'), 'skill.desc')

# ---------------------------------------------------------------------------
# commands (commands/*.md) and subagents (agents/*.md)
#
# These were NOT collected before v0.4.1 -- which is exactly why the slash
# command "/workflow" and every subagent entry stayed English in the UI:
# their names/descriptions live in plugin-owned markdown frontmatter, never in
# ZCode's i18n catalog, so only dictionary.json can cover them.
# ---------------------------------------------------------------------------
META_ROOTS = [
    os.path.join(HOME, '.zcode', 'agents'),          # user-level agents
] + roots

norm_ident = re.compile(r'^[\w.\- ]{1,64}$')

for root in META_ROOTS:
    if not os.path.isdir(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        if 'node_modules' in dirpath or '.git' in dirpath:
            dirnames[:] = []
            continue
        base = os.path.basename(dirpath)
        if base == 'commands':
            for f in filenames:
                if not f.endswith('.md'):
                    continue
                meta = read_fm(os.path.join(dirpath, f))
                add(meta.get('description'), 'command.desc')
                slug = f[:-3]
                if norm_ident.match(slug):
                    add(slug, 'command-id')
                # NOTE: `argument-hint` is deliberately NOT collected. It is literal
                # argument syntax (`<system-dir> [target-stack]`, `PROMPT [--max-iterations N]`)
                # shown in the composer -- translating it would misrepresent what to type.
        elif base == 'agents':
            for f in filenames:
                if not f.endswith('.md'):
                    continue
                meta = read_fm(os.path.join(dirpath, f))
                add(meta.get('name'), 'agent.name')
                add(meta.get('description'), 'agent.desc')

# installed marketplaces / plugins registries
for cfg in [
    os.path.join(HOME, '.zcode', 'cli', 'config.json'),
    os.path.join(HOME, '.zcode', 'cli', 'plugins', 'config.json'),
    os.path.join(HOME, '.zcode', 'cli', 'settings.json'),
]:
    if os.path.exists(cfg):
        try:
            j = json.load(open(cfg, encoding='utf8'))
            def walk(o, path=''):
                if isinstance(o, dict):
                    for k, v in o.items():
                        if isinstance(v, str) and k in ('name', 'description', 'displayName', 'marketplace', 'source'):
                            add(v, f'{os.path.basename(cfg)}:{path}{k}')
                        else: walk(v, path + k + '.')
                elif isinstance(o, list):
                    for i, v in enumerate(o): walk(v, path)
            walk(j)
        except Exception as e:
            print('cfg fail', cfg, e)

miss = {k: v for k, v in strings.items() if k not in covered}
print('total english strings:', len(strings), '| missing:', len(miss))
out = os.path.join(os.path.dirname(DICT), '_missing_report.txt')
with open(out, 'w', encoding='utf8') as f:
    for k in sorted(miss, key=lambda x: (len(x), x)):
        f.write(f'{json.dumps(k, ensure_ascii=False)}\n    <- {miss[k]}\n')
print('written', out)
for k in sorted(miss, key=lambda x: (len(x), x))[:400]:
    print(json.dumps(k, ensure_ascii=False)[:200], '<-', miss[k])
