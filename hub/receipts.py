"""Packages, Renewing this week and the reply-zero streak, from real mail.

Receipts come from Gmail's own per-email tags (receipts and purchases) across All Mail, so filed and
archived ones count too. Each is read once by Ollama (private mail) into a Receipt row.
"""
from datetime import date, timedelta
from email.utils import parseaddr
from urllib.parse import quote

from django.db import IntegrityError
from django.db.models import Q
from django.utils import timezone

from hub import mail, triage
from hub.models import DayStat, Receipt, Setting
from hub.sources import parse_message, special_folder

DAYS = 14
PER_ACCOUNT = 40  # newest receipts looked at per fetch
BUDGET_S = 60  # Ollama time per fetch run (about 30 s a receipt); the rest wait for the next run
QUERY = 'newer_than:{days}d (label:^smartlabel_receipt OR category:purchases)'
PROGRESS = {'ordered': .2, 'shipped': .5, 'out_for_delivery': .88, 'delivered': 1.0}
STATUS_LABEL = {'ordered': 'Ordered', 'shipped': 'Shipped', 'out_for_delivery': 'Out for delivery', 'delivered': 'Delivered'}

PROMPT = """You read one receipt, order or shipping email for YOUR_NAME and pull out the facts. Today is {today}.
kind: shipment (an order being shipped or delivered, with tracking or delivery status), renewal (a subscription
or membership that renews or bills again on a date), cancelled (a subscription that has been cancelled, will end
or will not renew: renews_on is then ""), purchase (a one-off receipt or order confirmation with no
shipping news), other (anything else, including marketing).
item: what was bought, in at most 5 words, e.g. "Desk lamp", "Spotify Premium". merchant: the store or service.
status (shipments only, else none): ordered, shipped, out_for_delivery or delivered.
eta: expected delivery date as YYYY-MM-DD if stated, else "". renews_on: the next renewal or billing date as
YYYY-MM-DD if stated, else "". amount: the total charged as a number, or null. Only use facts in the email."""

SCHEMA = {
    'type': 'object',
    'properties': {
        'kind': {'type': 'string', 'enum': Receipt.KINDS}, 'item': {'type': 'string', 'minLength': 1}, 'merchant': {'type': 'string', 'minLength': 1},
        'status': {'type': 'string', 'enum': Receipt.STATUSES}, 'eta': {'type': 'string'}, 'renews_on': {'type': 'string'},
        'amount': {'type': ['number', 'null']},
    },
    'required': ['kind', 'item', 'merchant', 'status', 'eta', 'renews_on', 'amount'],
}


def fetch(key):
    """The newest receipt emails of the last two weeks, from All Mail."""
    with mail.open_inbox(key, readonly=True) as imap:
        folder = special_folder(imap, b'\\All')
        if folder:
            imap.select(folder, readonly=True)
        uids = imap.uid('SEARCH', 'X-GM-RAW', f'"{QUERY.format(days=DAYS)}"')[1][0].split()[-PER_ACCOUNT:]
        known = set(Receipt.objects.filter(account=key).values_list('uid', flat=True))
        out = []
        for u in uids:
            # headers first: no need to download the body of a receipt already read
            head = imap.uid('FETCH', u, '(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])')[1][0][1].decode(errors='replace')
            msgid = head.split(':', 1)[-1].strip().strip('<> ')
            if msgid and msgid in known:
                continue
            flags, raw = imap.uid('FETCH', u, '(FLAGS BODY.PEEK[])')[1][0]
            out.append(parse_message(raw, flags, mail.account_config(key)['user']))
        return out


