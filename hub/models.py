from datetime import timedelta

from django.db import models
from django.utils import timezone


class Item(models.Model):
    EMAIL, NEWS = 'email', 'news'

    kind = models.CharField(max_length=10, choices=[(EMAIL, 'Email'), (NEWS, 'News')])
    source = models.CharField(max_length=100)
    uid = models.CharField(max_length=500)
    title = models.CharField(max_length=500)
    sender = models.CharField(max_length=300, blank=True)
    reply_to = models.CharField(max_length=300, blank=True)  # email: the Reply-To address, when it differs from From
    others = models.TextField(blank=True)  # email: everyone else on it (To + Cc, minus you and the sender), comma-separated
    thread = models.CharField(max_length=30, blank=True)  # email: Gmail's X-GM-THRID; blank on mail stored before it was read
    url = models.URLField(max_length=1000, blank=True)
    snippet = models.TextField(blank=True)
    unread = models.BooleanField(default=False)
    published = models.DateTimeField()
    topic = models.CharField(max_length=40, blank=True)  # news only: the feed's topic
    # email only
    account = models.CharField(max_length=20, blank=True)  # work | personal
    body = models.TextField(blank=True)  # plain text, trimmed; what the model reads
    bulk = models.BooleanField(default=False)  # mailing-list headers present
    answered = models.BooleanField(default=False)  # IMAP \\Answered: replied to from Gmail or from here
    group = models.CharField(max_length=20, blank=True)  # needs_reply | fyi | newsletter | receipt; blank = not sorted yet
    summary = models.CharField(max_length=300, blank=True)
    model = models.CharField(max_length=10, blank=True)

    class Meta:
        ordering = ['-published']
        constraints = [models.UniqueConstraint(fields=['source', 'uid'], name='unique_item')]

    def __str__(self):
        return f'{self.source}: {self.title}'


class Approval(models.Model):
    KINDS = ['email', 'calendar', 'post', 'cleanup', 'purchase']
    STATUSES = ['pending', 'approved', 'declined', 'edited']

    kind = models.CharField(max_length=20, choices=[(k, k) for k in KINDS])
    account = models.CharField(max_length=20, blank=True)
    title = models.CharField(max_length=300)
    detail = models.TextField(blank=True)
    reason = models.CharField(max_length=200, blank=True)
    payload = models.JSONField(default=dict)
    model = models.CharField(max_length=10, default='none')
    status = models.CharField(max_length=10, choices=[(s, s) for s in STATUSES], default='pending')
    created = models.DateTimeField(auto_now_add=True)
    decided = models.DateTimeField(null=True, blank=True)
    # email replies: the message being answered, and when the approved reply actually went out
    item = models.ForeignKey(Item, null=True, blank=True, on_delete=models.SET_NULL, related_name='drafts')
    sent_at = models.DateTimeField(null=True, blank=True)
    send_error = models.CharField(max_length=500, blank=True)

    class Meta:
        ordering = ['created']

    def __str__(self):
        return f'{self.status}: {self.title}'


class AuditRow(models.Model):
    """Every decision on an approval: what was proposed, what was final, who, when."""
    approval = models.ForeignKey(Approval, null=True, on_delete=models.SET_NULL, related_name='audit')
    title = models.CharField(max_length=300)
    action = models.CharField(max_length=20)
    proposed = models.JSONField()
    final = models.JSONField(null=True)
    by = models.CharField(max_length=150)
    at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-at']


class Activity(models.Model):
    at = models.DateTimeField(auto_now_add=True)
    text = models.CharField(max_length=300)
    via = models.CharField(max_length=50)
    model = models.CharField(max_length=10, default='none')
    approval = models.ForeignKey(Approval, null=True, blank=True, on_delete=models.SET_NULL)

    class Meta:
        ordering = ['-at']
        verbose_name_plural = 'activity'


