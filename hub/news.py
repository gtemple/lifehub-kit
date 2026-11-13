"""The News tile: stories picked across topics, and the daily brief.

Headlines are public, so the brief prefers Gemini and falls back to Ollama (SPEC: model routing).
"""
import json
import time as clock
import urllib.request
from datetime import datetime, time, timedelta

from django.utils import timezone

from hub import events
from hub.models import Activity, Item, NewsBrief
from hub.triage import NUM_CTX, gemini_text, keep_alive, mark_busy, ollama_model, ollama_url
from hub.triage import timeout as ollama_timeout

BRIEF_AT = [time(7, 15), time(12, 0)]
FRESH = timedelta(hours=24)
STORIES = 14
HEADLINES = 80  # what the brief reads

PROMPT = """Write a news brief: two or three short sentences, at most 70 words, no list, no heading.
Pick the few biggest stories in these headlines, favouring YOUR_INTERESTS. State the news itself; never mention the reader
or what anyone "is tracking". Only use facts and names exactly as they appear in the headlines.

Headlines (topic | source | title):
{headlines}"""


def recent():
    return Item.objects.filter(kind=Item.NEWS, published__gte=timezone.now() - FRESH)


def stories():
    """Newest first within each topic, taken in turns so no single busy feed fills the tile."""
    by_topic = {}
    for it in recent().order_by('-published'):
        by_topic.setdefault(it.topic or it.source, []).append(it)
    order = sorted(by_topic, key=lambda t: by_topic[t][0].published, reverse=True)
    out, i = [], 0
    while len(out) < STORIES and any(i < len(by_topic[t]) for t in order):
        out += [by_topic[t][i] for t in order if i < len(by_topic[t])][:STORIES - len(out)]
        i += 1
    return out


def ollama(prompt):
    mark_busy()
    req = urllib.request.Request(
        ollama_url() + '/api/chat',
        data=json.dumps({'model': ollama_model(), 'messages': [{'role': 'user', 'content': prompt}],
                         'think': False, 'stream': False, 'keep_alive': keep_alive(), 'options': {'num_ctx': NUM_CTX}}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=ollama_timeout()) as r:
        return json.load(r)['message']['content'].split('</think>')[-1].strip()


def brief_due(now=None):
    """True when the latest brief predates the most recent 7:15 or noon slot."""
    now = timezone.localtime(now)
    slots = [datetime.combine(now.date(), t, now.tzinfo) for t in BRIEF_AT]
    passed = [s for s in slots if s <= now]
    if not passed:
        return False
    latest = NewsBrief.objects.first()
    return not latest or latest.written < passed[-1]


def write_brief():
    items = list(recent().order_by('-published')[:HEADLINES])
    if not items:
        return None
    prompt = PROMPT.format(headlines='\n'.join(f'{i.topic} | {i.source} | {i.title}' for i in items))
    t = clock.monotonic()
    try:
        text, model = gemini_text(None, prompt), 'gemini'
    except Exception:
        text, model = ollama(prompt), 'ollama'
    node = events.model_node(model)
    events.record('news', 'fetch', node, count=len(items), ms=events.ms(t), text=f'Read {len(items)} headlines on {events.label(node)}')
    b = NewsBrief.objects.create(text=text, model=model, sources=sorted({i.source for i in items}))
    Activity.objects.create(text=f'Read {len(items)} headlines, wrote the news brief', via='News', model=model)
    return b
