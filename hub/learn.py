"""AI daily: one card a day on an AI term or tool, written by Gemini with web search.

A trending term from the AI news feeds wins the day; otherwise the next term in CURRICULUM.
Reviews come back after 3, 7 and 30 days; that part is date math, no model.
"""
import urllib.error
import urllib.request
from datetime import time, timedelta
from urllib.parse import urlparse

from django.utils import timezone

from hub.models import Item, LearnCard, SourceStatus
from hub.triage import gemini_call, gemini_json, gemini_text

WRITE_AT = time(7, 15)
RETRY = timedelta(minutes=30)
REVIEW_DAYS = [3, 7, 30]
AI_TOPIC = 'AI agents'
UA = 'Mozilla/5.0 (Lifehub)'

# fundamentals, easiest first; edit freely, cards already written are skipped
CURRICULUM = [
    'Large language model', 'Token', 'Context window', 'Prompt', 'System prompt', 'Temperature', 'Embedding',
    'Vector database', 'Cosine similarity', 'Transformer', 'Attention', 'Pretraining', 'Fine-tuning',
    'Hallucination', 'RAG (retrieval-augmented generation)', 'Chunking', 'Reranking', 'Few-shot prompting',
    'Chain of thought', 'Reasoning models', 'Structured output', 'Function calling', 'AI agent', 'Agent loop',
    'MCP (Model Context Protocol)', 'Tool use', 'Multimodal models', 'Inference', 'Latency and throughput',
    'Prompt caching', 'Quantization', 'Open-weight models', 'Ollama', 'Model distillation', 'Mixture of experts',
    'RLHF', 'Constitutional AI', 'Evals', 'LLM-as-judge', 'Benchmarks', 'Prompt injection', 'Jailbreaks',
    'Guardrails', 'Grounding', 'Context engineering', 'Memory in agents', 'Multi-agent systems', 'Subagents',
    'Computer use', 'Browser agents', 'Coding agents', 'Agent skills', 'Long context vs RAG', 'Hybrid search',
    'BM25', 'Knowledge graphs', 'GraphRAG', 'Semantic caching', 'Streaming responses', 'Batch APIs',
    'Token pricing', 'Rate limits', 'Speculative decoding', 'KV cache', 'LoRA', 'Synthetic data',
    'Diffusion models', 'Text-to-speech', 'Speech-to-text', 'Vision-language models', 'Small language models',
    'On-device AI', 'AI observability', 'Tracing agent runs', 'Model routing', 'Fallbacks between models',
    'Sandboxing agents', 'Human in the loop', 'Agent permissions', 'Scaling laws', 'Test-time compute',
    'Interpretability', 'AI safety', 'Alignment', 'Model cards', 'Data contamination', 'Tokenizer',
    'Positional encoding', 'Sampling (top-p, top-k)', 'Logprobs', 'Embeddings for code', 'Vibe coding',
    'Spec-driven development', 'Agent frameworks', 'A2A (agent-to-agent protocols)', 'World models',
]

KINDS = ['Concept', 'Technique', 'Tool', 'Trend']

PICK = """Here are recent AI news headlines (number | title). Is there one AI term, technique, tool or product that
several headlines are about, worth a short explainer for a developer learning AI? Skip anything already covered:
{covered}.
Answer null for term when nothing stands out.

{headlines}"""

PICK_SCHEMA = {'type': 'object', 'properties': {
    'term': {'type': ['string', 'null']}, 'headline': {'type': ['integer', 'null']},
}, 'required': ['term', 'headline']}

WRITE = """Write a learning card about "{term}" for a web developer (Django, React) who is learning AI development.
Base it on these research notes. Plain English, no hype, no marketing words.
- summary: one sentence, at most 30 words, what it is.
- body: two or three sentences: how it works or why it matters, with one concrete example.
- depth: two short paragraphs (separated by a blank line) for someone who wants more: the mechanics, trade-offs, common mistakes.
- kind: one of {kinds}.
- buildsOn: two or three terms to understand first. leadsTo: three or four terms to learn next. Short names only.
- tryIt: a small runnable snippet (at most 8 lines) that shows the idea, preferring free or local tools; tryLang names its language;
  tryNote says in a few words what it needs (e.g. "Python · runs locally, free"). Empty strings if code doesn't fit the term.
- followups: three short questions the reader might ask next.
{why}

Research notes:
{notes}"""

