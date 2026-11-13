"""Cleanup: thousands of unread emails, handled per sender instead of one by one.

scan() reads only headers (fast), groups the inbox by sender and notes who you have written to.
suggest() asks Ollama for one decision per sender, biggest first, a few minutes per fetch run.
apply() marks read or archives in Gmail; deleting (and unsubscribing) waits for a stamp, then due() does it.
"""
import re
import threading
import time
import urllib.request
from collections import defaultdict
from itertools import groupby
from datetime import datetime, timedelta
from email import message_from_bytes
from email.header import decode_header, make_header
from email.policy import default as email_policy
from email.utils import getaddresses, parseaddr

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from hub import mail, triage
from hub.models import Activity, Approval, Item, Sender, Setting
from hub.sources import special_folder

CHUNK = 500
PASSES = 3
CATEGORIES = ['promotions', 'social', 'updates', 'forums']  # anything else is Primary
SUGGEST_BUDGET_S = 90  # per fetch run; with receipts (60 s) a run stays well inside its 5 min
STUCK = timedelta(minutes=10)  # a read/archive/file still 'working' this long lost its thread (a restart); fetch finishes it
DUE_BUDGET_S = 120  # approved deletes per fetch run: pm2 restarts fetch every 5 min, killing whatever is still going
FIELDS = '(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT LIST-ID LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST)])'
# Gmail tags these one email at a time; they are filed on their own and never go down with their sender.
# Travel first: a ticket is often also a receipt.
PROTECTED = {
    'Travel': ['label:^smartlabel_travel', 'category:reservations'],
    'Receipts': ['label:^smartlabel_receipt', 'category:purchases'],
    'Finance': ['label:^smartlabel_finance'],
}
EXCLUDE = ' '.join(f'-{q}' for qs in PROTECTED.values() for q in qs)
DONE = {'read': 'marked read', 'archive': 'archived', 'trash': 'deleted', 'file': 'filed'}

PROMPT = """You help YOUR_NAME clear thousands of unread emails. For one sender, pick what to do with all of their mail:
Receipts, tickets, bookings and statements are already set aside one by one and are never touched here,
so judge the rest of the sender's mail.
- delete: bulk junk he won't miss: promotions, marketing, sales, job alerts, social network notifications,
  automated app notifications and digests, test or staging mail. Lean towards delete for bulk mail.
- file: worth keeping, belongs in a folder rather than the inbox: receipts, invoices, orders, payments,
  e-transfers, bank and card statements, government, taxes, insurance, travel, account security, contracts,
  a project or a club. Never delete mail about money, orders, bookings or accounts. Name the folder:
  use one of their existing folders when one fits; otherwise propose a short new name (one or two words,
  Title Case, e.g. "Receipts", "Travel"), reusing one of the new folders already proposed when it fits.
- archive: worth keeping but fits no folder.
- read: still belongs in the inbox but he doesn't need each one flagged.
- keep: a real person, a client or colleague, or anything that may still need them to act.
The reason is at most 10 words and says what the mail is. folder is "" unless the action is file."""

SCHEMA = {
    'type': 'object',
    'properties': {'action': {'type': 'string', 'enum': Sender.SUGGESTIONS}, 'reason': {'type': 'string', 'minLength': 1}, 'folder': {'type': 'string'}},
    'required': ['action', 'reason', 'folder'],
}


def accounts():
    return [a.get('account', a['name'].lower()) for a in settings.LIFEHUB.get('email', [])]


def text(value):
    try:
        return str(make_header(decode_header(value or ''))).strip()
    except Exception:
        return (value or '').strip()


def chunks(uids):
    for i in range(0, len(uids), CHUNK):
        yield b','.join(uids[i:i + CHUNK])


def parse_unsubscribe(header, post):
    links = re.findall(r'<([^>]+)>', header or '')
    https = next((u for u in links if u.startswith('https://')), '')
    one_click = bool(https) and 'one-click' in (post or '').lower()
    return (https if one_click else ''), (https or next((u for u in links if u.startswith('mailto:')), ''))