class SourceStatus(models.Model):
    """Last fetch result per source, so a tile can say which account failed."""
    GRACE = timedelta(minutes=15)  # Wi-Fi blips for seconds at a time; only a lasting failure is shown

    source = models.CharField(max_length=100, unique=True)
    ok_at = models.DateTimeField(null=True)
    error = models.CharField(max_length=500, blank=True)
    fails = models.PositiveIntegerField(default=0)  # rate-limit answers in a row
    retry_at = models.DateTimeField(null=True, blank=True)  # rate-limited: leave it alone until then

    @property
    def failing(self):
        return bool(self.error) and (not self.ok_at or timezone.now() - self.ok_at > self.GRACE)


class Task(models.Model):
    text = models.CharField(max_length=300)
    source = models.CharField(max_length=200, blank=True)  # "from Maya's email", "added by you"
    due = models.DateField(null=True, blank=True)
    done = models.BooleanField(default=False)
    done_at = models.DateTimeField(null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)
    item = models.ForeignKey(Item, null=True, blank=True, on_delete=models.SET_NULL, related_name='tasks')
    # the email it came from, kept here because the inbox mirror only holds the last few days
    context = models.CharField(max_length=500, blank=True)
    url = models.URLField(max_length=1000, blank=True)
    repeat = models.CharField(max_length=10, blank=True, choices=[('daily', 'Daily'), ('weekly', 'Weekly'), ('monthly', 'Monthly')])
    snoozed = models.DateField(null=True, blank=True)  # hidden until this day

    class Meta:
        ordering = ['done', models.F('due').asc(nulls_last=True), 'created']

    @classmethod
    def active(cls):
        """Open and not snoozed past today."""
        return cls.objects.filter(done=False).exclude(snoozed__gt=timezone.localdate())

    def next_due(self):
        """The next due date after today, so ticking an overdue repeat doesn't leave it overdue."""
        import calendar

        today = timezone.localdate()
        start = self.due or today
        for n in range(1, 10000):
            if self.repeat == 'daily':
                d = start + timedelta(days=n)
            elif self.repeat == 'weekly':
                d = start + timedelta(weeks=n)
            else:  # from the start's day each time, so the 31st doesn't drift to the 28th
                y, m = divmod(start.month - 1 + n, 12)
                y += start.year
                d = start.replace(year=y, month=m + 1, day=min(start.day, calendar.monthrange(y, m + 1)[1]))
            if d > today:
                return d

    @classmethod
    def from_email(cls, item, text, due=None):
        from email.utils import parseaddr
        who = parseaddr(item.sender)[0] or parseaddr(item.sender)[1]
        return cls.objects.create(
            text=text[:300], due=due, item=item, url=item.url,
            source=f"from {who.split()[0] if who else 'an'}'s email",
            context=f'{item.sender} · {item.account} · “{item.title}” · {item.summary or item.snippet}'[:500],
        )


class SentMail(models.Model):
    """Your newest sent message in each recent Gmail conversation, and whether the other side has answered."""
    account = models.CharField(max_length=20)
    thread = models.CharField(max_length=30)  # Gmail X-GM-THRID
    uid = models.CharField(max_length=500)  # Message-ID
    to = models.CharField(max_length=300)
    subject = models.CharField(max_length=500)
    sent_at = models.DateTimeField()
    url = models.URLField(max_length=1000, blank=True)
    expects = models.BooleanField(null=True)  # does it ask for an answer? None = not read yet
    summary = models.CharField(max_length=200, blank=True)  # what you're waiting for
    replied = models.BooleanField(default=False)
    dismissed = models.BooleanField(default=False)

    class Meta:
        ordering = ['sent_at']
        constraints = [models.UniqueConstraint(fields=['account', 'thread'], name='unique_sent_thread')]


class Note(models.Model):
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated']


