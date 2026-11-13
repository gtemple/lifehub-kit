import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { TileState } from '../api'
import { ago, clock } from '../time'
import type { TileResponse } from '../types'
import { Btn, MiniSun, Window, wide } from './ui'

export type Shown = 'ok' | 'loading' | 'empty' | 'error' | 'stale' | 'waiting_for_model'

// one place decides which of the six states a tile is in
export function shownState<T, D>(s: Pick<TileState<T, D>, 'res' | 'loading' | 'failed'>, everyMs: number, isEmpty: (r: TileResponse<T, D>) => boolean, now = Date.now()): Shown {
  const { res } = s
  if (!res) return s.loading ? 'loading' : 'error'
  if (s.failed || res.status === 'error') return 'error'
  if (res.status === 'waiting_for_model') return 'waiting_for_model'
  if (res.status === 'stale' || now - Date.parse(res.updatedAt) > everyMs * 3) return 'stale'
  if (isEmpty(res)) return 'empty'
  return 'ok'
}

// "personal_email" -> "personal email"
const sourceName = (s: string) => s.replace(/_/g, ' ')

// "2 h ago" -> "2 H OLD"
const old = (iso: string) => ago(iso).replace(' ago', '').toUpperCase() + ' OLD'

type Props = {
  title: ReactNode // the window's file-style name
  grad?: number
  jp?: string
  state: Shown
  updatedAt?: string
  right?: ReactNode // replaces the age line, e.g. "live"
  onRefresh?: () => void
  newCount?: number
  loadingText?: string
  error?: { source: string; message?: string; also?: string }
  waiting?: { lines: string[]; actions?: ReactNode; more?: ReactNode }
  empty?: ReactNode
  emptyTitle?: string // the big spaced line under the mini sun
  emptyJp?: string
  skeletonRows?: number
  className?: string
  id?: string
  children?: ReactNode
}

export function Tile(p: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)

  // the NEW chip clears a few seconds after the window scrolls into view
  useEffect(() => {
    if (!p.newCount || seen || !ref.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const io = new IntersectionObserver(([e]) => {
      clearTimeout(timer)
      if (e?.isIntersecting) timer = setTimeout(() => setSeen(true), 4000)
    })
    io.observe(ref.current)
    return () => { io.disconnect(); clearTimeout(timer) }
  }, [p.newCount, seen])

  const refresh = p.onRefresh && <button type="button" className="age-btn" aria-label="Refresh" onClick={p.onRefresh}>⟳</button>
  const right =
    p.state === 'loading' ? undefined
    : p.state === 'waiting_for_model' ? <span>○ ollama offline</span>
    : p.state === 'stale' && p.updatedAt ? <span className="stale-chip">{old(p.updatedAt)}{refresh}</span>
    : p.state === 'error' ? undefined
    : p.right ?? (p.updatedAt && <span className="age">{ago(p.updatedAt)}{refresh}</span>)

  const title = (
    <>
      {p.title}
      {!!p.newCount && !seen && <> <span className="new-chip">{p.newCount} NEW ★</span></>}
    </>
  )

  return (
    <div ref={ref} id={p.id} className={p.className}>
      <Window name={title} grad={p.grad} jp={p.jp} right={right}>
        {p.state === 'loading' && (
          <>
            <span className="loading-line cursor">{p.loadingText ?? 'loading'}</span>
            <div className="progress" aria-hidden="true">{Array.from({ length: 22 }, (_, i) => <i key={i} />)}</div>
            <span className="small sub">this takes a few seconds on first load</span>
          </>
        )}

        {p.state === 'waiting_for_model' && p.waiting && (
          <>
            <div className="term">{p.waiting.lines.map((l, i) => <div key={i} className={i === p.waiting!.lines.length - 1 ? 'cursor' : i ? 'soft' : ''}>&gt; {l}</div>)}</div>
            {p.waiting.actions && <div className="actions">{p.waiting.actions}</div>}
            {p.waiting.more}
          </>
        )}

        {p.state === 'empty' && (
          p.emptyTitle
            ? <div className="empty-state"><MiniSun /><span className="empty-title">{wide(p.emptyTitle)}</span>{p.emptyJp && <span className="jp small" aria-hidden="true">{p.emptyJp}</span>}<span className="small">{p.empty}</span></div>
            : <div className="empty-plain">{p.empty}</div>
        )}

        {p.state === 'error' && (
          <div className="err-wrap">
            <div role="alert" className="win dialog err-dialog">
              <div className="win-bar"><span className="win-name">error</span></div>
              <div className="win-body">
                <svg className="err-icon" width="34" height="30" viewBox="0 0 34 30" aria-hidden="true"><path d="M17 2 32 28H2z" fill="var(--yellow)" stroke="var(--ink)" strokeWidth="2" /><path d="M17 11v8M17 22v2" stroke="var(--ink)" strokeWidth="3" /></svg>
                <div className="col gap8 grow">
                  <span>Couldn’t reach <b>{sourceName(p.error?.source ?? 'the server')}</b>.{p.error?.also ? ` ${p.error.also}` : ''}{p.updatedAt ? ` Last good data ${clock(p.updatedAt)}.` : ''}</span>
                  {p.onRefresh && <div className="actions"><Btn tone="mint" size="sm" onClick={p.onRefresh}>Retry</Btn></div>}
                </div>
              </div>
            </div>
          </div>
        )}

        {(p.state === 'ok' || p.state === 'stale' || p.state === 'error') && (
          <div className={`col gap8 ${p.state === 'error' ? 'dimmed' : ''}`}>{p.children}</div>
        )}
      </Window>
    </div>
  )
}

export function EmptyLine({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="col">
      <span className="strong">{title}</span>
      {detail && <span className="sub">{detail}</span>}
    </div>
  )
}
