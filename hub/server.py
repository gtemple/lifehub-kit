"""Server page: this machine's memory, compose stacks, containers, pm2 apps and Ollama, and the controls to change them.
Turned on with `server = true` in lifehub.toml; it needs the docker CLI and its socket (in Docker: compose.server.yml).

Container limits apply live (docker update) and are also written to a compose override file beside each stack's compose
file, so a rebuild keeps them. Only names that exist right now are ever acted on, and nothing goes through a shell.
"""
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from django.core.cache import cache

from hub import health
from hub.models import Activity, Setting

GB = 2**30
OS_RESERVE = 1.5 * GB  # kept for the OS and its caches when adding up limits
STACKS = 'server_stacks'  # Setting: {project: [compose files]}; a stack that's down has no containers left to say where it lives
LIMITS = 'server_limits'  # Setting: {project: {service: bytes}}, the source of each override file
HEADER = "# Written by Lifehub's Server page: memory limits for this stack. Change them there, not here.\n"
UPDATE_EVERY = 6 * 3600
LOG_LINES = 300


def sh(*cmd, timeout=60):
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode:
        raise RuntimeError((out.stderr or out.stdout).strip()[-300:] or f'{cmd[0]} failed')
    return out.stdout


def size(text):
    """'42.41MiB' / '1.2GB' / '512kB' -> bytes."""
    m = re.match(r'([\d.]+)\s*([kKMGT]?)(i?)B', text.strip())
    if not m:
        return 0
    n, unit, binary = float(m.group(1)), m.group(2).upper(), m.group(3)
    return int(n * (1024 if binary else 1000) ** ' KMGT'.index(unit or ' '))


def meminfo():
    """(total, used) bytes; Linux only (in Docker Desktop, the VM's)."""
    vals = dict(re.findall(r'^(\w+):\s+(\d+) kB', open('/proc/meminfo').read(), re.M))
    total = int(vals['MemTotal']) * 1024
    return total, total - int(vals['MemAvailable']) * 1024


def pm2_apps():
    if not shutil.which('pm2'):
        return []
    try:
        return json.loads(sh('pm2', 'jlist', timeout=10) or '[]')
    except (RuntimeError, ValueError):
        return []


# containers and stacks

def crashed():
    """Containers that are restarting or exited with an error, for the red dot beside Server. Cheap: one docker ps."""
    rows = [json.loads(line) for line in sh('docker', 'ps', '-a', '--format', '{{json .}}', timeout=10).splitlines()]
    return [r['Names'] for r in rows if r['State'] in ('restarting', 'dead') or (r['State'] == 'exited' and not r['Status'].startswith('Exited (0)'))]


def containers():
    rows = [json.loads(line) for line in sh('docker', 'ps', '-a', '--format', '{{json .}}').splitlines()]
    if not rows:
        return []
    info = {c['Name'].lstrip('/'): c for c in json.loads(sh('docker', 'inspect', *[r['ID'] for r in rows]))}
    running = any(r['State'] == 'running' for r in rows)
    stats = {s['Name']: s for s in map(json.loads, sh('docker', 'stats', '--no-stream', '--format', '{{json .}}').splitlines())} if running else {}
    out = []
    for r in rows:
        c, s = info[r['Names']], stats.get(r['Names'], {})
        labels = c['Config'].get('Labels') or {}
        row = {
            'name': r['Names'], 'image': c['Config']['Image'], 'state': r['State'], 'status': r['Status'],
            'project': labels.get('com.docker.compose.project', ''), 'service': labels.get('com.docker.compose.service', ''),
            'files': [f for f in labels.get('com.docker.compose.project.config_files', '').split(',') if f],
            'used': size(s['MemUsage'].split('/')[0]) if s else 0, 'cpu': s.get('CPUPerc', ''),
            'limit': c['HostConfig'].get('Memory') or None,
        }
        row['builder'] = builder(row)
        row['built'] = bool(row['builder'])  # built from source here: it updates by rebuilding, there's no registry to ask
        row['update'] = None if row['built'] else update_available(row['image'], c['Image'], local_digests(c['Image']))
        out.append(row)
    return out


def services(project, files):
    """{service: (builds its image here?, image name)} from compose's own view of the stack, cached for a minute."""
    key = f'server-services:{project}'
    got = cache.get(key)
    if got is None:
        try:
            cfg = json.loads(sh('docker', 'compose', '-p', project, *sum((['-f', f] for f in files), []), 'config', '--format', 'json', timeout=20))
            got = {k: ('build' in v, v.get('image', '')) for k, v in cfg.get('services', {}).items()}
        except (RuntimeError, ValueError, OSError):
            got = {}
        cache.set(key, got, 60)
    return got


