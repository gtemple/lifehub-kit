import { useCallback, useState } from 'react'
import type React from 'react'

import { post } from '../../api'
import type { TileState } from '../../api'
import { ago, clock, due } from '../../time'
import type { CalendarEvent, NewsTile, Note, SocialPost, Story, Streak, Task, Waiting, Watch } from '../../types'
import { isoDay, untilText } from './data'
import { PriceEditor } from './PriceEditor'

function Quiet<T, D>({ t, empty, what }: { t: TileState<T, D>; empty: boolean; what: string }) {
  if (!t.res) return <p className={t.loading ? 'lg-empty' : 'lg-error'}>{t.loading ? 'Loading…' : `Couldn’t load ${what}.`}</p>
  if (t.res.status === 'error') return <p className="lg-error">{t.res.error?.message ?? `Couldn’t load ${what}.`}</p>
  return empty ? <p className="lg-empty">Nothing here.</p> : null
}

export function Today({ t, now }: { t: TileState<CalendarEvent>; now: number }) {
  const items = t.res?.items ?? []
  const next = items.find(e => !e.allDay && Date.parse(e.start) > now)
  return (
    <section id="lgd-today" aria-labelledby="lgd-today-h" className="lgd-sec">
      <h2 id="lgd-today-h" className="lgd-h3">Today</h2>
      <Quiet t={t} empty={items.length === 0} what="the calendar" />
      {items.map(e => {
        const past = !e.allDay && Date.parse(e.end) < now
        return (
          <div key={e.id} className={`lgd-event ${past ? 'lgd-past' : ''}`} data-nav tabIndex={-1}>
            <span className={e === next ? '' : 'lg-dim'}>{e.allDay ? 'all day' : clock(e.start)}</span>
            <div>
              <div>{e.title}</div>
              <div className="lg-dim lg-xs">{past ? 'done' : e === next ? `in ${untilText(Date.parse(e.start) - now)}` : e.where ?? ''}</div>
            </div>
          </div>
        )
      })}
    </section>
  )
}



const REPEATS = ['', 'daily', 'weekly', 'monthly'] as const
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d) }

