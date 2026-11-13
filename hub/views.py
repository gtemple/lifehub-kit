from functools import reduce
from itertools import groupby
from operator import or_

import hmac
import re
import json
from pathlib import Path

from django.conf import settings
from django.contrib.auth.decorators import login_required
from datetime import timedelta
from email.utils import parseaddr

from django.core.cache import cache
from django.db import transaction
from django.db.models import Q
from django.http import FileResponse, Http404, JsonResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_POST
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.shortcuts import render

import threading
import time

from hub import agenda, agent, brief, cleanup, connections, drafts, events, health, learn, mail, news, prices, receipts, triage, waiting, weekly
from hub.models import PERMISSIONS, DayBrief, NewsBrief, Sender, Setting, permission
from hub.models import Activity, Approval, AuditRow, Item, LearnCard, Note, SentMail, SourceStatus, Task, Watch

PER_SOURCE = 15
SAMPLES = Path(__file__).parent / 'sample_data'
FRONTEND = Path(__file__).resolve().parent.parent / 'frontend' / 'dist' / 'index.html'


def grouped(kind):
    items = sorted(Item.objects.filter(kind=kind), key=lambda i: (i.source, -i.published.timestamp()))
    return [(source, list(group)[:PER_SOURCE]) for source, group in groupby(items, key=lambda i: i.source)]


@ensure_csrf_cookie
@login_required
def app(request):
    return FileResponse(FRONTEND.open('rb'), content_type='text/html')


UNDO = mail.UNDO
EDITABLE = ('to', 'cc', 'subject', 'body')
PLACEHOLDER = re.compile(r'\[[^\]\n]{1,60}\]')


def approval_json(a):
    return {
        'id': str(a.pk), 'kind': a.kind, 'account': a.account or None, 'title': a.title, 'detail': a.detail,
        'reason': a.reason, 'payload': a.payload, 'createdAt': a.created.isoformat(), 'model': a.model, 'status': a.status,
    }


def approvals_tile():
    return {'items': [approval_json(a) for a in Approval.objects.filter(status='pending')]}


def activity_tile():
    now = timezone.now()
    items = []
    for e in Activity.objects.select_related('approval')[:20]:
        a = e.approval
        undoable = a and a.status in ('approved', 'declined') and a.decided and now - a.decided < UNDO and e.at >= a.decided
        items.append({
            'id': str(e.pk), 'at': e.at.isoformat(), 'text': e.text, 'via': e.via, 'model': e.model,
            **({'undo': {'approvalId': str(a.pk), 'until': (a.decided + UNDO).isoformat()}} if undoable else {}),
        })
    return {'items': items}


OTHER_GROUPS = ['fyi', 'newsletter', 'receipt']
PREVIEW = 6


def email_json(m, draft=None):
    name, address = parseaddr(m.sender)
    return {
        **({'draftId': str(draft)} if draft else {}),
        'id': str(m.pk), 'account': m.account, 'from': {'name': name or address.split('@')[0], 'address': address},
        'subject': m.title, 'summary': m.summary or m.snippet[:140], 'receivedAt': m.published.isoformat(),
        'group': m.group, 'url': m.url, 'unread': m.unread,
    }


def inbox_mail():
    mail = list(Item.objects.filter(kind=Item.EMAIL))
    # a conversation answered from Gmail no longer needs a reply
    done = drafts.settled(mail)
    for m in mail:
        if m.pk in done and m.group == 'needs_reply':
            m.group = 'fyi'
    return mail


def accounts_json():
    return [{'account': x.get('account', x['name'].lower()), 'name': x['name'], 'address': x['user']} for x in settings.LIFEHUB.get('email', [])]


