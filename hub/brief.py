"""The day brief: a few sentences on what the rest of today holds, from mail, calendar, tasks, approvals and to-dos.

It reads private data, so it runs on Ollama only (SPEC: model routing).
"""
import time as clock
from datetime import datetime, time, timedelta

from django.utils import timezone

from hub import agenda, drafts, events, news, triage
from hub.models import Activity, Approval, DayBrief, Item, Task

BRIEF_AT = time(7, 40)

REWRITE_AFTER = timedelta(minutes=30)  # when the day changes, at most this often

PROMPT = """Write the user's day brief: two or three short sentences, at most 60 words, no list, no heading,
no greeting. Speak to them as "you". Say what shapes the rest of today: meetings, people waiting on a reply, drafts
waiting for their stamp, anything due. If little is happening, say so in a few words; no filler or encouragement.
Only use the facts below, and only call something a draft if it is listed under drafts. Never invent names,
times, counts, shifts or deadlines. Automated notices are low priority: mention them in a few words at most.
Right now it is {now}.

{basis}"""

BASIS = """Calendar today:
{calendar}

Drafts waiting for their stamp:
{approvals}

People waiting on a reply:
{replies}

Automated notices asking for an action:
{notices}

To-dos due today or overdue:
{tasks}"""


def lines(rows):
    return '\n'.join(f'- {r}' for r in rows) or '- none'


def basis():
    """What the brief is written from; when this changes, the brief is out of date."""
    now = timezone.localtime()
    try:
        events = agenda.today()
        cal = [f"{'all day' if e['allDay'] else timezone.localtime(datetime.fromisoformat(e['start'])).strftime('%H:%M')} {e['title']}"
               f"{' (over)' if not e['allDay'] and datetime.fromisoformat(e['end']) < now else ''}" for e in events]
    except Exception:
        cal = ['(calendar not connected)']
    approvals = [a.title for a in Approval.objects.filter(status='pending')]
    mail = list(Item.objects.filter(kind=Item.EMAIL))
    done = drafts.settled(mail)
    open_ = [m for m in mail if m.group == 'needs_reply' and m.pk not in done]
    replies = [f"{m.account}: {m.summary or m.title}" for m in open_ if drafts.wants_draft(m)][:10]
    notices = sorted({m.summary or m.title for m in open_ if not drafts.wants_draft(m)})[:10]
    tasks = [t.text for t in Task.active().filter(due__lte=now.date())]
    return BASIS.format(calendar=lines(cal), approvals=lines(approvals), replies=lines(replies), notices=lines(notices), tasks=lines(tasks))


def due(now=None, current=None):
    """Due at 7:40, and again later in the day once what it was written from has changed."""
    now = timezone.localtime(now)
    slot = datetime.combine(now.date(), BRIEF_AT, now.tzinfo)
    latest = DayBrief.objects.first()
    if now < slot:
        return False
    if not latest or latest.written < slot:
        return True
    return now - latest.written >= REWRITE_AFTER and latest.basis != (current if current is not None else basis())


def write(src='fetch'):
    b_ = basis()
    t = clock.monotonic()
    try:
        text, model = triage.private_text('', PROMPT.format(now=timezone.localtime().strftime('%A %H:%M'), basis=b_))
    except Exception:
        events.failed('brief', src, t, text='Day brief failed')
        raise
    node = events.model_node(model)
    last = DayBrief.objects.first()
    verb = 'Updated' if last and timezone.localtime(last.written).date() == timezone.localdate() else 'Wrote'
    events.record('brief', src, node, ms=events.ms(t), private=model == 'gemini', text=f'{verb} the day brief on {events.label(node)}')
    b = DayBrief.objects.create(text=text, model=model, basis=b_)
    Activity.objects.create(text=f'{verb} the day brief', via='Brief', model=model)
    return b