def read_headers(imap, uids):
    """(uid, seen, headers) for each message, in chunks so 60k messages stay quick."""
    for chunk in chunks(uids):
        for part in imap.uid('FETCH', chunk, FIELDS)[1]:
            if isinstance(part, tuple):
                uid = re.search(rb'UID (\d+)', part[0])
                if uid:
                    yield uid.group(1), b'\\Seen' in part[0], message_from_bytes(part[1], policy=email_policy)


def folders(imap):
    """His own Gmail labels: everything except the inbox and Gmail's system folders."""
    out = []
    for line in imap.list()[1]:
        m = re.match(rb'\(([^)]*)\) "[^"]*" (.+)$', line)
        if not m or b'\\Noselect' in m.group(1):
            continue
        name = m.group(2).decode().strip('"')
        if name.upper() != 'INBOX' and not name.startswith('[Gmail]'):
            out.append(name)
    return sorted(out)


def quote(folder):
    return '"' + folder.replace('\\', '\\\\').replace('"', '\\"') + '"'


def written_to(imap):
    """Everyone you have sent mail to, from the Sent folder's To and Cc headers."""
    folder = special_folder(imap, b'\\Sent')
    if not folder:
        return set()
    imap.select(folder, readonly=True)
    uids = imap.uid('SEARCH', None, 'ALL')[1][0].split()
    out = set()
    for chunk in chunks(uids):
        for part in imap.uid('FETCH', chunk, '(BODY.PEEK[HEADER.FIELDS (TO CC)])')[1]:
            if isinstance(part, tuple):
                msg = message_from_bytes(part[1])
                out |= {a.lower() for _, a in getaddresses(msg.get_all('To', []) + msg.get_all('Cc', [])) if a}
    return out


def scan_account(key):
    with mail.open_inbox(key, readonly=True) as imap:
        uids = imap.uid('SEARCH', None, 'ALL')[1][0].split()
        category = {}
        for c in CATEGORIES:
            for u in imap.uid('SEARCH', 'X-GM-RAW', f'"category:{c}"')[1][0].split():
                category[u] = c
        protected = {}
        for folder, queries in PROTECTED.items():
            for u in imap.uid('SEARCH', 'X-GM-RAW', quote(' OR '.join(queries)))[1][0].split():
                protected.setdefault(u, folder)
        found = defaultdict(lambda: {'protected': 0, 'total': 0, 'unread': 0, 'subjects': [], 'cats': defaultdict(int), 'bulk': False, 'name': '', 'unsub': ('', '')})
        for uid, seen, msg in read_headers(imap, uids):
            name, address = parseaddr(text(msg['From']))
            if not address:
                continue
            s = found[address.lower()]
            if uid in protected:
                s['protected'] += 1
                continue
            s['total'] += 1
            s['unread'] += not seen
            s['cats'][category.get(uid, 'primary')] += 1
            s['name'] = name or s['name']
            s['subjects'] = ([text(msg['Subject'])] + s['subjects'])[:5]  # uids ascend, so newest end up first
            s['bulk'] = s['bulk'] or bool(msg['List-Id'] or msg['List-Unsubscribe'])
            if msg['List-Unsubscribe']:
                s['unsub'] = parse_unsubscribe(str(msg['List-Unsubscribe']), str(msg['List-Unsubscribe-Post'] or ''))
        labels = folders(imap)
        replied = written_to(imap)
    with transaction.atomic():
        known = {s.address: s for s in Sender.objects.filter(account=key)}
        for address, s in found.items():
            if not s['unread']:
                continue
            row = known.pop(address, None) or Sender(account=key, address=address)
            row.name, row.total, row.unread, row.bulk, row.subjects = s['name'][:300], s['total'], s['unread'], s['bulk'], s['subjects']
            row.protected = s['protected']
            row.category = max(s['cats'], key=s['cats'].get)
            row.replied = address in replied
            row.unsubscribe, row.unsubscribe_link = s['unsub'][0][:1000], s['unsub'][1][:1000]
            if row.done != 'kept':
                row.done = ''  # mail came back since it was handled
            row.save()
        # nothing unread from them any more
        Sender.objects.filter(pk__in=[s.pk for s in known.values()]).delete()
        Setting.objects.update_or_create(key=f'cleanup_folders_{key}', defaults={'value': labels})
        counts = {f: sum(1 for v in protected.values() if v == f) for f in PROTECTED}
        Setting.objects.update_or_create(key=f'cleanup_protected_{key}', defaults={'value': counts})
    return sum(s['unread'] for s in found.values()), sum(1 for s in found.values() if s['unread'])