RESEARCH = """Search the web for "{term}" as used in AI development. Find three good, current sources (official docs,
well-known guides or explainers) and write research notes, at most 250 words: what it is, how it works, current tools
or examples, and common mistakes."""

WHY = """- whyNow: one sentence tying the term to this headline: "{headline}"."""

CARD_SCHEMA = {'type': 'object', 'properties': {
    'summary': {'type': 'string'}, 'body': {'type': 'string'}, 'depth': {'type': 'string'},
    'kind': {'type': 'string', 'enum': KINDS},
    'buildsOn': {'type': 'array', 'items': {'type': 'string'}}, 'leadsTo': {'type': 'array', 'items': {'type': 'string'}},
    'tryIt': {'type': 'string'}, 'tryLang': {'type': 'string'}, 'tryNote': {'type': 'string'},
    'followups': {'type': 'array', 'items': {'type': 'string'}}, 'whyNow': {'type': 'string'},
}, 'required': ['summary', 'body', 'depth', 'kind', 'buildsOn', 'leadsTo', 'tryIt', 'tryLang', 'tryNote', 'followups']}

ASK = """You are helping someone learn about "{term}". Their card says:
{summary}
{body}
{depth}

Answer their question in at most 120 words, plainly, with an example when it helps. Question: {question}"""


def today():
    return timezone.localdate()


def due(now=None):
    now = timezone.localtime(now)
    if now.time() < WRITE_AT or LearnCard.objects.filter(day=now.date()).exists():
        return False
    s = SourceStatus.objects.filter(source='learn').first()
    return not (s and s.retry_at and timezone.now() < s.retry_at)


def covered():
    return {t.lower() for t in LearnCard.objects.values_list('term', flat=True)}


def next_term(done):
    return next((t for t in CURRICULUM if t.lower() not in done), None)


def trending(done):
    """(term, headline Item) when the AI feeds keep mentioning something new, else None."""
    items = list(Item.objects.filter(kind=Item.NEWS, topic=AI_TOPIC, published__gte=timezone.now() - timedelta(days=3)).order_by('-published')[:40])
    if len(items) < 5:
        return None
    lines = '\n'.join(f'{n} | {i.title}' for n, i in enumerate(items))
    got = gemini_json(None, PICK.format(covered=', '.join(sorted(done)) or 'nothing yet', headlines=lines), PICK_SCHEMA)
    term, n = (got.get('term') or '').strip(), got.get('headline')
    if not term or term.lower() in done or not isinstance(n, int) or not 0 <= n < len(items):
        return None
    return term, items[n]


def resolve(uri):
    """Search results come as Google redirect links; follow them to the real page."""
    try:
        with urllib.request.urlopen(urllib.request.Request(uri, headers={'User-Agent': UA}), timeout=10) as r:
            return r.url
    except urllib.error.HTTPError as e:
        return e.url
    except Exception:
        return None


def sources(meta):
    out = []
    for c in meta.get('groundingChunks', []):
        web = c.get('web', {})
        url = resolve(web['uri']) if web.get('uri') else None
        if url and url.startswith(('http://', 'https://')) and url not in [s['url'] for s in out]:
            out.append({'url': url, 'site': web.get('title') or urlparse(url).netloc.removeprefix('www.')})
    return out[:5]


def write(day=None, term=None):
    """Writes the day's card; raises when Gemini fails (the fetch loop then waits RETRY)."""
    day = day or today()
    done = covered()
    # at most every other day, or the feeds (always busy) would crowd out the fundamentals
    last = LearnCard.objects.filter(day__lt=day).first()
    hit = None if term or (last and last.trending) else trending(done)
    term = term or (hit[0] if hit else next_term(done))
    if not term:
        return None
    why = WHY.format(headline=hit[1].title) if hit else ''
    # two calls: in JSON mode the model skips the search, so it researches first in plain text
    found = gemini_call({'contents': [{'parts': [{'text': RESEARCH.format(term=term)}]}], 'tools': [{'google_search': {}}]}, search=True)['candidates'][0]
    notes = ''.join(p.get('text', '') for p in found['content']['parts'])
    c = gemini_json(None, WRITE.format(term=term, kinds=', '.join(KINDS), why=why, notes=notes), CARD_SCHEMA)
    return LearnCard.objects.update_or_create(day=day, defaults=dict(
        term=term, kind=c['kind'] if c['kind'] in KINDS else 'Concept', trending=bool(hit),
        summary=c['summary'].strip(), body=c['body'].strip(), depth=c['depth'].strip(),
        builds_on=c['buildsOn'][:4], leads_to=c['leadsTo'][:5],
        try_it=c['tryIt'].strip(), try_lang=c['tryLang'].strip(), try_note=c['tryNote'].strip(),
        followups=c['followups'][:3], why_now=(c.get('whyNow') or '').strip() if hit else '',
        why_url=hit[1].url if hit else '', why_source=hit[1].source if hit else '',
        sources=sources(found.get('groundingMetadata', {})),
        status='new', review_round=0, review_due=None, questions=[],
    ))[0]


