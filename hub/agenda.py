"""Today's events from Google calendars' private iCal addresses (Settings > the calendar > Integrate calendar).

The secret address is read-only and needs no login, which is all the Today tile needs.
"""
import time as clock
import urllib.request
from datetime import date, datetime, time, timedelta

import icalendar
import recurring_ical_events
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from hub import events as telemetry

CACHE_S = 5 * 60


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'lifehub'}), timeout=20) as r:
        return r.read()


def events_on(ics, day, account):
    tz = timezone.get_current_timezone()
    start = datetime.combine(day, time.min, tz)
    out = []
    for ev in recurring_ical_events.of(icalendar.Calendar.from_ical(ics)).between(start, start + timedelta(days=1)):
        if str(ev.get('STATUS', '')).upper() == 'CANCELLED':
            continue
        s, e = ev.decoded('DTSTART'), ev.decoded('DTEND') if ev.get('DTEND') else None
        all_day = not isinstance(s, datetime)
        if all_day:
            s = datetime.combine(s, time.min, tz)
            e = datetime.combine(e, time.min, tz) if isinstance(e, date) else s + timedelta(days=1)
        else:
            s, e = s.astimezone(tz), (e or s + timedelta(hours=1)).astimezone(tz)
        out.append({
            'id': f"{ev.get('UID')}@{s.isoformat()}",
            'start': s.isoformat(), 'end': e.isoformat(),
            'title': str(ev.get('SUMMARY', '(no title)')),
            'where': str(ev.get('LOCATION', '')).split(',')[0][:80],
            'calendar': account,
            'allDay': all_day,
        })
    return out


def today():
    """Events today across every configured calendar; raises with the calendar's name when one can't be read."""
    cached = cache.get('calendar')
    if cached is not None:
        return cached
    day = timezone.localdate()
    events = []
    if not settings.LIFEHUB.get('calendar'):
        raise RuntimeError('No calendars connected yet.')
    t = clock.monotonic()
    for cal in settings.LIFEHUB.get('calendar', []):
        try:
            events += events_on(fetch(cal['url']), day, cal.get('account', cal['name'].lower()))
        except Exception as e:
            telemetry.record('fetch', 'calendar', telemetry.HERE, ms=telemetry.ms(t), ok=False, text=f"Calendar → Lifehub · {cal['name']} failed")
            raise RuntimeError(f"{cal['name']} calendar: {e}") from e
    telemetry.record('fetch', 'calendar', telemetry.HERE, count=len(events), ms=telemetry.ms(t), text=f'Calendar → Lifehub · {len(events)} events today')
    events.sort(key=lambda e: (not e['allDay'], e['start']))
    now = timezone.now()
    # the next thing still ahead of you is highlighted
    nxt = next((e for e in events if not e['allDay'] and datetime.fromisoformat(e['end']) > now), None)
    for e in events:
        e['highlight'] = e is nxt
    cache.set('calendar', events, CACHE_S)
    return events


WORK_HOURS = (9, 17)
SLOT = timedelta(minutes=30)


def gaps(events, day, hours=WORK_HOURS, now=None):
    """Open stretches of at least SLOT inside working hours on one day, around its timed events."""
    tz = timezone.get_current_timezone()
    start, end = datetime.combine(day, time(hours[0]), tz), datetime.combine(day, time(hours[1]), tz)
    if now:
        start = max(start, now)
    busy = sorted((datetime.fromisoformat(e['start']), datetime.fromisoformat(e['end'])) for e in events if not e['allDay'])
    out, at = [], start
    for s, e in busy + [(end, end)]:
        if s - at >= SLOT and at < end:
            out.append((at, min(s, end)))
        at = max(at, e)
    return out


def open_slots(days=5, limit=6):
    """Open times on the next few weekdays across every calendar, as short lines for a draft: 'Thu Oct 9, 10:00-11:30'."""
    cals = [(fetch(c['url']), c.get('account', c['name'].lower())) for c in settings.LIFEHUB.get('calendar', [])]
    if not cals:
        return []
    out, day, now = [], timezone.localdate(), timezone.localtime()
    while len(out) < limit and day <= timezone.localdate() + timedelta(days=days + 2):
        day += timedelta(days=1)
        if day.weekday() < 5:
            events = [e for ics, acct in cals for e in events_on(ics, day, acct)]
            out += [f"{s:%a %b %-d}, {s:%H:%M}-{e:%H:%M}" for s, e in gaps(events, day, now=now)]
    return out[:limit]
