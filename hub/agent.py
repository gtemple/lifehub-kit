"""The ⌘K command panel's agent: a local model with tools over YOUR_NAME's own data.

Private data never leaves the machine: this runs on Ollama only. It can read, add tasks and notes,
and draft replies, but drafts go to the approval queue; nothing here sends anything.
"""
import json
import time
import urllib.request
from datetime import date, datetime
from email.utils import parseaddr

from django.db.models import Q
from django.utils import timezone

from hub import agenda, drafts, events, health, mail, triage
from hub.models import Activity, Approval, Item, Note, Task, allowed
from hub.triage import NUM_CTX, keep_alive, mark_busy, ollama_model, ollama_url
from hub.triage import timeout as ollama_timeout

MAX_ROUNDS = 6

SYSTEM = """You are Lifehub, YOUR_NAME's personal assistant. Today is {today}, now is {now}.
Look things up with the tools before answering; never guess about their mail, calendar or tasks.
Answer in a few short lines. When there are several things, start with one short summary line of your
own, ending in a colon, then a numbered list; bold the action
at the start of each item, and put the email's account right after the person as (work) or (personal).
You cannot send anything. To reply to someone, use draft_reply; the draft waits for their approval.
You can mark emails read and archive them. delete_email only queues the deletion for their approval.
Use email ids from needs_reply or search_email; never guess an id."""


def tool(name, description, **params):
    required = [k for k, v in params.items() if not v.pop('optional', False)]
    return {'type': 'function', 'function': {'name': name, 'description': description,
            'parameters': {'type': 'object', 'properties': params, 'required': required}}}


TOOLS = [
    tool('needs_reply', 'Emails in both inboxes that are waiting for a reply, newest first.'),
    tool('search_email', 'Search the last few days of email by sender, subject or content.',
         query={'type': 'string', 'description': 'words to look for'}),
    tool('calendar_today', "Today's calendar events."),
    tool('tasks', 'Open to-dos with due dates.'),
    tool('add_task', 'Add a to-do.', text={'type': 'string'},
         due={'type': 'string', 'description': 'YYYY-MM-DD', 'optional': True}),
    tool('notes', "YOUR_NAME's notes, optionally filtered.", query={'type': 'string', 'optional': True}),
    tool('add_note', 'Save a note.', title={'type': 'string'}, body={'type': 'string'}),
    tool('news', "Today's headlines from their feeds."),
    tool('mark_read', 'Mark emails as read in Gmail.', email_ids={'type': 'array', 'items': {'type': 'integer'}}),
    tool('archive_email', 'Archive emails in Gmail (out of the inbox, still searchable).', email_ids={'type': 'array', 'items': {'type': 'integer'}}),
    tool('delete_email', 'Ask to move emails to Gmail Trash. Waits for their approval.', email_ids={'type': 'array', 'items': {'type': 'integer'}}),
    tool('draft_reply', 'Draft a reply to an email for their approval. Never sends.',
         email_id={'type': 'integer'}, instructions={'type': 'string', 'description': 'what the reply should say', 'optional': True}),
]


def email_line(m):
    name = parseaddr(m.sender)[0] or parseaddr(m.sender)[1]
    return {'id': m.pk, 'from': name, 'account': m.account, 'subject': m.title, 'summary': m.summary or m.snippet[:140],
            'received': timezone.localtime(m.published).strftime('%a %H:%M'), 'unread': m.unread, 'drafted': m.drafts.filter(status='pending', kind='email').exists()}


# what the panel shows while a tool runs: [ .. ] drafting a reply to Mike
DOING = {
    'needs_reply': 'reading emails that need a reply', 'search_email': 'searching your email',
    'calendar_today': "checking today's calendar", 'tasks': 'reading your to-dos', 'add_task': 'adding a to-do',
    'notes': 'reading your notes', 'add_note': 'saving a note', 'news': 'skimming the headlines',
    'mark_read': 'marking emails read', 'archive_email': 'archiving emails',
    'delete_email': 'queueing deletions for your stamp',
}


# a tool that acts, and the permission it needs (Settings > permissions.cpl)
NEEDS = {'add_task': 'tasks', 'add_note': 'tasks', 'draft_reply': 'reply', 'delete_email': 'delete', 'mark_read': 'sort', 'archive_email': 'sort'}


def doing(fn, args):
    if fn == 'draft_reply':
        item = Item.objects.filter(pk=args.get('email_id'), kind=Item.EMAIL).first()
        name = item and (parseaddr(item.sender)[0] or parseaddr(item.sender)[1])
        return f'drafting a reply to {name.split()[0]}' if name else 'drafting a reply'
    return DOING.get(fn, 'working')


