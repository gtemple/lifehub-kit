import imaplib
import smtplib
import time
from contextlib import contextmanager
from email.utils import parseaddr
from datetime import timedelta
from email.message import EmailMessage

from django.conf import settings
from django.utils import timezone

from hub import events
from hub.models import Activity, Approval, Setting
from hub.sources import IMAP_TIMEOUT, special_folder

UNDO = timedelta(seconds=30)


def account_config(key):
    for a in settings.LIFEHUB.get('email', []):
        if a.get('account', a['name'].lower()) == key:
            return a
    raise LookupError(f'no email account {key!r} (Settings > connections)')


def send(approval):
    p = approval.payload
    acct = account_config(approval.account)
    msg = EmailMessage()
    msg['From'] = acct['user']
    msg['To'] = p['to']
    if p.get('cc'):
        msg['Cc'] = p['cc']
    msg['Subject'] = p['subject']
    if p.get('inReplyTo'):
        msg['In-Reply-To'] = p['inReplyTo']
        msg['References'] = p['inReplyTo']
    msg.set_content(p['body'])
    # Gmail files mail sent over SMTP in Sent, threaded with the original
    with smtplib.SMTP_SSL(acct.get('smtp_host', 'smtp.gmail.com'), 465, timeout=30) as smtp:
        smtp.login(acct['user'], acct['password'])
        smtp.send_message(msg)


def send_due():
    """Send approved replies whose undo window has passed. Safe to call from anywhere, any number of times."""
    live = Setting.get('send_email', False)
    due = Approval.objects.filter(kind='email', status='approved', sent_at__isnull=True, item__isnull=False,
                                  decided__lte=timezone.now() - UNDO)
    for a in due:
        # claim it first, so two callers can never send the same reply twice
        if not Approval.objects.filter(pk=a.pk, sent_at__isnull=True).update(sent_at=timezone.now()):
            continue
        if not live:
            Activity.objects.create(text=f'Would send (sending is off): {a.title}', via='Email', approval=a)
            continue
        t = time.monotonic()
        try:
            send(a)
        except Exception as e:
            Approval.objects.filter(pk=a.pk).update(sent_at=None, status='pending', decided=None, send_error=str(e)[:500])
            Activity.objects.create(text=f"Couldn't send, back in your stamps: {a.title} ({e})"[:300], via='Email', approval=a)
            events.record('send', 'web', 'gmail', ms=events.ms(t), ok=False, item=f'email:{a.item_id}', text=f"Couldn't send: {a.title}")
            continue
        events.record('send', 'web', 'gmail', ms=events.ms(t), item=f'email:{a.item_id}', text=f'Sent: {a.title}')
        Activity.objects.create(text=f'Sent: {a.title}', via='Email', approval=a)
        if a.item:
            a.item.answered = True
            a.item.save(update_fields=['answered'])


MOVE_TO = {'archive': b'\\All', 'trash': b'\\Trash'}  # archiving in Gmail is moving out of the inbox into All Mail


@contextmanager
def open_inbox(key, readonly=False):
    acct = account_config(key)
    with imaplib.IMAP4_SSL(acct.get('host', 'imap.gmail.com'), timeout=IMAP_TIMEOUT) as imap:
        imap.login(acct['user'], acct['password'])
        imap.select('INBOX', readonly=readonly)
        yield imap


def act(item, action):
    """Mark one email read, archive it or move it to Trash in Gmail, then mirror that here."""
    with open_inbox(item.account) as imap:
        uids = imap.uid('SEARCH', None, 'HEADER', 'Message-ID', item.uid)[1][0].split()
        if not uids:
            raise LookupError('it is no longer in your inbox')
        for u in uids:
            if action == 'read':
                imap.uid('STORE', u, '+FLAGS', '(\\Seen)')
            else:
                imap.uid('MOVE', u, special_folder(imap, MOVE_TO[action]))
    if action == 'read':
        item.unread = False
        item.save(update_fields=['unread'])
    else:
        item.delete()


def ask_trash(item, reason):
    """Deleting waits for a stamp, so a misheard request can't lose mail."""
    existing = Approval.objects.filter(kind='cleanup', status='pending', item=item, payload__action='trash').first()
    if existing:
        return existing
    who = parseaddr(item.sender)[0] or parseaddr(item.sender)[1]
    return Approval.objects.create(
        kind='cleanup', account=item.account, item=item, payload={'action': 'trash'}, reason=reason,
        title=f'Delete: {item.title}'[:300], detail=f'From {who}. Moves to Gmail Trash, kept there 30 days.')


def trash_due():
    due = Approval.objects.filter(kind='cleanup', status='approved', sent_at__isnull=True, payload__action='trash',
                                  decided__lte=timezone.now() - UNDO)
    for a in due:
        if not Approval.objects.filter(pk=a.pk, sent_at__isnull=True).update(sent_at=timezone.now()):
            continue
        if not a.item:
            Activity.objects.create(text=f'Already gone from your inbox: {a.title}', via='Email', approval=a)
            continue
        try:
            act(a.item, 'trash')
        except Exception as e:
            Approval.objects.filter(pk=a.pk).update(sent_at=None, status='pending', decided=None, send_error=str(e)[:500])
            Activity.objects.create(text=f"Couldn't delete, back in your stamps: {a.title} ({e})"[:300], via='Email', approval=a)
            continue
        Activity.objects.create(text=f'Moved to Trash: {a.title[8:]}', via='Email', approval=a)


def run_due():
    """Everything approved whose undo window has passed."""
    from hub import cleanup
    send_due()
    trash_due()
    cleanup.due()