def inbox_tile(request):
    mail = inbox_mail()
    pending = dict(Approval.objects.filter(status='pending', item__isnull=False).values_list('item_id', 'pk'))
    sorted_ = [m for m in mail if m.group]
    unsorted = [m for m in mail if not m.group]
    by = {g: [m for m in sorted_ if m.group == g] for g in ['needs_reply', *OTHER_GROUPS]}
    accounts = {a.get('account', a['name'].lower()): a['name'] for a in settings.LIFEHUB.get('email', [])}
    statuses = {s.source: s for s in SourceStatus.objects.filter(source__in=accounts.values())}
    failed = [k for k, name in accounts.items() if statuses.get(name) and statuses[name].failing]
    oks = [s.ok_at for s in statuses.values() if s.ok_at]

    # the gold badge: mail that arrived since this browser last asked
    seen = request.session.get('inbox_seen')
    request.session['inbox_seen'] = timezone.now().isoformat()
    new = sum(1 for m in mail if seen and m.published.isoformat() > seen)

    res = {
        'tile': 'inbox',
        'items': [email_json(m) for m in unsorted],
        'updatedAt': (min(oks) if oks else timezone.now()).isoformat(),
        'newSince': new,
        'status': 'ok',
        'data': {
            'counts': {g: len(v) for g, v in by.items()},
            'byAccount': {k: sum(1 for m in mail if m.account == k) for k in accounts},
            'needsReply': [email_json(m, pending.get(m.pk)) for m in by['needs_reply']],
            'others': [{'group': g, 'count': len(by[g]), 'preview': [email_json(m) for m in by[g][:PREVIEW]]} for g in OTHER_GROUPS],
            'unsorted': len(unsorted),
        },
    }
    if failed:
        fine = [accounts[k] for k in accounts if k not in failed]
        res['status'] = 'error'
        res['error'] = {'source': f'{failed[0]}_email', 'message': f"{' and '.join(fine)} email is fine." if fine else ''}
    elif unsorted and not health.ollama_up():
        res['status'] = 'waiting_for_model'
    return res


# tiles with a real source; the rest serve their sample file until their milestone connects one
LIVE = {'agent-status': health.agent_status, 'weather': health.weather, 'streak': receipts.streak}
def calendar_tile():
    return {'items': agenda.today()}


def task_json(t):
    m = t.item
    return {
        'id': str(t.pk), 'text': t.text, 'source': t.source, 'due': t.due.isoformat() if t.due else None, 'done': t.done,
        'repeat': t.repeat, 'snoozed': t.snoozed.isoformat() if t.snoozed else None,
        **({'email': {'id': str(m.pk), 'from': m.sender, 'account': m.account, 'subject': m.title, 'summary': m.summary, 'snippet': m.snippet[:300], 'receivedAt': m.published.isoformat()}} if m else {}),
        'context': t.context, 'url': t.url,
    }


TASK_LINGER = timedelta(seconds=30)


def tasks_tile():
    # open tasks (snoozed ones too, the page tucks them away), plus ones ticked in the last 30 s so they don't vanish under your cursor
    open_ = Task.objects.filter(done=False)
    just_done = Task.objects.filter(done=True, done_at__gte=timezone.now() - TASK_LINGER)
    return {'items': [task_json(t) for t in [*open_, *just_done]]}


def note_json(n):
    return {'id': str(n.pk), 'title': n.title, 'body': n.body, 'updatedAt': n.updated.isoformat()}


def notes_tile():
    return {'items': [note_json(n) for n in Note.objects.all()[:12]]}


def news_tile():
    b = NewsBrief.objects.first()
    feeds = [f['name'] for f in settings.LIFEHUB.get('feed', [])]
    last = SourceStatus.objects.filter(source__in=feeds, ok_at__isnull=False).order_by('-ok_at').first()
    picked = news.stories()
    return {
        'items': [],
        **({'updatedAt': last.ok_at.isoformat()} if last else {}),
        'data': {
            'brief': {'text': b.text, 'writtenAt': b.written.isoformat(), 'model': b.model, 'sources': b.sources} if b else None,
            'stories': [{'id': str(i.pk), 'topic': i.topic, 'source': i.source, 'title': i.title, 'url': i.url, 'at': i.published.isoformat()} for i in picked],
            'sourceCount': news.recent().values('source').distinct().count(),
            'storyCount': news.recent().count(),
        },
    }


def brief_json(b):
    return {'kind': 'evening' if timezone.localtime(b.written).hour >= 18 else 'morning', 'text': b.text, 'writtenAt': b.written.isoformat(), 'model': b.model}


