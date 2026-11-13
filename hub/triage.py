import json
import time
import urllib.request
from datetime import date

from django.conf import settings

from hub import health

GROUPS = ['needs_reply', 'fyi', 'newsletter', 'receipt']
PER_RUN = 40  # bounds one fetch run; the rest wait for the next
# WSL has ~8 GB and was OOM-killing Ollama at 16K: sorting, drafting and the command panel share one
# modest context (a different size forces a reload) and let the model go a minute after use
NUM_CTX = 8192

PROMPT = """You sort one email for YOUR_NAME and write a one-line summary.

Groups:
- needs_reply: a real person, client, colleague or business expects a reply or an action from them.
- fyi: worth knowing, nothing to do (updates, notifications, calendar changes, team news, security alerts,
  sign-in and verification codes).
- newsletter: bulk mail, marketing, digests, promotions, social notifications.
- receipt: orders, invoices, payments, shipping, bookings, subscriptions and renewals.

The summary is at most 12 words, says what the email means for them, and has no greeting or sender name.

task: if the email asks YOUR_NAME to do something concrete besides replying (send a document, pay, book, fix,
upload), write it as a short to-do starting with a verb, e.g. "Upload two September receipts". Otherwise "".
Never make a task from newsletters, promotions or notifications. due: the deadline as YYYY-MM-DD if the email
states one, else "". Today is {today}."""

SCHEMA = {
    'type': 'object',
    'properties': {
        'group': {'type': 'string', 'enum': GROUPS}, 'summary': {'type': 'string', 'minLength': 1},  # qwen3.5:9b leaves it blank otherwise
        'task': {'type': 'string'}, 'due': {'type': 'string'},
    },
    'required': ['group', 'summary', 'task', 'due'],
}


def ollama_url():
    return health.ollama()['url']


def ollama_model():
    return health.ollama()['model']


def keep_alive():
    return health.ollama()['keep_alive']


def timeout(background=False):
    """How long to wait: a CPU-only machine is slow, and background work may also queue behind other requests."""
    t = health.ollama()['timeout']
    return max(t, 300) if background else t


# background work yields to everything else: any other Ollama call marks the model busy
BUSY_KEY = 'ollama_busy'


def mark_busy():
    from django.utils import timezone

    from hub.models import Setting
    Setting.objects.update_or_create(key=BUSY_KEY, defaults={'value': timezone.now().isoformat()})


def busy_within(seconds):
    from datetime import datetime

    from django.utils import timezone

    from hub.models import Setting
    row = Setting.objects.filter(key=BUSY_KEY).first()
    return bool(row) and (timezone.now() - datetime.fromisoformat(row.value)).total_seconds() < seconds


GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}'
# pinned, and the fallback is a different tier so one overloaded tier doesn't take out both
GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-3-flash-preview']  # gemini-2.5-flash answers 404 since Nov 2026
GEMINI_TIMEOUT = 40  # per model; a hung model used to hold every caller for 90 s before the fallback ran
USAGE_LOG = settings.DATA_DIR / 'var' / 'gemini_usage.jsonl'


def record_usage(data, search=False):
    """Appends one Gemini response's token counts to var/gemini_usage.jsonl for the spend estimate; returns data."""
    u = data.get('usageMetadata') or {}
    line = {'ts': time.time(), 'model': data.get('modelVersion', ''), 'in': u.get('promptTokenCount', 0),
            'out': u.get('candidatesTokenCount', 0) + u.get('thoughtsTokenCount', 0), 'search': int(search)}
    try:
        USAGE_LOG.parent.mkdir(exist_ok=True)
        with USAGE_LOG.open('a') as f:
            f.write(json.dumps(line) + '\n')
    except OSError:
        pass
    return data


def usage_rows(since):
    """The usage log's rows (one per Gemini call) since a unix time."""
    try:
        lines = USAGE_LOG.read_text().splitlines()
    except OSError:
        return []
    rows = []
    for raw in lines:
        try:
            row = json.loads(raw)
        except ValueError:
            continue
        if row.get('ts', 0) >= since:
            rows.append(row)
    return rows