def scan():
    status = {'running': True, 'startedAt': timezone.now().isoformat()}
    Setting.objects.update_or_create(key='cleanup_scan', defaults={'value': status})
    try:
        unread = senders = 0
        keys = accounts()
        for i, key in enumerate(keys):
            Setting.objects.update_or_create(key='cleanup_scan', defaults={'value': {**status, 'account': key, 'step': i + 1, 'of': len(keys)}})
            u, s = scan_account(key)
            unread, senders = unread + u, senders + s
        status = {'running': False, 'finishedAt': timezone.now().isoformat(), 'unread': unread, 'senders': senders}
        Activity.objects.create(text=f'Scanned {unread:,} unread emails from {senders:,} senders for Cleanup', via='Cleanup')
    except Exception as e:
        status = {'running': False, 'error': str(e)[:300], 'finishedAt': timezone.now().isoformat()}
    Setting.objects.update_or_create(key='cleanup_scan', defaults={'value': status})


def start_scan():
    status = Setting.get('cleanup_scan') or {}
    # a scan that died with its worker shouldn't block a new one forever
    if status.get('running') and timezone.now() - datetime.fromisoformat(status['startedAt']) < timedelta(minutes=15):
        return False
    threading.Thread(target=scan, daemon=True).start()
    return True


def existing_folders(key):
    return Setting.get(f'cleanup_folders_{key}') or []


def describe(s):
    existing = existing_folders(s.account)
    proposed = sorted(set(Sender.objects.filter(account=s.account, suggestion='file').exclude(folder__in=existing).values_list('folder', flat=True)))
    return (
        f"Their existing folders: {', '.join(existing) or 'none'}\n"
        f"New folders already proposed: {', '.join(proposed) or 'none'}\n\n"
        + 
        f"Sender: {s.name} <{s.address}> ({s.account} inbox)\n"
        f"{s.total} emails in the inbox, {s.unread} unread. Gmail files most under: {s.category}.\n"
        f"Mailing-list headers: {'yes' if s.bulk else 'no'}\n"
        'Recent subjects:\n' + '\n'.join(f'- {x}' for x in s.subjects)
    )


def suggest(budget_s=SUGGEST_BUDGET_S):
    """Biggest senders first; stops after the budget and carries on next run. Raises when Ollama is away."""
    start, n = time.monotonic(), 0
    for s in Sender.objects.filter(suggestion='', done=''):
        if time.monotonic() - start > budget_s:
            break
        if s.replied:
            s.suggestion, s.reason, s.model = 'keep', 'You have written to them', 'none'
        else:
            out, s.model = triage.private_json(PROMPT, describe(s), SCHEMA)
            s.suggestion = out['action'] if out.get('action') in Sender.SUGGESTIONS else 'keep'
            s.reason = out.get('reason', '').strip()[:200]
            s.folder = out.get('folder', '').strip().strip('/')[:100] if s.suggestion == 'file' else ''
            if s.suggestion == 'file' and not s.folder:
                s.suggestion = 'archive'
        s.save(update_fields=['suggestion', 'reason', 'folder', 'model'])
        n += 1
    return n