def brief_tile():
    b = DayBrief.objects.first()
    return {'items': [], 'data': brief_json(b) if b else None}


def watch_json(w):
    return {'id': str(w.pk), 'name': w.name, 'target': w.target, 'best': w.best, 'low90': prices.low90(w), 'checkedAt': w.checked.isoformat() if w.checked else None, 'sources': w.sources}


def prices_tile():
    return {'items': [watch_json(w) for w in Watch.objects.all()]}


def nav_tile():
    """The ledger top bar: replies waiting beside Inbox."""
    # every open tab asks each minute; one count a minute is plenty
    replies = cache.get_or_set('nav_replies', lambda: sum(m.group == 'needs_reply' for m in inbox_mail()), 60)
    # private: Ollama or allowed Gemini is there to sort, draft and brief; checked at most once a minute
    return {'replies': replies, 'private': cache.get_or_set('nav_private', health.private_up, 60)}


LIVE['nav'] = nav_tile


LIVE_ITEMS = {'prices': prices_tile, 'packages': lambda: {'items': receipts.packages()}, 'renewals': lambda: {'items': receipts.renewals()}, 'brief': brief_tile, 'approvals': approvals_tile, 'activity': activity_tile, 'calendar': calendar_tile, 'tasks': tasks_tile, 'waiting': lambda: {'items': waiting.waiting()}, 'notes': notes_tile, 'news': news_tile, 'week': weekly.tile, 'mailweek': weekly.days_tile}


@login_required
def tile(request, name):
    now = timezone.now().isoformat()
    if name == 'inbox':
        return JsonResponse(inbox_tile(request))
    if name in LIVE_ITEMS:
        try:
            return JsonResponse({'tile': name, 'data': None, 'status': 'ok', 'updatedAt': now, **LIVE_ITEMS[name]()}, json_dumps_params={'ensure_ascii': False})
        except Exception as e:
            return JsonResponse({'tile': name, 'items': [], 'status': 'error', 'error': {'source': name, 'message': str(e)}, 'updatedAt': now})
    if name in LIVE:
        try:
            return JsonResponse({'tile': name, 'items': [], 'data': LIVE[name](), 'status': 'ok', 'updatedAt': now})
        except Exception as e:
            return JsonResponse({'tile': name, 'items': [], 'status': 'error', 'error': {'source': name, 'message': str(e)}, 'updatedAt': now})
    path = SAMPLES / f'{name}.json'
    if not path.is_file():
        raise Http404(name)
    raw = json.loads(path.read_text())
    res = raw if 'tile' in raw else {'tile': name, 'items': [], 'data': raw, 'status': 'ok'}
    return JsonResponse({**res, 'updatedAt': now})


def apply_edits(a, body):
    # the Edit screen may change who it goes to, the subject, the text and which account sends it
    edits = body.get('payload') or {}
    a.payload = {**a.payload, **{k: str(edits[k]) for k in EDITABLE if k in edits}}
    if body.get('account') in [x.get('account', x['name'].lower()) for x in settings.LIFEHUB.get('email', [])]:
        a.account = body['account']


@require_POST
@login_required
def decide(request, pk):
    body = json.loads(request.body or '{}')
    decision = body.get('decision')
    if decision not in ('approve', 'decline'):
        return JsonResponse({'error': 'decision must be approve or decline'}, status=400)
    with transaction.atomic():
        a = get_object_or_404(Approval.objects.select_for_update(), pk=pk)
        if a.status != 'pending':
            return JsonResponse({'error': f'already {a.status}'}, status=409)
        proposed = a.payload
        if decision == 'approve':
            apply_edits(a, body)
            gaps = PLACEHOLDER.findall(a.payload.get('body', '')) if a.kind == 'email' else []
            if gaps:
                return JsonResponse({'error': f'fill in {", ".join(gaps)} first'}, status=400)
        a.status = 'approved' if decision == 'approve' else 'declined'
        a.decided = timezone.now()
        a.save()
        AuditRow.objects.create(approval=a, title=a.title, action=a.status, proposed=proposed,
                                final=a.payload if a.status == 'approved' else None, by=request.user.username)
        Activity.objects.create(text=f"{'Approved' if a.status == 'approved' else 'Declined'}: {a.title}", via='Approvals', approval=a)
    if a.status == 'approved' and a.kind in ('email', 'cleanup'):
        # done once the undo window has passed; the fetch job sweeps up anything this timer misses
        timer = threading.Timer(UNDO.total_seconds() + 1, mail.run_due)
        timer.daemon = True
        timer.start()
    return JsonResponse(approval_json(a))