class NewsBrief(models.Model):
    """The two or three sentences at the top of the News tile."""
    text = models.TextField()
    written = models.DateTimeField(auto_now_add=True)
    model = models.CharField(max_length=10)
    sources = models.JSONField(default=list)

    class Meta:
        ordering = ['-written']


class DayBrief(models.Model):
    """The day brief at the top of the page, written from mail, calendar and tasks."""
    text = models.TextField()
    written = models.DateTimeField(auto_now_add=True)
    model = models.CharField(max_length=10)
    basis = models.TextField(blank=True)  # the facts it was written from

    class Meta:
        ordering = ['-written']


class Setting(models.Model):
    """Settings changed from the Settings panel; anything not set here falls back to lifehub.toml."""
    key = models.CharField(max_length=50, unique=True)
    value = models.JSONField()

    @classmethod
    def get(cls, key, default=None):
        from django.conf import settings
        row = cls.objects.filter(key=key).first()
        return row.value if row else settings.LIFEHUB.get(key, default)


# what Lifehub may do on its own (the fetch run and the command panel), set in Settings > permissions.cpl; your own
# clicks aren't limited by these. Sending, deleting and unsubscribing always wait for a stamp; 'never' turns them off.
PERMISSIONS = {
    'sort': ('allowed', ['allowed', 'never']),  # sort, mark read and archive email
    'tasks': ('allowed', ['allowed', 'never']),  # create to-dos (from email or when asked) and notes
    'reply': ('ask first', ['ask first', 'never']),  # draft replies for your stamp
    'delete': ('ask first', ['ask first', 'never']),  # queue deletions for your stamp
}


def permission(key):
    value = (Setting.get('permissions') or {}).get(key)
    return value if value in PERMISSIONS[key][1] else PERMISSIONS[key][0]


def allowed(key):
    return permission(key) != 'never'


class Sender(models.Model):
    """One sender in an inbox, for Cleanup: how much they send, and what Ollama suggests doing with it."""
    SUGGESTIONS = ['keep', 'read', 'file', 'archive', 'delete']

    account = models.CharField(max_length=20)
    address = models.CharField(max_length=300)
    name = models.CharField(max_length=300, blank=True)
    total = models.IntegerField(default=0)  # in the inbox
    unread = models.IntegerField(default=0)
    protected = models.IntegerField(default=0)  # their receipts, tickets and statements: kept aside, never in total
    category = models.CharField(max_length=20, blank=True)  # Gmail tab most of their mail lands in
    bulk = models.BooleanField(default=False)
    subjects = models.JSONField(default=list)  # newest few
    replied = models.BooleanField(default=False)  # you have written to them
    unsubscribe = models.URLField(max_length=1000, blank=True)  # one-click (RFC 8058) only
    unsubscribe_link = models.CharField(max_length=1000, blank=True)  # anything else, for you to open
    suggestion = models.CharField(max_length=10, blank=True)
    reason = models.CharField(max_length=200, blank=True)
    folder = models.CharField(max_length=100, blank=True)  # for 'file': a Gmail label, existing or proposed
    model = models.CharField(max_length=10, blank=True)
    done = models.CharField(max_length=200, blank=True)  # working:<action> | marked read | archived | deleted | kept | failed: ...
    queued_at = models.DateTimeField(null=True, blank=True)  # when a read/archive/file was started, so a run killed midway gets finished

    class Meta:
        ordering = ['-total']
        constraints = [models.UniqueConstraint(fields=['account', 'address'], name='unique_sender')]