def run():
    """From the fetch loop: today's card once it's due; a failure waits RETRY before the next try."""
    if not due():
        return None
    s, _ = SourceStatus.objects.get_or_create(source='learn')
    try:
        card = write()
    except Exception as e:
        s.error, s.retry_at = str(e)[:500], timezone.now() + RETRY
        s.save()
        raise
    s.ok_at, s.error, s.retry_at = timezone.now(), '', None
    s.save()
    return card


def mark(card, how):
    """'known' ends it; 'review' brings it back after the next interval (3, 7, then every 30 days)."""
    if how == 'known':
        card.status, card.review_due = 'known', None
    else:
        card.status = 'review'
        card.review_due = today() + timedelta(days=REVIEW_DAYS[min(card.review_round, len(REVIEW_DAYS) - 1)])
        card.review_round += 1
    card.marked = card.marked or timezone.now()
    card.save()


def ask(card, question):
    answer = gemini_text(None, ASK.format(term=card.term, summary=card.summary, body=card.body, depth=card.depth, question=question))
    card.questions = [*card.questions, {'q': question, 'a': answer}]
    card.save(update_fields=['questions'])
    return answer


def streak(days=None):
    """Days in a row, back from today (or yesterday while today's is unread), whose card was marked."""
    marked = set(days if days is not None else LearnCard.objects.filter(marked__isnull=False).values_list('day', flat=True))
    d = today() if today() in marked else today() - timedelta(days=1)
    n = 0
    while d in marked:
        n, d = n + 1, d - timedelta(days=1)
    return n


def link_terms(names, by_term):
    return [{'name': n, 'id': by_term.get(n.lower())} for n in names]


def full(c, by_term):
    return {**lite(c), 'summary': c.summary, 'body': c.body, 'depth': c.depth,
            'buildsOn': link_terms(c.builds_on, by_term), 'leadsTo': link_terms(c.leads_to, by_term),
            'tryIt': c.try_it, 'tryLang': c.try_lang, 'tryNote': c.try_note, 'followups': c.followups,
            'whyNow': c.why_now, 'whyUrl': c.why_url, 'whySource': c.why_source, 'sources': c.sources, 'questions': c.questions,
            'reviewRound': c.review_round, 'reviewDue': c.review_due.isoformat() if c.review_due else None}


def lite(c):
    return {'id': c.pk, 'term': c.term, 'kind': c.kind, 'day': c.day.isoformat(), 'status': c.status, 'trending': c.trending, 'summary': c.summary}


def page(card_id=None):
    cards = list(LearnCard.objects.order_by('-day'))
    # 'RAG (retrieval-augmented generation)' also answers to 'RAG'
    by_term = {k: c.pk for c in cards for k in (c.term.lower(), c.term.split(' (')[0].lower())}
    t = today()
    current = next((c for c in cards if c.pk == card_id), None) if card_id else next((c for c in cards if c.day == t), None)
    return {
        'card': full(current, by_term) if current else None,
        'today': current is not None and current.day == t,
        'reviews': [lite(c) for c in sorted(cards, key=lambda c: c.review_due or t) if c.status == 'review' and c.review_due and c.review_due <= t],
        'archive': [lite(c) for c in cards],
        'stats': {'streak': streak([c.day for c in cards if c.marked]), 'cards': len(cards), 'known': sum(c.status == 'known' for c in cards)},
        'writesAt': WRITE_AT.strftime('%-H:%M'),
    }
