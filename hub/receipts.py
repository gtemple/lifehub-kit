"""Packages, Renewing this week, Coming up and the reply-zero streak, from real mail.

Receipts come from Gmail's own per-email tags (receipts and purchases) across All Mail, so filed and
archived ones count too. Each is read once by Ollama (private mail) into a Receipt row.
"""
from datetime import date, datetime, time, timedelta
from datetime import timezone as dt_timezone
from email.utils import parseaddr
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from django.conf import settings
from django.core.cache import cache

from django.db import IntegrityError
from django.db.models import Q
from django.utils import timezone

from hub import agenda, mail, triage
from hub.models import DayStat, Receipt, Setting
from hub.sources import parse_message, special_folder

DAYS = 14
PER_ACCOUNT = 40  # newest receipts looked at per fetch
BUDGET_S = 60  # Ollama time per fetch run (about 30 s a receipt); the rest wait for the next run
QUERY = 'newer_than:{days}d (label:^smartlabel_receipt OR category:purchases OR category:reservations)'  # invites skipped: Gmail puts those on your calendar itself
AHEAD = timedelta(days=60)
PROGRESS = {'ordered': .2, 'shipped': .5, 'out_for_delivery': .88, 'delivered': 1.0}
STATUS_LABEL = {'ordered': 'Ordered', 'shipped': 'Shipped', 'out_for_delivery': 'Out for delivery', 'delivered': 'Delivered'}

PROMPT = """You read one receipt, order or shipping email for YOUR_NAME and pull out the facts. Today is {today}.
kind: shipment (an order being shipped or delivered, with tracking or delivery status), renewal (a subscription
or membership that renews or bills again on a date), event (a booking or appointment YOUR_NAME will attend: flight,
train, hotel or Airbnb stay, restaurant reservation, appointment, ticketed show or game, meeting invitation; also
reminder, check-in and boarding-pass emails for one), cancelled (a subscription that has been cancelled, will end
or will not renew: renews_on is then ""; or a booking, reservation or meeting that was cancelled: fill starts),
purchase (a one-off receipt or order confirmation with no shipping news or date to attend), other (anything else,
including marketing and tickets merely on sale).
item: what was bought, in at most 5 words, e.g. "Desk lamp", "Spotify Premium"; for an event a short title, e.g.
"Flight YUL to YVR", "Dinner at La Toile", "Airbnb in Vancouver". merchant: the store or service; for an event the
airline, restaurant, host or organizer.
status (shipments only, else none): ordered, shipped, out_for_delivery or delivered.
eta: expected delivery date as YYYY-MM-DD if stated, else "". renews_on: the next renewal or billing date as
YYYY-MM-DD if stated, else "". amount: the total charged as a number, or null.
Events and cancelled bookings only, else "": starts = when it begins as YYYY-MM-DDTHH:MM in the local time where
it happens, or YYYY-MM-DD for a stay or anything without a time; ends = when it ends (arrival, check-out) the same
way, else ""; timezone = the IANA zone where it starts, e.g. America/Vancouver, else ""; place = where, in a few
words (airports, restaurant, address). Leave starts "" when the email doesn't state the date, and give a time
only when it states one. Only use facts in the email."""

