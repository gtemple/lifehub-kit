import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { post, useTile } from '../api'
import { placeholders } from '../ApprovalEdit'
import { useActivityTray } from '../components/Notifications'
import { setDesign } from '../design'
import { loadLedgerLayout } from '../layout'
import { Shell } from '../Shell'
import { clock, when } from '../time'
import type { Approval, CalendarEvent, ComingEvent, Email, EmailAccount, EmailGroup, MorningBrief, NewsTile, Note, SocialPost, Story, Streak, Task, Waiting, Watch } from '../types'
import { useConfirm } from './Confirm'
import { Bars } from './dash/Bars'
import { isoDay, pct, untilText } from './dash/data'
import type { MailWeek } from './dash/data'
import { InboxZero, Notes, PriceWatch, Reading, Today, Todo } from './dash/Rail'
import { AiDaily } from './ResourcesPage'
import { TopBar } from './TopBar'
import './dashboard.css'

type Mail = Email & { draft: string }
const MIN = 60_000
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()

function useNow() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MIN)
    return () => clearInterval(id)
  }, [])
  return now
}

// the full list (the inbox tile only previews), so the filter tabs can count everything
function useInbox() {
  const [mail, setMail] = useState<Mail[] | null>(null)
  const [failed, setFailed] = useState(false)
  const load = useCallback(() => fetch('/api/inbox/', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() as Promise<{ emails: Mail[] }> : Promise.reject(new Error(String(r.status)))))
    .then(d => { setMail(d.emails); setFailed(false) }).catch(() => setFailed(true)), [])
  useEffect(() => {
    void load()
    const id = setInterval(load, 2 * MIN)
    return () => clearInterval(id)
  }, [load])
  return { mail, failed, load }
}


function Pill({ href, big, text, stamp }: { href: string; big: ReactNode; text: string; stamp?: boolean }) {
  return <a href={href} className={`lgd-pill ${stamp ? 'lgd-pill-stamp' : ''}`}><span className="lgd-pill-big">{big}</span><span>{text}</span></a>
}

const KIND: Record<Approval['kind'], string> = { email: 'draft reply', calendar: 'calendar', post: 'post', cleanup: 'cleanup', purchase: 'purchase' }
const ACCT: Record<EmailAccount, string> = { work: 'work', personal: 'personal' }

function Stamp({ items, onDecide }: { items: Approval[]; onDecide: (id: string, d: 'approve' | 'decline') => void }) {
  const a = items[0]
  if (!a) return null
  const gaps = a.kind === 'email' && placeholders(String((a.payload as { body?: string })?.body ?? '')).length > 0
  return (
    // data-column sits on a wrapper: focusColumn looks for [data-nav] inside it
    <div data-column="act">
    <section id="lgd-stamp" aria-labelledby="lgd-stamp-h" className="lgd-stamp" data-nav tabIndex={-1}>
      <div className="lg-col lgd-stamp-text">
        <span className="lg-yellow lg-xs">{['Needs your stamp', KIND[a.kind], a.account && ACCT[a.account], items.length > 1 && `1 of ${items.length}`].filter(Boolean).join(' · ')}</span>
        <h2 id="lgd-stamp-h" className="lgd-stamp-title">{a.title}</h2>
        {a.detail && <p className="lg-soft lgd-clamp">{a.kind === 'email' && !a.detail.trim().startsWith('“') ? `“${a.detail.trim()}”` : a.detail}</p>}
      </div>
      <div className="lg-row lg-wrap">
        {gaps
          ? <a className="lg-btn lg-btn-primary lgd-tall" href={`/approvals/${a.id}`} aria-keyshortcuts="A">Fill in</a>
          : <button type="button" className="lg-btn lg-btn-primary lgd-tall" aria-keyshortcuts="A" onClick={() => onDecide(a.id, 'approve')}>{a.kind === 'email' ? 'Send' : 'Approve'}</button>}
        {a.kind === 'email' && <a className="lg-btn lgd-tall" href={`/approvals/${a.id}`} aria-keyshortcuts="E">Edit</a>}
        <button type="button" className="lg-btn lg-btn-quiet lgd-tall" aria-keyshortcuts="N" onClick={() => onDecide(a.id, 'decline')}>Skip</button>
      </div>
    </section>
    </div>
  )
}

