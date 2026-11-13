import { useEffect, useRef, useState } from 'react'

import { post } from '../api'
import type { TileState } from '../api'
import { clock, stamp } from '../time'
import type { ActivityEntry } from '../types'
import { Btn, Tag } from './ui'
import type { TagTone } from './ui'

// What LifeHub did: the bell at the end of the taskbar, its tray, and a toast per new entry.
// Opening the tray doesn't clear the badge; "mark all read" does.

type Kind = 'cleanup' | 'email' | 'approvals' | 'ollama' | 'other'
const TONE: Record<Kind, TagTone> = { cleanup: 'yellow', email: 'cyan', approvals: 'pink', ollama: 'mint', other: 'gray' }
const FILTERS: ('all' | Kind)[] = ['all', 'cleanup', 'email', 'approvals', 'ollama']
const TOAST_MS = 6000
const READ_KEY = 'lifehub.activity.seen'

function kindOf(e: ActivityEntry): Kind {
  if (e.via === 'Cleanup') return 'cleanup'
  if (e.via === 'Approvals' || e.undo) return 'approvals'
  if (e.model === 'ollama' || e.model === 'gemini') return 'ollama'
  if (e.via === 'Email') return 'email'
  return 'other'
}

export function readMark() {
  try { return Number(localStorage.getItem(READ_KEY) ?? 0) } catch { return 0 }
}
export function writeMark(id: number) {
  try { localStorage.setItem(READ_KEY, String(id)) } catch { /* private window: the badge just resets */ }
}

function Row({ e, unread, now, onUndo }: { e: ActivityEntry; unread: boolean; now: number; onUndo: (id: string) => void }) {
  const k = kindOf(e)
  const today = new Date(e.at).toDateString() === new Date().toDateString()
  return (
    <div className={`tray-row ${unread ? 'unread' : ''}`} data-nav tabIndex={-1}>
      <span className="t">{unread ? '★' : ''}{today ? clock(e.at) : stamp(e.at)}</span>
      <span>
        {e.text}
        {e.undo && Date.parse(e.undo.until) > now && <> · <button type="button" className="link-btn" onClick={() => onUndo(e.undo!.approvalId)}>undo</button></>}
      </span>
      <Tag tone={TONE[k]} big>{k === 'other' ? e.via.toLowerCase() : k}</Tag>
    </div>
  )
}

export function useActivityTray() {
  const [open, setOpen] = useState(false)
  return { open, setOpen, toggle: () => setOpen(o => !o) }
}

export function Notifications({ t, onUndone, open, setOpen }: { t: TileState<ActivityEntry>; onUndone: () => void; open: boolean; setOpen: (v: boolean) => void }) {
  const items = t.res?.items ?? []
  const [mark, setMark] = useState(readMark)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [toasts, setToasts] = useState<ActivityEntry[]>([])
  const [now, setNow] = useState(Date.now())
  const known = useRef<Set<string> | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const bell = useRef<HTMLButtonElement>(null)

  // toast entries that arrive after the page loaded; the first load only sets the baseline
  useEffect(() => {
    if (!t.res) return
    const ids = new Set(items.map(e => e.id))
    if (known.current && !open) {
      const fresh = items.filter(e => !known.current!.has(e.id))
      if (fresh.length) {
        setToasts(ts => [...fresh, ...ts].slice(0, 3))
        for (const f of fresh) setTimeout(() => setToasts(ts => ts.filter(x => x.id !== f.id)), TOAST_MS)
      }
    }
    known.current = ids
  }, [t.res]) // eslint-disable-line react-hooks/exhaustive-deps

  // tick while an Undo is showing, so it disappears when its 30 s run out
  const undoable = items.some(e => e.undo && Date.parse(e.undo.until) > now)
  useEffect(() => {
    if (!undoable) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [undoable])

  // a click outside closes it; Esc closes it and hands focus back to the bell
  useEffect(() => {
    if (!open) return
    const click = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); setOpen(false); bell.current?.focus() }
      if (e.key === 'R' && e.shiftKey) markAll()
    }
    addEventListener('mousedown', click)
    addEventListener('keydown', key, true)
    return () => { removeEventListener('mousedown', click); removeEventListener('keydown', key, true) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const unread = items.filter(e => Number(e.id) > mark).length
  const markAll = () => { if (items[0]) { writeMark(Number(items[0].id)); setMark(Number(items[0].id)) } }
  const undo = (approvalId: string) => post(`/api/approvals/${approvalId}/undo/`).finally(() => { t.refresh(); onUndone() })
  const shown = items.filter(e => filter === 'all' || kindOf(e) === filter)

  return (
    <>
      <div ref={box} style={{ display: 'contents' }}>
        <button ref={bell} type="button" className="bell" aria-label={`Activity log${unread ? `, ${unread} new` : ''}`} aria-expanded={open} aria-keyshortcuts="B" onClick={() => setOpen(!open)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" aria-hidden="true"><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z" /><path d="M10 21h4" /></svg>
          {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
        {open && (
          <div className="win dialog tray" role="dialog" aria-label="What LifeHub did">
            <div className="win-bar" style={{ background: 'linear-gradient(90deg, var(--pink), var(--purple), var(--cyan))' }}>
              <span className="win-name">what_lifehub_did.log · <span className="jp" aria-hidden="true">履歴</span></span>
              <button type="button" className="win-x" aria-label="Close activity log" onClick={() => { setOpen(false); bell.current?.focus() }}>×</button>
            </div>
            <div className="tray-filters" role="group" aria-label="Filter activity">
              {FILTERS.map(f => (
                <button key={f} type="button" className={`chip ${f !== 'all' ? `chip-${TONE[f] === 'yellow' ? 'yellow-btn' : TONE[f]}` : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)} style={{ fontFamily: 'var(--font-display)', fontSize: 18 }}>{f}</button>
              ))}
            </div>
            <div className="tray-list">
              {shown.length === 0 && <div className="empty-plain">nothing yet</div>}
              {shown.map(e => <Row key={e.id} e={e} unread={Number(e.id) > mark} now={now} onUndo={undo} />)}
            </div>
            <div className="tray-foot">
              <Btn tone="face" size="sm" lower k="Shift+R" onClick={markAll}>mark all read</Btn>
              <span>B toggles · Esc closes</span>
            </div>
          </div>
        )}
      </div>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map(e => (
          <div key={e.id} className="toast raised">
            <Row e={e} unread={false} now={now} onUndo={undo} />
          </div>
        ))}
      </div>
    </>
  )
}