class Tools:
    """Each method is one tool. It returns (result for the model, step line for the panel)."""

    def __init__(self):
        self.approvals = []

    def needs_reply(self):
        everything = list(Item.objects.filter(kind=Item.EMAIL))
        done = drafts.settled(everything)
        mail = [m for m in everything if m.group == 'needs_reply' and m.pk not in done]
        accounts = sorted({m.account for m in mail})
        return [email_line(m) for m in mail], f"Read {len(mail)} email{'s that need' if len(mail) != 1 else ' that needs'} a reply ({' and '.join(accounts) or 'no accounts'})"

    def search_email(self, query):
        words = [w for w in query.split() if len(w) > 2][:5] or [query]
        q = Q()
        for w in words:
            q |= Q(title__icontains=w) | Q(sender__icontains=w) | Q(summary__icontains=w) | Q(body__icontains=w)
        mail = list(Item.objects.filter(kind=Item.EMAIL).filter(q)[:10])
        return [email_line(m) for m in mail], f'Searched your email for “{query}” ({len(mail)} found)'

    def calendar_today(self):
        try:
            events = agenda.today()
        except Exception as e:
            return {'error': str(e)}, "Couldn't read your calendar"
        return [{'time': 'all day' if e['allDay'] else datetime.fromisoformat(e['start']).strftime('%H:%M'), 'title': e['title'],
                 'where': e['where'], 'calendar': e['calendar']} for e in events], "Checked today's calendar"

    def tasks(self):
        open_ = Task.active()
        return [{'text': t.text, 'due': t.due.isoformat() if t.due else None, 'source': t.source} for t in open_], f'Looked at your {open_.count()} open tasks'

    def add_task(self, text, due=None):
        try:
            d = date.fromisoformat(due) if due else None
        except ValueError:
            d = None
        t = Task.objects.create(text=text[:300], due=d, source='added by Lifehub')
        return {'added': t.text, 'due': t.due.isoformat() if t.due else None}, f'Added to your to-do list: {t.text}'

    def notes(self, query=None):
        ns = Note.objects.all()
        if query:
            ns = ns.filter(Q(title__icontains=query) | Q(body__icontains=query))
        return [{'title': n.title, 'body': n.body[:500]} for n in ns[:10]], 'Read your notes'

    def add_note(self, title, body):
        n = Note.objects.create(title=title[:200] or 'Untitled', body=body)
        return {'saved': n.title}, f'Saved a note: {n.title}'

    def news(self):
        items = Item.objects.filter(kind=Item.NEWS)[:15]
        return [{'source': i.source, 'title': i.title} for i in items], 'Skimmed today’s headlines'

    def draft_reply(self, email_id, instructions=''):
        item = Item.objects.filter(pk=email_id, kind=Item.EMAIL).first()
        if not item:
            return {'error': 'no such email'}, 'Couldn’t find that email'
        a = drafts.make_approval(item, 'drafted when you asked', instructions)
        self.approvals.append(a.pk)
        name = a.payload['toName'] or a.payload['to']
        return {'drafted': a.title, 'waiting_for_approval': True}, f'Drafted a reply to {name.split()[0] if name else name}'

    def _each(self, email_ids, action, verb):
        done, failed = [], []
        for item in Item.objects.filter(pk__in=list(email_ids or [])[:20], kind=Item.EMAIL):
            try:
                mail.act(item, action)
                done.append(item.title)
            except Exception as e:
                failed.append({'subject': item.title, 'error': str(e)})
        n = len(done)
        return {verb: done, 'failed': failed}, f"{verb.capitalize()} {n} email{'s' if n != 1 else ''}" + (f', {len(failed)} failed' if failed else '')

    def mark_read(self, email_ids):
        return self._each(email_ids, 'read', 'marked read')

    def archive_email(self, email_ids):
        result, step = self._each(email_ids, 'archive', 'archived')
        if result['archived']:
            Activity.objects.create(text=f"Archived {len(result['archived'])} email{'s' if len(result['archived']) != 1 else ''} when you asked", via='Ask Lifehub')
        return result, step

    def delete_email(self, email_ids):
        items = list(Item.objects.filter(pk__in=list(email_ids or [])[:20], kind=Item.EMAIL))
        for item in items:
            self.approvals.append(mail.ask_trash(item, 'you asked Lifehub').pk)
        n = len(items)
        return {'queued_for_approval': [i.title for i in items]}, f"Queued {n} deletion{'s' if n != 1 else ''} for your stamp"