def run(key, senders, action, deadline=None):
    """read | archive | trash | file: every inbox email from these senders, in Gmail, then mirrored here. Each
    sender is marked as he's done, with what Gmail still has left; past `deadline` (time.monotonic()) the rest wait."""
    with mail.open_inbox(key) as imap:
        folder = special_folder(imap, mail.MOVE_TO[action]) if action in mail.MOVE_TO else None
        existing = set(folders(imap)) if action == 'file' else set()
        for s in senders:
            if deadline and time.monotonic() > deadline:
                return
            if action == 'file':
                if s.folder not in existing:
                    imap.create(quote(s.folder))
                    existing.add(s.folder)
                folder = quote(s.folder)
            query = quote(f"from:{s.address} {'is:unread ' if action == 'read' else ''}{EXCLUDE}")
            # Gmail sometimes leaves part of a big move behind, so look again until nothing is left
            for _ in range(PASSES):
                uids = imap.uid('SEARCH', 'X-GM-RAW', query)[1][0].split()
                if not uids:
                    break
                for chunk in chunks(uids):
                    if action == 'read':
                        imap.uid('STORE', chunk, '+FLAGS', '(\\Seen)')
                    else:
                        imap.uid('MOVE', chunk, folder)
            left = len(imap.uid('SEARCH', 'X-GM-RAW', query)[1][0].split())
            mine = Item.objects.filter(kind=Item.EMAIL, account=key, sender__icontains=s.address)
            mine.update(unread=False) if action == 'read' else mine.delete()
            done = (f'filed in {s.folder}' if action == 'file' else DONE[action]) + (f', {left:,} left in Gmail' if left else '')
            Sender.objects.filter(pk=s.pk).update(done=done[:200], **({'unread': left} if action == 'read' else {'total': left, 'unread': 0}))


def file_protected(folder):
    """Every inbox email Gmail tagged for this folder, in both accounts, filed there. Runs in the background."""
    def work():
        moved = 0
        for key in accounts():
            try:
                with mail.open_inbox(key) as imap:
                    uids = imap.uid('SEARCH', 'X-GM-RAW', quote(' OR '.join(PROTECTED[folder])))[1][0].split()
                    if uids and folder not in folders(imap):
                        imap.create(quote(folder))
                    for chunk in chunks(uids):
                        imap.uid('MOVE', chunk, quote(folder))
                    moved += len(uids)
                counts = Setting.get(f'cleanup_protected_{key}') or {}
                Setting.objects.update_or_create(key=f'cleanup_protected_{key}', defaults={'value': {**counts, folder: 0}})
            except Exception as e:
                Activity.objects.create(text=f"Couldn't file {folder.lower()} in {key}: {e}"[:300], via='Cleanup')
        Activity.objects.create(text=f'Filed {moved:,} emails in {folder}', via='Cleanup')

    threading.Thread(target=work, daemon=True).start()


def apply_now(ids, action):
    """Mark read, archive or file, in the background: a big sender can take a minute. If a restart kills the thread,
    fetch finishes what's left (resume_stuck)."""
    senders = list(Sender.objects.filter(pk__in=ids).exclude(done__startswith='working'))
    Sender.objects.filter(pk__in=[s.pk for s in senders]).update(done=f'working:{action}', queued_at=timezone.now())

    def work():
        for key in {s.account for s in senders}:
            mine = [s for s in senders if s.account == key]
            try:
                run(key, mine, action)
            except Exception as e:
                Sender.objects.filter(pk__in=[s.pk for s in mine], done__startswith='working').update(done=f'failed: {e}'[:200])
        n = sum(s.unread if action == 'read' else s.total for s in senders)
        Activity.objects.create(text=f"{DONE[action].capitalize()} {n:,} emails from {len(senders)} sender{'s' if len(senders) != 1 else ''}", via='Cleanup')

    threading.Thread(target=work, daemon=True).start()
    return len(senders)


def ask_delete(ids, unsubscribe):
    """Deleting and unsubscribing reach outside Lifehub, so both wait for one stamp."""
    senders = list(Sender.objects.filter(pk__in=ids, done=''))
    if not senders:
        return None
    unsub = [s.pk for s in senders if unsubscribe and s.unsubscribe]
    n = sum(s.total for s in senders)
    top = sorted(senders, key=lambda s: -s.total)
    parts = [f'{s.name or s.address} {s.total:,}' for s in top[:4]] + ([f'{len(top) - 4} more'] if len(top) > 4 else [])
    title = f"Delete {n:,} emails from {senders[0].name or senders[0].address}" if len(senders) == 1 else f'Delete {n:,} emails from {len(senders)} senders'
    detail = ' · '.join(parts + ([f'unsubscribe from {len(unsub)}'] if unsub else []))
    return Approval.objects.create(kind='cleanup', account=senders[0].account if len({s.account for s in senders}) == 1 else '',
                                   title=title[:300], detail=detail, reason='Cleanup', payload={'action': 'trash_senders', 'senders': [s.pk for s in senders], 'unsubscribe': unsub})


