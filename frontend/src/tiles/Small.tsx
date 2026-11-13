import type { ReactNode } from 'react'

import type { TileState } from '../api'
import { Stat } from '../components/ui'
import type { Accent } from '../components/ui'
import type { EmailWeek, Package, Renewal, Streak } from '../types'

export const STREAK_MS = 24 * 60 * 60_000
export const PACKAGES_MS = 30 * 60_000
export const RENEWALS_MS = 24 * 60 * 60_000
export const WEEK_MS = 60 * 60_000

const weekday = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short' })

// the bottom-row stat tiles: loading and errors stay small, in the same dark panel
function StatState<T, D>({ t, label, accent, color, children }: { t: TileState<T, D>; label: string; accent: Accent; color?: string; children: ReactNode }) {
  if (!t.res) return <Stat label={label} accent={accent} color={color}><span className="stat-small">{t.loading ? 'loading…' : `couldn’t reach ${label.toLowerCase()}`}</span></Stat>
  if (t.failed || t.res.status === 'error') return <Stat label={label} accent={accent} color={color}><span className="stat-small">couldn’t reach it · {t.res.error?.message ?? ''}</span></Stat>
  return <>{children}</>
}

export function StreakTile({ t }: { t: TileState<never, Streak> }) {
  const s = t.res?.data
  return (
    <StatState t={t} label="Inbox zero streak" accent="cyan" color="var(--mint)">
      <Stat label="Inbox zero streak" accent="cyan" color="var(--mint)" value={s ? `${s.days} ${s.days === 1 ? 'DAY' : 'DAYS'}` : '—'}>
        {s && <span className="stat-small" aria-label={`${s.week.filter(Boolean).length} of 7 days this week`}>{s.week.map(on => (on ? '■' : '□')).join('')}</span>}
        <span className="stat-small">days you cleared needs-a-reply</span>
      </Stat>
    </StatState>
  )
}

// Packages and Renewals hide themselves when there is nothing to show
export function Packages({ t }: { t: TileState<Package> }) {
  const items = t.res?.items ?? []
  if (t.res && items.length === 0) return null
  const p = items[0]
  return (
    <StatState t={t} label="Packages" accent="mint" color="var(--pink)">
      <Stat label="Packages" accent="mint" color="var(--pink)">
        {p && (
          <>
            {p.url
              ? <a href={p.url} target="_blank" rel="noopener" className="strong small stat-link">{p.item} · {p.status.toLowerCase()} ↗</a>
              : <span className="strong small">{p.item} · {p.status.toLowerCase()}</span>}
            <span className="bar">[<i style={{ maxWidth: `${Math.round(p.progress * 100)}%` }} />]</span>
            <span className="vt green" style={{ fontSize: 22, color: 'var(--mint)' }}>{Math.round(p.progress * 100)}%</span>
            {items.length > 1 && <span className="stat-small detail">+{items.length - 1} more on the way</span>}
          </>
        )}
      </Stat>
    </StatState>
  )
}

export function Renewals({ t }: { t: TileState<Renewal> }) {
  const items = t.res?.items ?? []
  if (t.res && items.length === 0) return null
  return (
    <StatState t={t} label="Renewing this week" accent="yellow" color="var(--yellow)">
      <Stat label="Renewing this week" accent="yellow" color="var(--yellow)" value={String(items.length).padStart(2, '0')}>
        {items.slice(0, 3).map(r => {
          const line = <>{r.name} · {weekday(r.date)}{r.amount !== null ? ` · $${r.amount.toFixed(2)}` : ''}</>
          return r.url
            ? <a key={r.id} href={r.url} target="_blank" rel="noopener" className="stat-small stat-link">{line} ↗</a>
            : <span key={r.id} className="stat-small">{line}</span>
        })}
        {items.length > 3 && <span className="stat-small">+{items.length - 3} more</span>}
      </Stat>
    </StatState>
  )
}

const trend = (now: number, before: number | null) => {
  if (before === null || before === 0) return ''
  const pct = Math.round((now - before) / before * 100)
  return pct === 0 ? ' · same as before' : ` · ${pct > 0 ? '▲' : '▼'}${Math.abs(pct)}%`
}

// written Sunday morning by the fetch run; hidden until the first one exists
export function EmailWeekTile({ t }: { t: TileState<never, EmailWeek> }) {
  const w = t.res?.data
  if (t.res && !w) return null
  const span = w && `${new Date(w.weekStart).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} – ${new Date(new Date(w.weekEnd).getTime() - 86_400_000).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}`
  return (
    <StatState t={t} label="Email last week" accent="pink" color="var(--pink)">
      <Stat label={`Email last week${span ? ` · ${span}` : ''}`} accent="pink" color="var(--pink)">
        {w?.accounts.map(a => a.error
          ? <span key={a.key} className="stat-small">{a.name} · couldn’t count · {a.error}</span>
          : (
            <span key={a.key} className="stat-small">
              <span className="strong">{a.name}</span> · {a.received} in{trend(a.received!, a.receivedBefore)} · {a.sent} sent · {a.unread} unread
              {a.top?.length ? <><br />top: {a.top.map(s => `${s.name} (${s.count})`).join(', ')}</> : null}
              {a.waiting > 0 && <><br />{a.waiting} waiting on you{a.oldestWaiting ? `, oldest: ${a.oldestWaiting}` : ''}</>}
            </span>
          ))}
      </Stat>
    </StatState>
  )
}