function TaskRow({ k, isDone, toggle, save }: { k: Task; isDone: boolean; toggle: () => void; save: (b: Partial<Task>) => void }) {
  const [open, setOpen] = useState(false)
  const today = isoDay(new Date())
  const late = !!k.due && k.due < today
  return (
    <div className={`lgd-task-wrap ${isDone ? 'lgd-done' : ''}`} data-nav tabIndex={-1}>
      <div className="lgd-task">
        <input type="checkbox" className="lg-check" id={`lgd-task-${k.id}`} checked={isDone} onChange={toggle} />
        <label htmlFor={`lgd-task-${k.id}`} className="lg-grow">{k.text}</label>
        <span className={`lg-xs ${late ? 'lg-red' : k.due === today ? 'lg-yellow' : 'lg-dim'}`}>
          {k.repeat && <span aria-label={`repeats ${k.repeat}`}>↻ </span>}
          {k.snoozed && k.snoozed > today ? `snoozed · ${due(k.snoozed)}` : k.due ? (k.due === today ? 'today' : late ? `late · ${due(k.due)}` : due(k.due)) : k.email ? 'from email' : ''}
        </span>
        {k.email && <a className="lg-link lg-xs" href={`/inbox?id=${k.email.id}`} aria-label={`Open the email “${k.email.subject}”`}>↗</a>}
        <button type="button" className="lg-link lg-xs" aria-expanded={open} aria-keyshortcuts="E" aria-label={`Edit ${k.text}`} onClick={() => setOpen(o => !o)}>⋯</button>
        <button type="button" className="visually-hidden" aria-keyshortcuts="X" onClick={toggle}>tick {k.text}</button>
        <button type="button" className="visually-hidden" aria-keyshortcuts="Z" onClick={() => save({ snoozed: plusDays(1) })}>snooze {k.text} to tomorrow</button>
      </div>
      {open && (
        <div className="lgd-task-edit">
          <label className="lg-xs lg-dim">Due <input type="date" className="lg-input" value={k.due ?? ''} onChange={e => save({ due: e.target.value || null })} /></label>
          <label className="lg-xs lg-dim">Repeat{' '}
            <select className="lg-select" value={k.repeat ?? ''} onChange={e => save({ repeat: e.target.value as Task['repeat'] })}>
              {REPEATS.map(r => <option key={r} value={r}>{r || 'never'}</option>)}
            </select>
          </label>
          <span className="lg-xs lg-dim">Snooze</span>
          <button type="button" className="lg-btn lg-btn-sm" onClick={() => save({ snoozed: plusDays(1) })}>Tomorrow</button>
          <button type="button" className="lg-btn lg-btn-sm" onClick={() => save({ snoozed: plusDays(7) })}>Next week</button>
          {k.snoozed && <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" onClick={() => save({ snoozed: null })}>Unsnooze</button>}
        </div>
      )}
    </div>
  )
}

export function Todo({ t, w }: { t: TileState<Task>; w: TileState<Waiting> }) {
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [gone, setGone] = useState<Record<string, boolean>>({})
  const [text, setText] = useState('')
  const [dropped, setDropped] = useState<Record<string, boolean>>({})
  const waits = (w.res?.items ?? []).filter(x => !dropped[x.id])
  const drop = (x: Waiting) => { setDropped(d => ({ ...d, [x.id]: true })); void post(`/api/waiting/${x.id}/`, {}) }
  const isDone = (k: Task) => done[k.id] ?? k.done
  // a ticked task stays (crossed out) for 30 s, then goes; untick it before then and it stays
  const items = (t.res?.items ?? []).filter(k => !(gone[k.id] && isDone(k)))
  const toggle = (k: Task) => {
    const v = !isDone(k)
    if (k.repeat && v) {
      // a repeating task moves to its next date instead of going away
      void post(`/api/tasks/${k.id}/`, { done: true }).then(t.refresh)
      return
    }
    setDone(d => ({ ...d, [k.id]: v }))
    setGone(({ [k.id]: _, ...rest }) => rest)
    if (v) setTimeout(() => setGone(g => ({ ...g, [k.id]: true })), 30_000)
    post(`/api/tasks/${k.id}/`, { done: v }).catch(() => setDone(({ [k.id]: _, ...rest }) => rest))
  }
  const save = (k: Task) => (b: Partial<Task>) => void post(`/api/tasks/${k.id}/`, b).then(t.refresh)
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    void post('/api/tasks/', { text }).then(() => { setText(''); t.refresh() })
  }
  const today = isoDay(new Date())
  const week = plusDays(7)
  const snoozed = items.filter(k => k.snoozed && k.snoozed > today)
  const awake = items.filter(k => !snoozed.includes(k))
  const groups: [string, Task[]][] = [
    ['Today', awake.filter(k => k.due && k.due <= today)],
    ['Upcoming', awake.filter(k => k.due && k.due > today && k.due <= week)],
    ['Later', awake.filter(k => !k.due || k.due > week)],
  ]
  const row = (k: Task) => <TaskRow key={k.id} k={k} isDone={isDone(k)} toggle={() => toggle(k)} save={save(k)} />
  return (
    <section aria-labelledby="lgd-todo-h" className="lgd-sec" data-column="act">
      <div className="lg-split"><h2 id="lgd-todo-h" className="lgd-h3">To-do</h2><span className="lg-dim lg-small">{awake.filter(k => !isDone(k)).length} open</span></div>
      <Quiet t={t} empty={false} what="to-dos" />
      {groups.filter(([, ks]) => ks.length).map(([name, ks]) => (
        <div key={name} role="group" aria-label={name}>
          <h3 className="lgd-task-group lg-xs lg-dim">{name}</h3>
          {ks.map(row)}
        </div>
      ))}
      {waits.length > 0 && (
        <div role="group" aria-label="Waiting on a reply">
          <h3 className="lgd-task-group lg-xs lg-dim">Waiting on</h3>
          {waits.map(x => (
            <div key={x.id} className="lgd-task" data-nav tabIndex={-1}>
              <span className="lg-grow lgd-wait">
                <span>{x.to} <span className="lg-dim">· {x.summary || x.subject}</span></span>
              </span>
              <span className="lg-xs lg-dim">{ago(x.sentAt)}</span>
              {x.url && <a className="lg-link lg-xs" href={x.url} target="_blank" rel="noreferrer" aria-label={`Open “${x.subject}” in Gmail`}>↗</a>}
              <button type="button" className="lg-link lg-xs" aria-keyshortcuts="X" onClick={() => drop(x)} aria-label={`Stop waiting on ${x.to}: ${x.subject}`}>✓</button>
            </div>
          ))}
        </div>
      )}
      {snoozed.length > 0 && (
        <details className="lgd-task-snoozed">
          <summary className="lg-xs lg-dim">{snoozed.length} snoozed</summary>
          {snoozed.map(row)}
        </details>
      )}
      <form className="lgd-adder" onSubmit={add}>
        <label htmlFor="lgd-new-task" className="visually-hidden">Add a to-do</label>
        <input id="lgd-new-task" className="lg-input lg-grow" placeholder="Add a to-do…" value={text} onChange={e => setText(e.target.value)} />
        <button type="submit" className="lg-btn lg-btn-sm">Add</button>
      </form>
    </section>
  )
}

const WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export function InboxZero({ t }: { t: TileState<never, Streak> }) {
  const s = t.res?.data
  const todayAt = (new Date().getDay() + 6) % 7
  return (
    <section aria-labelledby="lgd-streak-h" className="lgd-sec lgd-gap">
      <div className="lg-split"><h2 id="lgd-streak-h" className="lgd-h3">Inbox zero</h2>{s && <span className="lg-dim lg-small"><span className="lg-strong lgd-ink">{s.days} {s.days === 1 ? 'day' : 'days'}</span> in a row</span>}</div>
      {s ? (
        <div className="lgd-streak" role="img" aria-label={`This week: inbox zero on ${s.week.filter(Boolean).length} of ${todayAt + 1} days so far`}>
          {s.week.map((on, i) => <span key={i} className={on ? 'lgd-on' : i > todayAt ? 'lgd-future' : ''}><i />{WEEK[i]}</span>)}
        </div>
      ) : <Quiet t={t} empty what="the streak" />}
    </section>
  )
}

const money = (p: number) => `$${p % 1 ? p.toFixed(2) : p}`

export function PriceWatch({ t }: { t: TileState<Watch> }) {
  const items = t.res?.items ?? []
  const [editing, setEditing] = useState<Watch | 'new' | null>(null)
  const close = useCallback(() => setEditing(null), [])
  return (
    <section aria-labelledby="lgd-prices-h" className="lgd-sec">
      <div className="lg-split"><h2 id="lgd-prices-h" className="lgd-h3">Price watch</h2>
        <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" onClick={() => setEditing('new')}>+ Watch</button></div>
      <Quiet t={t} empty={items.length === 0} what="prices" />
      {items.map(w => {
        const low = w.sources.find(s => s.price === w.best && s.inStock !== false)
        const hit = w.best !== null && w.target !== null && w.best <= w.target
        const lowest = w.best !== null && w.low90 !== null && w.best <= w.low90
        return (
          <button key={w.id} type="button" className="lgd-pricerow" data-nav onClick={() => setEditing(w)}
            aria-label={`${w.name}: ${w.best !== null ? `cheapest ${money(w.best)}${low ? ` at ${low.store}` : ''}` : 'out of stock everywhere'}. Edit`}>
            <span className="lg-ellipsis lg-grow">{w.name}</span>
            <span className="lgd-price">
              {w.best !== null ? money(w.best) : 'out of stock'}
              <span className={hit ? '' : 'lg-dim'}>{hit ? 'at your target' : low ? `at ${low.store}` : w.checkedAt ? `checked ${ago(w.checkedAt)}` : ''}{!hit && w.target !== null ? ` · target ${money(w.target)}` : ''}{lowest ? ' · 90-day low' : ''}</span>
            </span>
          </button>
        )
      })}
      {editing && <PriceEditor watch={editing === 'new' ? null : editing} onClose={close} onSaved={() => { close(); t.refresh() }} />}
    </section>
  )
}

