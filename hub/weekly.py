"""The weekly email summary: last week's mail per account, counted by Gmail itself, written Sunday morning; and the
dashboard's Mail this week chart, recounted every half hour.

The inbox mirror only holds the last 3 days, so the counts come from Gmail search (X-GM-RAW) over All Mail, headers only.
"""
import imaplib
from collections import Counter
from datetime import datetime, time, timedelta
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr

from django.conf import settings
from django.utils import timezone

from hub.models import Item, Setting
from hub.sources import IMAP_TIMEOUT, special_folder

KEY = 'email_week'
WRITE_AT = time(8, 0)
TOP_SENDERS = 3
HEADER_CAP = 2000  # From headers read for the top-senders list
DAYS_KEY = 'email_days'
DAYS_EVERY = timedelta(minutes=30)


def week_end(now=None):
    """Midnight starting the most recent Sunday that is past WRITE_AT: the summary covers the 7 days before it."""
    now = timezone.localtime(now)
    days = (now.weekday() + 1) % 7  # Monday 0 .. Sunday 6 -> days since Sunday
    if days == 0 and now.time() < WRITE_AT:
        days = 7
    return timezone.make_aware(datetime.combine(now.date() - timedelta(days=days), time()))


def due(now=None):
    last = Setting.get(KEY)
    return not last or last.get('weekEnd') != week_end(now).isoformat()


def search(imap, query):
    _, data = imap.search(None, 'X-GM-RAW', f'"{query}"')
    return data[0].split()


def sender_name(raw):
    name, addr = parseaddr(str(make_header(decode_header(raw))))
    return name or addr


def account_week(account, start, end):
    span = f'after:{int(start.timestamp())} before:{int(end.timestamp())}'
    with imaplib.IMAP4_SSL(account.get('host', 'imap.gmail.com'), timeout=IMAP_TIMEOUT) as imap:
        imap.login(account['user'], account['password'])
        imap.select(special_folder(imap, b'\\All') or '"[Gmail]/All Mail"', readonly=True)
        received = search(imap, f'{span} -in:sent -in:chats')
        sent = search(imap, f'{span} in:sent')
        unread = search(imap, f'{span} in:inbox is:unread -in:sent')
        senders = Counter()
        for i in range(0, min(len(received), HEADER_CAP), 200):
            _, parts = imap.fetch(b','.join(received[i:i + 200]), '(BODY.PEEK[HEADER.FIELDS (FROM)])')
            for p in parts:
                if isinstance(p, tuple):
                    senders[sender_name(message_from_bytes(p[1]).get('From', ''))] += 1
    senders.pop('', None)
    return {'received': len(received), 'sent': len(sent), 'unread': len(unread),
            'top': [{'name': n, 'count': c} for n, c in senders.most_common(TOP_SENDERS)]}


def build(now=None):
    end = week_end(now)
    start = end - timedelta(days=7)
    last = Setting.get(KEY) or {}
    before = {a['key']: a for a in last.get('accounts', [])}
    accounts = []
    for account in settings.LIFEHUB.get('email', []):
        key = account.get('account', account['name'].lower())
        try:
            week = account_week(account, start, end)
        except Exception as e:
            week = {'error': str(e)[:200]}
        prev = before.get(key, {})
        waiting = Item.objects.filter(kind=Item.EMAIL, account=key, group='needs_reply', answered=False).order_by('published')
        accounts.append({'key': key, 'name': account['name'], **week,
                         'receivedBefore': prev.get('received'), 'waiting': waiting.count(),
                         'oldestWaiting': waiting[0].title if waiting else None})
    summary = {'weekStart': start.isoformat(), 'weekEnd': end.isoformat(), 'writtenAt': timezone.now().isoformat(), 'accounts': accounts}
    Setting.objects.update_or_create(key=KEY, defaults={'value': summary})
    return summary


def tile():
    s = Setting.get(KEY)
    return {'items': [], 'data': s}


def account_days(account, bounds):
    """(received, sent) in each span between consecutive bounds."""
    with imaplib.IMAP4_SSL(account.get('host', 'imap.gmail.com'), timeout=IMAP_TIMEOUT) as imap:
        imap.login(account['user'], account['password'])
        imap.select(special_folder(imap, b'\\All') or '"[Gmail]/All Mail"', readonly=True)
        spans = [f'after:{int(a.timestamp())} before:{int(b.timestamp())}' for a, b in zip(bounds, bounds[1:])]
        return [(len(search(imap, f'{s} -in:sent -in:chats')), len(search(imap, f'{s} in:sent'))) for s in spans]


def days_due():
    last = Setting.get(DAYS_KEY)
    return not last or timezone.now() - datetime.fromisoformat(last['at']) >= DAYS_EVERY


def build_days(now=None):
    """Mail this week: the 7 days ending today, and the 7 before for the trend. Answered is mail you sent. Raises when an
    account can't be read, so a half count never replaces a whole one."""
    today = timezone.localtime(now).date()
    midnight = lambda d: timezone.make_aware(datetime.combine(d, time()))
    bounds = [midnight(today - timedelta(days=13))] + [midnight(today - timedelta(days=i)) for i in range(6, -2, -1)]
    totals = [[0, 0] for _ in bounds[1:]]
    for account in settings.LIFEHUB.get('email', []):
        for t, (received, sent) in zip(totals, account_days(account, bounds)):
            t[0] += received
            t[1] += sent
    days = [{'date': (today - timedelta(days=6 - i)).isoformat(), 'received': r, 'answered': a} for i, (r, a) in enumerate(totals[1:])]
    data = {'days': days, 'received': sum(d['received'] for d in days), 'answered': sum(d['answered'] for d in days), 'lastWeekReceived': totals[0][0]}
    Setting.objects.update_or_create(key=DAYS_KEY, defaults={'value': {'at': timezone.now().isoformat(), 'data': data}})
    return data


def days_tile():
    s = Setting.get(DAYS_KEY)
    if not s:
        raise RuntimeError('not counted yet: the next fetch run counts it')
    return {'items': [], 'data': s['data'], 'updatedAt': s['at']}
