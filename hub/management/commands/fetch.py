from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from hub.health import private_up as ollama_up  # private mail: Ollama, or Gemini when Settings allows
from hub.models import Activity, Approval, Event, Item, SourceStatus, Task, allowed
from hub.sources import fetch_email, fetch_feed
import signal
import time
import urllib.error

from hub import brief, cleanup, drafts, events, learn, mail, news, prices, receipts, waiting, weekly
from hub.triage import PER_RUN, classify

KEEP_NEWS = timedelta(days=3)
FEEDS_EVERY = timedelta(minutes=25)  # news refreshes about every 30 min; email every run
REDDIT_PAUSE_S = 12  # Reddit rate-limits feed readers hard
REDDIT_EVERY = timedelta(minutes=90)  # and a logged-out reader every 25 min still gets 429s
# a 429 or 503 means back off: 30 min, doubling to 4 h, or what the server's Retry-After asks
BACKOFF, BACKOFF_MAX = timedelta(minutes=30), timedelta(hours=4)
KEEP_DECLINED = timedelta(days=7)
RETRY_S = 10
RECEIPTS_EVERY = timedelta(minutes=30)
WAITING_EVERY = timedelta(minutes=30)
MAX_RUN_S = 60 * 60  # backstop: a run stuck past this is ended and pm2 starts a fresh one


def backoff(e, fails):
    """How long to leave a rate-limited source alone: its Retry-After (seconds) if it sent one, else doubling."""
    try:
        asked = timedelta(seconds=int(e.headers.get('Retry-After', '')))
    except (TypeError, ValueError):
        asked = None
    return min(BACKOFF_MAX, asked or BACKOFF * 2 ** (fails - 1))