def builder(c):
    """The service that builds this container's image (itself, or e.g. backend for a worker running backend's image), else None."""
    if not c['project'] or not c['files']:
        return None
    svcs = services(c['project'], c['files'])
    if svcs.get(c['service'], (False, ''))[0]:
        return c['service']
    return next((k for k, (built, image) in svcs.items() if built and image and image == c['image']), None)


def remember(cs):
    """Note where each container's compose files are: once a stack is down, nothing else says."""
    known = Setting.get(STACKS, {}) or {}
    for c in cs:
        if c['project'] and c['files'] and known.get(c['project']) != c['files']:
            known[c['project']] = c['files']
            Setting.objects.update_or_create(key=STACKS, defaults={'value': known})
    return known


def stacks(cs):
    """Every compose project seen, running or not."""
    known = remember(cs)
    out = []
    for name, files in sorted(known.items()):
        mine = [c for c in cs if c['project'] == name]
        up = sum(c['state'] == 'running' for c in mine)
        out.append({'name': name, 'files': files, 'containers': len(mine), 'running': up,
                    'state': 'running' if up and up == len(mine) else 'partly running' if up else 'stopped',
                    'used': sum(c['used'] for c in mine)})
    return out


def compose(name, *args, timeout=600):
    files = (Setting.get(STACKS, {}) or {}).get(name)
    if not files:
        raise LookupError(f'{name} is not a known stack')
    over = override_path(files)
    cmd = ['docker', 'compose', '-p', name, *sum((['-f', f] for f in files), [])]
    if over.exists() and str(over) not in files:
        cmd += ['-f', str(over)]
    return sh(*cmd, *args, timeout=timeout)


def override_path(files):
    """compose.yml -> compose.override.yml beside it: the name compose itself loads, so a hand-run `docker compose up` keeps the limits too."""
    first = Path(files[0])
    stem = first.name.removesuffix('.yaml').removesuffix('.yml')
    return first.with_name(f'{stem}.override.yml')


def write_override(project):
    files = (Setting.get(STACKS, {}) or {}).get(project)
    if not files:
        return
    path = override_path(files)
    if path.exists() and not path.read_text().startswith(HEADER):
        raise RuntimeError(f'{path.name} already exists and is not Lifehub’s; set limits there by hand')
    limits = (Setting.get(LIMITS, {}) or {}).get(project, {})
    if not limits:
        path.unlink(missing_ok=True)
        return
    body = ''.join(f'  {svc}:\n    mem_limit: {b}\n    memswap_limit: {b}\n' for svc, b in sorted(limits.items()))
    path.write_text(f'{HEADER}services:\n{body}')
    exclude(path)


def exclude(path):
    """Keep the override out of the stack's git repo, if it lives in one."""
    try:
        git_dir = Path(sh('git', '-C', str(path.parent), 'rev-parse', '--absolute-git-dir', timeout=10).strip())
    except (RuntimeError, OSError):
        return
    if not git_dir.is_absolute() or not git_dir.is_dir():
        return
    ex = git_dir / 'info' / 'exclude'
    rel = os.path.relpath(path, Path(sh('git', '-C', str(path.parent), 'rev-parse', '--show-toplevel', timeout=10).strip()))
    if f'/{rel}' not in (ex.read_text() if ex.exists() else ''):
        ex.parent.mkdir(parents=True, exist_ok=True)
        with ex.open('a') as f:
            f.write(f'\n/{rel}\n')


MANIFESTS = ('application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, '
             'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json')


def image_ref(image):
    """'postgres:16' -> ('registry-1.docker.io', 'library/postgres', '16'); 'ghcr.io/o/app:1' -> ('ghcr.io', 'o/app', '1').
    None for an image pinned by digest."""
    if '@' in image:
        return None
    name, _, tag = image.rpartition(':') if ':' in image.split('/')[-1] else (image, '', 'latest')
    first, _, rest = name.partition('/')
    if rest and ('.' in first or ':' in first or first == 'localhost'):
        host, repo = first, rest
    else:
        host, repo = 'registry-1.docker.io', name if '/' in name else f'library/{name}'
    return ('registry-1.docker.io' if host == 'docker.io' else host), repo, tag


def challenge(header):
    """Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/app:pull" -> the token URL."""
    parts = dict(re.findall(r'(\w+)="([^"]*)"', header or ''))
    if not header.lower().startswith('bearer') or 'realm' not in parts:
        return None
    query = '&'.join(f'{k}={urllib.parse.quote(v, safe=":/")}' for k, v in parts.items() if k in ('service', 'scope'))
    return f"{parts['realm']}?{query}" if query else parts['realm']


