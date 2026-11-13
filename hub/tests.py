import json
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings

from hub.sources import parse_date, parse_feed, parse_message

RSS = b'''<rss><channel><item><title>Budget &amp; you</title><link>https://g.ca/a</link>
<guid>g1</guid><pubDate>Mon, 05 Oct 2026 09:00:00 GMT</pubDate><description>&lt;p&gt;Big news&lt;/p&gt;</description></item></channel></rss>'''

ATOM = b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_x</id><title>Transit update</title>
<link href="https://reddit.com/x"/><author><name>/u/bob</name></author><updated>2026-10-05T10:00:00+00:00</updated>
<content type="html">&lt;div&gt;Line 1 delayed&lt;/div&gt;</content></entry></feed>'''

MAIL = b'''From: Ana <ana@x.com>\r\nSubject: Lunch?\r\nDate: Mon, 05 Oct 2026 12:00:00 -0400\r
Message-ID: <abc@x.com>\r\nContent-Type: text/plain\r\n\r\nAre you free tomorrow?\r\n'''


class ParseTests(SimpleTestCase):
    def test_rss(self):
        [it] = parse_feed(RSS)
        self.assertEqual((it['uid'], it['title'], it['snippet'], it['published'].day), ('g1', 'Budget & you', 'Big news', 5))

    def test_atom(self):
        [it] = parse_feed(ATOM)
        self.assertEqual((it['url'], it['sender'], it['snippet']), ('https://reddit.com/x', '/u/bob', 'Line 1 delayed'))

    def test_email(self):
        it = parse_message(MAIL, b'1 (FLAGS ())', 'me@gmail.com')
        self.assertTrue(it['unread'])
        self.assertEqual((it['title'], it['snippet'], it['uid']), ('Lunch?', 'Are you free tomorrow?', 'abc@x.com'))
        self.assertIn('rfc822msgid:abc%40x.com', it['url'])
        self.assertEqual(it['sender'], 'Ana <ana@x.com>')
        self.assertFalse(parse_message(MAIL, b'1 (FLAGS (\\Seen))', 'me@gmail.com')['unread'])

    def test_replies_found_in_sent(self):
        from hub import sources
        raw = b'In-Reply-To: <a1@mail.gmail.com>\r\nReferences: <a0@x.com>\r\n <a1@mail.gmail.com>\r\n\r\n'
        self.assertEqual(sources.reply_targets(raw), {'a0@x.com', 'a1@mail.gmail.com'})

        class Imap:
            def list(self):
                return 'OK', [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Messages envoy\xc3\xa9s"']
        self.assertEqual(sources.special_folder(Imap(), b'\\Sent'), '"[Gmail]/Messages envoyés"')

    def test_date_without_zone(self):
        self.assertIsNotNone(parse_date('Mon, 05 Oct 2026 19:05:12').tzinfo)


@override_settings(LIFEHUB={'api_token': 'abc'})
class ApiAuthTests(TestCase):
    def test_token(self):
        self.assertEqual(self.client.get('/api/items/').status_code, 401)
        self.assertEqual(self.client.get('/api/items/', HTTP_AUTHORIZATION='Bearer nope').status_code, 401)
        self.assertEqual(self.client.get('/api/items/', HTTP_AUTHORIZATION='Bearer abc').status_code, 200)


class TileTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        self.user = User.objects.create_user('me', password='pw')

    def test_login_required(self):
        self.assertEqual(self.client.get('/api/tiles/inbox/').status_code, 302)

    def test_envelopes(self):
        self.client.force_login(self.user)
        social = self.client.get('/api/tiles/social/').json()
        self.assertEqual((social['tile'], social['status'], len(social['items'])), ('social', 'ok', 4))
        streak = self.client.get('/api/tiles/streak/').json()
        self.assertEqual((streak['tile'], streak['items'], streak['data']['days']), ('streak', [], 0))
        self.assertIn('updatedAt', streak)
        self.assertEqual(self.client.get('/api/tiles/nope/').status_code, 404)


class OllamaScheduleTests(SimpleTestCase):
    def test_falls_back_when_the_scheduled_one_is_away(self):
        from unittest.mock import patch

        from hub import health
        health._picked.update(at=-999, host=None)
        with patch.object(health, 'ollama_hosts', return_value=[{'where': 'pc', 'url': 'http://pc'}, {'where': 'mac', 'url': 'http://mac'}]), \
                patch.object(health, 'up', side_effect=lambda url: url.startswith('http://mac')):
            self.assertEqual(health.ollama()['where'], 'mac')
        health._picked.update(at=-999, host=None)


class HealthTests(SimpleTestCase):
    def status(self, ollama, gemini, key='k'):
        from unittest.mock import patch

        from hub import health
        with self.settings(LIFEHUB={'gemini_api_key': key}), \
                patch.object(health, 'up', side_effect=lambda url: ollama if '/api/tags' in url else gemini):
            return health.agent_status()

    def test_routing(self):
        self.assertEqual(self.status(True, True)['activeModel'], 'ollama')
        self.assertEqual(self.status(False, True)['activeModel'], 'gemini')
        s = self.status(False, False)
        self.assertEqual((s['activeModel'], s['online']), ('none', False))
        # no key: Gemini counts as down without being asked
        self.assertFalse(self.status(False, True, key='')['geminiUp'])


class ApprovalTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User

        from hub.models import Approval
        self.client.force_login(User.objects.create_user('me', password='pw'))
        self.a = Approval.objects.create(kind='email', account='work', title='Reply to Maya', payload={'body': 'Thursday works'})

    def post(self, path, body=None):
        return self.client.post(path, data=json.dumps(body or {}), content_type='application/json')

    def test_stamp_audit_and_undo(self):
        from hub.models import AuditRow
        self.assertEqual(len(self.client.get('/api/tiles/approvals/').json()['items']), 1)
        self.assertEqual(self.post(f'/api/approvals/{self.a.pk}/decide/', {'decision': 'approve'}).json()['status'], 'approved')
        self.assertEqual(self.client.get('/api/tiles/approvals/').json()['items'], [])
        row = AuditRow.objects.get()
        self.assertEqual((row.action, row.final, row.by), ('approved', {'body': 'Thursday works'}, 'me'))
        # deciding twice is refused
        self.assertEqual(self.post(f'/api/approvals/{self.a.pk}/decide/', {'decision': 'decline'}).status_code, 409)
        log = self.client.get('/api/tiles/activity/').json()['items']
        self.assertEqual((log[0]['text'], log[0]['undo']['approvalId']), ('Approved: Reply to Maya', str(self.a.pk)))
        self.assertEqual(self.post(f'/api/approvals/{self.a.pk}/undo/').json()['status'], 'pending')
        self.assertEqual(list(AuditRow.objects.values_list('action', flat=True)), ['undone', 'approved'])

    def test_undo_window_closes(self):
        from datetime import timedelta

        from django.utils import timezone
        self.post(f'/api/approvals/{self.a.pk}/decide/', {'decision': 'decline'})
        self.a.refresh_from_db()
        self.a.decided = timezone.now() - timedelta(seconds=31)
        self.a.save()
        self.assertEqual(self.post(f'/api/approvals/{self.a.pk}/undo/').status_code, 409)
        self.assertNotIn('undo', self.client.get('/api/tiles/activity/').json()['items'][0])


@override_settings(LIFEHUB={'email': [{'name': 'Personal', 'user': 'p'}, {'name': 'Work', 'user': 'w'}]})
class InboxTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        from django.utils import timezone

        from hub.models import Item
        self.client.force_login(User.objects.create_user('me', password='pw'))
        mk = lambda uid, account, group: Item.objects.create(  # noqa: E731
            kind='email', source=account.title(), uid=uid, title=uid, sender=f'Ana <{uid}@x.com>', account=account,
            group=group, summary=f'{uid} summary' if group else '', published=timezone.now())
        mk('a', 'work', 'needs_reply')
        mk('b', 'personal', 'receipt')
        mk('c', 'personal', '')

    def get(self):
        from unittest.mock import patch

        from hub import health
        with patch.object(health, 'ollama_up', return_value=False):
            return self.client.get('/api/tiles/inbox/').json()

    def test_groups_and_waiting(self):
        res = self.get()
        d = res['data']
        self.assertEqual((d['counts']['needs_reply'], d['counts']['receipt'], d['unsorted']), (1, 1, 1))
        self.assertEqual(d['needsReply'][0]['from'], {'name': 'Ana', 'address': 'a@x.com'})
        self.assertEqual(d['needsReply'][0]['account'], 'work')
        # unsorted mail and Ollama away: the tile waits rather than sending private mail elsewhere
        self.assertEqual((res['status'], len(res['items'])), ('waiting_for_model', 1))

    def test_failed_account_is_named(self):
        from hub.models import SourceStatus
        SourceStatus.objects.create(source='Personal', error='login failed')
        SourceStatus.objects.create(source='Work')
        res = self.get()
        self.assertEqual((res['status'], res['error']['source'], res['error']['message']), ('error', 'personal_email', 'Work email is fine.'))

    def test_short_blip_is_not_an_error(self):
        from datetime import timedelta

        from django.utils import timezone

        from hub.models import SourceStatus
        SourceStatus.objects.create(source='Personal', error='[Errno 65] No route to host', ok_at=timezone.now() - timedelta(minutes=4))
        SourceStatus.objects.create(source='Work', ok_at=timezone.now())
        self.assertNotEqual(self.get()['status'], 'error')
        SourceStatus.objects.filter(source='Personal').update(ok_at=timezone.now() - timedelta(minutes=20))
        self.assertEqual(self.get()['status'], 'error')

    def test_fetch_keeps_sorting(self):
        from unittest.mock import patch

        from django.core.management import call_command
        from django.utils import timezone

        from hub.management.commands import fetch
        from hub.models import Item
        mail = [{'uid': 'a', 'title': 'a', 'sender': 'Ana <a@x.com>', 'url': '', 'snippet': '', 'body': '', 'bulk': False, 'unread': True, 'published': timezone.now()}]
        with patch.object(fetch, 'fetch_email', side_effect=lambda acct, **kw: mail if acct['name'] == 'Work' else []), \
                patch.object(fetch, 'classify', side_effect=OSError('ollama away')):
            call_command('fetch', stdout=open('/dev/null', 'w'), stderr=open('/dev/null', 'w'))
        a = Item.objects.get(uid='a')
        self.assertEqual((a.group, a.summary), ('needs_reply', 'a summary'))
        # Personal came back empty, so its mirrored mail is gone
        self.assertFalse(Item.objects.filter(source='Personal').exists())


class FetchManyTests(TestCase):
    def test_flags_after_the_literal_still_count(self):
        from hub.sources import fetch_many

        class Imap:
            def fetch(self, nums, what):
                assert nums == b'1,2'
                return 'OK', [(b'1 (FLAGS (\\Seen) BODY[] {3}', b'one'), b')', (b'2 (BODY[] {3}', b'two'), b' FLAGS (\\Answered))']
        out = fetch_many(Imap(), [b'1', b'2'], '(FLAGS BODY.PEEK[])')
        self.assertEqual([lit for _, lit in out], [b'one', b'two'])
        self.assertIn(b'\\Seen', out[0][0])
        self.assertIn(b'\\Answered', out[1][0])
        self.assertEqual(fetch_many(Imap(), [], 'x'), [])


class DraftTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        from django.utils import timezone

        from hub.models import Approval, Item
        self.client.force_login(User.objects.create_user('me', password='pw'))
        self.item = Item.objects.create(kind='email', source='Work', uid='m1@x.com', title='Radiator', sender='Mike <mike@x.com>',
                                        account='work', group='needs_reply', published=timezone.now())
        self.a = Approval.objects.create(kind='email', account='work', item=self.item, title='Reply to Mike re: Radiator',
                                         payload={'to': 'mike@x.com', 'subject': 'Re: Radiator', 'body': 'Hi Mike, [day that works] suits me.\n\nSam', 'inReplyTo': '<m1@x.com>'})

    def post(self, path, body):
        return self.client.post(path, data=json.dumps(body), content_type='application/json')

    def test_placeholders_block_approval(self):
        r = self.post(f'/api/approvals/{self.a.pk}/decide/', {'decision': 'approve'})
        self.assertEqual((r.status_code, r.json()['error']), (400, 'fill in [day that works] first'))
        r = self.post(f'/api/approvals/{self.a.pk}/decide/', {'decision': 'approve', 'payload': {'body': 'Hi Mike, Friday suits me.\n\nSam'}})
        self.assertEqual(r.json()['status'], 'approved')

    @override_settings(LIFEHUB={'send_email': False, 'email': [{'name': 'Work', 'user': 'me@example.com', 'password': 'x'}]})
    def test_sending_off_sends_nothing(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import mail
        from hub.models import Activity, Approval
        Approval.objects.filter(pk=self.a.pk).update(status='approved', decided=timezone.now() - timedelta(seconds=31))
        with patch.object(mail, 'send') as send:
            mail.send_due()
            mail.send_due()
        send.assert_not_called()
        self.assertEqual(Activity.objects.get().text, 'Would send (sending is off): Reply to Mike re: Radiator')

    @override_settings(LIFEHUB={'send_email': True, 'email': [{'name': 'Work', 'user': 'me@example.com', 'password': 'x'}]})
    def test_send_after_undo_window_once(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import mail
        from hub.models import Approval
        Approval.objects.filter(pk=self.a.pk).update(status='approved', decided=timezone.now())
        with patch.object(mail, 'send') as send:
            mail.send_due()  # still inside the undo window
            send.assert_not_called()
            Approval.objects.filter(pk=self.a.pk).update(decided=timezone.now() - timedelta(seconds=31))
            mail.send_due()
            mail.send_due()
        send.assert_called_once()
        self.item.refresh_from_db()
        self.assertTrue(self.item.answered)
        # once sent there is no undo
        self.assertEqual(self.post(f'/api/approvals/{self.a.pk}/undo/', {}).status_code, 409)

    def test_sample_approvals_never_send(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import mail
        from hub.models import Approval
        Approval.objects.create(kind='email', account='work', title='sample', status='approved', decided=timezone.now() - timedelta(minutes=1),
                                payload={'to': 'maya@example.com', 'subject': 's', 'body': 'b'})
        with self.settings(LIFEHUB={'send_email': True}), patch.object(mail, 'send') as send:
            mail.send_due()
        send.assert_not_called()


class DraftRulesTests(SimpleTestCase):
    def test_who_gets_a_draft(self):
        from hub.drafts import clean, strip_re, thread_key, wants_draft
        from hub.models import Item
        self.assertTrue(wants_draft(Item(sender='Maya <maya@example.com>')))
        self.assertFalse(wants_draft(Item(sender='Google <no-reply@accounts.google.com>')))
        self.assertFalse(wants_draft(Item(sender='Acme <notifications@example.com>')))
        self.assertFalse(wants_draft(Item(sender='News <a@b.com>', bulk=True)))
        self.assertEqual(thread_key('Re: [External] -Re: Workday x Acme'), 'workday x acme')
        self.assertEqual(thread_key('Workday x Acme'), 'workday x acme')
        self.assertEqual(strip_re('Re: RE: Radiator'), 'Radiator')
        with self.assertRaises(ValueError):
            clean('Hi\n</think>\nHi')


class SettledTests(SimpleTestCase):
    def test_thread_handled_when_newest_answered(self):
        from datetime import datetime, timezone
        from types import SimpleNamespace as M

        from hub import drafts
        at = lambda h: datetime(2026, 10, 5, h, tzinfo=timezone.utc)
        mail = [
            M(pk=1, account='work', title='[External] -Re: Weekly Connect', published=at(17), answered=False),
            M(pk=2, account='work', title='Re: Weekly Connect', published=at(22), answered=True),
            M(pk=3, account='work', title='Radiator', published=at(9), answered=True),
            M(pk=4, account='work', title='Re: Radiator', published=at(10), answered=False),  # new mail after your reply
        ]
        for m in mail:
            m.unread, m.bulk, m.sender, m.thread = False, False, 'Mike <mike@x.com>', ''  # no Gmail thread id: subject fallback
        alert = M(pk=5, account='work', title='Security alert', published=at(11), answered=False, unread=False, bulk=False, sender='Google <no-reply@accounts.google.com>', thread='')
        self.assertEqual(drafts.settled([*mail, alert]), {1, 2, 5})
        alert.unread = True
        self.assertEqual(drafts.settled([*mail, alert]), {1, 2})


class AgendaTests(SimpleTestCase):
    ICS = b'''BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:standup