@login_required
def approval_detail(request, pk):
    a = get_object_or_404(Approval.objects.select_related('item'), pk=pk)
    m = a.item
    accounts = accounts_json()
    pending = list(Approval.objects.filter(status='pending').values_list('pk', flat=True))
    return JsonResponse({
        'approval': approval_json(a),
        'email': {**email_json(m), 'body': m.body} if m else None,
        'accounts': accounts,
        'position': [pending.index(a.pk) + 1 if a.pk in pending else 0, len(pending)],
    })


@require_POST
@login_required
def save_draft(request, pk):
    a = get_object_or_404(Approval, pk=pk, status='pending')
    apply_edits(a, json.loads(request.body or '{}'))
    a.save()
    return JsonResponse(approval_json(a))


@require_POST
@login_required
def rewrite(request, pk):
    a = get_object_or_404(Approval.objects.select_related('item'), pk=pk)
    body = json.loads(request.body or '{}')
    if body.get('style') not in drafts.STYLES:
        return JsonResponse({'error': 'unknown style'}, status=400)
    try:
        text, model = drafts.rewrite(body.get('body') or a.payload.get('body', ''), body['style'], a.item)
        return JsonResponse({'body': text, 'model': model})
    except Exception:
        if body['style'] == 'polish':
            return JsonResponse({'error': 'Gemini didn’t answer; try again in a minute'}, status=503)
        return JsonResponse({'error': 'Ollama is away; rewrites run on your PC (or allow Gemini for private data in Settings)'}, status=503)


@require_POST
@login_required
def undo(request, pk):
    with transaction.atomic():
        a = get_object_or_404(Approval.objects.select_for_update(), pk=pk)
        if a.status not in ('approved', 'declined') or not a.decided or timezone.now() - a.decided > UNDO or a.sent_at:
            return JsonResponse({'error': 'too late to undo'}, status=409)
        AuditRow.objects.create(approval=a, title=a.title, action='undone', proposed=a.payload, final=None, by=request.user.username)
        a.status, a.decided = 'pending', None
        a.save()
        Activity.objects.create(text=f'Undid: {a.title}', via='Approvals', approval=a)
    return JsonResponse(approval_json(a))


@require_POST
@login_required
def task_save(request, pk=None):
    body = json.loads(request.body or '{}')
    t = get_object_or_404(Task, pk=pk) if pk else Task(source='added by you')
    if 'text' in body:
        text = str(body['text']).strip()[:300]
        if not text:
            return JsonResponse({'error': 'a task needs some text'}, status=400)
        t.text = text
    if 'due' in body:
        t.due = parse_date(body['due']) if body['due'] else None
    if 'repeat' in body:
        if body['repeat'] not in ('', 'daily', 'weekly', 'monthly'):
            return JsonResponse({'error': 'repeat is daily, weekly, monthly or blank'}, status=400)
        t.repeat = body['repeat']
    if 'snoozed' in body:
        t.snoozed = parse_date(body['snoozed']) if body['snoozed'] else None
    if 'done' in body:
        t.done = bool(body['done'])
        t.done_at = timezone.now() if t.done else None
        if t.done and t.repeat:
            # a repeating task stays open and moves to its next date
            t.done, t.due, t.snoozed = False, t.next_due(), None
    t.save()
    return JsonResponse(task_json(t))


@require_POST
@login_required
def waiting_dismiss(request, pk):
    SentMail.objects.filter(pk=pk).update(dismissed=True)
    return JsonResponse({'dismissed': True})