def day(value):
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def read(key, message):
    """One receipt through Ollama into a row, once. Raises when Ollama is away."""
    if Receipt.objects.filter(account=key, uid=message['uid']).exists():
        return None
    out, _ = triage.private_json(PROMPT.format(today=date.today().isoformat()),
                             f"From: {message['sender']}\nSubject: {message['title']}\n\n{message['body']}", SCHEMA)
    amount = out.get('amount')
    try:
        return Receipt.objects.create(
            account=key, uid=message['uid'], sender=message['sender'][:300], subject=message['title'][:500], received=message['published'],
            kind=out['kind'] if out.get('kind') in Receipt.KINDS else 'other',
            item=out.get('item', '').strip()[:120], merchant=(out.get('merchant', '').strip() or parseaddr(message['sender'])[0])[:120],
            status=out.get('status') if out.get('status') in Receipt.STATUSES else 'none',
            eta=day(out.get('eta', '')), renews_on=day(out.get('renews_on', '')),
            amount=float(amount) if isinstance(amount, (int, float)) else None,
        )
    except IntegrityError:
        return None


def packages(now=None):
    """Shipments still coming (or delivered in the last day): the latest email per order wins."""
    now = now or timezone.now()
    latest = {}
    for r in Receipt.objects.filter(kind='shipment', received__gte=now - timedelta(days=DAYS)):
        latest[(r.merchant.lower(), r.item.lower())] = r
    live = [r for r in latest.values() if r.status != 'delivered' or now - r.received < timedelta(days=1)]
    return [{'id': str(r.pk), 'item': r.item or r.subject[:40], 'carrier': r.merchant, 'status': STATUS_LABEL.get(r.status, 'On its way'),
             'progress': PROGRESS.get(r.status, .5), 'eta': r.eta.isoformat() if r.eta else '', 'url': gmail_link(r)}
            for r in sorted(live, key=lambda r: PROGRESS.get(r.status, .5), reverse=True)]


def renewals(today=None):
    today = today or timezone.localdate()
    # the item names the service ("EA Play"); the merchant is often only the store that billed it ("Google Play")
    hidden = {h.lower() for h in Setting.get('hidden_renewals') or []}
    seen = {}
    for r in Receipt.objects.filter(renews_on__gte=today, renews_on__lte=today + timedelta(days=7)).exclude(kind='cancelled').order_by('renews_on'):
        name = (r.item or r.merchant).lower()
        # a cancellation that came after it means it won't renew
        ended = Receipt.objects.filter(kind='cancelled', received__gt=r.received).filter(Q(item__iexact=r.item) if r.item else Q(merchant__iexact=r.merchant)).exists()
        if name not in hidden and not ended:
            seen.setdefault(name, r)
    rows = [{'id': str(r.pk), 'name': r.item or r.merchant, 'date': r.renews_on.isoformat(), 'amount': amount_for(r), 'url': gmail_link(r)} for r in seen.values()]
    return sorted(rows, key=lambda r: r['date'])


def amount_for(r):
    """A renewal notice often leaves out the price: use what the last receipt for the same thing charged."""
    if r.amount is not None:
        return r.amount
    last = Receipt.objects.filter(item__iexact=r.item, amount__isnull=False).exclude(item='').order_by('-received').first()
    return last.amount if last else None


def gmail_link(r):
    try:
        return f"https://mail.google.com/mail/u/{mail.account_config(r.account)['user']}/#search/rfc822msgid:{quote(r.uid)}"
    except LookupError:
        return ''


def note_replies(count, today=None):
    """Keep the day's lowest Needs-a-reply count."""
    today = today or timezone.localdate()
    stat, made = DayStat.objects.get_or_create(day=today, defaults={'reply_min': count})
    if not made and count < stat.reply_min:
        DayStat.objects.filter(pk=stat.pk).update(reply_min=count)


def streak(today=None):
    """Days in a row Needs a reply got to zero. Today only counts once it has; until then the streak runs to yesterday."""
    today = today or timezone.localdate()
    zero = set(DayStat.objects.filter(reply_min=0, day__gte=today - timedelta(days=366)).values_list('day', flat=True))
    d = today if today in zero else today - timedelta(days=1)
    days = 0
    while d in zero:
        days += 1
        d -= timedelta(days=1)
    monday = today - timedelta(days=today.weekday())
    return {'days': days, 'week': [monday + timedelta(days=i) in zero for i in range(7)]}
