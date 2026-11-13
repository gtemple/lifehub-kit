"""Connections managed from Settings > connections.cpl: email accounts, calendars, and news feeds.

lifehub.toml is where they start; the first change to a kind copies the file's list into the database, which wins
from then on (config.settings.Config). Secrets (app passwords, private calendar addresses) go in but never come
back out: the page gets a masked version, and a blank field on save keeps the stored secret.
"""
import imaplib
from urllib.parse import urlparse

from django.conf import settings

from hub import agenda, sources
from hub.models import Activity, Setting

FIELDS = {
    'email': ['name', 'account', 'user', 'password', 'host'],
    'calendar': ['name', 'account', 'url'],
    'feed': ['name', 'url', 'topic'],
}
SECRET = {'email': 'password', 'calendar': 'url'}
LABEL = {'email': 'email account', 'calendar': 'calendar', 'feed': 'news feed'}


def items(kind):
    return list(settings.LIFEHUB.get(kind) or [])


def account_of(item):
    return item.get('account') or item['name'].lower()


def masked(kind, item):
    out = {k: item.get(k, '') for k in FIELDS[kind] if k != SECRET.get(kind)}
    if kind == 'email':
        out['account'], out['hasPassword'] = account_of(item), bool(item.get('password'))
    if kind == 'calendar':
        u = urlparse(item.get('url', ''))
        out['account'], out['urlHint'] = account_of(item), f"{u.netloc} … {u.path.rsplit('/', 1)[-1]}" if u.netloc else ''  # the path is the secret
    return out


def clean(kind, data, old=None):
    """The item to store, validated; raises ValueError with a message for the page."""
    old = old or {}
    item = {k: str(data.get(k, '')).strip() for k in FIELDS[kind]}
    secret = SECRET.get(kind)
    if secret and not item[secret]:
        item[secret] = old.get(secret, '')  # blank: keep what's stored
    if not item['name']:
        raise ValueError('give it a name')
    if kind == 'email':
        item['account'] = old.get('account') or item['account'].lower() or item['name'].lower()  # mail is filed under it: never renamed
        if '@' not in item['user']:
            raise ValueError('the address needs an @')
        if not item['password']:
            raise ValueError('add the app password')
        item['host'] = item['host'] or 'imap.gmail.com'
    else:
        if urlparse(item['url']).scheme not in ('http', 'https'):
            raise ValueError('the address must start with https://')
    if kind == 'calendar':
        item['account'] = item['account'].lower() or 'personal'
    return {k: v for k, v in item.items() if v}


def store(kind, rows):
    Setting.objects.update_or_create(key=f'connections_{kind}', defaults={'value': rows})


def save(kind, original, data):
    """Add (original '') or edit one connection; returns its masked form."""
    rows = items(kind)
    i = next((n for n, r in enumerate(rows) if r['name'] == original), None) if original else None
    if original and i is None:
        raise LookupError(f'no {LABEL[kind]} called {original}')
    item = clean(kind, data, rows[i] if i is not None else None)
    if any(r['name'] == item['name'] for n, r in enumerate(rows) if n != i):
        raise ValueError(f"there's already a {LABEL[kind]} called {item['name']}")
    if i is None:
        rows.append(item)
    else:
        rows[i] = item
    store(kind, rows)
    Activity.objects.create(text=f"{'Changed' if original else 'Added'} {LABEL[kind]}: {item['name']}", via='Settings')
    return masked(kind, item)


def remove(kind, name):
    rows = items(kind)
    kept = [r for r in rows if r['name'] != name]
    if len(kept) == len(rows):
        raise LookupError(f'no {LABEL[kind]} called {name}')
    store(kind, kept)
    Activity.objects.create(text=f'Removed {LABEL[kind]}: {name}', via='Settings')


def test(kind, original, data):
    """Try a connection as entered (blank secret: the stored one). Returns a short line for the page; raises on failure."""
    old = next((r for r in items(kind) if r['name'] == original), None) if original else None
    item = clean(kind, data, old)
    if kind == 'email':
        with imaplib.IMAP4_SSL(item['host'], timeout=sources.IMAP_TIMEOUT) as imap:
            imap.login(item['user'], item['password'])
            imap.select('INBOX', readonly=True)
            n = len(imap.uid('SEARCH', None, 'UNSEEN')[1][0].split())
        return f'logged in · {n:,} unread in the inbox'
    if kind == 'calendar':
        from django.utils import timezone
        n = len(agenda.events_on(agenda.fetch(item['url']), timezone.localdate(), item['account']))
        return f"read it · {n} event{'s' if n != 1 else ''} today"
    n = len(sources.fetch_feed(item['url']))
    return f"read it · {n} item{'s' if n != 1 else ''}"