@require_POST
@login_required
def note_save(request, pk=None):
    body = json.loads(request.body or '{}')
    n = get_object_or_404(Note, pk=pk) if pk else Note()
    if body.get('delete') and pk:
        n.delete()
        return JsonResponse({'deleted': True})
    n.title = str(body.get('title', n.title)).strip()[:200] or 'Untitled'
    n.body = str(body.get('body', n.body))
    n.save()
    return JsonResponse(note_json(n))


@login_required
def learn_page(request):
    return JsonResponse(learn.page(int(request.GET['id']) if request.GET.get('id', '').isdigit() else None))


@require_POST
@login_required
def learn_write(request):
    if LearnCard.objects.filter(day=learn.today()).exists():
        return JsonResponse({'error': 'today’s card is already written'}, status=400)
    try:
        learn.write()
    except Exception as e:
        return JsonResponse({'error': f'Gemini couldn’t write the card: {e}'}, status=502)
    return JsonResponse(learn.page())


@require_POST
@login_required
def learn_action(request, pk, action):
    card = get_object_or_404(LearnCard, pk=pk)
    body = json.loads(request.body or '{}')
    if action == 'mark' and body.get('mark') in ('known', 'review'):
        learn.mark(card, body['mark'])
        return JsonResponse(learn.page(pk))
    if action == 'ask':
        q = str(body.get('question', '')).strip()[:500]
        if not q:
            return JsonResponse({'error': 'type a question'}, status=400)
        try:
            learn.ask(card, q)
        except Exception as e:
            return JsonResponse({'error': f'Gemini didn’t answer: {e}'}, status=502)
        return JsonResponse(learn.page(pk))
    raise Http404


@require_POST
@login_required
def watch_save(request, pk=None):
    body = json.loads(request.body or '{}')
    w = get_object_or_404(Watch, pk=pk) if pk else Watch()
    if body.get('delete') and pk:
        w.delete()
        return JsonResponse({'deleted': True})
    name = str(body.get('name', w.name)).strip()[:200]
    urls = list(dict.fromkeys(u.strip() for u in body.get('urls', [s['url'] for s in w.sources]) if str(u).strip()))
    if not name:
        return JsonResponse({'error': 'name the product to watch'}, status=400)
    if not all(prices.web_url(u) for u in urls):
        return JsonResponse({'error': 'store links must start with http:// or https://'}, status=400)
    try:
        w.target = float(body['target']) if body.get('target') not in (None, '') else None
    except (TypeError, ValueError):
        return JsonResponse({'error': 'the target price must be a number'}, status=400)
    old = {s['url']: s for s in w.sources}
    w.skipped += [u for u in old if u not in urls]  # removed by you: a seller search won't bring it back
    w.name, w.sources = name, [old.get(u, {'url': u, 'store': prices.store(u)}) for u in urls]
    w.save()
    if not w.searched:
        prices.discover(w)
    if not w.checked or any('checkedAt' not in s for s in w.sources):
        t = time.monotonic()
        prices.check(w)  # new links get a price straight away
        events.record('price', 'web', 'stores', count=len(w.sources), ms=events.ms(t), text=f'Lifehub → stores · priced {w.name}')
    return JsonResponse(watch_json(w))


@require_POST
@login_required
def watch_find(request):
    body = json.loads(request.body or '{}')
    name = str(body.get('name', '')).strip()
    if not name:
        return JsonResponse({'error': 'name the product first'}, status=400)
    try:
        return JsonResponse({'items': prices.find(name, body.get('known', []))})
    except Exception as e:
        return JsonResponse({'error': f'search failed: {e}'}, status=502)


@require_POST
@login_required
def ask(request):
    body = json.loads(request.body or '{}')
    question = str(body.get('question', '')).strip()[:500]
    if not question:
        return JsonResponse({'error': 'ask something'}, status=400)
    # one JSON object per line, so the panel can show each step as it happens
    lines = (json.dumps(event) + '\n' for event in agent.ask(question, 'gemini' if body.get('model') == 'gemini' else 'ollama'))
    res = StreamingHttpResponse(lines, content_type='application/x-ndjson')
    res['X-Accel-Buffering'] = 'no'
    return res