export function Reading({ news, social }: { news: TileState<Story, NewsTile>; social: TileState<SocialPost, { kept: number; scanned: number }> }) {
  const [tab, setTab] = useState<'news' | 'social'>('news')
  const stories = news.res?.data?.stories ?? []
  const posts = social.res?.items ?? []
  return (
    <section aria-labelledby="lgd-read-h" className="lgd-sec" data-column="read">
      <div className="lg-split lgd-center">
        <h2 id="lgd-read-h" className="lgd-h3">Reading</h2>
        <div className="lg-seg" role="group" aria-label="Feed">
          <button type="button" aria-pressed={tab === 'news'} onClick={() => setTab('news')}>News</button>
          <button type="button" aria-pressed={tab === 'social'} onClick={() => setTab('social')}>Social</button>
        </div>
      </div>
      {tab === 'news' ? (
        <>
          <Quiet t={news} empty={stories.length === 0} what="news" />
          {stories.slice(0, 6).map(n => (
            <a key={n.id} href={n.url} target="_blank" rel="noopener" className="lgd-story" data-nav>
              <span className="lg-dim lg-xs">{n.source}{n.at ? ` · ${ago(n.at)}` : ''}</span><span>{n.title}</span>
            </a>
          ))}
        </>
      ) : (
        <>
          <Quiet t={social} empty={posts.length === 0} what="social" />
          {posts.slice(0, 6).map(s => {
            const body = <><span className="lg-dim lg-xs">{s.network} · {s.who}</span><span>{s.text}</span></>
            return s.url ? <a key={s.id} href={s.url} target="_blank" rel="noopener" className="lgd-story" data-nav>{body}</a>
              : <div key={s.id} className="lgd-story" data-nav tabIndex={-1}>{body}</div>
          })}
        </>
      )}
    </section>
  )
}



type Editing = { id?: string; title: string; body: string }

export function Notes({ t }: { t: TileState<Note> }) {
  const items = t.res?.items ?? []
  const [editing, setEditing] = useState<Editing | null>(null)
  const done = () => { setEditing(null); t.refresh() }
  const save = () => editing && void post(editing.id ? `/api/notes/${editing.id}/` : '/api/notes/', editing).then(done)
  const remove = () => editing?.id && void post(`/api/notes/${editing.id}/`, { delete: true }).then(done)
  return (
    <section aria-labelledby="lgd-notes-h" className="lgd-sec">
      <div className="lg-split lgd-center">
        <h2 id="lgd-notes-h" className="lgd-h3">Notes</h2>
        {!editing && <button type="button" className="lg-btn lg-btn-quiet lg-btn-sm" onClick={() => setEditing({ title: '', body: '' })}>New note</button>}
      </div>
      {editing ? (
        <div className="lg-col lgd-pad">
          <label htmlFor="lgd-note-title" className="visually-hidden">Title</label>
          <input id="lgd-note-title" className="lg-input" placeholder="Title" value={editing.title} autoFocus onChange={e => setEditing({ ...editing, title: e.target.value })} />
          <label htmlFor="lgd-note-body" className="visually-hidden">Note</label>
          <textarea id="lgd-note-body" className="lg-textarea" rows={4} placeholder="Write it down…" value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} />
          <div className="lg-row">
            <button type="button" className="lg-btn lg-btn-primary lg-btn-sm" onClick={save}>Save</button>
            <button type="button" className="lg-btn lg-btn-sm" onClick={() => setEditing(null)}>Cancel</button>
            {editing.id && <button type="button" className="lg-btn lg-btn-danger lg-btn-sm lgd-push" onClick={remove}>Delete</button>}
          </div>
        </div>
      ) : (
        <>
          <Quiet t={t} empty={items.length === 0} what="notes" />
          {items.map(n => (
            <button key={n.id} type="button" className="lgd-note" data-nav onClick={() => setEditing({ id: n.id, title: n.title, body: n.body })}>
              {n.title && <span className="lg-strong">{n.title}</span>}
              <span className="lgd-note-body">{n.body}</span>
            </button>
          ))}
        </>
      )}
    </section>
  )
}
