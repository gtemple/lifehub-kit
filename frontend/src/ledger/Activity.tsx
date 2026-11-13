import { useEffect, useRef, useState } from 'react'

import { post, useTile } from '../api'
import { readMark, writeMark } from '../components/Notifications'
import { ACTIVITY_MS } from '../tiles/Bottom'
import { clock, stamp } from '../time'
import type { ActivityEntry } from '../types'
import './activity.css'

type Filter = 'all' | 'mail' | 'health' | 'prices'
const FILTERS: [Filter, string][] = [['all', 'All'], ['mail', 'Mail'], ['health', 'Health'], ['prices', 'Prices']]
const FILTER_VIA: Record<Exclude<Filter, 'all'>, string[]> = {
  mail: ['Email', 'Cleanup', 'Approvals', 'Ask Lifehub'], health: ['Health'], prices: ['Prices'],
}
// where an entry that needs you can be dealt with
const PAGE: Record<string, string> = { Email: '/inbox', Cleanup: '/cleanup', Approvals: '/', Health: '/health' }
const TOAST_MS = 6000
const FAILED = /couldn.t|stalled|failed|failing|down|error/i
const WAITING = /back in your stamps|waiting for your stamp|started on:/i

type Tone = 'red' | 'yellow' | 'old' | ''
const toneOf = (e: ActivityEntry, read: boolean): Tone => FAILED.test(e.text) ? 'red' : WAITING.test(e.text) ? 'yellow' : read ? 'old' : ''
const dayOf = (iso: string) => {
  const d = new Date(iso), now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday'
  return 'Earlier'
}

function Row({ e, read, now, onUndo, nav }: { e: ActivityEntry; read: boolean; now: number; onUndo: (id: string) => void; nav?: boolean }) {
  const tone = toneOf(e, read)
  const left = e.undo ? Math.ceil((Date.parse(e.undo.until) - now) / 1000) : 0
  const href = (tone === 'red' || tone === 'yellow') ? PAGE[e.via] : undefined
  return (
    <div className="ac-row" data-nav={nav || undefined} tabIndex={nav ? -1 : undefined}>
      <span className={`ac-dot ac-dot-${tone || 'on'}`} aria-label={tone === 'red' ? 'failed' : tone === 'yellow' ? 'waiting on you' : read ? undefined : 'new'} role={tone === 'red' || tone === 'yellow' || !read ? 'img' : undefined} />
      <div className="lg-grow">
        <div className="ac-text">{e.text}</div>
        <div className="lg-dim lg-xs">{e.via} · {dayOf(e.at) === 'Earlier' ? stamp(e.at) : clock(e.at)}</div>
      </div>
      {left > 0 ? <button type="button" className="lg-btn lg-btn-primary lg-btn-sm" onClick={() => onUndo(e.undo!.approvalId)}>Undo · {left} s</button>
        : href ? <a className="lg-btn lg-btn-sm" href={href}>Open</a> : null}
    </div>
  )
}

// the bell in the top bar, its drawer, and a toast per new entry. Opening doesn't clear the pip; "Mark all read" does.
export function Activity({ open, setOpen, onUndone }: { open: boolean; setOpen: (v: boolean) => void; onUndone?: () => void }) {
  const t = useTile<ActivityEntry>('activity', ACTIVITY_MS)
  const items = t.res?.items ?? []
  const [mark, setMark] = useState(readMark)
  const [filter, setFilter] = useState<Filter>('all')
  const [toasts, setToasts] = useState<ActivityEntry[]>([])
  const [now, setNow] = useState(() => Date.now())
  const known = useRef<Set<string> | null>(null)
  const bell = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  // toast entries that arrive after the page loaded; the first load only sets the baseline
  useEffect(() => {
    if (!t.res) return
    if (known.current && !open) {
      const fresh = items.filter(e => !known.current!.has(e.id))
      if (fresh.length) {
        setToasts(ts => [...fresh, ...ts].slice(0, 3))
        for (const f of fresh) setTimeout(() => setToasts(ts => ts.filter(x => x.id !== f.id)), TOAST_MS)
      }
    }
    known.current = new Set(items.map(e => e.id))
  }, [t.res]) // eslint-disable-line react-hooks/exhaustive-deps

  const undoable = items.some(e => e.undo && Date.parse(e.undo.until) > now)
  useEffect(() => {
    if (!undoable) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [undoable])

  const markAll = () => { if (items[0]) { writeMark(Number(items[0].id)); setMark(Number(items[0].id)) } }
  const shut = () => { setOpen(false); bell.current?.focus() }

  useEffect(() => {
    if (!open) return
    close.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); shut() }
      if (e.key === 'R' && e.shiftKey) { e.stopImmediatePropagation(); markAll() }
    }
    addEventListener('keydown', key, true)
    return () => removeEventListener('keydown', key, true)
  }, [open, items[0]?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const unread = items.filter(e => Number(e.id) > mark).length
  const undo = (approvalId: string) => post(`/api/approvals/${approvalId}/undo/`).finally(() => { t.refresh(); onUndone?.() })
  const shown = items.filter(e => filter === 'all' || FILTER_VIA[filter].includes(e.via))
  const days = ['Today', 'Yesterday', 'Earlier'].map(label => ({ label, list: shown.filter(e => dayOf(e.at) === label) })).filter(d => d.list.length)

  return (
    <>
      <button ref={bell} type="button" className="lg-iconbtn" aria-label={`Activity${unread ? `, ${unread} new` : ''}`} aria-expanded={open} aria-keyshortcuts="B" onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></svg>
        {unread > 0 && <span className="lg-pip" />}
      </button>
      {open && (
        <>
          <div className="lg-backdrop" onClick={shut} />
          <aside className="lg-drawer ac-drawer" role="dialog" aria-modal="true" aria-labelledby="ac-title">
            <div className="ac-head">
              <h2 id="ac-title" className="ac-title">Activity</h2>
              <button ref={close} type="button" className="lg-iconbtn ac-x" aria-label="Close activity" onClick={shut}>×</button>
            </div>
            <div className="ac-filters" role="group" aria-label="Show">
              {FILTERS.map(([f, label]) => <button key={f} type="button" className="ac-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>)}
            </div>
            <div className="ac-list">
              {t.failed && !t.res && <div className="lg-error ac-pad">Couldn’t load activity.</div>}
              {t.res && !shown.length && <div className="lg-empty ac-pad">Nothing yet.</div>}
              {days.map(d => (
                <section key={d.label} aria-label={d.label}>
                  <h3 className="ac-day">{d.label}</h3>
                  {d.list.map(e => <Row key={e.id} e={e} read={Number(e.id) <= mark} now={now} onUndo={undo} nav />)}
                </section>
              ))}
            </div>
            <div className="ac-foot">
              <button type="button" className="lg-btn lg-btn-quiet lg-btn-sm" aria-keyshortcuts="Shift+R" disabled={!unread} onClick={markAll}>Mark all read</button>
              <span className="lg-decor lg-xs">B toggles · Esc closes</span>
            </div>
          </aside>
        </>
      )}
      <div className="ac-toasts" role="status" aria-live="polite">
        {toasts.map(e => <div key={e.id} className="ac-toast"><Row e={e} read={false} now={now} onUndo={undo} /></div>)}
      </div>
    </>
  )
}