@login_required
def inbox_page(request):
    pending = Approval.objects.filter(status='pending', item__isnull=False)
    replies = {a.item_id: a for a in pending if a.kind == 'email'}
    trash = {a.item_id: a.pk for a in pending if a.kind == 'cleanup'}
    # stamped deletes are on their way to Gmail Trash (30 s undo, then the next fetch): gone from the list already
    leaving = set(Approval.objects.filter(kind='cleanup', status='approved', sent_at__isnull=True, payload__action='trash').values_list('item_id', flat=True))
    statuses = SourceStatus.objects.filter(source__in=[a['name'] for a in settings.LIFEHUB.get('email', [])], ok_at__isnull=False)
    emails = []
    for m in inbox_mail():
        if m.pk in leaving:
            continue
        r = replies.get(m.pk)
        emails.append({**email_json(m, r.pk if r else None), 'body': m.body, 'draft': r.payload.get('body', '') if r else '', 'trashId': str(trash[m.pk]) if m.pk in trash else None})
    return JsonResponse({
        'emails': emails, 'accounts': accounts_json(),
        'updatedAt': min(s.ok_at for s in statuses).isoformat() if statuses else None,
    })


@require_POST
@login_required
def email_action(request, pk, action):
    item = get_object_or_404(Item, pk=pk, kind=Item.EMAIL)
    body = json.loads(request.body or '{}')
    if action in ('read', 'archive'):
        try:
            mail.act(item, action)
        except Exception as e:
            return JsonResponse({'error': f"Gmail didn't take it: {e}"}, status=502)
        if action == 'archive':
            Activity.objects.create(text=f'Archived: {item.title}'[:300], via='Email')
        return JsonResponse({'ok': True})
    if action == 'delete':
        return JsonResponse(approval_json(mail.ask_trash(item, 'you asked')))
    if action == 'task':
        t = Task.from_email(item, item.summary or item.title)
        return JsonResponse(task_json(t))
    if action == 'group':
        if body.get('group') not in triage.GROUPS:
            return JsonResponse({'error': 'unknown group'}, status=400)
        item.group = body['group']
        item.save(update_fields=['group'])
        return JsonResponse({'ok': True})
    if action == 'draft':
        if item.drafts.filter(status='pending', kind='email').exists():
            return JsonResponse({'error': 'a draft is already waiting for your stamp'}, status=409)
        try:
            return JsonResponse(approval_json(drafts.make_approval(item, 'drafted when you asked', str(body.get('instructions', ''))[:500])))
        except Exception:
            return JsonResponse({'error': 'Ollama is away; drafts run on your PC'}, status=503)
    raise Http404(action)


def sender_json(s, waiting, folders):
    return {
        'id': str(s.pk), 'account': s.account, 'address': s.address, 'name': s.name or s.address.split('@')[0], 'total': s.total,
        'unread': s.unread, 'protected': s.protected, 'category': s.category, 'subjects': s.subjects, 'replied': s.replied, 'oneClick': bool(s.unsubscribe),
        'unsubscribeLink': s.unsubscribe_link, 'suggestion': s.suggestion, 'reason': s.reason,
        'folder': s.folder, 'newFolder': bool(s.folder) and s.folder not in folders.get(s.account, []), 'done': s.done or waiting.get(s.pk, ''),
    }


@login_required
def cleanup_view(request):
    stamps = list(Approval.objects.filter(kind='cleanup', payload__action='trash_senders', status__in=['pending', 'approved'], sent_at__isnull=True))
    # a sender shows what's happening to it: waiting for the stamp, then queued until the fetch job reaches it, then done
    waiting = {pk: 'waiting for your stamp' if a.status == 'pending' else 'working:queued to delete' for a in stamps for pk in a.payload['senders']}
    folders = {k: cleanup.existing_folders(k) for k in cleanup.accounts()}
    deleting = []
    for a in stamps:
        if a.status != 'approved':
            continue
        ids = a.payload['senders']
        deleting.append({'title': a.title, 'senders': len(ids), 'done': Sender.objects.filter(pk__in=ids).exclude(done='').count(),
                         'approvedAt': a.decided.isoformat() if a.decided else None, 'error': a.send_error})
    return JsonResponse({
        'scan': Setting.get('cleanup_scan') or {},
        'deleting': deleting,
        'ollamaUp': health.ollama_up(),
        'folders': folders,
        'protected': {k: Setting.get(f'cleanup_protected_{k}') or {} for k in cleanup.accounts()},
        'senders': [sender_json(s, waiting, folders) for s in Sender.objects.all()],
    })


