import { useState } from 'react'
import type React from 'react'

import { post } from '../api'
import type { TileState } from '../api'
import { placeholders } from '../ApprovalEdit'
import { Tile, shownState } from '../components/Tile'
import { AccountTag, Btn, LinkBtn, Stamp } from '../components/ui'
import { clock, due, when } from '../time'
import type { Approval, CalendarEvent, Task } from '../types'

export const APPROVALS_MS = 30_000
export const TASKS_MS = 30_000
export const TODAY_MS = 5 * 60_000

const KIND: Record<Approval['kind'], string> = { email: 'Email', calendar: 'Calendar', post: 'Post', cleanup: 'Cleanup', purchase: 'Purchase' }
const STAMP_LEAVES_MS = 2000
const SHOWN = 5 // the rest wait behind "show more" so the tile stays short

// the stamp slams down straight away; the card leaves once the server has the decision and the stamp has had its moment
export function Approvals({ t, onDecided }: { t: TileState<Approval>; onDecided: () => void }) {
  const [decided, setDecided] = useState<Record<string, 'yes' | 'no'>>({})
  const [all, setAll] = useState(false)
  const decide = (id: string, v: 'yes' | 'no') => {
    setDecided(d => ({ ...d, [id]: v }))
    const forget = () => setDecided(({ [id]: _, ...rest }) => rest)
    post(`/api/approvals/${id}/decide/`, { decision: v === 'yes' ? 'approve' : 'decline' })
      .then(() => { onDecided(); setTimeout(() => { t.refresh(); setTimeout(forget, 500) }, STAMP_LEAVES_MS) })
      .catch(() => { forget(); t.refresh() })
  }
  const items = (t.res?.items ?? []).filter(a => a.status === 'pending')
  const pending = items.filter(a => !decided[a.id]).length
  return (
    <Tile
      title={`needs_your_stamp (${pending})`} grad={0} jp="承認" right="live"
      state={shownState(t, APPROVALS_MS, () => items.length === 0)} updatedAt={t.res?.updatedAt} onRefresh={t.refresh}
      error={t.res?.error ?? { source: 'approvals' }}
      emptyTitle="all clear" emptyJp="すべて完了" empty="nothing is waiting on you."
    >
      {items.slice(0, all ? undefined : SHOWN).map(a => {
        const d = decided[a.id]
        const gaps = a.kind === 'email' && placeholders(String((a.payload as { body?: string })?.body ?? '')).length > 0
        return (
          <div key={a.id} className={`card ${d ? 'dim' : ''}`} data-nav tabIndex={-1}>
            <span className="card-kind">{[KIND[a.kind], a.account && (a.account === 'work' ? 'Work' : 'Personal'), a.reason].filter(Boolean).join(' · ')}</span>
            <span className="card-title">{a.title}</span>
            {a.detail && <span className="small sub">{a.detail}</span>}
            {!d && (
              <div className="actions">
                {/* a draft with [placeholders] can't go out as is: it opens the editor instead */}
                {gaps
                  ? <LinkBtn tone="mint" href={`/approvals/${a.id}`} k="A">Fill in</LinkBtn>
                  : <Btn tone="mint" k="A" onClick={() => decide(a.id, 'yes')}>Approve</Btn>}
                {a.kind === 'email' && <LinkBtn tone="gray" href={`/approvals/${a.id}`} k="E">Edit</LinkBtn>}
                <Btn tone="pink" k="N" onClick={() => decide(a.id, 'no')}>Nope</Btn>
              </div>
            )}
            {d && <Stamp yes={d === 'yes'} />}
          </div>
        )
      })}
      {items.length > SHOWN && (
        <div style={{ textAlign: 'center' }}>
          <Btn tone="face" size="sm" lower aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'show fewer ▲' : `show ${items.length - SHOWN} more ▼`}</Btn>
        </div>
      )}
    </Tile>
  )
}