class Command(BaseCommand):
    help = 'Pull email and feeds into the dashboard'

    def add_arguments(self, parser):
        parser.add_argument('--every', type=int, default=0, help='seconds: after a run, wait out the rest of this slot, then exit for pm2 to start the next')

    def handle(self, every=0, **options):
        # pm2's cron_restart killed runs that went past 5 min; this way a long run just pushes the next one back
        start = time.monotonic()
        signal.alarm(MAX_RUN_S)  # SIGALRM's default action ends the process
        try:
            self.run()
        finally:
            signal.alarm(0)
            if every:
                time.sleep(max(0, every - (time.monotonic() - start)))

    def run(self):
        events.HERE = 'fetch'
        Event.objects.filter(at__lt=timezone.now() - events.KEEP).delete()
        cfg = settings.LIFEHUB
        mail.run_due()  # stamped sends and deletes first: the rest of a run can take minutes
        for account in cfg.get('email', []):
            key = account.get('account', account['name'].lower())
            t = time.monotonic()
            stored = list(Item.objects.filter(source=account['name']))
            done = drafts.settled(stored)
            # mail still waiting on a reply stays while it's in the inbox, however old
            waiting_reply = {m.uid for m in stored if m.group == 'needs_reply' and m.pk not in done}
            new = self.pull(account['name'], Item.EMAIL, lambda: [{**m, 'account': key} for m in fetch_email(account, known={m.uid for m in stored}, keep=waiting_reply)], replace=True)
            events.record('fetch', 'gmail', 'fetch', count=new or 0, ms=events.ms(t), ok=new is not None,
                          text=f"Gmail → Lifehub · {account['name']}: " + (f'{new} new' if new is not None else 'failed'))
        t, feeds, got, failed, limited = time.monotonic(), 0, 0, 0, 0
        for feed in cfg.get('feed', []):
            last = SourceStatus.objects.filter(source=feed['name']).first()
            every = REDDIT_EVERY if 'reddit.com' in feed['url'] else FEEDS_EVERY
            if last and last.ok_at and timezone.now() - last.ok_at < every:
                continue
            if last and last.retry_at and timezone.now() < last.retry_at:
                continue
            if 'reddit.com' in feed['url']:
                time.sleep(REDDIT_PAUSE_S)
            topic = feed.get('topic', '')
            new = self.pull(feed['name'], Item.NEWS, lambda: [{**i, 'topic': topic} for i in fetch_feed(feed['url'])], replace=False)
            feeds, got, failed = feeds + 1, got + (new or 0), failed + (new is None)
            # a rate limit isn't a broken feed: it's backing off and will be asked again later
            limited += new is None and bool(SourceStatus.objects.filter(source=feed['name'], retry_at__gt=timezone.now()).exists())
        if feeds:
            broken = failed - limited
            events.record('news', 'news', 'fetch', count=got, ms=events.ms(t), ok=not broken,
                          text=f"News → Lifehub · {got} new from {feeds} feed{'s' if feeds > 1 else ''}" + (f', {broken} failed' if broken else '')
                          + (f', {limited} rate-limited' if limited else ''))
        Item.objects.filter(kind=Item.NEWS, published__lt=timezone.now() - KEEP_NEWS).delete()
        # declined drafts go after a week; their audit rows stay
        Approval.objects.filter(status='declined', decided__lt=timezone.now() - KEEP_DECLINED).delete()
        self.triage()
        self.draft()
        self.replies_today()
        self.receipts()
        self.waiting()
        try:
            n = prices.run()
            if n:
                self.stdout.write(f'prices: {n}')
        except Exception as e:
            self.stderr.write(f'prices: {e}')
        mail.run_due()
        if weekly.due():
            try:
                weekly.build()
                Activity.objects.create(text='Wrote the weekly email summary', via='Email')
            except Exception as e:
                self.stderr.write(f'weekly summary: {e}')
        if weekly.days_due():
            try:
                weekly.build_days()
            except Exception as e:
                self.stderr.write(f'mail this week: {e}')
        if news.brief_due():
            try:
                news.write_brief()
            except Exception as e:
                self.stderr.write(f'news brief: {e}')
        try:
            if learn.run():
                Activity.objects.create(text='Wrote today’s AI daily card', via='Learn', model='gemini')
        except Exception as e:
            self.stderr.write(f'AI daily: {e}')
        if ollama_up():
            try:
                n = cleanup.suggest()
                if n:
                    self.stdout.write(f'cleanup suggestions: {n}')
            except Exception as e:
                self.stderr.write(f'cleanup: {e}')
        # Ollama may be away at 7:40 (the machine is off); the next run tries again
        if brief.due() and ollama_up():
            try:
                brief.write()
            except Exception as e:
                self.stderr.write(f'day brief: {e}')

    def replies_today(self):
        mail_ = list(Item.objects.filter(kind=Item.EMAIL))
        done = drafts.settled(mail_)
        receipts.note_replies(sum(1 for m in mail_ if m.group == 'needs_reply' and m.pk not in done))

    def waiting(self):
        for account in settings.LIFEHUB.get('email', []):
            key = account.get('account', account['name'].lower())
            status, _ = SourceStatus.objects.get_or_create(source=f'waiting:{key}')
            if status.ok_at and timezone.now() - status.ok_at < WAITING_EVERY:
                continue
            try:
                self.stdout.write(f'waiting {key}: read {waiting.scan(key)}')
                status.ok_at, status.error = timezone.now(), ''
            except Exception as e:
                status.error = str(e)[:500]
                self.stderr.write(f'waiting {key}: {e}')
            status.save()

    def receipts(self):
        # private mail: read only on Ollama, a dozen a run; Gmail is asked at most every 30 min
        if not ollama_up():
            return
        new = []
        for account in settings.LIFEHUB.get('email', []):
            key = account.get('account', account['name'].lower())
            status, _ = SourceStatus.objects.get_or_create(source=f'receipts:{key}')
            if status.ok_at and timezone.now() - status.ok_at < RECEIPTS_EVERY:
                continue
            try:
                new += [(key, m) for m in receipts.fetch(key)]
                status.ok_at, status.error = timezone.now(), ''
            except Exception as e:
                status.error = str(e)[:500]
                self.stderr.write(f'receipts {key}: {e}')
            status.save()
        read = shipments = 0
        start = time.monotonic()
        for key, message in new:
            if time.monotonic() - start > receipts.BUDGET_S:
                break
            try:
                r = receipts.read(key, message)
            except Exception as e:
                self.stderr.write(f'receipt: {message["title"][:60]}: {e}')
                break
            read += 1
            shipments += bool(r and r.kind == 'shipment')
        if read < len(new):
            # the rest are read on the next runs
            SourceStatus.objects.filter(source__startswith='receipts:').update(ok_at=None)
        if read:
            extra = f", {shipments} about shipments" if shipments else ''
            Activity.objects.create(text=f"Read {read} receipt{'s' if read > 1 else ''}{extra}", via='Email', model='ollama')
        self.stdout.write(f'receipts: {read}')

    def draft(self):
        if not allowed('reply'):
            return
        # a reply drafted for mail that has since been answered, or archived, is no longer wanted
        Approval.objects.filter(kind='email', status='pending', item__isnull=True, payload__has_key='inReplyTo').delete()
        Approval.objects.filter(kind='cleanup', status='pending', item__isnull=True, payload__action='trash').delete()
        mail = list(Item.objects.filter(kind=Item.EMAIL))
        done = drafts.settled(mail)
        Approval.objects.filter(kind='email', status='pending', item__in=done).delete()
        candidates = sorted((m for m in mail if m.group == 'needs_reply' and m.pk not in done), key=lambda m: m.published, reverse=True)
        threads, todo = set(), []
        for item in candidates:
            key = drafts.conversation(item)
            # only the newest email of a conversation gets a reply
            if key in threads:
                continue
            threads.add(key)
            if drafts.wants_draft(item) and not item.drafts.exists():
                todo.append(item)
        made, model = 0, 'ollama'
        for item in todo[:drafts.PER_RUN]:
            try:
                model = drafts.make_approval(item, 'drafted from the email', src='fetch').model
            except Exception as e:
                self.stderr.write(f'draft: {item.title[:60]}: {e}')
                if not ollama_up():
                    break
                continue
            made += 1
        if made:
            Activity.objects.create(text=f"Drafted {made} repl{'ies' if made > 1 else 'y'} for your stamp", via='Email', model=model)
        self.stdout.write(f'drafted: {made}')

    def triage(self):
        if not allowed('sort'):
            return
        sorted_ = tasks = 0
        for item in Item.objects.filter(kind=Item.EMAIL, group='')[:PER_RUN]:
            t = time.monotonic()
            try:
                item.group, item.summary, task, due, item.model = classify(item)
            except Exception as e:
                events.failed('triage', 'fetch', t, item=f'email:{item.pk}', text=f'Sorting failed: {item.title}')
                self.stderr.write(f'triage: {item.title[:60]}: {e}')
                # Ollama is away: private mail waits unsorted rather than going to the cloud.
                # One bad email only skips itself; it is retried on the next run.
                if not ollama_up():
                    break
                continue
            item.save(update_fields=['group', 'summary', 'model'])
            node = events.model_node(item.model)
            events.record('triage', 'fetch', node, ms=events.ms(t), item=f'email:{item.pk}', private=item.model == 'gemini', text=f'Read on {events.label(node)}: {item.title}')
            events.record('triage', 'fetch', 'web', item=f'email:{item.pk}', text=f"Filed under {item.group.replace('_', ' ')}: {item.title}")
            if task and allowed('tasks'):
                Task.from_email(item, task, due)
                tasks += 1
            sorted_ += 1
        if sorted_:
            extra = f", found {tasks} to-do{'s' if tasks > 1 else ''}" if tasks else ''
            Activity.objects.create(text=f"Sorted {sorted_} email{'s' if sorted_ > 1 else ''} into groups{extra}", via='Email', model=item.model)
        self.stdout.write(f'sorted: {sorted_}')

    def pull(self, source, kind, fetch, replace):
        status, _ = SourceStatus.objects.get_or_create(source=source)
        try:
            try:
                items = fetch()
            except urllib.error.HTTPError:
                raise  # the server answered: asking again straight away only makes a rate limit worse
            except OSError:
                # most failures are Wi-Fi dropping for a few seconds: one more try
                time.sleep(RETRY_S)
                items = fetch()
        except Exception as e:
            self.stderr.write(f'{source}: {e}')
            status.error = str(e)[:500]
            if isinstance(e, urllib.error.HTTPError) and e.code in (429, 503):
                status.fails += 1
                status.retry_at = timezone.now() + backoff(e, status.fails)
            status.save()
            return None
        status.ok_at, status.error, status.fails, status.retry_at = timezone.now(), '', 0, None
        status.save()
        with transaction.atomic():
            seen = set(Item.objects.filter(source=source).values_list('uid', flat=True))
            new = sum(1 for it in items if it['uid'] not in seen)
            # the first pull of an account is a backfill, not news
            if kind == Item.EMAIL and seen and new:
                Activity.objects.create(text=f"{new} new email{'s' if new > 1 else ''} in {source}", via='Email')
            # the inbox is mirrored, so archived mail drops off; news accumulates.
            # Updating in place keeps each email's group and summary across fetches.
            if replace:
                Item.objects.filter(source=source).exclude(uid__in=[it['uid'] for it in items]).delete()
            for it in items:
                Item.objects.update_or_create(source=source, uid=it.pop('uid'), defaults={'kind': kind, **it})
        self.stdout.write(f'{source}: {len(items)}')
        return new