type Filter = { key: string; label: string; test: (m: Mail) => boolean }
const FILTERS: Filter[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'needs_reply', label: 'Needs a reply', test: m => m.group === 'needs_reply' },
  { key: 'personal', label: 'Personal', test: m => m.account === 'personal' },
  { key: 'work', label: 'Work', test: m => m.account === 'work' },
  { key: 'fyi', label: 'FYI', test: m => m.group === 'fyi' },
  { key: 'newsletter', label: 'Newsletters', test: m => m.group === 'newsletter' },
  { key: 'receipt', label: 'Receipts', test: m => m.group === 'receipt' },
]
const GROUP: Record<EmailGroup, string> = { needs_reply: 'needs a reply', fyi: 'fyi', newsletter: 'newsletter', receipt: 'receipt' }
const ROWS = 6
const CYCLE = ['all', 'work', 'personal']

function Inbox({ inbox, onDrafted }: { inbox: ReturnType<typeof useInbox>; onDrafted: () => void }) {
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [confirm, dialog] = useConfirm()
  const all = inbox.mail ?? []
  const tabs = FILTERS.filter(f => f.key === 'all' || all.some(f.test))
  const shown = all.filter((FILTERS.find(f => f.key === filter) ?? FILTERS[0]!).test)
  const act = (m: Mail, action: 'draft' | 'archive') => {
    setBusy(`${m.id}:${action}`); setErr('')
    post(`/api/emails/${m.id}/${action}/`).then(() => { if (action === 'draft') onDrafted(); return inbox.load() })
      .catch((e: Error) => setErr(e.message)).finally(() => setBusy(''))
  }
  // your confirm is the stamp: it goes to Gmail Trash after the usual 30 s undo (in the bell)
  const remove = async (m: Mail) => {
    if (!(await confirm({ title: `Delete “${m.subject}”?`, detail: `From ${m.from.name || m.from.address}. It goes to Gmail Trash; undo from the bell for 30 s.`, action: 'Delete' }))) return
    setBusy(`${m.id}:delete`); setErr('')
    post<{ id: string }>(`/api/emails/${m.id}/delete/`).then(a => post(`/api/approvals/${a.id}/decide/`, { decision: 'approve' })).then(() => inbox.load())
      .catch((e: Error) => setErr(e.message)).finally(() => setBusy(''))
  }
  return (
    <section aria-labelledby="lgd-inbox-h" className="lgd-inbox" data-column="inbox">
      <div className="lgd-inbox-head">
        <h2 id="lgd-inbox-h" className="lgd-h2">Inbox</h2>
        <div className="lg-seg lg-wrap lgd-filters" role="group" aria-label="Show">
          {tabs.map(f => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}<span className={f.key === 'needs_reply' ? 'lg-yellow' : 'lg-count'}>{all.filter(f.test).length}</span>
            </button>
          ))}
        </div>
        <button type="button" className="visually-hidden" aria-keyshortcuts="F" onClick={() => setFilter(f => CYCLE[(CYCLE.indexOf(f) + 1) % CYCLE.length]!)}>Cycle all / work / personal</button>
      </div>
      {err && <p className="lg-error lgd-pad" role="alert">{err}</p>}
      {!inbox.mail ? <p className={inbox.failed ? 'lg-error lgd-pad' : 'lg-empty'}>{inbox.failed ? 'Couldn’t load the inbox.' : 'Loading…'}</p>
        : shown.length === 0 ? <p className="lg-empty">Nothing here. Inbox zero.</p>
        : shown.slice(0, ROWS).map(m => {
          const reply = m.group === 'needs_reply'
          return (
            <div key={m.id} className="lgd-mail" data-nav tabIndex={-1}>
              <span aria-hidden="true" className={`lgd-mail-dot ${m.unread ? 'lgd-unread' : ''}`} />
              <a href={`/inbox?id=${m.id}`} className="lgd-mail-from">
                <span className={`lg-ellipsis ${m.unread ? 'lgd-bold' : ''}`}>{m.from.name || m.from.address}</span>
                <span className={`lg-xs ${reply ? 'lg-yellow' : 'lg-dim'}`}>{[m.account === 'work' && 'work', m.group ? GROUP[m.group] : m.account].filter(Boolean).join(' · ')}</span>
              </a>
              <a href={`/inbox?id=${m.id}`} className="lgd-mail-subj" tabIndex={-1}>
                <span className="lg-ellipsis">{m.subject}</span>
                <span className="lg-ellipsis lg-dim lg-small">{m.summary}</span>
              </a>
              <span className="lgd-mail-when lg-dim lg-xs">{when(m.receivedAt)}{m.draftId ? ' · drafted' : ''}</span>
              <div className="lgd-mail-actions">
                {reply && (m.draftId
                  ? <a className="lg-btn lg-btn-primary lg-btn-sm" href={`/approvals/${m.draftId}`}>Review draft</a>
                  : <button type="button" className="lg-btn lg-btn-primary lg-btn-sm" disabled={!!busy} onClick={() => act(m, 'draft')}>{busy === `${m.id}:draft` ? 'Drafting…' : 'Draft reply'}</button>)}
                {m.url ? <a className="lg-btn lg-btn-sm" href={m.url} target="_blank" rel="noopener">Reply</a> : <a className="lg-btn lg-btn-sm" href={`/inbox?id=${m.id}`}>Open</a>}
                <button type="button" className="lg-btn lg-btn-sm" disabled={!!busy} onClick={() => act(m, 'archive')}>{busy === `${m.id}:archive` ? 'Archiving…' : 'Archive'}</button>
                <button type="button" className="lg-btn lg-btn-sm lg-btn-danger" disabled={!!busy} onClick={() => void remove(m)}>{busy === `${m.id}:delete` ? 'Deleting…' : 'Delete'}</button>
              </div>
            </div>
          )
        })}
      {dialog}
      <a href="/inbox" className="lgd-more">Open the inbox{shown.length > ROWS ? ` · ${shown.length - ROWS} more` : ''} →</a>
    </section>
  )
}