@require_POST
@login_required
def cleanup_scan(request):
    return JsonResponse({'started': cleanup.start_scan()})


@require_POST
@login_required
def cleanup_apply(request):
    body = json.loads(request.body or '{}')
    ids, action = [int(i) for i in body.get('ids', [])][:2000], body.get('action')
    if action == 'protect':
        if body.get('folder') not in cleanup.PROTECTED:
            return JsonResponse({'error': 'unknown folder'}, status=400)
        cleanup.file_protected(body['folder'])
        return JsonResponse({'started': True})
    if action == 'folder':
        # you picked a different folder than Ollama
        folder = str(body.get('folder', '')).strip().strip('/')[:100]
        return JsonResponse({'changed': Sender.objects.filter(pk__in=ids).update(folder=folder, suggestion='file')} if folder else {'error': 'name the folder'}, status=200 if folder else 400)
    if action in ('read', 'archive', 'file'):
        return JsonResponse({'started': cleanup.apply_now(ids, action)})
    if action == 'keep':
        return JsonResponse({'kept': Sender.objects.filter(pk__in=ids).update(done='kept')})
    if action == 'undo-keep':
        return JsonResponse({'kept': Sender.objects.filter(pk__in=ids, done='kept').update(done='')})
    if action == 'delete':
        a = cleanup.ask_delete(ids, bool(body.get('unsubscribe')))
        return JsonResponse(approval_json(a) if a else {'error': 'nothing left to delete'}, status=200 if a else 400)
    return JsonResponse({'error': 'unknown action'}, status=400)


@require_POST
@login_required
def brief_write(request):
    if not health.private_up():
        return JsonResponse({'error': 'Ollama is away; the brief reads your mail, so it only runs on your PC (or allow Gemini for private data in Settings)'}, status=503)
    return JsonResponse(brief_json(brief.write(src='web')))


@login_required
def connections_view(request):
    """connections.cpl's manage panels: the connections as stored (secrets masked), and add / change / remove / test."""
    if request.method == 'POST':
        body = json.loads(request.body or '{}')
        kind, op, original = body.get('kind'), body.get('op'), str(body.get('original') or '')
        try:
            if kind not in connections.FIELDS:
                return JsonResponse({'error': 'unknown kind'}, status=400)
            elif op == 'test':
                return JsonResponse({'ok': connections.test(kind, original, body.get('data') or {})})
            elif op == 'save':
                connections.save(kind, original, body.get('data') or {})
            elif op == 'remove':
                connections.remove(kind, original)
            else:
                return JsonResponse({'error': 'unknown op'}, status=400)
        except (ValueError, LookupError, KeyError) as e:
            return JsonResponse({'error': str(e).strip("'")}, status=400)
        except Exception as e:  # a failed test: IMAP refused, the address didn't answer
            return JsonResponse({'error': f"couldn't connect: {e}"[:300]}, status=400)
    return JsonResponse({
        **{kind: [connections.masked(kind, x) for x in connections.items(kind)] for kind in connections.FIELDS},
        'topics': sorted({f.get('topic', '') for f in connections.items('feed')} - {''}),
    })


