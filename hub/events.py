"""What moved where, for the system map on the health page: one row per fetch run, model call, poll or send."""
import time
from datetime import timedelta

from django.db import transaction
from django.db.models import Q

from hub import health
from hub.models import Event

OUTSIDE = ['gmail', 'calendar', 'gemini', 'stores', 'news']
LEFT = Q(dst__in=OUTSIDE)  # sent out of the house; reading Gmail or a feed comes in, it doesn't leave
KEEP = timedelta(days=7)
LATEST = 200


def record(kind, src, dst, *, count=1, ms=None, ok=True, item='', private=False, text=''):
    try:
        with transaction.atomic():  # a savepoint: a failed insert mustn't break the caller's transaction
            Event.objects.create(kind=kind, src=src, dst=dst, count=count, ms=ms, ok=ok, item=item, private=private, text=text[:200])
    except Exception:
        pass  # telemetry: never the reason something else fails


def ms(start):
    return int((time.monotonic() - start) * 1000)


# which process is recording: the fetch command sets 'fetch'; everything else runs in the web app
HERE = 'web'


def failed(kind, src, start, **kw):
    """A private model call that failed everywhere: when Gemini is allowed for private data it was tried first."""
    if health.gemini_private():
        record(kind, src, 'gemini', ms=ms(start), ok=False, private=True, **kw)
    record(kind, src, model_node('ollama'), ms=ms(start), ok=False, **kw)


def model_node(model):
    """The map node that answered: Gemini, or whichever Ollama is in use now."""
    return 'gemini' if model == 'gemini' else f"ollama-{health.ollama()['where']}"


def label(node):
    return {'gemini': 'Gemini', 'ollama-mac': 'Ollama'}.get(node, node)


