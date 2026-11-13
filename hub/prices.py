"""Price and restock watcher: each Watch is one product with links at several stores, checked every few hours.

A store page's schema.org JSON-LD gives price and stock for free; pages without it are read by Gemini (public data).
"""
import json
import re
import time
import urllib.error
import urllib.request
from datetime import timedelta
from html import unescape
from urllib.parse import quote, urlparse

from django.db.models import F, Q
from django.utils import timezone

from hub import events
from hub.models import Activity, Watch
from hub.triage import gemini_call, gemini_json

CHECK_EVERY = timedelta(hours=3)
SEARCH_EVERY = timedelta(days=1)  # look for new sellers
MAX_SOURCES = 8
BUDGET_S = 60  # per fetch run; the rest wait for the next one
# stores turn away anything that doesn't look like a browser
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
LD = re.compile(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)
BESTBUY = re.compile(r'bestbuy\.ca/.*?(\d{7,9})(?:[/?#.]|$)')  # its pages refuse scripts; its own JSON API doesn't
# Amazon, Newegg, Walmart, Memory Express and Staples turn scripts away (503/403 or a block page), so they aren't searched
# listings that name the product but aren't it: used units anywhere, accessories when the word comes first
# ("Case for Sony WH-1000XM5", not "Sony WH-1000XM5 ... Carrying Case")
USED = re.compile(r'\b(open box|refurbished|renewed|pre-owned)\b', re.I)
ACCESSORY = re.compile(r'\b(case|cover|compatible|replacement|protector|skin|pads?|for)\b', re.I)
IN_STOCK = ('InStock', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly')

PROMPT = """You read the text of one store's product page and report the product's current selling price and
whether it can be bought now. price: the price a buyer pays today (a sale price if shown), 0 if the page shows none.
inStock: false if the page says sold out, out of stock, unavailable or coming soon. title: the product's name.
store: true only if this page is a store selling the product; false for reviews, articles, forums and comparison sites."""

SCHEMA = {
    'type': 'object',
    'properties': {'price': {'type': 'number'}, 'currency': {'type': 'string'}, 'inStock': {'type': 'boolean'}, 'title': {'type': 'string'}, 'store': {'type': 'boolean'}},
    'required': ['price', 'currency', 'inStock', 'title', 'store'],
}


def store(url):
    return urlparse(url).netloc.removeprefix('www.')


def web_url(url):
    return urlparse(url).scheme in ('http', 'https') and bool(urlparse(url).netloc)


def page(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'en-CA,en;q=0.9'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read(3_000_000).decode(r.headers.get_content_charset() or 'utf-8', 'replace')


def nodes(x):
    if isinstance(x, dict):
        yield x
        for v in x.values():
            yield from nodes(v)
    elif isinstance(x, list):
        for v in x:
            yield from nodes(v)


def from_ld(html):
    """Price and stock from the page's schema.org Product, or None."""
    for block in LD.findall(html):
        try:
            data = json.loads(block.strip())
        except ValueError:
            continue
        for node in nodes(data):
            kind = node.get('@type')
            if 'Product' not in (kind if isinstance(kind, list) else [kind]):
                continue
            offers = node.get('offers') or []
            for offer in offers if isinstance(offers, list) else [offers]:
                if not isinstance(offer, dict):
                    continue
                price = offer.get('price') or offer.get('lowPrice')
                try:
                    price = float(str(price).replace(',', ''))
                except ValueError:
                    continue
                if price <= 0:
                    continue
                stock = str(offer.get('availability', ''))
                return {
                    'price': price, 'currency': offer.get('priceCurrency', ''),
                    'inStock': any(s in stock for s in IN_STOCK) if stock else True, 'title': str(node.get('name', ''))[:200],
                }
    return None


def text_of(html):
    html = re.sub(r'<(script|style|noscript|svg)\b.*?</\1>', ' ', html, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', unescape(re.sub(r'<[^>]+>', ' ', html))).strip()[:12000]


def read(url):
    if m := BESTBUY.search(url):
        d = json.loads(page(f'https://www.bestbuy.ca/api/v2/json/product/{m[1]}?lang=en-CA'))
        return {'price': float(d.get('salePrice') or d['regularPrice']), 'currency': 'CAD', 'inStock': bool((d.get('availability') or {}).get('isAvailableOnline')), 'title': d.get('name', '')[:200]}
    html = page(url)
    found = from_ld(html)
    if found:
        return found
    out = gemini_json(PROMPT, text_of(html), SCHEMA)
    if not out.get('store'):
        raise ValueError('not a store page')
    if not out.get('price'):
        raise ValueError('no price on the page')
    return {'price': float(out['price']), 'currency': out.get('currency', ''), 'inStock': bool(out.get('inStock')), 'title': out.get('title', '')[:200]}


def compact(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


def matches(name, title):
    """Is this listing the watched product? Every word of the name must appear in it, ignoring spacing and dashes."""
    title = title.lower()
    at = []
    for w in re.findall(r'[a-z0-9-]+', name.lower()):
        m = re.search('[^a-z0-9]*'.join(map(re.escape, compact(w))), title) if compact(w) else None
        if not m:
            return False
        at.append(m.start())
    used = USED.search(title)
    if used and used[1] not in name.lower():
        return False
    return not ACCESSORY.search(title[:min(at, default=0)])


def bestbuy_search(name):
    d = json.loads(page(f'https://www.bestbuy.ca/api/v2/json/search?lang=en-CA&query={quote(name)}'))
    return [f"https://www.bestbuy.ca{p['productUrl']}" for p in d.get('products', []) if matches(name, p.get('name', ''))][:2]


def canadacomputers_search(name):
    for block in LD.findall(page(f'https://www.canadacomputers.com/en/search?s={quote(name)}')):
        if '"ItemList"' in block:
            return [i['url'] for i in json.loads(block)['itemListElement'] if matches(name, unescape(i.get('name', '')))][:2]
    return []


def discover(w):
    """Add sellers found by the stores' own searches and a Gemini web search; check() drops the ones that turn out wrong."""
    known = {s['url'] for s in w.sources} | set(w.skipped)
    found = []
    for search in (bestbuy_search, canadacomputers_search, lambda n: [f['url'] for f in find(n)]):
        try:
            found += search(w.name)
        except Exception:
            pass  # one search failing (Gemini quota, Best Buy down) leaves the other's results
    for url in dict.fromkeys(found):
        if url not in known and len(w.sources) < MAX_SOURCES:
            w.sources.append({'url': url, 'store': store(url), 'auto': True})
    w.searched = timezone.now()
    w.save()


def money(p):
    return f'${p:,.2f}'


LOW_DAYS = 90
LOW_MIN_DAYS = 14  # a "90-day low" from a week of prices means nothing


def low90(w, before=None):
    """Lowest price seen in the last 90 days, from days before `before` if given."""
    since = (timezone.localdate() - timedelta(days=LOW_DAYS)).isoformat()
    seen = [p for d, p in w.history if d >= since and (before is None or d < before)]
    return min(seen) if seen else None


def remember(w, price):
    today = timezone.localdate().isoformat()
    since = (timezone.localdate() - timedelta(days=LOW_DAYS)).isoformat()
    days = dict((d, p) for d, p in w.history if d >= since)
    days[today] = min(price, days.get(today, price))
    w.history = sorted(days.items())


def check(w):
    """Read every store, then alert on a restock, a drop below the target, or (no target) any new low."""
    now = timezone.now().isoformat()
    before = w.best
    restocked = []
    for s in w.sources:
        try:
            found = read(s['url'])
        except Exception as e:
            s.update(error=str(e)[:200], checkedAt=now)
            continue
        if s.get('inStock') is False and found['inStock']:
            restocked.append(s['store'])
        s.update(found, error='', checkedAt=now)
    # a found seller that can't be read, or sells something else, goes and isn't found again
    # US stores turn up in the search too: their USD price would beat every CAD one
    wrong = [s for s in w.sources if s.get('auto') and (s.get('price') is None or not matches(w.name, s.get('title', '')) or s.get('currency', 'CAD') not in ('CAD', ''))]
    w.skipped += [s['url'] for s in wrong]
    w.sources = [s for s in w.sources if s not in wrong]
    priced = [s for s in w.sources if s.get('price') and s.get('inStock') is not False]
    low = min(priced, key=lambda s: s['price']) if priced else None
    w.best = low['price'] if low else None
    w.checked = timezone.now()
    today = timezone.localdate().isoformat()
    prior = low90(w, before=today)
    enough = bool(w.history) and w.history[0][0] <= (timezone.localdate() - timedelta(days=LOW_MIN_DAYS)).isoformat()
    if low:
        remember(w, low['price'])
    w.save()
    for name in restocked:
        Activity.objects.create(text=f'{w.name} is back in stock at {name}'[:300], via='Prices')
    if not low:
        return
    if w.target is not None:
        dropped = low['price'] <= w.target and (before is None or before > w.target)
    else:
        dropped = before is not None and low['price'] < before - 0.005
    record = enough and prior is not None and low['price'] < prior - 0.005
    if dropped:
        Activity.objects.create(text=f"{w.name} dropped to {money(low['price'])} at {low['store']}{' · lowest in 90 days' if record else ''}"[:300], via='Prices')
    elif record:
        Activity.objects.create(text=f"{w.name} is at its lowest in 90 days: {money(low['price'])} at {low['store']}"[:300], via='Prices')


def run():
    start = time.monotonic()
    for w in Watch.objects.filter(Q(searched__isnull=True) | Q(searched__lt=timezone.now() - SEARCH_EVERY)):
        if time.monotonic() - start > BUDGET_S:
            return 0
        discover(w)
        w.checked = None  # new sellers get read this run
        w.save()
    due = Watch.objects.filter(Q(checked__isnull=True) | Q(checked__lt=timezone.now() - CHECK_EVERY))
    n = 0
    for w in due.order_by(F('checked').asc(nulls_first=True)):
        if time.monotonic() - start > BUDGET_S:
            break
        check(w)
        n += 1
    if n:
        events.record('price', 'fetch', 'stores', count=n, ms=events.ms(start), text=f"Lifehub → stores · checked {n} watch{'es' if n > 1 else ''}")
    return n


def find(name, known=()):
    """Store pages for a product, from a Gemini web search; the user ticks the right ones."""
    body = {
        'contents': [{'parts': [{'text': f'Which online stores in Canada sell "{name}" right now? Find each store\'s product page for it.'}]}],
        'tools': [{'google_search': {}}],
    }
    chunks = gemini_call(body, search=True)['candidates'][0].get('groundingMetadata', {}).get('groundingChunks', [])
    out, seen = [], set(known)
    for c in chunks:
        uri = c.get('web', {}).get('uri')
        if not uri:
            continue
        # search results come as Google redirect links: follow them to the store's own page
        try:
            with urllib.request.urlopen(urllib.request.Request(uri, headers={'User-Agent': UA}), timeout=15) as r:
                url = r.url
        except urllib.error.HTTPError as e:
            url = e.url  # the store turned us away, but the redirect still landed there
        except Exception:
            continue
        if url not in seen and web_url(url):
            seen.add(url)
            out.append({'url': url, 'store': store(url)})
    return out