class Receipt(models.Model):
    """A receipt, order, shipping or booking email, read once by Ollama: feeds Packages, Renewing this week and Coming up."""
    KINDS = ['shipment', 'renewal', 'cancelled', 'purchase', 'event', 'other']
    STATUSES = ['ordered', 'shipped', 'out_for_delivery', 'delivered', 'none']

    account = models.CharField(max_length=20)
    uid = models.CharField(max_length=500)
    sender = models.CharField(max_length=300, blank=True)
    subject = models.CharField(max_length=500, blank=True)
    received = models.DateTimeField()
    kind = models.CharField(max_length=10)
    item = models.CharField(max_length=120, blank=True)
    merchant = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=20, blank=True)
    eta = models.DateField(null=True, blank=True)
    renews_on = models.DateField(null=True, blank=True)
    amount = models.FloatField(null=True, blank=True)
    starts = models.DateTimeField(null=True, blank=True)  # events (and cancelled bookings): when it happens
    ends = models.DateTimeField(null=True, blank=True)
    all_day = models.BooleanField(default=False)
    place = models.CharField(max_length=120, blank=True)
    model = models.CharField(max_length=10, default='ollama')

    class Meta:
        ordering = ['received']
        constraints = [models.UniqueConstraint(fields=['account', 'uid'], name='unique_receipt')]


class DayStat(models.Model):
    """The lowest Needs-a-reply count seen each day; a day at zero keeps the streak going."""
    day = models.DateField(unique=True)
    reply_min = models.IntegerField()


class Watch(models.Model):
    """One product watched for price drops and restocks at several stores (hub/prices.py)."""
    name = models.CharField(max_length=200)
    target = models.FloatField(null=True, blank=True)  # alert at or under this; none = any drop
    # [{url, store, price, currency, inStock, title, checkedAt, error}]; a failed read keeps the last price
    sources = models.JSONField(default=list)
    best = models.FloatField(null=True, blank=True)  # lowest in-stock price at the last check
    history = models.JSONField(default=list)  # [[YYYY-MM-DD, lowest in-stock price that day]], last 90 days
    searched = models.DateTimeField(null=True, blank=True)  # last look for new sellers
    skipped = models.JSONField(default=list)  # seller links found but wrong or removed by you: never re-added
    checked = models.DateTimeField(null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']


class Event(models.Model):
    """One thing moving between two parts of the setup, for the activity record (hub/events.py)."""
    at = models.DateTimeField(auto_now_add=True, db_index=True)
    kind = models.CharField(max_length=10)  # fetch | triage | draft | brief | price | news | ask | send
    src = models.CharField(max_length=20)
    dst = models.CharField(max_length=20)
    count = models.IntegerField(default=1)
    ms = models.IntegerField(null=True, blank=True)
    ok = models.BooleanField(default=True)
    item = models.CharField(max_length=40, blank=True)  # email:123, so one item's steps link up
    private = models.BooleanField(default=False)  # mail, notes or calendar sent outside the house (Gemini)
    text = models.CharField(max_length=200, blank=True)


class LearnCard(models.Model):
    """AI daily: one card a day on an AI term or tool (hub/learn.py)."""
    day = models.DateField(unique=True)
    term = models.CharField(max_length=120)
    kind = models.CharField(max_length=20)
    trending = models.BooleanField(default=False)  # picked from the AI news feeds, not the curriculum
    summary = models.TextField()
    body = models.TextField()
    depth = models.TextField(blank=True)
    builds_on = models.JSONField(default=list)
    leads_to = models.JSONField(default=list)
    try_it = models.TextField(blank=True)
    try_lang = models.CharField(max_length=40, blank=True)
    try_note = models.CharField(max_length=120, blank=True)
    followups = models.JSONField(default=list)
    why_now = models.TextField(blank=True)
    why_url = models.URLField(max_length=1000, blank=True)
    why_source = models.CharField(max_length=200, blank=True)
    sources = models.JSONField(default=list)  # [{url, site}] from the search Gemini ran
    questions = models.JSONField(default=list)  # [{q, a}] asked from the card
    status = models.CharField(max_length=10, default='new')  # new | known | review
    review_round = models.PositiveSmallIntegerField(default=0)
    review_due = models.DateField(null=True, blank=True)
    marked = models.DateTimeField(null=True, blank=True)  # first Got it / Review again, for the streak
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-day']


