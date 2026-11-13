"""Waiting on a reply: mail you sent that asks for an answer and hasn't had one."""
import email
import re
from datetime import date, timedelta
from email.policy import default as email_policy
from email.utils import getaddresses, parseaddr
from urllib.parse import quote

from django.utils import timezone

from hub import mail, triage
from hub.health import private_up
from hub.models import SentMail
from hub.sources import fetch_many, parse_date, parse_message, special_folder

DAYS = 14  # how far back sent mail is looked at
AFTER = timedelta(days=3)  # quiet this long before it shows as waiting
PER_RUN = 10  # sent emails read by the model per run

PROMPT = """YOUR_NAME sent this email. Decide whether they are waiting for an answer: it asks the recipient a question,
for a decision, a document, a time or some other action. Emails that only thank, confirm, share information
or close a conversation expect nothing. summary: at most 8 words, what they are waiting for, no names."""
SCHEMA = {'type': 'object', 'properties': {'expects': {'type': 'boolean'}, 'summary': {'type': 'string'}}, 'required': ['expects', 'summary']}


def thread_of(meta):
    m = re.search(rb'X-GM-THRID (\d+)', meta)
    return m.group(1).decode() if m else ''


def scan(key):
    """Bring SentMail up to date for one account. Returns how many were read by the model."""
    acct = mail.account_config(key)
    me = acct['user'].lower()
    read = 0
    with mail.open_inbox(key, readonly=True) as imap:
        sent = special_folder(imap, b'\\Sent')
        everything = special_folder(imap, b'\\All')
        if not sent or not everything:
            return 0
        imap.select(sent, readonly=True)
        cutoff = date.today() - timedelta(days=DAYS)
        since = cutoff.strftime('%d-%b-%Y')
        nums = imap.search(None, 'SINCE', since)[1][0].split()
        newest = {}  # thread -> (num, headers); later sends in a thread replace earlier ones
        for num, (meta, head) in zip(nums, fetch_many(imap, nums, '(X-GM-THRID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID TO SUBJECT DATE)])')):
            msg = email.message_from_bytes(head, policy=email_policy)
            to = [a for _, a in getaddresses([str(msg['To'] or '')]) if a]
            if thread_of(meta) and to and any(a.lower() != me for a in to):
                newest[thread_of(meta)] = (num, msg)
        unread = []
        for thread, (num, msg) in newest.items():
            uid = (msg['Message-ID'] or '').strip('<> ')
            row = SentMail.objects.filter(account=key, thread=thread).first()
            if row and row.uid == uid:
                if row.expects is None:
                    unread.append((num, row))
                continue
            # a new conversation, or you wrote again: start over
            names = getaddresses([str(msg['To'] or '')])
            first = names[0][0] or names[0][1]
            row = row or SentMail(account=key, thread=thread)
            row.uid, row.subject, row.sent_at = uid, str(msg['Subject'] or '(no subject)')[:500], parse_date(msg['Date'])
            row.to = (first + (f' +{len(names) - 1}' if len(names) > 1 else ''))[:300]
            row.url = f'https://mail.google.com/mail/u/{me}/#search/rfc822msgid:{quote(uid)}' if uid else ''
            row.expects, row.summary, row.replied, row.dismissed = None, '', False, False
            row.save()
            unread.append((num, row))
        # by day, like IMAP's SINCE: an exact 14 days would delete mail the search still returns, and re-read it every run
        SentMail.objects.filter(account=key, sent_at__date__lt=cutoff).delete()

        unread = unread[:PER_RUN] if private_up() else []
        for (num, row), (meta, raw) in zip(unread, fetch_many(imap, [n for n, _ in unread], '(FLAGS BODY.PEEK[])')):
            body = parse_message(raw, meta, me)['body']
            out, _ = triage.private_json(PROMPT, f'To: {row.to}\nSubject: {row.subject}\n\n{body}', SCHEMA, background=True)
            row.expects, row.summary = bool(out.get('expects')), str(out.get('summary', '')).strip()[:200]
            row.save(update_fields=['expects', 'summary'])
            read += 1

        # has anyone else written in the thread since?
        imap.select(everything, readonly=True)
        for row in SentMail.objects.filter(account=key, expects=True, replied=False, dismissed=False):
            found = imap.search(None, 'X-GM-THRID', row.thread)[1][0].split()
            for _, head in fetch_many(imap, found, '(BODY.PEEK[HEADER.FIELDS (FROM DATE)])'):
                msg = email.message_from_bytes(head, policy=email_policy)
                # shortcut: only the account's own address counts as you; add aliases here if replies from them show as answers
                if parseaddr(str(msg['From'] or ''))[1].lower() != me and parse_date(msg['Date']) > row.sent_at:
                    row.replied = True
                    row.save(update_fields=['replied'])
                    break
    return read


def waiting():
    rows = SentMail.objects.filter(expects=True, replied=False, dismissed=False, sent_at__lte=timezone.now() - AFTER)
    return [{'id': str(r.pk), 'to': r.to, 'subject': r.subject, 'summary': r.summary, 'sentAt': r.sent_at.isoformat(),
             'url': r.url, 'account': r.account} for r in rows]
