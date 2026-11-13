import email
from email.utils import getaddresses, parseaddr
import html
import imaplib
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.policy import default as email_policy
from email.utils import parsedate_to_datetime
from urllib.parse import quote

ATOM = '{http://www.w3.org/2005/Atom}'

IMAP_TIMEOUT = 120  # seconds per read: a dropped Gmail connection otherwise blocks a fetch run forever


def plain(text, limit=300):
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text or ''))
    return re.sub(r'\s+', ' ', text).strip()[:limit]


INVISIBLE = re.compile('[\u200b-\u200f\u034f\u00ad\ufeff\u2060\u180e]')
PARAGRAPH_END = re.compile(r'</(p|ul|ol|h[1-6]|table|blockquote|section)\s*>|<hr[^>]*>', re.I)
LINE_END = re.compile(r'</(div|tr)\s*>|<br\s*/?>', re.I)
URL = re.compile(r'\(?\s*<?https?://[^\s<>()]+>?\s*\)?')


def short_url(m):
    """A short link stays; a long (tracking) one goes: the email itself is a click away in Gmail."""
    url = m.group(0).strip('()<> ')
    return url if len(url) <= 40 else ''


def readable(text, is_html=False, limit=4000):
    """An email body as text that reads like the email: paragraphs and line breaks kept, no CSS or scripts, list
    items as bullets, links as their text (or their site, if the link is all there is), no invisible spacer
    characters or rows of dashes."""
    text = text or ''
    if is_html:
        text = re.sub(r'<(style|script|head|title)[^>]*>.*?</\1\s*>|<!--.*?-->', ' ', text, flags=re.S | re.I)
        text = re.sub(r'<a\b[^>]*href=["\']([^"\']*)["\'][^>]*>(.*?)</a\s*>', lambda m: m.group(2) if re.sub(r'<[^>]+>|\s', '', m.group(2)) else m.group(1), text, flags=re.S | re.I)
        text = re.sub(r'<li[^>]*>', '\n• ', text, flags=re.I)
        text = LINE_END.sub('\n', PARAGRAPH_END.sub('\n\n', text))
        text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    text = URL.sub(short_url, INVISIBLE.sub('', text.replace('\r\n', '\n')))
    lines = [re.sub(r'[ \t\xa0]+', ' ', line).strip() for line in text.split('\n')]
    lines = [line for line in lines if not re.fullmatch(r'[-=_*~·•.]{3,}', line)]
    lines = [line for i, line in enumerate(lines) if not (line and i and line == lines[i - 1])]  # 'Shop' 'Shop' 'Shop'
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()[:limit]


def parse_date(value):
    if not value:
        return datetime.now(timezone.utc)
    try:
        d = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        d = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def parse_feed(xml):
    root = ET.fromstring(xml)
    items = []
    for it in root.iter('item'):
        link = it.findtext('link') or ''
        items.append({
            'uid': it.findtext('guid') or link,
            'title': plain(it.findtext('title'), 500),
            'url': link,
            'snippet': plain(it.findtext('description')),
            'sender': plain(it.findtext('{http://purl.org/dc/elements/1.1/}creator'), 300),
            'published': parse_date(it.findtext('pubDate')),
        })
    for it in root.iter(ATOM + 'entry'):
        link = it.find(ATOM + 'link')
        items.append({
            'uid': it.findtext(ATOM + 'id'),
            'title': plain(it.findtext(ATOM + 'title'), 500),
            'url': link.get('href') if link is not None else '',
            'snippet': plain(it.findtext(ATOM + 'content') or it.findtext(ATOM + 'summary')),
            'sender': plain(it.findtext(f'{ATOM}author/{ATOM}name'), 300),
            'published': parse_date(it.findtext(ATOM + 'published') or it.findtext(ATOM + 'updated')),
        })
    return items