export function Tasks({ t }: { t: TileState<Task> }) {
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [text, setText] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const items = t.res?.items ?? []
  const isDone = (k: Task) => done[k.id] ?? k.done
  const toggle = (k: Task) => {
    const v = !isDone(k)
    setDone(d => ({ ...d, [k.id]: v }))
    post(`/api/tasks/${k.id}/`, { done: v }).catch(() => setDone(({ [k.id]: _, ...rest }) => rest))
  }
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    post('/api/tasks/', { text }).then(() => { setText(''); t.refresh() })
  }
  const adder = (
    <form className="adder" onSubmit={add}>
      <label htmlFor="new-task" className="visually-hidden">Add a task</label>
      <input id="new-task" className="field" placeholder="add a task…" value={text} onChange={e => setText(e.target.value)} />
      <Btn type="submit" tone="gray">Add</Btn>
    </form>
  )
  return (
    <Tile
      title={`todo.lst · ${items.filter(isDone).length}/${items.length}`} grad={2} jp="やること"
      state={shownState(t, TASKS_MS, r => r.items.length === 0)} updatedAt={t.res?.updatedAt} onRefresh={t.refresh}
      error={t.res?.error ?? { source: 'tasks' }} empty={<div className="col gap8"><span>nothing due</span>{adder}</div>}
    >
      <div className="col">
        {items.map(k => (
          <div key={k.id} className={`task-wrap ${isDone(k) ? 'done' : ''}`} data-nav tabIndex={-1}>
            <div className={`task ${isDone(k) ? 'done' : ''}`}>
              <input type="checkbox" id={`task-${k.id}`} checked={isDone(k)} onChange={() => toggle(k)} />
              <label htmlFor={`task-${k.id}`}>
                <span className="task-text">{k.text}</span>
                <span className="sub small">{k.source}</span>
              </label>
              {k.due && <span className="task-due">{due(k.due)}</span>}
              {(k.email || k.context) && (
                <button type="button" className="age-btn task-more" aria-expanded={open === k.id} aria-keyshortcuts="Enter" aria-label={`Where “${k.text}” came from`} onClick={() => setOpen(open === k.id ? null : k.id)}>
                  {open === k.id ? '▾' : '▸'}
                </button>
              )}
              <button type="button" className="visually-hidden" aria-keyshortcuts="X" onClick={() => toggle(k)}>tick {k.text}</button>
            </div>
            {open === k.id && (
              <div className="task-from">
                {k.email ? (
                  <>
                    <span className="mail-who"><strong>{k.email.from}</strong><AccountTag account={k.email.account} /></span>
                    <span className="strong">“{k.email.subject}” · {when(k.email.receivedAt)}</span>
                    {k.email.summary && <span><b>in one line:</b> {k.email.summary}</span>}
                    {k.email.snippet && <span className="sub">{k.email.snippet}…</span>}
                    <div className="actions">
                      <LinkBtn tone="face" size="sm" lower href={`/inbox?id=${k.email.id}`}>open in inbox.exe</LinkBtn>
                      {k.url && <LinkBtn tone="face" size="sm" lower href={k.url} target="_blank" rel="noopener">gmail ↗</LinkBtn>}
                    </div>
                  </>
                ) : (
                  <>
                    <span>{k.context}</span>
                    {k.url && <div className="actions"><LinkBtn tone="face" size="sm" lower href={k.url} target="_blank" rel="noopener">open the email in gmail ↗</LinkBtn></div>}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {adder}
    </Tile>
  )
}

export function Today({ t }: { t: TileState<CalendarEvent> }) {
  const items = t.res?.items ?? []
  return (
    <Tile
      title="today.cal" grad={1} jp="今日" state={shownState(t, TODAY_MS, r => r.items.length === 0)} updatedAt={t.res?.updatedAt} onRefresh={t.refresh}
      error={{ source: 'calendar', also: t.res?.error?.message }} emptyTitle="free day" emptyJp="予定なし" empty="nothing on the calendar." skeletonRows={4}
    >
      <div className="col">
        {items.map(v => (
          <div key={v.id} className={`event ${v.highlight ? 'highlight' : ''}`}>
            <span className="event-time" style={v.allDay ? { fontSize: 18 } : undefined}>{v.allDay ? 'all day' : clock(v.start)}</span>
            <span>{v.title}{v.where && <span className="sub small"> · {v.where}</span>}</span>
          </div>
        ))}
      </div>
    </Tile>
  )
}