function MailChart({ w, failed }: { w?: MailWeek | null; failed: boolean }) {
  const days = w?.days ?? []
  return (
    <section aria-labelledby="lgd-mail-h" className="lgd-chartsec">
      <h2 id="lgd-mail-h" className="lgd-h2s">Mail this week</h2>
      {!w ? <p className={failed ? 'lg-dim lg-small' : 'lg-empty'}>{failed ? 'Not counted yet.' : 'Loading…'}</p> : (
        <>
          <span className="lg-dim lg-small"><b className="lgd-ink">{w.received}</b> in · <b className="lgd-ink">{w.answered}</b> answered{pct(w.received, w.lastWeekReceived) && ` · ${pct(w.received, w.lastWeekReceived)} vs last week`}</span>
          <Bars
            days={days.map(d => d.date)} bars={days.map(d => d.received)} line={days.map(d => d.answered)} today={days.findIndex(d => d.date === isoDay(new Date()))}
            label={`Emails received per day as bars, answered as a dashed line: ${days.map(d => `${d.received} in, ${d.answered} answered`).join('; ')}`}
          />
        </>
      )}
    </section>
  )
}


export function Dashboard() {
  const tray = useActivityTray()
  const now = useNow()
  const [layout] = useState(loadLedgerLayout)
  const brief = useTile<never, MorningBrief>('brief', 10 * MIN)
  const mailweek = useTile<never, MailWeek>('mailweek', 60 * MIN)
  const approvals = useTile<Approval>('approvals', 30_000)
  const calendar = useTile<CalendarEvent>('calendar', 5 * MIN)
  const coming = useTile<ComingEvent>('coming', 10 * MIN)
  const tasks = useTile<Task>('tasks', 30_000)
  const waiting = useTile<Waiting>('waiting', 10 * MIN)
  const streak = useTile<never, Streak>('streak', 60 * MIN)
  const prices = useTile<Watch>('prices', 10 * MIN)
  const news = useTile<Story, NewsTile>('news', 30 * MIN)
  const social = useTile<SocialPost, { kept: number; scanned: number }>('social', 15 * MIN)
  const notes = useTile<Note>('notes', MIN)
  const inbox = useInbox()
  const [decided, setDecided] = useState<string[]>([])
  const [writing, setWriting] = useState(false)
  const [briefErr, setBriefErr] = useState('')

  const pending = (approvals.res?.items ?? []).filter(a => a.status === 'pending' && !decided.includes(a.id))
  const decide = (id: string, decision: 'approve' | 'decline') => {
    setDecided(d => [...d, id])
    post(`/api/approvals/${id}/decide/`, { decision }).catch(() => setDecided(d => d.filter(x => x !== id))).finally(approvals.refresh)
  }
  const write = () => {
    setWriting(true); setBriefErr('')
    post('/api/brief/').then(brief.refresh).catch((e: Error) => setBriefErr(e.message)).finally(() => setWriting(false))
  }
  const askClosed = useCallback(() => { approvals.refresh(); tasks.refresh(); notes.refresh() }, [approvals.refresh, tasks.refresh, notes.refresh])

  const b = brief.res?.data && sameDay(brief.res.data.writtenAt) ? brief.res.data : null
  const next = (calendar.res?.items ?? []).find(e => !e.allDay && Date.parse(e.start) > now)
  const replies = (inbox.mail ?? []).filter(m => m.group === 'needs_reply').length
  const drafts = pending.filter(a => a.kind === 'email').length

  const sections: Record<string, ReactNode> = {
    approvals: <Stamp items={pending} onDecide={decide} />,
    inbox: <Inbox inbox={inbox} onDrafted={approvals.refresh} />,
    mail: <MailChart w={mailweek.res?.data} failed={mailweek.failed || !!mailweek.res} />,
    today: <Today t={calendar} c={coming} now={now} />,
    tasks: <Todo t={tasks} w={waiting} />,
    streak: <InboxZero t={streak} />,
    prices: <PriceWatch t={prices} />,
    learn: <AiDaily />,
    reading: <Reading news={news} social={social} />,
    notes: <Notes t={notes} />,
  }
  const group = (name: string) => layout.order[name]!.filter(id => !layout.hidden.includes(id)).map(id => <Fragment key={id}>{sections[id]}</Fragment>)
  const charts = (['mail'] as const).filter(id => !layout.hidden.includes(id))
  const mainIds = layout.order.main!.filter(id => !layout.hidden.includes(id))

  return (
    <Shell screen="dashboard" handlers={{ toggleActivityTray: tray.toggle }} onAskClosed={askClosed}>
      <TopBar page="dashboard" tray={tray} onUndone={approvals.refresh} />
      <main className="lg-main">
        <section aria-label="Day brief" className="lgd-hero">
          <div className="lg-row lg-wrap lg-dim lg-small">
            <span>{new Date(now).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}{b && ` · brief written ${clock(b.writtenAt)}`}</span>
            <button type="button" className="lg-link lgd-rewrite" disabled={writing} onClick={write}>{writing ? 'Writing…' : b ? 'Rewrite' : 'Write it now'}</button>
          </div>
          <p className="lgd-brief" aria-live="polite">
            {writing ? 'Reading your mail, calendar and to-dos…' : b ? b.text : 'No brief yet today. It writes itself at 7:40.'}
          </p>
          {briefErr && <p className="lg-error" role="alert">{briefErr}</p>}
          <div className="lg-row lg-wrap lgd-pills">
            {next && <Pill href="#lgd-today" big={untilText(Date.parse(next.start) - now)} text={`until ${next.title}`} />}
            {inbox.mail && <Pill href="/inbox" big={replies} text={replies === 1 ? 'reply waiting' : 'replies waiting'} />}
            {drafts > 0 && <Pill href="#lgd-stamp" big={drafts} text={drafts === 1 ? 'draft to stamp' : 'drafts to stamp'} stamp />}
          </div>
        </section>

        <div className="lgd-cols">
          <div className="lgd-main">
            {mainIds.filter(id => !charts.includes(id as 'mail')).map(id => <Fragment key={id}>{sections[id]}</Fragment>)}
            {charts.length > 0 && <div className="lgd-charts">{mainIds.filter(id => charts.includes(id as 'mail')).map(id => <Fragment key={id}>{sections[id]}</Fragment>)}</div>}
          </div>
          <div className="lgd-rails">
            <aside aria-label="Today" className="lgd-side">{group('side')}</aside>
            <aside aria-label="More" className="lgd-side">{group('more')}</aside>
          </div>
        </div>

        <div className="lgd-foot"><button type="button" className="lg-link" onClick={() => setDesign('retro')}>Classic look</button></div>
      </main>
    </Shell>
  )
}