def remote_digest(host, repo, tag):
    """The registry's digest for a tag, through its token handshake when it asks for one. '' when it can't tell."""
    url = f'https://{host}/v2/{repo}/manifests/{tag}'
    head = lambda h: urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'Accept': MANIFESTS, **h}), timeout=10)
    try:
        try:
            r = head({})
        except urllib.error.HTTPError as e:
            token_url = challenge(e.headers.get('WWW-Authenticate', '')) if e.code == 401 else None
            if not token_url:
                return ''
            body = json.load(urllib.request.urlopen(token_url, timeout=10))
            r = head({'Authorization': f"Bearer {body.get('token') or body.get('access_token')}"})
        return r.headers.get('Docker-Content-Digest', '')
    except Exception:
        return ''


def local_digests(image_id):
    try:
        return json.loads(sh('docker', 'image', 'inspect', image_id, '--format', '{{json .RepoDigests}}', timeout=10)) or []
    except RuntimeError:
        return []


def update_available(image, image_id, digests):
    """Compares the tag's digest at its registry with the one pulled. None when it can't tell, or the image was built here."""
    ref = image_ref(image)
    if not ref or not digests:
        return None
    key = 'server-digest:' + ':'.join(ref)
    remote = cache.get(key)
    if remote is None:
        remote = remote_digest(*ref)
        cache.set(key, remote, UPDATE_EVERY)
    return not any(d.endswith(remote) for d in digests) if remote else None


# Ollama

def ollama():
    url = health.ollama_hosts()[0]['url']
    used_by = {h['model'] for h in health.ollama_hosts()}
    try:
        loaded = json.load(urllib.request.urlopen(url + '/api/ps', timeout=5)).get('models', [])
        installed = json.load(urllib.request.urlopen(url + '/api/tags', timeout=5)).get('models', [])
        up = True
    except OSError:
        loaded, installed, up = [], [], False
    return {
        'up': up, 'url': url,
        'loaded': [{'name': m['name'], 'size': m.get('size', 0), 'until': m.get('expires_at')} for m in loaded],
        'installed': [{'name': m['name'], 'size': m.get('size', 0), 'inUse': m['name'] in used_by} for m in installed],
    }


# the page

def state():
    total, used = meminfo() if os.path.exists('/proc/meminfo') else (None, None)
    cs = containers()
    st = stacks(cs)
    apps = pm2_apps()
    ol = ollama()
    # Ollama in a container is counted with its stack
    items = [] if any(c['image'].startswith('ollama/') for c in cs) else [{'id': 'ollama', 'name': 'Ollama', 'used': sum(m['size'] for m in ol['loaded']), 'limit': None}]
    for s in st:
        mine = [c for c in cs if c['project'] == s['name']]
        lims = [c['limit'] for c in mine]
        items.append({'id': f"stack:{s['name']}", 'name': s['name'], 'used': s['used'], 'limit': sum(lims) if lims and all(lims) else None})
    if used is not None:
        items.insert(0, {'id': 'os', 'name': 'System + caches', 'used': max(0, used - sum(i['used'] for i in items)), 'limit': OS_RESERVE})
    return {
        'total': total, 'used': used, 'items': items, 'cores': os.cpu_count(),
        'upSince': int(time.time() - float(open('/proc/uptime').read().split()[0])) if os.path.exists('/proc/uptime') else None,
        'limits': sum(i['limit'] or 0 for i in items),
        'stacks': st, 'containers': cs, 'ollama': ol,
        'apps': [{'name': a['name'], 'status': a['pm2_env']['status'], 'used': (a.get('monit') or {}).get('memory', 0),
                  'cron': a['pm2_env'].get('cron_restart') or '', 'restarts': a['pm2_env'].get('restart_time', 0)} for a in apps],
    }


