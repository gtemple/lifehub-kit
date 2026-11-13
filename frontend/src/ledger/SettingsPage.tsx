import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { loadLocal, post, saveLocal } from '../api'
import { ConnForm } from '../Connections'
import type { Conns, Kind } from '../Connections'
import { useActivityTray } from '../components/Notifications'
import { setDesign } from '../design'
import { DEFAULT_LEDGER_LAYOUT, LEDGER_NAMES, loadLedgerLayout, saveLedgerLayout } from '../layout'
import type { Layout } from '../layout'
import { Shell } from '../Shell'
import { applyMotion } from '../theme'
import { ago } from '../time'
import { TopBar } from './TopBar'
import './settings.css'

type Rule = 'allowed' | 'ask first' | 'never'
type Perm = 'sort' | 'tasks' | 'reply' | 'delete'
type Settings = {
  email: { name: string; address: string; account: string; okAt: string | null; error: string }[]
  calendars: string[]
  feeds: { count: number; failing: string[] }
  models: { ollamaUp: boolean; geminiUp: boolean; ollamaModel: string; ollamaWhere: 'pc' | 'mac'; geminiKey: boolean }
  sendEmail: boolean
  geminiPrivate: boolean
  permissions: Record<Perm, Rule>
}

const SECTIONS: [string, string][] = [['connections', 'Connections'], ['permissions', 'Permissions'], ['models', 'Models'], ['layout', 'Dashboard layout'], ['display', 'Display']]
const PERMS: [Perm, string, Rule[]][] = [
  ['sort', 'Sort, mark read and archive email', ['allowed', 'never']],
  ['tasks', 'Create to-dos and notes', ['allowed', 'never']],
  ['reply', 'Draft replies for your stamp', ['ask first', 'never']],
  ['delete', 'Queue deletions for your stamp', ['ask first', 'never']],
]
const RULE: Record<Rule, string> = { allowed: 'Allowed', 'ask first': 'Ask first', never: 'Never' }
const COLUMNS: [string, string][] = [['main', 'Main column'], ['side', 'Side column'], ['more', 'Third column (wide screens; under the side column otherwise)']]

function State({ tone, children }: { tone?: 'red' | 'yellow' | 'dim'; children: ReactNode }) {
  return <span className={`lg-state st-state${tone ? ` lg-${tone}` : ''}`}><span className="lg-dot" aria-hidden="true" />{children}</span>
}

// a two-way choice, as a segmented control; ← picks the first, → the second, Space flips
function Seg<T extends string>({ label, value, options, names, onPick }: { label: string; value: T; options: T[]; names: Record<string, string>; onPick: (v: T) => void }) {
  return (
    <div className="lg-seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} aria-pressed={value === o}
          aria-keyshortcuts={`${i === 0 ? 'ArrowLeft' : 'ArrowRight'}${value === o ? '' : ' Space'}`} onClick={() => value !== o && onPick(o)}>{names[o]}</button>
      ))}
    </div>
  )
}