def one_click(url):
    req = urllib.request.Request(url, data=b'List-Unsubscribe=One-Click', method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'lifehub'})
    with urllib.request.urlopen(req, timeout=20):
        pass


def resume_stuck(deadline):
    """Reads, archives and filings whose thread died with its web worker: carry on from where Gmail is now (moving
    or marking again is harmless, so a thread that is in fact still going does no damage)."""
    stuck = list(Sender.objects.filter(done__startswith='working:', queued_at__lte=timezone.now() - STUCK))
    for (key, action), group in groupby(sorted(stuck, key=lambda s: (s.account, s.done)), key=lambda s: (s.account, s.done.split(':', 1)[1])):
        group = list(group)
        try:
            run(key, group, action, deadline)
        except Exception as e:
            Sender.objects.filter(pk__in=[s.pk for s in group], done__startswith='working').update(done=f'failed: {e}'[:200])
        finished = Sender.objects.filter(pk__in=[s.pk for s in group]).exclude(done__startswith='working').count()
        if finished:
            Activity.objects.create(text=f"Finished {DONE[action]} for {finished} sender{'s' if finished != 1 else ''} after a restart", via='Cleanup')


def due(budget_s=DUE_BUDGET_S):
    """Approved deletes, a slice per fetch run: senders are marked as they're done, so a stamp too big for one run
    carries on in the next. Unsubscribes and the activity line come once none are left."""
    deadline = time.monotonic() + budget_s
    resume_stuck(deadline)
    approved = Approval.objects.filter(kind='cleanup', status='approved', sent_at__isnull=True, payload__action='trash_senders',
                                       decided__lte=timezone.now() - mail.UNDO).order_by('decided')
    approved = list(approved)
    for a in approved:
        senders = list(Sender.objects.filter(pk__in=a.payload['senders']))
        if len(senders) > 50 and all(not s.done for s in senders):
            Activity.objects.create(text=f"Started on: {a.title}. A stamp this big goes over several runs.", via='Cleanup', approval=a)
    # every stamp's senders in one pass per account, oldest stamp first: one Gmail login each, not one per stamp
    order = {pk: i for i, a in enumerate(approved) for pk in a.payload['senders']}
    todo = sorted(Sender.objects.filter(pk__in=list(order), done=''), key=lambda s: order[s.pk])
    for key in dict.fromkeys(s.account for s in todo):
        try:
            run(key, [s for s in todo if s.account == key], 'trash', deadline)
        except Exception as e:
            for a in approved:
                if any(s.account == key and s.pk in a.payload['senders'] for s in todo):
                    if a.send_error != str(e)[:500]:
                        Activity.objects.create(text=f"Delete stalled, retrying next run: {a.title} ({e})"[:300], via='Cleanup', approval=a)
                    Approval.objects.filter(pk=a.pk).update(send_error=str(e)[:500])
            return
    for a in approved:
        senders = list(Sender.objects.filter(pk__in=a.payload['senders']))
        if any(not s.done for s in senders):
            continue  # out of time; the next run picks up here
        Approval.objects.filter(pk=a.pk).update(sent_at=timezone.now(), send_error='')
        failed, unsubscribed = [], 0
        for s in senders:
            if s.pk in a.payload.get('unsubscribe', []) and s.unsubscribe:
                try:
                    one_click(s.unsubscribe)
                    unsubscribed += 1
                except Exception as e:
                    failed.append(f'unsubscribe {s.address}: {e}')
        left = Sender.objects.filter(pk__in=a.payload['senders']).exclude(total=0).count()
        extra = (f', unsubscribed from {unsubscribed}' if unsubscribed else '') + (f'; {left} sender{"s" if left != 1 else ""} still had mail left in Gmail' if left else '')
        Activity.objects.create(text=f"{a.title.replace('Delete', 'Deleted', 1)}{extra}" + (f" ({'; '.join(failed)})" if failed else ''), via='Cleanup', approval=a)