SCHEMA = {
    'type': 'object',
    'properties': {
        'kind': {'type': 'string', 'enum': Receipt.KINDS}, 'item': {'type': 'string', 'minLength': 1}, 'merchant': {'type': 'string', 'minLength': 1},
        'status': {'type': 'string', 'enum': Receipt.STATUSES}, 'eta': {'type': 'string'}, 'renews_on': {'type': 'string'},
        'amount': {'type': ['number', 'null']},
        'starts': {'type': 'string'}, 'ends': {'type': 'string'}, 'timezone': {'type': 'string'}, 'place': {'type': 'string'},
    },
    'required': ['kind', 'item', 'merchant', 'status', 'eta', 'renews_on', 'amount', 'starts', 'ends', 'timezone', 'place'],
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


def moment(value, zone):
    """'YYYY-MM-DDTHH:MM' in the event's own zone, or 'YYYY-MM-DD' for all day. Returns (aware datetime or None, all day)."""
    try:
        tz = ZoneInfo(zone) if zone else timezone.get_current_timezone()
    except (ZoneInfoNotFoundError, ValueError):
        tz = timezone.get_current_timezone()
    try:
        if len(value) == 10:
            # noon, so the date survives conversion to any zone within 11 h
            return datetime.combine(date.fromisoformat(value), time(12), tz), True
        dt = datetime.fromisoformat(value)
        return (dt if dt.tzinfo else dt.replace(tzinfo=tz)), False
    except ValueError:
        return None, False


def read(key, message):
    """One receipt through Ollama into a row, once. Raises when Ollama is away."""
    if Receipt.objects.filter(account=key, uid=message['uid']).exists():
        return None
    out, _ = triage.private_json(PROMPT.format(today=date.today().isoformat()),
                             f"From: {message['sender']}\nSubject: {message['title']}\n\n{message['body']}", SCHEMA)
    amount = out.get('amount')
    kind = out['kind'] if out.get('kind') in Receipt.KINDS else 'other'
    starts, all_day = moment(out.get('starts', ''), out.get('timezone', '')) if kind in ('event', 'cancelled') else (None, False)
    ends = moment(out.get('ends', ''), out.get('timezone', ''))[0] if starts else None
    try:
        return Receipt.objects.create(
            account=key, uid=message['uid'], sender=message['sender'][:300], subject=message['title'][:500], received=message['published'],
            kind=kind, starts=starts, ends=ends, all_day=all_day, place=out.get('place', '').strip()[:120] if starts else '',
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


def on_calendar(now):
    """Start times and titles already on your calendars; Gmail puts many bookings and every accepted invite there itself."""
    out = []
    for cal in settings.LIFEHUB.get('calendar', []):
        try:
            out += agenda.events_on(agenda.fetch(cal['url']), timezone.localdate(now), '', days=AHEAD.days + 1)
        except Exception:
            pass  # a calendar that can't be read hides nothing
    return out


def same(r, e):
    start = datetime.fromisoformat(e['start'])
    if r.all_day or e['allDay']:
        words = {w for w in (r.item + ' ' + r.place).lower().split() if len(w) > 3}
        return r.all_day and e['allDay'] and start.date() <= timezone.localtime(r.starts).date() < datetime.fromisoformat(e['end']).date() and any(w in e['title'].lower() for w in words)
    return abs(start - r.starts) <= timedelta(minutes=30)


def coming_up(now=None):
    """Bookings, appointments and invites from mail in the next 60 days that aren't on a calendar yet. Cached 5 min."""
    if now is None and (cached := cache.get('coming_up')) is not None:
        return cached
    at = now or timezone.now()
    groups = []
    rows = Receipt.objects.filter(kind__in=['event', 'cancelled'], starts__lte=at + AHEAD).filter(Q(starts__gte=at) | Q(ends__gte=at)).order_by('received')
    # one booking = same day and same merchant or title ("FlyFlair" and "Flair Airlines" both send "Flight YUL to YVR")
    # shortcut: two separate bookings with one merchant on one day collapse; key on a booking reference if that bites
    for r in rows:
        key = (timezone.localtime(r.starts).date(), r.merchant.lower(), r.item.lower())
        g = next((g for g in groups if g[0][0] == key[0] and (g[0][1] == key[1] or g[0][2] == key[2])), None)
        if g:
            g[1].append(r)
        else:
            groups.append((key, [r]))
    live = []
    for _, g in groups:
        if g[-1].kind == 'event':  # the newest email says whether it's still on
            # a boarding pass often only knows the date: a midnight time never beats a real one
            timed = [r for r in g if r.all_day or timezone.localtime(r.starts).time() != time.min]
            live.append((timed or g)[-1])
    listed = on_calendar(at) if live else []
    out = [{
        'id': str(r.pk), 'title': r.item or r.subject[:60], 'start': r.starts.isoformat(), 'end': r.ends.isoformat() if r.ends else None,
        'allDay': r.all_day, 'where': r.place, 'account': r.account, 'url': gmail_link(r), 'add': add_link(r),
    } for r in sorted(live, key=lambda r: (timezone.localtime(r.starts).date(), not r.all_day, r.starts)) if not any(same(r, e) for e in listed)]
    if now is None:
        cache.set('coming_up', out, 5 * 60)
    return out


def add_link(r):
    """Google Calendar's prefilled new-event page, on the account the email came to."""
    if r.all_day:
        s = timezone.localtime(r.starts).date()
        e = max(timezone.localtime(r.ends).date() if r.ends else s, s + timedelta(days=1))  # Google's all-day end is exclusive
        dates = f'{s:%Y%m%d}/{e:%Y%m%d}'
    else:
        e = r.ends if r.ends and r.ends > r.starts else r.starts + timedelta(hours=1)
        dates = '/'.join(x.astimezone(dt_timezone.utc).strftime('%Y%m%dT%H%M%SZ') for x in (r.starts, e))
    q = {'action': 'TEMPLATE', 'text': r.item or r.subject, 'dates': dates, 'location': r.place, 'details': gmail_link(r)}
    try:
        q['authuser'] = mail.account_config(r.account)['user']
    except LookupError:
        pass
    return f'https://calendar.google.com/calendar/render?{urlencode(q)}'


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
