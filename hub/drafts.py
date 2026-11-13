import re
import time
from email.utils import parseaddr

from hub import agenda, events, triage
from hub.triage import private_text

PER_RUN = 10

VOICE = """You write email replies for YOUR_NAME. Write the reply body only: no subject line.
Keep it short, plain and friendly, the way a busy person writes: a greeting with their first name,
one to four sentences, then "YOUR_NAME" on its own line.
Only answer what the email asks. Never invent facts, times, prices, excuses, feelings or promises
(no "I'm busy", no "I'll send an invite"), and never claim YOUR_NAME has done or will do something
("I've assigned", "I can make 3pm") unless the email already says so. Where the answer needs something only YOUR_NAME knows
(a time, a day, a yes or no, a number), put a short placeholder in square brackets, like [day that works].
If unsure, say less."""

REWRITER = """You rewrite an email reply YOUR_NAME is about to send, in the style asked for.
Keep every fact, date and [placeholder] exactly as given, and add none. Keep the greeting and the "YOUR_NAME" sign-off.
Reply with the rewritten email body only."""

STYLES = {
    'shorter': 'Make it shorter. Keep the meaning and any [placeholders].',
    'warmer': 'Make it noticeably warmer and friendlier: a friendly opener or thanks is fine. Still short.',
    'formal': 'Make it more formal and polished. Keep any [placeholders].',
    'newTime': ('Turn it into a reply that suggests another time instead, offering two or three of these open times from '
                "YOUR_NAME's calendar: {slots}. Keep it short, keep the other facts and any [placeholders] that aren't about the time."),
}
# Gemini by your choice, one draft at a time, even with Gemini off for private data; only the draft is sent
STYLES['polish'] = 'Polish it: fix grammar, spelling and flow so it reads naturally. Keep my voice, roughly the same length and any [placeholders].'
NO_SLOTS = 'no calendar connected; use the placeholder [another time that works]'


def chat(system, user):
    """Private mail: Ollama, or Gemini if Settings allows. Raises when neither can run, so drafting waits for the
    next run. Returns (text, model)."""
    text, model = private_text(system, user)
    return clean(text), model


AUTOMATED = re.compile(r'no-?reply|do-?not-?reply|notifications?@|alerts?@|mailer-daemon|bounce|automated|system@', re.I)


def wants_draft(item):
    # automated mail and mailing lists can't be replied to; they stay in Needs a reply without a draft
    return not item.bulk and not AUTOMATED.search(parseaddr(item.sender)[1] or item.sender)


def strip_re(subject):
    return re.sub(r'^((re|fw|fwd)\s*:\s*)+', '', subject.strip(), flags=re.I)


def thread_key(subject):
    return re.sub(r'^((re|fw|fwd)\s*:\s*|\[external\]\s*-?\s*)+', '', subject.strip(), flags=re.I).lower()


def conversation(m):
    """Which conversation an email belongs to: Gmail's thread id, else (older mail) its subject."""
    return (m.account, m.thread or 'subject:' + thread_key(m.title))


def make_approval(item, reason, instructions='', src='web'):
    from hub.models import Approval
    t = time.monotonic()
    try:
        payload, model = draft(item, instructions)
    except Exception:
        events.failed('draft', src, t, item=f'email:{item.pk}', text=f'Drafting failed: {item.title}')
        raise
    node = events.model_node(model)
    events.record('draft', src, node, ms=events.ms(t), item=f'email:{item.pk}', private=model == 'gemini', text=f'Drafted a reply on {events.label(node)}: {item.title}')
    name = payload['toName'] or payload['to']
    return Approval.objects.create(
        kind='email', account=item.account, item=item, model=model, payload=payload,
        title=f'Reply to {name.split()[0] if name else name} re: {strip_re(item.title)}'[:300],
        detail=payload['body'].split('\n\n')[1 if '\n\n' in payload['body'] else 0][:200],
        reason=reason,
    )


def settled(items):
    """pks of mail that needs nothing more: the newest message in its thread was answered (older messages in a
    thread are never replied to directly once a later one has been), or automated mail you have opened."""
    newest = {}
    for m in sorted(items, key=lambda m: m.published, reverse=True):
        newest.setdefault(conversation(m), m)
    return {m.pk for m in items if newest[conversation(m)].answered or (not m.unread and not wants_draft(m))}


def clean(text):
    # qwen sometimes leaks its reasoning even with thinking off; a draft carrying it is retried, not shown
    if 'think>' in text:
        raise ValueError('model output contained reasoning')
    return text.strip()


def reply_subject(subject):
    return subject if subject.lower().startswith('re:') else f'Re: {subject}'


def draft(item, instructions=''):
    ask = f'Reply to this email. YOUR_NAME wants the reply to say: {instructions}' if instructions else 'Reply to this email.'
    body, model = chat(VOICE, f'{ask}\n\nFrom: {item.sender}\nSubject: {item.title}\n\n{item.body or item.snippet}')
    name, address = parseaddr(item.sender)
    to = item.reply_to or address
    return {
        'to': to,
        'toName': name if to == address else '',
        'cc': ', '.join(a for a in item.others.split(', ') if a and a != to.lower()),
        'subject': reply_subject(item.title),
        'body': body,
        # threading: Gmail keeps the reply in the same conversation
        'inReplyTo': f'<{item.uid}>' if '@' in item.uid else '',
    }, model


def rewrite(body, style, item=None):
    """(new body, model). 'newTime' reads your open times from the calendars."""
    context = f'\n\nThe email being answered:\nFrom: {item.sender}\nSubject: {item.title}\n\n{item.body or item.snippet}' if item else ''
    ask = STYLES[style]
    if style == 'newTime':
        try:
            slots = agenda.open_slots()
        except Exception:
            slots = []
        ask = ask.format(slots='; '.join(slots) or NO_SLOTS)
    if style == 'polish':
        return clean(triage.gemini_text(REWRITER, f'{ask}\n\nThe draft:\n{body}')), 'gemini'
    return chat(REWRITER, f'{ask}\n\nThe draft:\n{body}{context}')