@login_required
def settings_view(request):
    if request.method == 'POST':
        body = json.loads(request.body or '{}')
        if 'sendEmail' in body:
            Setting.objects.update_or_create(key='send_email', defaults={'value': bool(body['sendEmail'])})
            Activity.objects.create(text=f"Sending approved replies turned {'on' if body['sendEmail'] else 'off'}", via='Settings')
        if 'geminiPrivate' in body:
            Setting.objects.update_or_create(key='gemini_private', defaults={'value': bool(body['geminiPrivate'])})
            Activity.objects.create(text=f"Gemini for private data turned {'on' if body['geminiPrivate'] else 'off'}", via='Settings')
        for key, value in (body.get('permissions') or {}).items():
            if key in PERMISSIONS and value in PERMISSIONS[key][1] and value != permission(key):
                row, _ = Setting.objects.get_or_create(key='permissions', defaults={'value': {}})
                row.value = {**row.value, key: value}
                row.save()
                Activity.objects.create(text=f'Permission changed: {key} is now {value}', via='Settings')
    cfg = settings.LIFEHUB
    statuses = {s.source: s for s in SourceStatus.objects.all()}

    def status(name):
        s = statuses.get(name)
        return {'okAt': s.ok_at.isoformat() if s and s.ok_at else None, 'error': s.error if s and s.failing else ''}

    feeds = [f['name'] for f in cfg.get('feed', [])]
    return JsonResponse({
        'email': [{'name': a['name'], 'address': a['user'], 'account': a.get('account', a['name'].lower()), **status(a['name'])} for a in cfg.get('email', [])],
        'calendars': [c['name'] for c in cfg.get('calendar', [])],
        'feeds': {'count': len(feeds), 'failing': [f for f in feeds if status(f)['error']]},
        'models': {**health.agent_status(), 'ollamaModel': health.ollama()['model'], 'ollamaWhere': health.ollama()['where'], 'geminiKey': bool(cfg.get('gemini_api_key'))},
        'sendEmail': bool(Setting.get('send_email', False)),
        'geminiPrivate': bool(Setting.get('gemini_private', False)),
        'permissions': {k: permission(k) for k in PERMISSIONS},
    })


@login_required
def home(request):
    return render(request, 'hub/home.html', {'sections': [('Email', grouped(Item.EMAIL)), ('News', grouped(Item.NEWS))]})


def token_ok(request):
    token = settings.LIFEHUB.get('api_token')
    return bool(token) and hmac.compare_digest(request.headers.get('Authorization', ''), f'Bearer {token}')


SEARCH_EACH = 6


@login_required
def search(request):
    """Plain text matches across mail, to-dos, notes and news, for the Ask panel while you type."""
    q = request.GET.get('q', '').strip()[:100]
    if len(q) < 2:
        return JsonResponse({'items': []})

    def has(*fields):
        return reduce(or_, (Q(**{f'{f}__icontains': q}) for f in fields))

    mail = Item.objects.filter(has('title', 'sender', 'snippet'), kind=Item.EMAIL).order_by('-published')[:SEARCH_EACH]
    news_ = Item.objects.filter(has('title'), kind=Item.NEWS).order_by('-published')[:SEARCH_EACH]
    tasks = Task.objects.filter(has('text', 'context')).order_by('done', '-created')[:SEARCH_EACH]
    notes = Note.objects.filter(has('title', 'body')).order_by('-updated')[:SEARCH_EACH]
    return JsonResponse({'items': [
        *({'kind': 'mail', 'id': str(m.pk), 'title': m.title, 'detail': parseaddr(m.sender)[0] or m.sender, 'url': f'/inbox?id={m.pk}', 'at': m.published.isoformat()} for m in mail),
        *({'kind': 'todo', 'id': str(t.pk), 'title': t.text, 'detail': 'done' if t.done else t.source, 'url': t.url, 'at': t.created.isoformat()} for t in tasks),
        *({'kind': 'note', 'id': str(n.pk), 'title': n.title or n.body[:80], 'detail': n.body[:140], 'url': '', 'at': n.updated.isoformat()} for n in notes),
        *({'kind': 'news', 'id': str(m.pk), 'title': m.title, 'detail': m.source, 'url': m.url, 'at': m.published.isoformat()} for m in news_),
    ]})


def api_items(request):
    if not (request.user.is_authenticated or token_ok(request)):
        return JsonResponse({'error': 'login or token required'}, status=401)
    items = Item.objects.all()
    if kind := request.GET.get('kind'):
        items = items.filter(kind=kind)
    return JsonResponse({'items': list(items.values('kind', 'source', 'title', 'sender', 'url', 'snippet', 'unread', 'published', 'group', 'answered')[:200])})