def act(kind, name, action, value=None):
    """One control. Returns a sentence for the bell. Raises LookupError for anything that doesn't exist right now."""
    if kind == 'container':
        c = next((c for c in containers() if c['name'] == name), None)
        if not c:
            raise LookupError(f'no container {name}')
        remember([c])  # its stack may not have been seen yet
        if action in ('start', 'stop', 'restart'):
            sh('docker', action, name)
            done = f"{ {'start': 'Started', 'stop': 'Stopped', 'restart': 'Restarted'}[action]} {name}"
        elif action == 'limit':
            limit = int(value) if value else None
            if c['project'] and c['service']:
                limits = Setting.get(LIMITS, {}) or {}
                proj = limits.setdefault(c['project'], {})
                if limit:
                    proj[c['service']] = limit
                else:
                    proj.pop(c['service'], None)
                Setting.objects.update_or_create(key=LIMITS, defaults={'value': limits})
                write_override(c['project'])
            if limit:
                sh('docker', 'update', '--memory', str(limit), '--memory-swap', str(limit), name)
            elif c['project']:
                compose(c['project'], 'up', '-d', '--no-deps', '--force-recreate', c['service'])  # a limit can't be lifted live, and compose sees nothing changed: force the recreate
            done = f"Set {name}'s memory limit to {gib(limit)}" if limit else f"Removed {name}'s memory limit"
        elif action == 'rebuild':
            if not c['builder']:
                raise LookupError(f'{name} is not built from source here')
            compose(c['project'], 'build', '--pull', c['builder'], timeout=1800)
            # everything running that image gets it: backend's rebuild reaches the worker too
            image = services(c['project'], c['files'])[c['builder']][1]
            users = [k for k, (_, img) in services(c['project'], c['files']).items() if k == c['builder'] or (image and img == image)]
            compose(c['project'], 'up', '-d', '--no-deps', *users)
            done = f"Rebuilt {c['image']} from source and recreated {', '.join(users)}"
        elif action == 'update':
            if not c['project']:
                raise LookupError(f'{name} is not part of a compose stack')
            compose(c['project'], 'pull', c['service'])
            compose(c['project'], 'up', '-d', '--no-deps', c['service'])
            done = f'Updated {name} to the newest {c["image"]}'
        else:
            raise LookupError(f'unknown action {action}')
    elif kind == 'stack':
        if action == 'up':
            compose(name, 'up', '-d')
        elif action == 'down':
            compose(name, 'down')
        else:
            raise LookupError(f'unknown action {action}')
        done = f'Brought {name} {action}'
    elif kind == 'app':
        if name not in {a['name'] for a in pm2_apps()}:
            raise LookupError(f'{name} is not a pm2 app')
        if action == 'restart':
            sh('pm2', 'restart', name)
            done = f'Restarted {name}'
        else:
            raise LookupError(f'unknown action {action}')
    elif kind == 'ollama':
        ol = ollama()
        if action == 'unload':
            for m in ol['loaded'] if not name else [m for m in ol['loaded'] if m['name'] == name]:
                urllib.request.urlopen(urllib.request.Request(ol['url'] + '/api/generate', data=json.dumps({'model': m['name'], 'keep_alive': 0}).encode(),
                                                              headers={'Content-Type': 'application/json'}), timeout=30).read()
            done = f'Unloaded {name or "Ollama’s models"}'
        elif action == 'remove':
            m = next((m for m in ol['installed'] if m['name'] == name), None)
            if not m:
                raise LookupError(f'no model {name}')
            if m['inUse']:
                raise LookupError(f'{name} is the model Lifehub uses; switch models first')
            urllib.request.urlopen(urllib.request.Request(ol['url'] + '/api/delete', data=json.dumps({'model': name}).encode(), method='DELETE',
                                                          headers={'Content-Type': 'application/json'}), timeout=30).read()
            done = f'Removed {name} ({gib(m["size"])})'
        else:
            raise LookupError(f'unknown action {action}')
    else:
        raise LookupError(f'unknown kind {kind}')
    Activity.objects.create(text=done[:300], via='Server')
    return done


def logs(kind, name, lines=LOG_LINES):
    lines = str(max(10, min(int(lines), 2000)))
    if kind == 'container':
        if name not in sh('docker', 'ps', '-a', '--format', '{{.Names}}', timeout=10).split():
            raise LookupError(f'no container {name}')
        out = subprocess.run(['docker', 'logs', '--tail', lines, '--timestamps', name], capture_output=True, text=True, timeout=30)
        text = out.stdout + out.stderr
        rows = sorted(text.splitlines())  # stdout and stderr arrive apart; their timestamps put them back in order
    elif kind == 'stack':
        rows = compose(name, 'logs', '--tail', lines, '--timestamps', '--no-color', timeout=30).splitlines()
    elif kind == 'app':
        apps = pm2_apps()
        if name not in {a['name'] for a in apps}:
            raise LookupError(f'{name} is not a pm2 app')
        env = next(a['pm2_env'] for a in apps if a['name'] == name)
        rows = []
        for key, tag in (('pm_out_log_path', ''), ('pm_err_log_path', 'err | ')):
            if env.get(key) and Path(env[key]).exists():
                rows += [tag + r for r in sh('tail', '-n', lines, env[key], timeout=10).splitlines()]
    else:
        raise LookupError(f'unknown kind {kind}')
    return [r for r in rows if r.strip()][-int(lines):]


def gib(b):
    if not b:
        return 'none'
    return f'{b / GB:.1f} GB'.replace('.0 GB', ' GB') if b >= GB else f'{round(b / 2**20)} MB'