export function SettingsPage() {
  const tray = useActivityTray()
  const [s, setS] = useState<Settings | null>(null)
  const [conns, setConns] = useState<Conns | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [still, setStill] = useState(() => loadLocal('reduceMotion', false))
  const [layout, setLayout] = useState<Layout>(loadLedgerLayout)
  const [dragging, setDragging] = useState<string | null>(null)
  const [current, setCurrent] = useState('connections')
  const refocus = useRef<string | null>(null)

  const loadSettings = () => fetch('/api/settings/', { credentials: 'same-origin' }).then(r => {
    if (r.redirected) location.href = `/login/?next=${location.pathname}`
    return r.json()
  }).then(setS)
  useEffect(() => {
    loadSettings().catch(() => setErr('Couldn’t load settings.'))
    fetch('/api/connections/', { credentials: 'same-origin' }).then(r => r.json()).then(setConns).catch(() => setErr('Couldn’t load connections.'))
  }, [])

  // /layout is this page, opened at Dashboard layout, once the sections exist; the side nav follows the scroll
  const loaded = !!s
  useEffect(() => {
    if (location.pathname.replace(/\/$/, '') === '/layout') document.getElementById('layout')?.scrollIntoView()
    const onScroll = () => {
      const top = (id: string) => document.getElementById(id)?.getBoundingClientRect().top ?? 1e9
      const at = SECTIONS.map(([id]) => id).filter(id => top(id) < 140)
      // the last section can't scroll up to the top: it counts once the page is at the bottom and it's well in view
      setCurrent(innerHeight + scrollY >= document.body.scrollHeight - 2 && top('display') < innerHeight * 0.6 ? 'display' : at.at(-1) ?? 'connections')
    }
    addEventListener('scroll', onScroll, { passive: true })
    return () => removeEventListener('scroll', onScroll)
  }, [loaded])

  const save = (change: object) => post<Settings>('/api/settings/', change).then(setS).catch(() => setErr('Couldn’t save.'))
  const saved = (c: Conns) => { setConns(c); setEditing(null); void loadSettings() }
  const setMotion = (v: boolean) => { setStill(v); saveLocal('reduceMotion', v); applyMotion(v) }

  const changeLayout = (l: Layout) => { setLayout(l); saveLedgerLayout(l) }
  const columnOf = (id: string) => Object.keys(layout.order).find(g => layout.order[g]!.includes(id))!
  // put id at index `to` of column g (it may come from the other column)
  const place = (id: string, g: string, to: number) => {
    const from = columnOf(id)
    const order = { ...layout.order, [from]: layout.order[from]!.filter(x => x !== id) }
    const list = [...order[g]!]
    list.splice(Math.max(0, Math.min(list.length, to)), 0, id)
    changeLayout({ ...layout, order: { ...order, [g]: list } })
  }
  const toggleHidden = (id: string) => changeLayout({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter(h => h !== id) : [...layout.hidden, id] })
  const selected = () => document.activeElement?.closest<HTMLElement>('[data-layout-id]')?.dataset.layoutId
  const nudge = (by: number) => {
    const id = selected()
    if (!id) return
    const g = columnOf(id), i = layout.order[g]!.indexOf(id)
    if (i + by < 0 || i + by >= layout.order[g]!.length) return
    refocus.current = id
    place(id, g, i + by)
  }
  useEffect(() => {
    if (!refocus.current) return
    document.querySelector<HTMLElement>(`[data-layout-id="${refocus.current}"]`)?.focus()
    refocus.current = null
  }, [layout])

  const handlers = {
    toggleActivityTray: tray.toggle,
    moveUp: () => nudge(-1), moveDown: () => nudge(1),
    toggleHidden: () => { const id = selected(); if (id) toggleHidden(id) },
    reset: () => changeLayout(DEFAULT_LEDGER_LAYOUT),
  }

  const conn = (kind: Kind, name: string) => conns?.[kind].find(x => x.name === name)
  const editRow = (key: string, form: ReactNode) => editing === key && <div className="st-form">{conns ? form : <span className="lg-empty">Loading…</span>}</div>
  const group = (kind: Kind, title: string, one: string, rows: ReactNode) => (
    <div className="st-group">
      <div className="st-group-head">
        <span className="lg-dim lg-small">{title}</span>
        <button type="button" className="lg-btn lg-btn-sm" aria-expanded={editing === `new-${kind}`} onClick={() => setEditing(editing === `new-${kind}` ? null : `new-${kind}`)}>+ Add {one}</button>
      </div>
      {editRow(`new-${kind}`, <ConnForm kind={kind} topics={conns?.topics ?? []} onSaved={saved} onCancel={() => setEditing(null)} />)}
      {Array.isArray(rows) && !rows.length && editing !== `new-${kind}` ? <div className="lg-empty">None yet.</div> : rows}
    </div>
  )
  const connRow = (kind: Kind, name: string, detail: string, state: ReactNode) => {
    const key = `${kind}:${name}`
    return (
      <div key={key}>
        <div className="st-conn" data-nav tabIndex={-1}>
          <div className="lg-grow"><div className="lg-strong">{name}</div><div className="lg-dim lg-xs lg-ellipsis st-sub">{detail}</div></div>
          {state}
          <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet st-edit" aria-expanded={editing === key} aria-label={`${editing === key ? 'Close' : 'Edit'} ${name}`} onClick={() => setEditing(editing === key ? null : key)}>{editing === key ? 'Close' : 'Edit'}</button>
        </div>
        {editRow(key, <ConnForm kind={kind} item={conn(kind, name)} topics={conns?.topics ?? []} onSaved={saved} onCancel={() => setEditing(null)} />)}
      </div>
    )
  }

  return (
    <Shell screen="settings" handlers={handlers}>
      <TopBar page="settings" tray={tray} />
      <div className="st-wrap">
        <nav className="st-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={current === id ? 'true' : undefined} onClick={() => setCurrent(id)}>{label}</a>)}
        </nav>
        <main className="st-main">
          <h1 className="lg-h1 st-h1">Settings</h1>
          {err && <div className="lg-error" role="alert">{err}</div>}

          <section id="connections" aria-labelledby="h-conn" className="st-section">
            <div className="lg-split"><h2 id="h-conn" className="st-h2">Connections</h2><span className="lg-dim lg-small">secrets are write-only: blank keeps what’s stored</span></div>
            {!s ? <div className="lg-empty">Loading…</div> : (
              <>
                {group('email', 'Email accounts', 'account', s.email.map(a => connRow('email', a.name, `${a.address} · ${conn('email', a.name)?.host || 'imap.gmail.com'}`,
                  a.error ? <State tone="red">failing</State> : a.okAt ? <State>checked {ago(a.okAt)}</State> : <State tone="dim">not fetched yet</State>)))}
                {group('calendar', 'Calendars', 'calendar', (conns?.calendar ?? []).map(c => connRow('calendar', c.name, `${c.account ?? ''} · ${c.urlHint ?? ''}`, <State>connected</State>)))}
                {group('feed', 'News feeds', 'feed', (conns?.feed ?? []).map(f => connRow('feed', f.name, `${f.topic || 'no topic'} · ${(f.url ?? '').replace(/^https?:\/\/(www\.)?/, '')}`,
                  s.feeds.failing.includes(f.name) ? <State tone="yellow">failing</State> : <State>connected</State>)))}
              </>
            )}
          </section>

          <section id="permissions" aria-labelledby="h-perm" className="st-section st-tight">
            <h2 id="h-perm" className="st-h2">What Lifehub can do on its own</h2>
            <p className="lg-dim st-lede">Your own clicks aren’t limited by these. Sending, deleting and unsubscribing always wait for a stamp.</p>
            {s && PERMS.map(([perm, label, options]) => (
              <div key={perm} className="st-perm" data-nav tabIndex={-1}>
                <span>{label}</span>
                <Seg label={label} value={s.permissions[perm]} options={options} names={RULE} onPick={v => void save({ permissions: { [perm]: v } })} />
              </div>
            ))}
            {s && (
              <div className="st-perm" data-nav tabIndex={-1}>
                <span>Send approved replies<span className="lg-dim lg-xs st-sub st-block">Off: approving only logs what would have been sent.</span></span>
                <Seg label="Send approved replies" value={s.sendEmail ? 'send' : 'log'} options={['send', 'log']} names={{ send: 'Send', log: 'Only log' }} onPick={v => void save({ sendEmail: v === 'send' })} />
              </div>
            )}
          </section>

          <section id="models" aria-labelledby="h-models" className="st-section st-tight">
            <h2 id="h-models" className="st-h2">Models</h2>
            {s && (
              <>
                <div className="st-model">
                  <div><div className="lg-strong">Ollama</div><div className="lg-dim lg-xs st-sub">{s.models.ollamaModel}</div></div>
                  {s.models.ollamaUp ? <State>up</State> : <State tone="dim">away</State>}
                </div>
                <div className="st-model">
                  <div><div className="lg-strong">Gemini</div><div className="lg-dim lg-xs st-sub">{s.models.geminiKey ? (s.geminiPrivate ? 'public and private data' : 'public data only') : 'needs gemini_api_key in lifehub.toml'}</div></div>
                  {s.models.geminiUp ? <State>up</State> : s.models.geminiKey ? <State tone="red">down</State> : <State tone="dim">no API key</State>}
                </div>
                <label className="st-toggle" data-nav tabIndex={-1}>
                  <span><span className="lg-strong">Allow Gemini for private data</span><span className="lg-dim lg-xs st-sub st-block">
                    {s.geminiPrivate ? 'On: mail sorting, drafts, the brief and cleanup use Gemini first, Ollama if it fails.' : 'Off: mail, notes and calendar run only on Ollama and wait if it’s away.'}
                  </span></span>
                  <input type="checkbox" className="lg-switch" aria-keyshortcuts="Space" checked={s.geminiPrivate} disabled={!s.models.geminiKey} onChange={e => void save({ geminiPrivate: e.target.checked })} />
                </label>
              </>
            )}
          </section>

          <section id="layout" aria-labelledby="h-layout" className="st-section" data-scope="layout">
            <div className="lg-split">
              <h2 id="h-layout" className="st-h2">Dashboard layout</h2>
              <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" aria-keyshortcuts="R" onClick={handlers.reset}>Reset</button>
            </div>
            <p className="lg-dim st-lede">Drag to reorder, or select one and use Shift ↑ / Shift ↓; H hides it. Saved on this device.</p>
            <div className="st-cols">
              {COLUMNS.map(([g, title]) => (
                <div key={g} className="st-col" role="list" aria-label={title}
                  onDragOver={e => { if (dragging) e.preventDefault() }}
                  onDrop={e => { e.preventDefault(); if (dragging && columnOf(dragging) !== g) place(dragging, g, layout.order[g]!.length); setDragging(null) }}>
                  <span className="lg-dim lg-xs st-col-title">{title}</span>
                  {layout.order[g]!.map((id, i) => {
                    const hidden = layout.hidden.includes(id)
                    return (
                      <div key={id} role="listitem" className={`st-lay${hidden ? ' st-off' : ''}${dragging === id ? ' st-dragging' : ''}`} data-nav data-layout-id={id} tabIndex={0} draggable
                        aria-label={`${LEDGER_NAMES[id]}, ${i + 1} of ${layout.order[g]!.length}${hidden ? ', hidden' : ''}`}
                        onDragStart={e => { setDragging(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id) }}
                        onDragEnd={() => setDragging(null)}
                        onDragOver={e => { if (dragging) e.preventDefault() }}
                        onDrop={e => {
                          e.preventDefault(); e.stopPropagation()
                          if (!dragging || dragging === id) return setDragging(null)
                          const r = e.currentTarget.getBoundingClientRect()
                          const without = layout.order[g]!.filter(x => x !== dragging)
                          place(dragging, g, without.indexOf(id) + (e.clientY > r.top + r.height / 2 ? 1 : 0))
                          setDragging(null)
                        }}>
                        <span className="st-grip" aria-hidden="true">⋮⋮</span>
                        <span className="lg-grow">{LEDGER_NAMES[id]}</span>
                        <input type="checkbox" className="lg-check" checked={!hidden} aria-label={`Show ${LEDGER_NAMES[id]}`} onChange={() => toggleHidden(id)} />
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </section>

          <section id="display" aria-labelledby="h-display" className="st-section st-tight">
            <h2 id="h-display" className="st-h2">Display</h2>
            <label className="st-toggle" data-nav tabIndex={-1}>
              <span>Reduce motion<span className="lg-dim lg-xs st-sub st-block">Stills the radio ticker, pulses and animations on this device.</span></span>
              <input type="checkbox" className="lg-switch" aria-keyshortcuts="Space" checked={still} onChange={e => setMotion(e.target.checked)} />
            </label>
            <label className="st-toggle" data-nav tabIndex={-1}>
              <span>Classic look<span className="lg-dim lg-xs st-sub st-block">The retro windows design, on this device only.</span></span>
              <input type="checkbox" className="lg-switch" aria-keyshortcuts="Space" checked={false} onChange={() => setDesign('retro')} />
            </label>
          </section>
        </main>
      </div>
    </Shell>
  )
}