def usage_since(since):
    """Token totals per model from the usage log since a unix time."""
    out = {}
    for row in usage_rows(since):
        m = out.setdefault(row.get('model') or '?', {'in': 0, 'out': 0, 'search': 0, 'calls': 0})
        m['in'] += row.get('in', 0)
        m['out'] += row.get('out', 0)
        m['search'] += row.get('search', 0)
        m['calls'] += 1
    return out


def gemini_call(body, search=False, timeout=GEMINI_TIMEOUT):
    """POSTs one generateContent body, trying each model in turn; returns the response JSON."""
    key = settings.LIFEHUB.get('gemini_api_key')
    if not key:
        raise RuntimeError('no Gemini key')
    errors = []
    for model in GEMINI_MODELS:
        req = urllib.request.Request(GEMINI.format(model=model, key=key), data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return record_usage(json.load(r), search)
        except Exception as e:
            errors.append(f'{model}: {e}')
    raise RuntimeError('; '.join(errors))


def gemini_text(system, user, schema=None, temperature=0.3):
    """One Gemini answer (JSON text when a schema is given)."""
    config = {'temperature': temperature, **({'responseMimeType': 'application/json', 'responseJsonSchema': schema} if schema else {})}
    body = {'contents': [{'parts': [{'text': user}]}], 'generationConfig': config, **({'systemInstruction': {'parts': [{'text': system}]}} if system else {})}
    return gemini_call(body)['candidates'][0]['content']['parts'][0]['text'].strip()


def gemini_json(system, user, schema=None):
    return json.loads(gemini_text(system, user, schema or {'type': 'object'}))


def private_json(system, user, schema, background=False):
    """A structured answer over private data: Gemini when Settings allows it (Ollama if Gemini fails), else
    Ollama only. Returns (answer, model)."""
    if health.gemini_private():
        try:
            return gemini_json(system, user, schema), 'gemini'
        except Exception:
            pass
    return ollama_json(system, user, schema, background), 'ollama'


def private_text(system, user, temperature=0.3):
    """Free text over private data, the same way: (text, model)."""
    if health.gemini_private():
        try:
            return gemini_text(system, user, temperature=temperature), 'gemini'
        except Exception:
            pass
    return ollama_text(system, user, temperature), 'ollama'


def ollama_text(system, user, temperature=0.3):
    mark_busy()
    messages = ([{'role': 'system', 'content': system}] if system else []) + [{'role': 'user', 'content': user}]
    req = urllib.request.Request(
        ollama_url() + '/api/chat',
        data=json.dumps({'model': ollama_model(), 'messages': messages, 'think': False, 'stream': False, 'keep_alive': keep_alive(),
                         'options': {'temperature': temperature, 'num_ctx': NUM_CTX}}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=timeout()) as r:
        return json.load(r)['message']['content'].split('</think>')[-1].strip()


def ollama_json(system, user, schema, background=False):
    """One structured answer from Ollama. Raises when Ollama is unreachable."""
    if not background:
        mark_busy()
    req = urllib.request.Request(
        ollama_url() + '/api/chat',
        data=json.dumps({
            'model': ollama_model(),
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
            'format': schema,
            'think': False,
            'stream': False,
            'keep_alive': keep_alive(),
            'options': {'temperature': 0, 'num_ctx': NUM_CTX},
        }).encode(),
        headers={'Content-Type': 'application/json'},
    )
    # background work may sit behind other requests in Ollama's queue, so it waits longer
    with urllib.request.urlopen(req, timeout=timeout(background)) as r:
        return json.loads(json.load(r)['message']['content'])


def classify(item):
    """Private mail: Ollama (or Gemini, if Settings allows). Raises when neither can run, so the email waits.
    Returns group, summary, task, due and the model that read it."""
    email = (
        f'From: {item.sender}\nSubject: {item.title}\n'
        f"Mailing-list headers: {'yes' if item.bulk else 'no'}\n\n{item.body or item.snippet}"
    )
    out, model = private_json(PROMPT.format(today=date.today().isoformat()), email, SCHEMA)
    group = out['group'] if out.get('group') in GROUPS else 'fyi'
    task = out.get('task', '').strip()[:300] if group != 'newsletter' else ''
    try:
        due = date.fromisoformat(out.get('due', '')) if task else None
    except ValueError:
        due = None
    return group, out.get('summary', '').strip()[:300], task, due, model