def call_ollama(messages):
    mark_busy()
    req = urllib.request.Request(
        ollama_url() + '/api/chat',
        data=json.dumps({
            'model': ollama_model(), 'messages': messages, 'tools': TOOLS,
            'think': False, 'stream': False, 'keep_alive': keep_alive(), 'options': {'temperature': 0.2, 'num_ctx': NUM_CTX},
        }).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=max(180, ollama_timeout())) as r:
        return json.load(r)['message']


def gemini_contents(messages):
    """The conversation in Gemini's shape: tool results answer the model's calls in one user turn, and the model's own
    turns are replayed exactly as it sent them (Gemini checks its signatures)."""
    out = []
    for m in messages[1:]:
        if m['role'] == 'user':
            out.append({'role': 'user', 'parts': [{'text': m['content']}]})
        elif m['role'] == 'assistant':
            out.append({'role': 'model', 'parts': m['parts']})
        else:
            part = {'functionResponse': {'name': m['tool_name'], 'response': {'result': json.loads(m['content'])}}}
            if out and out[-1]['role'] == 'user' and 'functionResponse' in out[-1]['parts'][0]:
                out[-1]['parts'].append(part)
            else:
                out.append({'role': 'user', 'parts': [part]})
    return out


def call_gemini(messages):
    """One Gemini turn with the same tools, as an Ollama-shaped message (plus its raw parts to replay)."""
    decls = [{k: v for k, v in t['function'].items() if k != 'parameters' or v['properties']} for t in TOOLS]
    body = {'systemInstruction': {'parts': [{'text': messages[0]['content']}]}, 'contents': gemini_contents(messages),
            'tools': [{'functionDeclarations': decls}], 'generationConfig': {'temperature': 0.2}}
    parts = triage.gemini_call(body)['candidates'][0]['content'].get('parts', [])
    calls = [{'function': {'name': p['functionCall']['name'], 'arguments': p['functionCall'].get('args') or {}}} for p in parts if 'functionCall' in p]
    return {'role': 'assistant', 'content': ''.join(p.get('text', '') for p in parts if not p.get('thought')), 'tool_calls': calls, 'parts': parts}


def ask(question, model='ollama'):
    """Yields panel events: {'step'}, then one {'answer'} or {'error'}. model='gemini' only when Settings allows
    Gemini for private data: these tools read mail, calendar and notes."""
    if model == 'gemini' and not health.gemini_private():
        yield {'error': 'Gemini is off for private data. Turn on "Allow Gemini for private data" in Settings (and set a key) to ask it.'}
        return
    call = call_gemini if model == 'gemini' else call_ollama
    now = timezone.localtime()
    messages = [
        {'role': 'system', 'content': SYSTEM.format(today=now.strftime('%A %B %-d, %Y'), now=now.strftime('%H:%M'))},
        {'role': 'user', 'content': question},
    ]
    tools = Tools()
    t, node = time.monotonic(), events.model_node(model)
    for _ in range(MAX_ROUNDS):
        try:
            msg = call(messages)
        except Exception as e:
            events.record('ask', 'web', node, ms=events.ms(t), ok=False, private=model == 'gemini', text=f'Ask failed: {question}')
            yield {'error': f"Gemini didn't answer ({e})." if model == 'gemini' else 'Ollama is away. Questions about your mail and calendar run on your PC, so this waits until it is on.'}
            return
        calls = msg.get('tool_calls') or []
        if not calls:
            # a leaked reasoning block is dropped, keeping only what follows it
            answer = msg.get('content', '').split('</think>')[-1].strip()
            Activity.objects.create(text=f'Answered: {question}'[:300], via='Ask', model=model)
            events.record('ask', 'web', node, ms=events.ms(t), private=model == 'gemini', text=f'Asked {events.label(node)}: {question}')
            yield {'answer': answer, 'approvals': [str(pk) for pk in tools.approvals], 'model': model}
            return
        messages.append(msg)
        for c in calls:
            fn, args = c['function']['name'], c['function'].get('arguments') or {}
            method = getattr(tools, fn, None) if fn in {t['function']['name'] for t in TOOLS} else None
            if method:
                yield {'doing': doing(fn, args)}
            try:
                if method and fn in NEEDS and not allowed(NEEDS[fn]):
                    result, line = {'error': 'not allowed: turned off in Settings > permissions'}, f"Skipped {fn.replace('_', ' ')}: turned off in Settings"
                else:
                    result, line = method(**args) if method else ({'error': f'unknown tool {fn}'}, None)
            except Exception as e:
                result, line = {'error': str(e)}, None
            if line:
                yield {'step': line, 'ok': not (isinstance(result, dict) and 'error' in result)}
            messages.append({'role': 'tool', 'tool_name': fn, 'content': json.dumps(result, default=str)[:6000]})
    yield {'error': 'That took too many steps. Try asking something narrower.'}