DTSTART;TZID=America/Toronto:20261001T093000
DTEND;TZID=America/Toronto:20261001T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
SUMMARY:Standup
LOCATION:Teams, online
END:VEVENT
BEGIN:VEVENT
UID:gone
DTSTART;TZID=America/Toronto:20261005T120000
DTEND;TZID=America/Toronto:20261005T130000
SUMMARY:Cancelled lunch
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:bday
DTSTART;VALUE=DATE:20261005
DTEND;VALUE=DATE:20261006
SUMMARY:Luca's birthday
END:VEVENT
END:VCALENDAR'''

    def test_today(self):
        from datetime import date

        from hub.agenda import events_on
        evs = events_on(self.ICS, date(2026, 10, 5), 'work')
        self.assertEqual(sorted((e['title'], e['allDay']) for e in evs), [("Luca's birthday", True), ('Standup', False)])
        standup = next(e for e in evs if e['title'] == 'Standup')
        self.assertEqual((standup['start'][:16], standup['where'], standup['calendar']), ('2026-10-05T09:30', 'Teams', 'work'))
        # Sunday: the weekday standup does not repeat
        self.assertEqual(events_on(self.ICS, date(2026, 10, 4), 'work'), [])


class TaskNoteTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        self.client.force_login(User.objects.create_user('me', password='pw'))

    def post(self, path, body):
        return self.client.post(path, data=json.dumps(body), content_type='application/json')

    def test_tasks(self):
        t = self.post('/api/tasks/', {'text': 'Renew parking permit', 'due': '2026-10-09'}).json()
        self.assertEqual((t['source'], t['due'], t['done']), ('added by you', '2026-10-09', False))
        self.assertEqual(self.post('/api/tasks/', {'text': '  '}).status_code, 400)
        self.post(f"/api/tasks/{t['id']}/", {'done': True})
        # just ticked: still listed, as done, for 30 s
        self.assertEqual([x['done'] for x in self.client.get('/api/tiles/tasks/').json()['items']], [True])
        from datetime import timedelta
        from django.utils import timezone
        from hub.models import Task
        Task.objects.filter(pk=t['id']).update(done_at=timezone.now() - timedelta(seconds=31))
        self.assertEqual(self.client.get('/api/tiles/tasks/').json()['items'], [])

    def test_repeat_and_snooze(self):
        from datetime import date, timedelta
        from unittest import mock
        from hub.models import Task
        with mock.patch('django.utils.timezone.localdate', return_value=date(2026, 11, 12)):
            # monthly from Jan 31 lands on the month's last day; an overdue daily skips to tomorrow
            self.assertEqual(Task(due=date(2026, 1, 31), repeat='monthly').next_due(), date(2026, 11, 30))
            self.assertEqual(Task(due=date(2026, 12, 31), repeat='monthly').next_due(), date(2027, 1, 31))
            self.assertEqual(Task(due=date(2026, 11, 1), repeat='daily').next_due(), date(2026, 11, 13))
            self.assertEqual(Task(repeat='weekly').next_due(), date(2026, 11, 19))
            self.assertEqual(self.post('/api/tasks/', {'text': 'x', 'repeat': 'hourly'}).status_code, 400)
            t = self.post('/api/tasks/', {'text': 'Water plants', 'due': '2026-11-12', 'repeat': 'weekly'}).json()
            t = self.post(f"/api/tasks/{t['id']}/", {'done': True}).json()
            self.assertEqual((t['done'], t['due']), (False, '2026-11-19'))
            self.post(f"/api/tasks/{t['id']}/", {'snoozed': '2026-11-14'})
            self.assertFalse(Task.active().exists())
        with mock.patch('django.utils.timezone.localdate', return_value=date(2026, 11, 14)):
            self.assertTrue(Task.active().exists())

    def test_notes(self):
        n = self.post('/api/notes/', {'title': 'Gift ideas', 'body': 'Desk lamp for Mom'}).json()
        self.post(f"/api/notes/{n['id']}/", {'body': 'Desk lamp for Mom, record for Luca'})
        items = self.client.get('/api/tiles/notes/').json()['items']
        self.assertEqual((items[0]['title'], items[0]['body']), ('Gift ideas', 'Desk lamp for Mom, record for Luca'))
        self.post(f"/api/notes/{n['id']}/", {'delete': True})
        self.assertEqual(self.client.get('/api/tiles/notes/').json()['items'], [])


class AgentTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        from django.utils import timezone

        from hub.models import Item
        self.client.force_login(User.objects.create_user('me', password='pw'))
        self.item = Item.objects.create(kind='email', source='Work', uid='m1@x.com', title='Radiator', sender='Mike <mike@x.com>',
                                        account='work', group='needs_reply', summary='Asks which day works', published=timezone.now())

    def test_tool_loop_drafts_but_never_sends(self):
        from unittest.mock import patch

        from hub import agent, drafts
        from hub.models import Approval
        replies = iter([
            {'role': 'assistant', 'content': '', 'tool_calls': [{'function': {'name': 'needs_reply', 'arguments': {}}}]},
            {'role': 'assistant', 'content': '', 'tool_calls': [{'function': {'name': 'draft_reply', 'arguments': {'email_id': self.item.pk, 'instructions': 'Thursday works'}}}]},
            {'role': 'assistant', 'content': '1. **Approve the reply** to Mike (work).'},
        ])
        fake = {'to': 'mike@x.com', 'toName': 'Mike', 'subject': 'Re: Radiator', 'body': 'Hi Mike, Thursday works.\n\nSam', 'inReplyTo': '<m1@x.com>'}
        with patch.object(agent, 'call_ollama', side_effect=lambda m: next(replies)), patch.object(drafts, 'draft', return_value=(fake, 'ollama')):
            r = self.client.post('/api/ask/', data=json.dumps({'question': 'what needs a reply?'}), content_type='application/json')
            events = [json.loads(line) for line in b''.join(r.streaming_content).decode().splitlines()]
        steps = [e for e in events if 'step' in e]
        self.assertEqual(events[0], {'doing': 'reading emails that need a reply'})
        self.assertEqual(steps[0], {'step': 'Read 1 email that needs a reply (work)', 'ok': True})
        self.assertIn({'doing': 'drafting a reply to Mike'}, events)
        self.assertEqual(steps[1]['step'], 'Drafted a reply to Mike')
        a = Approval.objects.get()
        self.assertEqual((a.status, a.sent_at, events[-1]['approvals']), ('pending', None, [str(a.pk)]))

    def test_ollama_away(self):
        from unittest.mock import patch

        from hub import agent
        with patch.object(agent, 'call_ollama', side_effect=OSError('down')):
            r = self.client.post('/api/ask/', data=json.dumps({'question': 'hi'}), content_type='application/json')
            events = [json.loads(line) for line in b''.join(r.streaming_content).decode().splitlines()]
        self.assertIn('Ollama is away', events[0]['error'])


class NewsTests(TestCase):
    def setUp(self):
        from datetime import timedelta

        from django.utils import timezone

        from hub.models import Item
        now = timezone.now()
        for i in range(10):
            Item.objects.create(kind='news', source='Sportsnet NHL', topic='Hockey', uid=f'h{i}', title=f'hockey {i}', published=now - timedelta(minutes=i))
        Item.objects.create(kind='news', source='BBC World', topic='World', uid='w', title='world', published=now - timedelta(hours=3))
        Item.objects.create(kind='news', source='BBC World', topic='World', uid='old', title='old', published=now - timedelta(days=2))

    def test_stories_take_turns_across_topics(self):
        from hub import news
        picked = [i.title for i in news.stories()]
        self.assertEqual(picked[:3], ['hockey 0', 'world', 'hockey 1'])
        self.assertNotIn('old', picked)

    def test_brief_slots_and_fallback(self):
        from datetime import datetime
        from unittest.mock import patch
        from zoneinfo import ZoneInfo

        from hub import news
        from hub.models import NewsBrief
        tz = ZoneInfo('America/Toronto')
        self.assertFalse(news.brief_due(datetime(2026, 10, 5, 7, 0, tzinfo=tz)))
        self.assertTrue(news.brief_due(datetime(2026, 10, 5, 7, 20, tzinfo=tz)))
        # Gemini down: Ollama writes it, and the model is recorded
        with patch.object(news, 'gemini_text', side_effect=OSError('down')), patch.object(news, 'ollama', return_value='Leafs win.'):
            b = news.write_brief()
        self.assertEqual((b.text, b.model), ('Leafs win.', 'ollama'))
        NewsBrief.objects.filter(pk=b.pk).update(written=datetime(2026, 10, 5, 7, 16, tzinfo=tz))
        self.assertFalse(news.brief_due(datetime(2026, 10, 5, 11, 0, tzinfo=tz)))
        self.assertTrue(news.brief_due(datetime(2026, 10, 5, 12, 5, tzinfo=tz)))


class MorningBriefTests(TestCase):
    def test_due_and_write(self):
        from datetime import datetime
        from unittest.mock import patch
        from zoneinfo import ZoneInfo

        from hub import brief
        from hub.models import Approval, DayBrief
        tz = ZoneInfo('America/Toronto')
        self.assertFalse(brief.due(datetime(2026, 10, 5, 7, 30, tzinfo=tz)))
        self.assertTrue(brief.due(datetime(2026, 10, 5, 7, 45, tzinfo=tz)))
        Approval.objects.create(kind='email', title='Reply to Maya re: sync')
        with patch.object(brief.agenda, 'today', side_effect=RuntimeError('No calendars')), patch.object(brief.triage, 'ollama_text', return_value='Quiet day.') as llm:
            b = brief.write()
        self.assertIn('Reply to Maya re: sync', llm.call_args[0][1])
        self.assertIn('Reply to Maya re: sync', b.basis)
        DayBrief.objects.filter(pk=b.pk).update(written=datetime(2026, 10, 5, 7, 41, tzinfo=tz))
        self.assertTrue(brief.due(datetime(2026, 10, 6, 7, 41, tzinfo=tz)))
        # later the same day it is rewritten only when what it read has changed
        self.assertFalse(brief.due(datetime(2026, 10, 5, 15, 0, tzinfo=tz), current=b.basis))
        self.assertTrue(brief.due(datetime(2026, 10, 5, 15, 0, tzinfo=tz), current='something new'))
        self.assertFalse(brief.due(datetime(2026, 10, 5, 8, 0, tzinfo=tz), current='something new'))


class SettingsTests(TestCase):
    @override_settings(LIFEHUB={'send_email': False, 'email': [{'name': 'Work', 'user': 'me@example.com', 'password': 'x'}]})
    def test_send_toggle_overrides_toml(self):
        from unittest.mock import patch

        from django.contrib.auth.models import User

        from hub import health
        from hub.models import Setting
        self.client.force_login(User.objects.create_user('me', password='pw'))
        with patch.object(health, 'agent_status', return_value={}):
            self.assertFalse(self.client.get('/api/settings/').json()['sendEmail'])
            r = self.client.post('/api/settings/', data=json.dumps({'sendEmail': True}), content_type='application/json')
        self.assertTrue(r.json()['sendEmail'])
        self.assertNotIn('password', r.content.decode())
        self.assertTrue(Setting.get('send_email'))


class EmailActionTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        from django.utils import timezone

        from hub.models import Item
        self.client.force_login(User.objects.create_user('me', password='pw'))
        self.item = Item.objects.create(kind='email', source='Work', uid='m1@x.com', title='Promo', sender='Shop <shop@x.com>',
                                        account='work', group='newsletter', unread=True, published=timezone.now())

    def post(self, path, body=None):
        return self.client.post(path, data=json.dumps(body or {}), content_type='application/json')

    def test_read_and_archive_go_straight_to_gmail(self):
        from unittest.mock import patch

        from hub import mail
        with patch.object(mail, 'act') as act:
            self.assertEqual(self.post(f'/api/emails/{self.item.pk}/read/').status_code, 200)
            act.side_effect = LookupError('it is no longer in your inbox')
            r = self.post(f'/api/emails/{self.item.pk}/archive/')
        self.assertEqual(r.status_code, 502)
        self.assertEqual([c.args[1] for c in act.call_args_list], ['read', 'archive'])

    @override_settings(LIFEHUB={'email': [{'name': 'Work', 'user': 'me@example.com', 'password': 'x'}]})
    def test_delete_waits_for_stamp_and_undo_window(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import mail
        from hub.models import Approval
        a = self.post(f'/api/emails/{self.item.pk}/delete/').json()
        self.assertEqual(self.post(f'/api/emails/{self.item.pk}/delete/').json()['id'], a['id'])  # asked twice, one stamp
        self.assertEqual((a['kind'], a['status']), ('cleanup', 'pending'))
        with patch.object(mail, 'act') as act:
            mail.run_due()
            act.assert_not_called()
            self.post(f"/api/approvals/{a['id']}/decide/", {'decision': 'approve'})
            mail.run_due()
            act.assert_not_called()  # still inside the undo window
            Approval.objects.filter(pk=a['id']).update(decided=timezone.now() - timedelta(seconds=31))
            mail.run_due()
            mail.run_due()
        act.assert_called_once_with(self.item, 'trash')

    def test_page_shows_draft_and_pending_delete(self):
        from hub import mail
        mail.ask_trash(self.item, 'you asked')
        e = self.client.get('/api/inbox/').json()['emails'][0]
        self.assertEqual((bool(e['trashId']), e['draft'], e['group']), (True, '', 'newsletter'))


class CleanupTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User

        from hub.models import Sender
        self.client.force_login(User.objects.create_user('me', password='pw'))
        self.promo = Sender.objects.create(account='work', address='deals@shop.com', name='Shop', total=900, unread=880, bulk=True,
                                           subjects=['50% off'], unsubscribe='https://shop.com/u/1')
        self.friend = Sender.objects.create(account='work', address='maya@x.com', name='Maya', total=3, unread=1, replied=True)

    def post(self, body):
        return self.client.post('/api/cleanup/apply/', data=json.dumps(body), content_type='application/json')

    def test_unsubscribe_header(self):
        from hub import cleanup
        self.assertEqual(cleanup.parse_unsubscribe('<mailto:u@x.com>, <https://x.com/u>', 'List-Unsubscribe=One-Click'), ('https://x.com/u', 'https://x.com/u'))
        self.assertEqual(cleanup.parse_unsubscribe('<mailto:u@x.com>', ''), ('', 'mailto:u@x.com'))

    def test_suggest_keeps_people_you_write_to(self):
        from unittest.mock import patch

        from hub import cleanup
        with patch.object(cleanup.triage, 'ollama_json', return_value={'action': 'delete', 'reason': 'Shop promotions', 'folder': ''}) as llm:
            self.assertEqual(cleanup.suggest(), 2)
        llm.assert_called_once()  # Maya never reaches the model
        self.friend.refresh_from_db(); self.promo.refresh_from_db()
        self.assertEqual((self.friend.suggestion, self.promo.suggestion), ('keep', 'delete'))

    @override_settings(LIFEHUB={'email': [{'name': 'Work', 'user': 'me@example.com', 'password': 'x'}]})
    def test_delete_and_unsubscribe_wait_for_stamp(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import cleanup, mail
        from hub.models import Approval, Sender
        a = self.post({'ids': [self.promo.pk], 'action': 'delete', 'unsubscribe': True}).json()
        self.assertEqual(a['title'], 'Delete 900 emails from Shop')
        self.assertEqual(self.client.get('/api/cleanup/').json()['senders'][0]['done'], 'waiting for your stamp')
        done = lambda key, senders, action, deadline=None: Sender.objects.filter(pk__in=[x.pk for x in senders]).update(done='deleted', total=0)
        with patch.object(cleanup, 'run', side_effect=done) as run, patch.object(cleanup, 'one_click') as unsub, patch.object(mail, 'send_due'):
            mail.run_due()
            run.assert_not_called()
            self.client.post(f"/api/approvals/{a['id']}/decide/", data=json.dumps({'decision': 'approve'}), content_type='application/json')
            Approval.objects.filter(pk=a['id']).update(decided=timezone.now() - timedelta(seconds=31))
            page = self.client.get('/api/cleanup/').json()  # stamped: queued, and the page shows the delete's progress
            self.assertEqual(page['senders'][0]['done'], 'working:queued to delete')
            self.assertEqual([(d['senders'], d['done']) for d in page['deleting']], [(1, 0)])
            mail.run_due()
            mail.run_due()
        run.assert_called_once()
        self.assertEqual(run.call_args.args[2], 'trash')
        unsub.assert_called_once_with('https://shop.com/u/1')

    @patch('hub.cleanup.accounts', return_value=['work'])
    def test_file_suggestion_and_folder_change(self, _):
        from unittest.mock import patch

        from hub import cleanup
        from hub.models import Setting
        Setting.objects.create(key='cleanup_folders_work', value=['Receipts'])
        with patch.object(cleanup.triage, 'ollama_json', return_value={'action': 'file', 'reason': 'Shop orders', 'folder': 'Shopping'}) as llm:
            cleanup.suggest()
        self.assertIn('Their existing folders: Receipts', llm.call_args.args[1])
        s = next(x for x in self.client.get('/api/cleanup/').json()['senders'] if x['address'] == 'deals@shop.com')
        self.assertEqual((s['suggestion'], s['folder'], s['newFolder']), ('file', 'Shopping', True))
        self.post({'ids': [self.promo.pk], 'action': 'folder', 'folder': 'Receipts'})
        s = next(x for x in self.client.get('/api/cleanup/').json()['senders'] if x['address'] == 'deals@shop.com')
        self.assertEqual((s['folder'], s['newFolder']), ('Receipts', False))

    def test_moves_until_gmail_has_nothing_left(self):
        from unittest.mock import MagicMock, patch

        from hub import cleanup
        imap = MagicMock()
        searches = iter([('OK', [b'1 2 3']), ('OK', [b'3']), ('OK', [b'']), ('OK', [b''])])  # Gmail left one behind
        imap.uid.side_effect = lambda cmd, *a: next(searches) if cmd == 'SEARCH' else ('OK', [b''])
        imap.list.return_value = ('OK', [b'(\\Trash) "/" "[Gmail]/Trash"'])
        with patch.object(cleanup.mail, 'open_inbox') as box:
            box.return_value.__enter__.return_value = imap
            cleanup.run('work', [self.promo], 'trash')
        moves = [c.args[1] for c in imap.uid.call_args_list if c.args[0] == 'MOVE']
        self.assertEqual(moves, [b'1,2,3', b'3'])
        self.promo.refresh_from_db()
        self.assertEqual((self.promo.done, self.promo.total), ('deleted', 0))
        imap.uid.side_effect = lambda cmd, *a: ('OK', [b'7 8']) if cmd == 'SEARCH' else ('OK', [b''])  # Gmail won't let go
        with patch.object(cleanup.mail, 'open_inbox') as box:
            box.return_value.__enter__.return_value = imap
            cleanup.run('work', [self.promo], 'trash')
        self.promo.refresh_from_db()
        self.assertEqual((self.promo.done, self.promo.total), ('deleted, 2 left in Gmail', 2))

    def test_a_filing_cut_off_by_a_restart_is_finished_by_fetch(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import cleanup
        from hub.models import Sender
        Sender.objects.filter(pk=self.promo.pk).update(done='working:file', folder='Shopping', queued_at=timezone.now() - timedelta(minutes=11))
        Sender.objects.filter(pk=self.friend.pk).update(done='working:file', queued_at=timezone.now())  # its thread may still be going
        with patch.object(cleanup, 'run') as run:
            cleanup.due()
        run.assert_called_once()
        self.assertEqual(([s.pk for s in run.call_args.args[1]], run.call_args.args[2]), ([self.promo.pk], 'file'))

    @override_settings(LIFEHUB={'email': [{'name': 'Work', 'user': 'me@example.com', 'password': 'x'}]})
    def test_a_big_delete_carries_on_in_the_next_run(self):
        from datetime import timedelta
        from unittest.mock import patch

        from django.utils import timezone

        from hub import cleanup
        from hub.models import Activity, Approval, Sender
        other = Sender.objects.create(account='work', address='news@x.com', name='News', total=5)
        a = Approval.objects.create(kind='cleanup', status='approved', decided=timezone.now() - timedelta(minutes=1), title='Delete 905 emails from 2 senders',
                                    payload={'action': 'trash_senders', 'senders': [self.promo.pk, other.pk], 'unsubscribe': []})

        def one_per_run(key, senders, action, deadline=None):  # time runs out after one sender
            Sender.objects.filter(pk=senders[0].pk).update(done='deleted', total=0)
        with patch.object(cleanup, 'run', side_effect=one_per_run):
            cleanup.due()
            a.refresh_from_db()
            self.assertIsNone(a.sent_at)
            cleanup.due()
        a.refresh_from_db()
        self.assertIsNotNone(a.sent_at)
        self.assertTrue(Activity.objects.filter(text='Deleted 905 emails from 2 senders').exists())

    def test_protected_mail_never_goes_with_its_sender(self):
        from unittest.mock import MagicMock, patch

        from hub import cleanup
        imap = MagicMock()
        imap.uid.return_value = ('OK', [b'1 2'])
        imap.list.return_value = ('OK', [])
        with patch.object(cleanup.mail, 'open_inbox') as box:
            box.return_value.__enter__.return_value = imap
            cleanup.run('work', [self.promo], 'trash')
        search = next(c for c in imap.uid.call_args_list if c.args[0] == 'SEARCH')
        self.assertIn('from:deals@shop.com', search.args[2])
        self.assertIn('-label:^smartlabel_receipt', search.args[2])
        self.assertIn('-category:reservations', search.args[2])


class ReceiptTests(TestCase):
    def mail(self, uid, subject, hours_ago):
        from datetime import timedelta

        from django.utils import timezone
        return {'uid': uid, 'sender': 'Shop <orders@shop.com>', 'title': subject, 'body': '...', 'published': timezone.now() - timedelta(hours=hours_ago)}

    def test_packages_follow_the_latest_email(self):
        from unittest.mock import patch

        from hub import receipts
        out = iter([
            {'kind': 'shipment', 'item': 'Desk lamp', 'merchant': 'Shop', 'status': 'shipped', 'eta': '', 'renews_on': '', 'amount': None},
            {'kind': 'shipment', 'item': 'Desk lamp', 'merchant': 'Shop', 'status': 'out_for_delivery', 'eta': '', 'renews_on': '', 'amount': None},
            {'kind': 'shipment', 'item': 'Shoes', 'merchant': 'Shop', 'status': 'delivered', 'eta': '', 'renews_on': '', 'amount': None},
            {'kind': 'other', 'item': '', 'merchant': 'Shop', 'status': 'none', 'eta': '', 'renews_on': '', 'amount': None},
        ])
        with patch.object(receipts.triage, 'ollama_json', side_effect=lambda *a: next(out)):
            receipts.read('personal', self.mail('a', 'Shipped', 30))
            receipts.read('personal', self.mail('b', 'Out for delivery', 2))
            receipts.read('personal', self.mail('c', 'Delivered', 50))
            receipts.read('personal', self.mail('d', '20% off', 1))
            self.assertIsNone(receipts.read('personal', self.mail('a', 'Shipped', 30)))  # read once
        self.assertEqual([(p['item'], p['status'], p['progress']) for p in receipts.packages()], [('Desk lamp', 'Out for delivery', .88)])

    def test_renewals_this_week_only(self):
        from datetime import timedelta

        from django.utils import timezone

        from hub import receipts
        from hub.models import Receipt
        today = timezone.localdate()
        for uid, merchant, days in [('1', 'Spotify', 2), ('2', 'Spotify', 2), ('3', 'Adobe', 20), ('4', 'iCloud', -1)]:
            Receipt.objects.create(account='personal', uid=uid, received=timezone.now(), kind='renewal', merchant='Google Play', item=f'{merchant} Premium', renews_on=today + timedelta(days=days), amount=11.99)
        self.assertEqual([(r['name'], r['amount']) for r in receipts.renewals()], [('Spotify Premium', 11.99)])
        # a notice without a price borrows the last receipt's; a hidden one never shows
        Receipt.objects.create(account='personal', uid='5', received=timezone.now(), kind='renewal', merchant='Google Play', item='Duolingo', renews_on=today + timedelta(days=3))
        Receipt.objects.create(account='personal', uid='6', received=timezone.now() - timedelta(days=30), kind='purchase', merchant='Google Play', item='duolingo', amount=9.99)
        self.assertIn(('Duolingo', 9.99), [(r['name'], r['amount']) for r in receipts.renewals()])
        from hub.models import Setting
        Setting.objects.create(key='hidden_renewals', value=['spotify premium'])
        self.assertEqual([r['name'] for r in receipts.renewals()], ['Duolingo'])
        Receipt.objects.create(account='personal', uid='cancel-1', received=timezone.now() + timedelta(minutes=1), kind='cancelled', merchant='Google Play', item='Duolingo')
        self.assertEqual(receipts.renewals(), [])  # cancelled after the renewal notice

    def test_reply_zero_streak(self):
        from datetime import date

        from hub import receipts
        wed = date(2026, 10, 7)
        for d, n in [(4, 0), (5, 0), (6, 2)]:
            receipts.note_replies(n, date(2026, 10, d))
        receipts.note_replies(0, date(2026, 10, 6))  # cleared later that day
        receipts.note_replies(3, date(2026, 10, 7))
        self.assertEqual(receipts.streak(wed), {'days': 3, 'week': [True, True, False, False, False, False, False]})
        receipts.note_replies(0, wed)
        self.assertEqual(receipts.streak(wed)['days'], 4)


class PrivateModelTests(TestCase):
    def test_private_data_goes_to_gemini_only_when_allowed(self):
        from unittest.mock import patch

        from hub import triage
        from hub.models import Setting
        with self.settings(LIFEHUB={'gemini_api_key': 'k'}), patch.object(triage, 'gemini_json', return_value={'a': 1}) as gem, \
                patch.object(triage, 'ollama_json', return_value={'a': 2}):
            self.assertEqual(triage.private_json('s', 'u', {}), ({'a': 2}, 'ollama'))  # off by default
            Setting.objects.create(key='gemini_private', value=True)
            self.assertEqual(triage.private_json('s', 'u', {}), ({'a': 1}, 'gemini'))
            gem.side_effect = OSError('down')
            self.assertEqual(triage.private_json('s', 'u', {}), ({'a': 2}, 'ollama'))  # falls back
        with self.settings(LIFEHUB={}), patch.object(triage, 'ollama_json', return_value={'a': 2}):
            self.assertEqual(triage.private_json('s', 'u', {})[1], 'ollama')  # switch on but no key

    def test_open_slots_skip_meetings(self):
        from datetime import date, datetime
        from zoneinfo import ZoneInfo

        from hub import agenda
        tz = ZoneInfo('America/Toronto')
        ev = lambda h1, m1, h2, m2: {'start': datetime(2026, 10, 8, h1, m1, tzinfo=tz).isoformat(), 'end': datetime(2026, 10, 8, h2, m2, tzinfo=tz).isoformat(), 'allDay': False}
        got = agenda.gaps([ev(9, 0, 10, 0), ev(10, 15, 12, 0), ev(16, 45, 18, 0)], date(2026, 10, 8))
        self.assertEqual([(s.hour, s.minute, e.hour, e.minute) for s, e in got], [(12, 0, 16, 45)])  # 10:00-10:15 is too short


class PermissionTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        self.client.force_login(User.objects.create_user('me', password='pw'))

    def test_settings_change_a_permission_and_the_panel_obeys(self):
        from unittest.mock import patch

        from hub import agent
        from hub.models import Task
        r = self.client.post('/api/settings/', data=json.dumps({'permissions': {'tasks': 'never', 'reply': 'sometimes'}}), content_type='application/json').json()
        self.assertEqual((r['permissions']['tasks'], r['permissions']['reply']), ('never', 'ask first'))  # unknown values are ignored
        replies = iter([{'role': 'assistant', 'content': '', 'tool_calls': [{'function': {'name': 'add_task', 'arguments': {'text': 'Pay rent'}}}]},
                        {'role': 'assistant', 'content': 'Done.'}])
        with patch.object(agent, 'call_ollama', side_effect=lambda m: next(replies)):
            events = list(agent.ask('remind me to pay rent'))
        self.assertFalse(Task.objects.exists())
        self.assertIn({'step': 'Skipped add task: turned off in Settings', 'ok': False}, events)

    def test_gemini_needs_the_private_switch_and_replays_its_own_turns(self):
        from hub import agent
        self.assertIn('error', next(agent.ask('anything', 'gemini')))
        msgs = [{'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'q'},
                {'role': 'assistant', 'parts': [{'functionCall': {'name': 'tasks', 'args': {}}, 'thoughtSignature': 'abc'}, {'functionCall': {'name': 'news', 'args': {}}}]},
                {'role': 'tool', 'tool_name': 'tasks', 'content': '[]'}, {'role': 'tool', 'tool_name': 'news', 'content': '[]'}]
        got = agent.gemini_contents(msgs)
        self.assertEqual([c['role'] for c in got], ['user', 'model', 'user'])
        self.assertEqual(got[1]['parts'][0]['thoughtSignature'], 'abc')
        self.assertEqual([p['functionResponse']['name'] for p in got[2]['parts']], ['tasks', 'news'])


class ConnectionTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        self.client.force_login(User.objects.create_user('me', password='pw'))

    def post(self, body):
        return self.client.post('/api/connections/', data=json.dumps(body), content_type='application/json')

    def test_edits_win_over_the_file_and_secrets_never_come_back(self):
        from django.conf import settings
        r = self.post({'kind': 'email', 'op': 'save', 'data': {'name': 'Side', 'user': 'me@side.com', 'password': 'app-pass-1'}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(settings.LIFEHUB.get('email')[-1]['password'], 'app-pass-1')  # every process reads it from here now
        page = self.client.get('/api/connections/').content.decode()
        self.assertNotIn('app-pass-1', page)
        side = next(x for x in json.loads(page)['email'] if x['name'] == 'Side')
        self.assertEqual((side['account'], side['hasPassword'], side['host']), ('side', True, 'imap.gmail.com'))
        # a blank password keeps the stored one; the account key never changes (mail is filed under it)
        self.post({'kind': 'email', 'op': 'save', 'original': 'Side', 'data': {'name': 'Side job', 'account': 'other', 'user': 'me@side.com', 'password': ''}})
        row = next(x for x in settings.LIFEHUB.get('email') if x['name'] == 'Side job')
        self.assertEqual((row['password'], row['account']), ('app-pass-1', 'side'))
        self.post({'kind': 'email', 'op': 'remove', 'original': 'Side job'})
        self.assertFalse(any(x['name'] == 'Side job' for x in settings.LIFEHUB.get('email')))

    def test_bad_input_is_refused(self):
        self.assertIn('https', self.post({'kind': 'feed', 'op': 'save', 'data': {'name': 'X', 'url': 'javascript:alert(1)'}}).json()['error'])
        self.assertIn('@', self.post({'kind': 'email', 'op': 'save', 'data': {'name': 'X', 'user': 'nope', 'password': 'p'}}).json()['error'])
        self.post({'kind': 'feed', 'op': 'save', 'data': {'name': 'CBC', 'url': 'https://cbc.ca/rss', 'topic': 'World'}})
        self.assertIn('already', self.post({'kind': 'feed', 'op': 'save', 'data': {'name': 'CBC', 'url': 'https://cbc.ca/2'}}).json()['error'])
        cal = self.post({'kind': 'calendar', 'op': 'save', 'data': {'name': 'Gym', 'url': 'https://calendar.google.com/calendar/ical/secret123/basic.ics'}})
        self.assertNotIn('secret123', self.client.get('/api/connections/').content.decode())
        self.assertEqual(cal.status_code, 200)


class ReadableTests(SimpleTestCase):
    def test_email_bodies_keep_their_shape(self):
        from hub.sources import readable
        html = ('<html><head><style>.x{color:red}</style></head><body><p>Hi Sam,</p><p>Your order&nbsp;shipped.\u200b</p>'
                '<ul><li>Lamp</li><li>Desk</li></ul><a href="https://click.example.com/ls/click?upn=' + 'a' * 60 + '">Track it</a><br>------<br>Thanks</body></html>')
        self.assertEqual(readable(html, True), 'Hi Sam,\n\nYour order shipped.\n\n• Lamp\n• Desk\n\nTrack it\nThanks')
        self.assertEqual(readable('Sale ( http://clicks.shop.com/ls/click?upn=' + 'b' * 50 + ' )\r\n\n\n\nBye'), 'Sale\n\nBye')


class PriceTests(TestCase):
    LD = '''<script type="application/ld+json">{"@graph": [{"@type": ["Product"], "name": "Dock",
    "offers": {"@type": "Offer", "price": "1,249.99", "priceCurrency": "CAD", "availability": "https://schema.org/OutOfStock"}}]}</script>'''

    def test_json_ld(self):
        from hub.prices import from_ld
        self.assertEqual(from_ld(self.LD), {'price': 1249.99, 'currency': 'CAD', 'inStock': False, 'title': 'Dock'})
        self.assertIsNone(from_ld('<script type="application/ld+json">{"@type": "Organization"}</script>'))

    def test_best_buy_sku(self):
        from hub.prices import BESTBUY
        self.assertEqual(BESTBUY.search('https://www.bestbuy.ca/en-ca/product/sony-wh-1000xm5-black/17540636?x=1')[1], '17540636')
        self.assertEqual(BESTBUY.search('https://www.bestbuy.ca/en-ca/product/17540636')[1], '17540636')

    def checked(self, target, reads, best=None):
        from unittest.mock import patch
        from hub import prices
        from hub.models import Activity, Watch
        w = Watch.objects.create(name='Dock', target=target, best=best, sources=[
            {'url': 'https://a.ca/x', 'store': 'a.ca', 'price': 300, 'inStock': False}, {'url': 'https://b.ca/x', 'store': 'b.ca'}])
        with patch.object(prices, 'read', side_effect=reads):
            prices.check(w)
        return w, list(Activity.objects.values_list('text', flat=True))

    def test_restock_and_new_low(self):
        w, alerts = self.checked(None, [{'price': 250, 'currency': 'CAD', 'inStock': True, 'title': ''}, OSError('blocked')], best=280)
        self.assertEqual(w.best, 250)
        self.assertEqual(sorted(alerts), ['Dock dropped to $250.00 at a.ca', 'Dock is back in stock at a.ca'])
        self.assertEqual(w.sources[1]['error'], 'blocked')

    def test_target_alerts_once(self):
        read = {'price': 190, 'currency': 'CAD', 'inStock': True, 'title': ''}
        w, alerts = self.checked(200, [OSError('x'), read], best=210)
        self.assertEqual(alerts, ['Dock dropped to $190.00 at b.ca'])
        _, alerts = self.checked(200, [OSError('x'), read], best=195)
        self.assertEqual(len(alerts), 1)  # already under the target: no second alert

    def test_save_rejects_non_web_links(self):
        from django.contrib.auth.models import User
        self.client.force_login(User.objects.create_user('g'))
        r = self.client.post('/api/prices/', {'name': 'Dock', 'urls': ['file:///etc/passwd']}, content_type='application/json')
        self.assertEqual(r.status_code, 400)

    def test_matches(self):
        from hub.prices import matches
        name = 'Sony WH-1000XM5'
        self.assertTrue(matches(name, 'Sony WH1000XM5 Premium Headphones, Black | Carrying Case'))
        self.assertFalse(matches(name, 'Hard Case for Sony WH-1000XM5'))
        self.assertFalse(matches(name, 'Open Box - Sony WH-1000XM5 Headphones'))
        self.assertFalse(matches(name, 'Sony WH-1000XM6 Headphones'))

    def test_wrong_found_seller_is_dropped(self):
        from unittest.mock import patch
        from hub import prices
        from hub.models import Watch
        w = Watch.objects.create(name='Sony WH-1000XM5', sources=[
            {'url': 'https://a.ca/x', 'store': 'a.ca'}, {'url': 'https://b.ca/x', 'store': 'b.ca', 'auto': True}, {'url': 'https://c.ca/x', 'store': 'c.ca', 'auto': True}])
        read = {'price': 300, 'currency': 'CAD', 'inStock': True, 'title': 'Sony WH-1000XM5'}
        with patch.object(prices, 'read', side_effect=[read, {**read, 'title': 'Case for Sony WH-1000XM5'}, OSError('blocked')]):
            prices.check(w)
        self.assertEqual([s['store'] for s in w.sources], ['a.ca'])
        self.assertEqual(w.skipped, ['https://b.ca/x', 'https://c.ca/x'])
        with patch.object(prices, 'bestbuy_search', return_value=['https://b.ca/x', 'https://d.ca/x']), patch.object(prices, 'find', side_effect=RuntimeError('quota')), \
                patch.object(prices, 'canadacomputers_search', return_value=['https://cc.ca/x']):
            prices.discover(w)
        self.assertEqual([s['store'] for s in w.sources], ['a.ca', 'd.ca', 'cc.ca'])

    def test_found_store_in_another_currency_is_dropped(self):
        from unittest.mock import patch
        from hub import prices
        from hub.models import Watch
        w = Watch.objects.create(name='KAMRUI E3B', sources=[{'url': 'https://bestbuy.ca/x', 'store': 'bestbuy.ca'}, {'url': 'https://kamrui.store/e3b', 'store': 'kamrui.store', 'auto': True}])
        read = {'price': 659, 'currency': 'CAD', 'inStock': True, 'title': 'KAMRUI E3B'}
        with patch.object(prices, 'read', side_effect=[read, {**read, 'price': 399, 'currency': 'USD'}]):
            prices.check(w)
        self.assertEqual((w.best, [s['store'] for s in w.sources], w.skipped), (659, ['bestbuy.ca'], ['https://kamrui.store/e3b']))

    def test_canadacomputers_search(self):
        from unittest.mock import patch
        from hub import prices
        html = '''<script type="application/ld+json">{"@type": "ItemList", "itemListElement": [
          {"@type": "ListItem", "name": "Beelink SER8 Ryzen 7 8745HS 32GB", "url": "https://www.canadacomputers.com/en/mini-pcs/1/beelink-ser8.html"},
          {"@type": "ListItem", "name": "GIGABYTE BRIX Intel N150", "url": "https://www.canadacomputers.com/en/mini-pcs/2/brix.html"}]}</script>'''
        with patch.object(prices, 'page', return_value=html):
            self.assertEqual(prices.canadacomputers_search('Beelink SER8'), ['https://www.canadacomputers.com/en/mini-pcs/1/beelink-ser8.html'])


class WeeklyEmailTests(TestCase):
    def at(self, s):
        from datetime import datetime

        from django.utils import timezone
        return timezone.make_aware(datetime.fromisoformat(s))

    def test_week_ends_at_the_last_sunday_after_8(self):
        from hub import weekly
        self.assertEqual(weekly.week_end(self.at('2026-11-15 09:00')).date().isoformat(), '2026-11-15')  # Sunday
        self.assertEqual(weekly.week_end(self.at('2026-11-15 07:00')).date().isoformat(), '2026-11-08')
        self.assertEqual(weekly.week_end(self.at('2026-11-10 12:00')).date().isoformat(), '2026-11-08')  # Tuesday

    def test_build_keeps_last_week_for_the_trend_and_marks_the_week_done(self):
        from unittest.mock import patch

        from hub import weekly
        accounts = [{'name': 'Work', 'account': 'work'}, {'name': 'Personal'}]
        counts = iter([{'received': 80, 'sent': 5, 'unread': 3, 'top': []}, OSError('down'),
                       {'received': 100, 'sent': 6, 'unread': 1, 'top': []}, OSError('down')])

        def fake(account, start, end):
            c = next(counts)
            if isinstance(c, Exception):
                raise c
            return c
        with self.settings(LIFEHUB={'email': accounts}), patch.object(weekly, 'account_week', side_effect=fake):
            self.assertTrue(weekly.due(self.at('2026-11-08 09:00')))
            weekly.build(self.at('2026-11-08 09:00'))
            self.assertFalse(weekly.due(self.at('2026-11-14 23:00')))
            self.assertTrue(weekly.due(self.at('2026-11-15 08:30')))
            s = weekly.build(self.at('2026-11-15 08:30'))
        work, personal = s['accounts']
        self.assertEqual((work['received'], work['receivedBefore']), (100, 80))
        self.assertEqual((personal['key'], personal['error']), ('personal', 'down'))
        self.assertEqual(s['weekStart'][:10], '2026-11-08')


class MailWeekTests(TestCase):
    def test_days_oldest_first_with_last_week_total(self):
        from datetime import datetime
        from unittest.mock import patch

        from django.contrib.auth.models import User
        from django.utils import timezone

        from hub import weekly
        spans = []

        def fake(account, bounds):
            spans.append(bounds)
            return [(70, 9)] + [(i, 1) for i in range(1, 8)]
        now = timezone.make_aware(datetime(2026, 11, 11, 15, 0))
        with self.settings(LIFEHUB={'email': [{'name': 'Work'}, {'name': 'Personal'}]}), patch.object(weekly, 'account_days', side_effect=fake):
            self.assertTrue(weekly.days_due())
            weekly.build_days(now)
            self.assertFalse(weekly.days_due())
        self.assertEqual((len(spans), len(spans[0]), spans[0][-1].date().isoformat()), (2, 9, '2026-11-12'))
        self.client.force_login(User.objects.create_user('me', password='pw'))
        d = self.client.get('/api/tiles/mailweek/').json()['data']
        self.assertEqual((d['days'][0], d['days'][-1]['date']), ({'date': '2026-11-05', 'received': 2, 'answered': 2}, '2026-11-11'))
        self.assertEqual((d['received'], d['answered'], d['lastWeekReceived']), (56, 14, 140))


class CleanupBatchTests(TestCase):
    def test_stamps_for_one_account_share_one_gmail_pass(self):
        from datetime import timedelta
        from unittest.mock import patch
        from django.utils import timezone
        from hub import cleanup
        from hub.models import Approval, Sender
        a, b = (Sender.objects.create(account='personal', address=f'{n}@x.com', total=3) for n in 'ab')
        for s in (a, b):
            Approval.objects.create(kind='cleanup', title=f'Delete 3 emails from {s.address}', status='approved', decided=timezone.now() - timedelta(minutes=1),
                                    payload={'action': 'trash_senders', 'senders': [s.pk]})
        done = lambda key, senders, action, deadline=None: Sender.objects.filter(pk__in=[x.pk for x in senders]).update(done='deleted', total=0)
        with patch.object(cleanup, 'run', side_effect=done) as run:
            cleanup.due()
        run.assert_called_once()
        self.assertEqual([x.pk for x in run.call_args.args[1]], [a.pk, b.pk])
        self.assertFalse(Approval.objects.filter(sent_at__isnull=True).exists())


class FetchBackoffTests(TestCase):
    def test_rate_limit_backs_off_without_retrying_and_resets_on_success(self):
        import io
        import urllib.error
        from datetime import timedelta
        from email.message import Message
        from unittest.mock import patch
        from django.utils import timezone
        from hub.management.commands import fetch
        from hub.models import Item, SourceStatus
        cmd = fetch.Command(stdout=io.StringIO(), stderr=io.StringIO())
        calls = []

        def limited(headers=None):
            def go():
                calls.append(1)
                h = Message()
                for k, v in (headers or {}).items():
                    h[k] = v
                raise urllib.error.HTTPError('https://reddit.com/r/x/.rss', 429, 'Too Many Requests', h, None)
            return go
        with patch.object(fetch.time, 'sleep'):
            self.assertIsNone(cmd.pull('r/x', Item.NEWS, limited(), replace=False))
        self.assertEqual(len(calls), 1)  # a 429 isn't retried on the spot
        s = SourceStatus.objects.get(source='r/x')
        self.assertEqual(s.fails, 1)
        self.assertAlmostEqual((s.retry_at - timezone.now()).total_seconds(), 1800, delta=5)
        cmd.pull('r/x', Item.NEWS, limited(), replace=False)
        s.refresh_from_db()
        self.assertAlmostEqual((s.retry_at - timezone.now()).total_seconds(), 3600, delta=5)  # doubling
        cmd.pull('r/x', Item.NEWS, limited({'Retry-After': '120'}), replace=False)
        s.refresh_from_db()
        self.assertAlmostEqual((s.retry_at - timezone.now()).total_seconds(), 120, delta=5)  # the server's own ask wins
        self.assertEqual(fetch.backoff(urllib.error.HTTPError('u', 429, '', Message(), None), 9), timedelta(hours=4))  # capped
        cmd.pull('r/x', Item.NEWS, lambda: [], replace=False)
        s.refresh_from_db()
        self.assertEqual((s.fails, s.retry_at, s.error), (0, None, ''))


class FetchPacingTests(TestCase):
    def test_every_waits_out_the_slot_even_when_the_run_fails(self):
        from unittest import mock
        from hub.management.commands import fetch
        with mock.patch.object(fetch.Command, 'run', side_effect=RuntimeError), \
                mock.patch.object(fetch.time, 'monotonic', side_effect=[0, 40]), \
                mock.patch.object(fetch.time, 'sleep') as sleep, self.assertRaises(RuntimeError):
            fetch.Command().handle(every=300)
        sleep.assert_called_once_with(260)

    def test_no_every_no_wait(self):
        from unittest import mock
        from hub.management.commands import fetch
        with mock.patch.object(fetch.Command, 'run'), mock.patch.object(fetch.time, 'sleep') as sleep:
            fetch.Command().handle()
        sleep.assert_not_called()


class NinetyDayLowTests(TestCase):
    def check(self, history, target, price):
        from datetime import timedelta
        from unittest.mock import patch
        from django.utils import timezone
        from hub import prices
        from hub.models import Activity, Watch
        day = lambda n: (timezone.localdate() - timedelta(days=n)).isoformat()
        w = Watch.objects.create(name='Dock', target=target, best=history[-1][1] if history else None,
                                 history=[[day(n), p] for n, p in history], sources=[{'url': 'https://a.ca/x', 'store': 'a.ca'}])
        with patch.object(prices, 'read', return_value={'price': price, 'currency': 'CAD', 'inStock': True, 'title': 'Dock'}):
            prices.check(w)
        return w, list(Activity.objects.values_list('text', flat=True))

    def test_new_low_over_enough_days_alerts_even_above_target(self):
        w, alerts = self.check([(30, 300), (10, 280)], target=200, price=270)
        self.assertEqual(alerts, ['Dock is at its lowest in 90 days: $270.00 at a.ca'])
        self.assertEqual(w.history[-1][1], 270)

    def test_drop_message_notes_the_low(self):
        _, alerts = self.check([(30, 300), (10, 280)], target=None, price=270)
        self.assertEqual(alerts, ['Dock dropped to $270.00 at a.ca · lowest in 90 days'])

    def test_too_little_history_or_not_lower_stays_quiet(self):
        self.assertEqual(self.check([(3, 300)], target=200, price=250)[1], [])
        self.assertEqual(self.check([(30, 260)], target=200, price=270)[1], [])

    def test_history_keeps_90_days_one_low_per_day(self):
        w, _ = self.check([(120, 100), (5, 300), (0, 280)], target=None, price=290)
        from hub import prices
        self.assertEqual([p for _, p in w.history], [300, 280])
        self.assertEqual(prices.low90(w), 280)


class SearchTests(TestCase):
    def setUp(self):
        from django.contrib.auth.models import User
        from django.utils import timezone
        from hub.models import Item, Note, Task
        self.client.force_login(User.objects.create_user('me', password='pw'))
        now = timezone.now()
        Item.objects.create(kind=Item.EMAIL, source='Work', uid='1', title='Dentist booking', sender='Maya <m@x.ca>', published=now)
        Item.objects.create(kind=Item.NEWS, source='CBC', uid='2', title='New dentist rules', url='https://cbc.ca/a', published=now)
        Task.objects.create(text='Call the dentist')
        Note.objects.create(title='Health', body='dentist is on Bloor')
        Item.objects.create(kind=Item.EMAIL, source='Work', uid='3', title='Lunch', published=now)

    def test_matches_each_kind(self):
        items = self.client.get('/api/search/?q=DENTIST').json()['items']
        self.assertEqual([i['kind'] for i in items], ['mail', 'todo', 'note', 'news'])
        self.assertEqual(items[0]['detail'], 'Maya')
        self.assertTrue(items[0]['url'].startswith('/inbox?id='))

    def test_short_query_and_login(self):
        self.assertEqual(self.client.get('/api/search/?q=d').json()['items'], [])
        self.client.logout()
        self.assertEqual(self.client.get('/api/search/?q=dentist').status_code, 302)


class HangGuardTests(TestCase):
    def test_fetch_sets_and_clears_the_watchdog(self):
        from unittest import mock
        from hub.management.commands import fetch
        with mock.patch.object(fetch.Command, 'run'), mock.patch.object(fetch.signal, 'alarm') as alarm:
            fetch.Command().handle()
        self.assertEqual(alarm.call_args_list, [mock.call(fetch.MAX_RUN_S), mock.call(0)])


class LearnTests(TestCase):
    def card(self, day, **kw):
        from hub.models import LearnCard
        return LearnCard.objects.create(day=day, term=kw.pop('term', f't{day}'), kind='Concept', summary='s', body='b', **kw)

    def test_review_schedule_and_streak(self):
        from datetime import timedelta
        from django.utils import timezone
        from hub import learn
        t = timezone.localdate()
        c = self.card(t)
        learn.mark(c, 'review')
        self.assertEqual((c.review_due, c.review_round), (t + timedelta(days=3), 1))
        learn.mark(c, 'review')
        learn.mark(c, 'review')
        learn.mark(c, 'review')
        self.assertEqual(c.review_due, t + timedelta(days=30))  # stays monthly after the third
        learn.mark(c, 'known')
        self.assertEqual((c.status, c.review_due), ('known', None))
        self.assertEqual(learn.streak([t, t - timedelta(days=1), t - timedelta(days=3)]), 2)
        self.assertEqual(learn.streak([t - timedelta(days=1)]), 1)  # today's not read yet doesn't break it

    def test_next_term_skips_covered(self):
        from hub import learn
        self.assertEqual(learn.next_term({learn.CURRICULUM[0].lower()}), learn.CURRICULUM[1])

    def test_page_links_known_terms(self):
        from django.utils import timezone
        from hub import learn
        t = timezone.localdate()
        old = self.card(t - timezone.timedelta(days=1), term='Vector')
        self.card(t, term='Embedding', builds_on=['vector', 'Neural network'])
        p = learn.page()
        self.assertEqual(p['card']['buildsOn'], [{'name': 'vector', 'id': old.pk}, {'name': 'Neural network', 'id': None}])
        self.assertTrue(p['today'])

    def test_trending_skipped_day_after_trending(self):
        from unittest import mock
        from django.utils import timezone
        from hub import learn
        t = timezone.localdate()
        self.card(t - timezone.timedelta(days=1), trending=True)
        with mock.patch.object(learn, 'trending') as tr, mock.patch.object(learn, 'gemini_call', side_effect=RuntimeError):
            with self.assertRaises(RuntimeError):
                learn.write(t)
            tr.assert_not_called()


class WaitingTests(TestCase):
    def test_scan(self):
        from contextlib import contextmanager
        from datetime import timedelta
        from email.utils import format_datetime
        from unittest import mock

        from django.utils import timezone

        from hub import waiting
        from hub.models import SentMail

        old = format_datetime(timezone.now() - timedelta(days=5))
        edge = format_datetime(timezone.now() - timedelta(days=14, minutes=1))  # still inside SINCE's whole day
        older = format_datetime(timezone.now() - timedelta(days=6))
        newer = format_datetime(timezone.now() - timedelta(days=1))

        def head(**h):
            return ''.join(f'{k.replace("_", "-")}: {v}\r\n' for k, v in h.items()).encode() + b'\r\n'
        sent = {  # num: (thread, headers)
            b'1': ('100', head(Message_ID='<a1@me>', To='Eric <eric@x.com>', Subject='Budget?', Date=older)),
            b'2': ('100', head(Message_ID='<a2@me>', To='Eric <eric@x.com>', Subject='Re: Budget?', Date=old)),
            b'3': ('200', head(Message_ID='<b@me>', To='Ana <ana@x.com>', Subject='Thanks!', Date=old)),
            b'4': ('300', head(Message_ID='<c@me>', To='me@me.com', Subject='note to self', Date=old)),
            b'5': ('400', head(Message_ID='<d@me>', To='Bo <bo@x.com>', Subject='Contract', Date=old)),
            b'6': ('500', head(Message_ID='<e@me>', To='Cy <cy@x.com>', Subject='Quote?', Date=edge)),
        }
        threads = {'100': [(head(From='me@me.com', Date=old))], '400': [head(From='me@me.com', Date=old), head(From='Bo <bo@x.com>', Date=newer)]}

        class Imap:
            folder = ''

            def list(self):
                return 'OK', [b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"', b'(\\HasNoChildren \\All) "/" "[Gmail]/All Mail"']

            def select(self, f, readonly=False):
                self.folder = f

            def search(self, _, *crit):
                if crit[0] == 'X-GM-THRID':
                    return 'OK', [b' '.join(str(i).encode() for i in range(len(threads.get(crit[1], []))))]
                return 'OK', [b' '.join(sent)]

            def fetch(self, nums, what):
                out = []
                for n in nums.split(b','):
                    if 'All' in self.folder:
                        thread = self.last
                        out += [(b'x', threads[thread][int(n)]), b')']
                    elif 'X-GM-THRID' in what:
                        out += [(f'{n.decode()} (X-GM-THRID {sent[n][0]} BODY[] {{1}}'.encode(), sent[n][1]), b')']
                    else:
                        out += [(b'x (FLAGS () BODY[] {1}', sent[n][1] + b'Can you send it?'), b')']
                return 'OK', out

        imap = Imap()
        real_search = Imap.search

        def search(self, _, *crit):
            if crit[0] == 'X-GM-THRID':
                self.last = crit[1]
            return real_search(self, _, *crit)
        Imap.search = search

        @contextmanager
        def inbox(key, readonly=False):
            yield imap

        verdict = lambda system, user, schema, background=False: ({'expects': 'Thanks' not in user, 'summary': 'an answer'}, 'gemini')
        with mock.patch.object(waiting.mail, 'open_inbox', inbox), \
                mock.patch.object(waiting.mail, 'account_config', return_value={'user': 'me@me.com'}), \
                mock.patch.object(waiting, 'private_up', return_value=True), \
                mock.patch.object(waiting.triage, 'private_json', side_effect=verdict):
            self.assertEqual(waiting.scan('work'), 4)
        rows = {r.thread: r for r in SentMail.objects.all()}
        self.assertEqual(set(rows), {'100', '200', '400', '500'})  # mail to yourself skipped
        self.assertEqual(rows['100'].uid, 'a2@me')  # the newest send in the thread
        self.assertEqual((rows['200'].expects, rows['400'].replied, rows['100'].replied), (False, True, False))
        self.assertEqual([w['subject'] for w in waiting.waiting()], ['Quote?', 'Re: Budget?'])


class KeepOlderMailTests(SimpleTestCase):
    def test_older_mail_waiting_on_a_reply_survives_the_window(self):
        from unittest import mock
        from hub import sources

        class Imap:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def login(self, *a):
                pass

            def list(self):
                return 'OK', []  # no Sent folder: nothing answered

            def select(self, *a, **k):
                pass

            def search(self, _, *crit):
                if crit[0] == 'SINCE':
                    return 'OK', [b'']  # nothing new in the last few days
                return 'OK', [b'7' if crit[2] == '"old@x.com"' else b'']  # old@ still in the inbox, gone@ archived

            def fetch(self, nums, what):
                return 'OK', [(b'7 (FLAGS (\\Seen) BODY[HEADER.FIELDS (MESSAGE-ID)] {1}', b'x'), b')']

        with mock.patch.object(sources.imaplib, 'IMAP4_SSL', Imap):
            items = sources.fetch_email({'user': 'me@x.com', 'password': 'p'}, known={'old@x.com', 'gone@x.com'},
                                        keep={'old@x.com', 'gone@x.com', 'Mon, 1 Jan 2026Hi'})
        self.assertEqual(items, [{'uid': 'old@x.com', 'unread': False, 'answered': False, 'thread': ''}])


class ReplyAllTests(SimpleTestCase):
    def test_reply_to_and_everyone_else_on_the_email(self):
        import email as em
        from email.policy import default
        from hub.sources import recipients
        msg = em.message_from_string('From: Ana <ana@x.com>\nReply-To: team@x.com\nTo: Me <ME@me.com>, Bo <bo@x.com>\nCc: ana@x.com, cy@x.com, bo@x.com\n\nhi', policy=default)
        self.assertEqual(recipients(msg, 'me@me.com'), {'reply_to': 'team@x.com', 'others': 'bo@x.com, cy@x.com'})
        plain = em.message_from_string('From: Ana <ana@x.com>\nReply-To: Ana <ana@x.com>\nTo: me@me.com\n\nhi', policy=default)
        self.assertEqual(recipients(plain, 'me@me.com'), {'reply_to': '', 'others': ''})  # Reply-To = From is no news


class ConversationTests(TestCase):
    def test_same_subject_different_gmail_threads_are_different_conversations(self):
        from django.utils import timezone
        from hub import drafts
        from hub.models import Item
        mk = lambda uid, thread, answered, mins: Item.objects.create(kind='email', source='Work', uid=uid, title='Quick question', sender='a@x.com',
                                                                     account='work', group='needs_reply', unread=True, answered=answered,
                                                                     thread=thread, published=timezone.now() - timezone.timedelta(minutes=mins))
        ana = mk('1@x', '111', False, 5)   # Ana's, still waiting
        bo = mk('2@x', '222', True, 1)     # Bo's, newer and answered: by subject alone it settled Ana's too
        self.assertEqual(drafts.settled([ana, bo]), {bo.pk})
        old1, old2 = mk('3@x', '', True, 1), mk('4@x', '', False, 9)  # stored before thread ids: subject fallback
        self.assertIn(old2.pk, drafts.settled([old1, old2]))


class PolishTests(SimpleTestCase):
    def test_polish_goes_to_gemini_with_only_the_draft(self):
        from types import SimpleNamespace
        from unittest import mock
        from hub import drafts
        email = SimpleNamespace(sender='Ana <ana@x.com>', title='Private matter', body='my bank details', snippet='')
        with mock.patch.object(drafts.triage, 'gemini_text', return_value='Hi Ana, sounds good.\n\nSam') as g, \
                mock.patch.object(drafts, 'private_text') as private:
            self.assertEqual(drafts.rewrite('hi ana sounds good\n\nSam', 'polish', email), ('Hi Ana, sounds good.\n\nSam', 'gemini'))
        self.assertNotIn('bank details', g.call_args[0][1])  # the email being answered never leaves the house
        private.assert_not_called()