def fetch_feed(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'lifehub/0.1 (personal dashboard)'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return parse_feed(r.read())


def message_key(msg):
    """What an email is stored under: its Message-ID, else its date and subject."""
    msgid = (msg['Message-ID'] or '').strip('<> ')
    return msgid or f"{msg['Date']}{msg['Subject']}"


def parse_message(raw, flags, user):
    msg = email.message_from_bytes(raw, policy=email_policy)
    body = msg.get_body(preferencelist=('plain', 'html'))
    msgid = (msg['Message-ID'] or '').strip('<> ')
    try:
        text = body.get_content() if body else ''
    except (LookupError, UnicodeDecodeError):
        text = ''
    is_html = bool(body) and body.get_content_type() == 'text/html'
    return {
        'uid': message_key(msg),
        'title': plain(str(msg['Subject'] or '(no subject)'), 500),
        # not plain(): its tag stripping would eat the <address>
        'sender': re.sub(r'\s+', ' ', str(msg['From'] or '')).strip()[:300],
        **recipients(msg, user),
        'url': f'https://mail.google.com/mail/u/{user}/#search/rfc822msgid:{quote(msgid)}' if msgid else '',
        'snippet': plain(readable(text, is_html)),
        'body': readable(text, is_html),
        'bulk': bool(msg['List-Unsubscribe'] or msg['List-Id'] or str(msg['Precedence'] or '').lower() in ('bulk', 'list')),
        'unread': b'\\Seen' not in flags,
        'answered': b'\\Answered' in flags,
        'published': parse_date(msg['Date']),
    }


def recipients(msg, user):
    """Who a reply goes to, like Gmail's Reply all: Reply-To (else From), copying everyone else on the email but you."""
    sender = parseaddr(str(msg['From'] or ''))[1].lower()
    reply_to = parseaddr(str(msg['Reply-To'] or ''))[1].lower()
    me = user.lower()
    others = []
    for _, addr in getaddresses([str(msg['To'] or ''), str(msg['Cc'] or '')]):
        addr = addr.lower()
        if addr and '@' in addr and addr not in (me, sender, reply_to) and addr not in others:
            others.append(addr)
    return {'reply_to': reply_to if reply_to != sender else '', 'others': ', '.join(others)}


def reply_targets(headers):
    """Message-IDs a sent message answers, from its In-Reply-To and References headers."""
    msg = email.message_from_bytes(headers, policy=email_policy)
    return set(re.findall(r'<([^>]+)>', f"{msg['In-Reply-To'] or ''} {msg['References'] or ''}"))


def special_folder(imap, flag):
    """Gmail's Sent, All Mail or Trash: their names depend on the account's language; the flag (b'\\Sent') doesn't."""
    for line in imap.list()[1]:
        m = re.match(rb'\(([^)]*)\) "[^"]*" (.+)$', line)
        if m and flag in m.group(1).split():
            return m.group(2).decode()
    return None


def fetch_many(imap, nums, what):
    """One FETCH for many messages: [(metadata, literal)] in order. Gmail may put FLAGS after the literal, so the
    bytes that follow a literal are part of its metadata."""
    if not nums:
        return []
    _, data = imap.fetch(b','.join(nums), what)
    return [(part[0] + (data[i + 1] if i + 1 < len(data) and isinstance(data[i + 1], bytes) else b''), part[1])
            for i, part in enumerate(data) if isinstance(part, tuple)]


def replied(imap, since):
    """IDs of mail answered from anywhere, Gmail's web UI included, which never sets \\Answered."""
    folder = special_folder(imap, b'\\Sent')
    if not folder:
        return set()
    imap.select(folder, readonly=True)
    _, data = imap.search(None, 'SINCE', since)
    out = set()
    for _, headers in fetch_many(imap, data[0].split(), '(BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO REFERENCES)])'):
        out |= reply_targets(headers)
    return out


def gm_thread(meta):
    """Gmail's conversation id from a FETCH response ('' from a server that isn't Gmail)."""
    m = re.search(rb'X-GM-THRID (\d+)', meta)
    return m.group(1).decode() if m else ''


KEEP_MAX = 40  # older mail checked one by one each run; more than this waiting on a reply is a backlog, not a list


def fetch_email(account, days=3, limit=50, known=frozenset(), keep=frozenset()):
    """The inbox's last few days. Mail already in `known` (stored keys) comes back as just its key and flags, so
    only new mail is downloaded whole. `keep` is older mail still waiting on a reply: each one that is still in the
    inbox comes back too, so it isn't dropped (with its draft) just for being more than a few days old."""
    with imaplib.IMAP4_SSL(account.get('host', 'imap.gmail.com'), timeout=IMAP_TIMEOUT) as imap:
        imap.login(account['user'], account['password'])
        imap.select('INBOX', readonly=True)
        since = (date.today() - timedelta(days=days)).strftime('%d-%b-%Y')
        _, data = imap.search(None, 'SINCE', since)
        nums = data[0].split()[-limit:]
        heads = fetch_many(imap, nums, '(X-GM-THRID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE SUBJECT)])')
        items, new = [], []
        for num, (meta, head) in zip(nums, heads):
            key = message_key(email.message_from_bytes(head, policy=email_policy))
            if key in known:
                items.append({'uid': key, 'unread': b'\\Seen' not in meta, 'answered': b'\\Answered' in meta, 'thread': gm_thread(meta)})
            else:
                new.append(num)
        items += [{**parse_message(raw, meta, account['user']), 'thread': gm_thread(meta)}
                  for meta, raw in fetch_many(imap, new, '(X-GM-THRID FLAGS BODY.PEEK[])')]
        seen = {it['uid'] for it in items}
        for key in sorted(keep - seen)[:KEEP_MAX]:
            if '@' not in key or '"' in key:
                continue  # stored under date+subject (no Message-ID): can't be looked up
            _, found = imap.search(None, 'HEADER', 'Message-ID', f'"{key}"')
            if found[0].split():
                meta = fetch_many(imap, found[0].split()[:1], '(X-GM-THRID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])')[0][0]
                items.append({'uid': key, 'unread': b'\\Seen' not in meta, 'answered': b'\\Answered' in meta, 'thread': gm_thread(meta)})
        answered = replied(imap, since)
        for it in items:
            it['answered'] = it['answered'] or it['uid'] in answered
        return items
