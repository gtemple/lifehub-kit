import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { post } from '../api'
import { useActivityTray } from '../components/Notifications'
import { Shell } from '../Shell'
import { TopBar } from './TopBar'
import './server.css'

// Server: this machine's memory budget and the controls for its stacks, containers, pm2 apps and Ollama (hub/server.py)

type Kind = 'container' | 'stack' | 'app' | 'ollama'
type Item = { id: string; name: string; used: number; limit: number | null }
type Stack = { name: string; files: string[]; containers: number; running: number; state: string; used: number }
type Container = { name: string; image: string; state: string; status: string; project: string; service: string; used: number; cpu: string; limit: number | null; update: boolean | null; built: boolean }
type App = { name: string; status: string; used: number; cron: string; restarts: number }
type Model = { name: string; size: number }
type Ollama = { up: boolean; loaded: (Model & { until: string })[]; installed: (Model & { inUse: boolean })[] }
type State = { total: number | null; used: number | null; items: Item[]; limits: number; cores: number; upSince: number | null; stacks: Stack[]; containers: Container[]; apps: App[]; ollama: Ollama }
type Target = { name: string; label: string; used: number; limit: number | null; total: number }

const GB = 2 ** 30, MB = 2 ** 20
const size = (b: number | null) => !b ? 'none' : b >= GB ? `${(b / GB).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.round(b / MB)} MB`
const SHADES = ['#F5F5F5', '#5A5A5A', '#BDBDBD', '#8C8C8C', '#3D3D3D', '#707070', '#A6A6A6', '#4A4A4A']
const upFor = (since: number) => {
  const h = (Date.now() / 1000 - since) / 3600
  return h < 48 ? `up ${Math.max(1, Math.round(h))} h` : `up ${Math.round(h / 24)} days`
}
// "768 MB", "1.5gb", "800" (MB) -> bytes
const parseSize = (s: string) => {
  const m = s.trim().match(/^([\d.]+)\s*(m|mb|g|gb)?$/i)
  if (!m) return null
  return Math.round(parseFloat(m[1]) * (/^g/i.test(m[2] ?? '') ? GB : MB))
}

function useServer() {
  const [data, setData] = useState<State | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => fetch('/api/server/', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() as Promise<State> : Promise.reject(new Error(String(r.status)))))
    .then(d => { setData(d); setErr('') }, (e: Error) => setErr(e.message)), [])
  useEffect(() => {
    void load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])
  return { data, err, load }
}

export function ServerPage() {
  const tray = useActivityTray()
  const { data, err, load } = useServer()
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [limitFor, setLimitFor] = useState<Target | null>(null)
  const [logsFor, setLogsFor] = useState<{ kind: Kind; name: string; container?: Container } | null>(null)

  // every control confirms when it interrupts something, then reloads and says what happened
  const act = (kind: Kind, name: string, action: string, ask?: string, value?: number | null) => {
    if (ask && !confirm(ask)) return Promise.resolve(false)
    setBusy(`${kind}:${name}:${action}`); setNote(null)
    return post<{ done: string }>('/api/server/act/', { kind, name, action, value })
      .then(r => { setNote({ text: r.done }); return load().then(() => true) }, (e: Error) => { setNote({ text: e.message, bad: true }); return false })
      .finally(() => setBusy(''))
  }
  const isBusy = (kind: Kind, name: string, action: string) => busy === `${kind}:${name}:${action}`

  return (
    <Shell screen="server" handlers={{
      toggleActivityTray: tray.toggle,
      // Escape closes an open drawer first, then goes home like every page
      closeOrBack: () => { if (limitFor) setLimitFor(null); else if (logsFor) setLogsFor(null); else location.href = '/' },
    }}>
      <TopBar page="server" tray={tray} />
      <main className="lg-main sv-main">
        <header className="sv-head">
          <div className="lg-col sv-gap6">
            <span className="lg-dim">Server</span>
            <h1 className="lg-h1">This machine</h1>
            {data && <span className="lg-dim">{data.cores} threads{data.total ? ` · ${size(data.total)} memory` : ''}{data.upSince ? ` · ${upFor(data.upSince)}` : ''}</span>}
          </div>
        </header>
        {note && <p role="status" className={note.bad ? 'lg-error' : 'lg-dim'}>{note.text}</p>}
        {!data ? <p className={err ? 'lg-error' : 'lg-empty'}>{err ? `Couldn’t load the server: ${err}` : 'Loading…'}</p> : (
          <>
            {data.total != null && data.used != null && <Budget data={{ ...data, total: data.total, used: data.used }} />}
            <Stacks data={data} act={act} isBusy={isBusy} onLogs={name => setLogsFor({ kind: 'stack', name })} />
            <Containers data={data} act={act} isBusy={isBusy}
              onLimit={c => setLimitFor({ name: c.name, label: c.project ? `${c.project} stack · ${c.image}` : c.image, used: c.used, limit: c.limit, total: data.total ?? 0 })}
              onLogs={c => setLogsFor({ kind: 'container', name: c.name, container: c })} />
            <div className={data.apps.length ? 'sv-two' : undefined}>
              {data.apps.length > 0 && <Apps data={data} act={act} isBusy={isBusy} onLogs={name => setLogsFor({ kind: 'app', name })} />}
              <OllamaPanel o={data.ollama} act={act} isBusy={isBusy} />
            </div>
            <p className="lg-dim sv-foot">Every stop, restart, limit change and update asks first and lands in the bell. Container limits are written to an override file beside each compose file, so they survive rebuilds.</p>
          </>
        )}
      </main>
      {limitFor && data && <LimitDrawer t={limitFor} data={data} onClose={() => setLimitFor(null)}
        onSave={v => act('container', limitFor.name, 'limit', undefined, v).then(ok => { if (ok) setLimitFor(null) })} />}
      {logsFor && <LogsDrawer target={logsFor} onClose={() => setLogsFor(null)}
        onUpdate={c => act('container', c.name, 'update', `Pull the newest ${c.image} and recreate ${c.name}? It is offline for a few seconds.`).then(ok => { if (ok) setLogsFor(null) })}
        onRebuild={c => act('container', c.name, 'rebuild', `Rebuild ${c.name} from source and recreate it? Building can take a few minutes; it is offline for a few seconds at the end.`).then(ok => { if (ok) setLogsFor(null) })} />}
    </Shell>
  )
}

type Act = (kind: Kind, name: string, action: string, ask?: string, value?: number | null) => Promise<boolean>
type Busy = (kind: Kind, name: string, action: string) => boolean

function Budget({ data }: { data: State & { total: number; used: number } }) {
  const shade = (i: number) => SHADES[i % SHADES.length]
  const scale = Math.max(data.total, data.limits)
  const pct = (b: number, of: number) => `${(b / of * 100).toFixed(2)}%`
  const over = data.limits > data.total
  const uncapped = data.items.filter(i => !i.limit && i.used).map(i => i.name)
  return (
    <section aria-labelledby="sv-budget-h" className="lg-col sv-gap16">
      <div className="lg-split lg-wrap">
        <h2 id="sv-budget-h" className="sv-h2">Memory budget</h2>
        <span className="lg-dim"><span className="sv-ink sv-b">{size(data.used)} of {size(data.total)} in use</span> · {size(data.total - data.used)} free</span>
      </div>
      <div className="lg-col sv-gap6">
        <span className="lg-dim lg-xs">In use now</span>
        <div className="sv-bar" role="img" aria-label={`In use: ${data.items.filter(i => i.used).map(i => `${i.name} ${size(i.used)}`).join(', ')}; ${size(data.total - data.used)} free`}>
          {data.items.map((it, i) => it.used > 0 && <span key={it.id} style={{ width: pct(it.used, data.total), background: shade(i) }} />)}
        </div>
        <span className="lg-dim lg-xs sv-mt10">Limits</span>
        <div className="sv-bar sv-bar-thin" role="img" aria-label={`Limits: ${data.items.filter(i => i.limit).map(i => `${i.name} ${size(i.limit)}`).join(', ')}; ${size(data.limits)} of ${size(data.total)}`}>
          {data.items.map((it, i) => it.limit ? <span key={it.id} style={{ width: pct(it.limit, scale), background: shade(i) }} /> : null)}
        </div>
        <div className="lg-split lg-decor lg-xs"><span>0</span><span>{size(scale / 2)}</span><span>{size(scale)}</span></div>
      </div>
      <div className="sv-legend">
        {data.items.map((it, i) => (
          <div key={it.id}>
            <span className="lg-row sv-gap8 sv-b"><span aria-hidden="true" className="sv-swatch" style={{ background: shade(i) }} />{it.name}</span>
            <span className="lg-dim">{it.used ? size(it.used) : 'nothing running'} <span className="lg-decor">of {it.limit ? size(it.limit) + (it.id === 'os' ? ' reserved' : '') : 'no limit'}</span></span>
          </div>
        ))}
      </div>
      {over && <p className="sv-warn">Limits add up to {size(data.limits)} of {size(data.total)}. Fine while they don’t all peak at once; if they do, something gets squeezed. Lower a limit or keep the big ones apart.</p>}
      {!over && uncapped.length > 0 && <p className="lg-dim lg-small">No limit yet: {uncapped.join(', ')}. Without one they can use any free memory.</p>}
    </section>
  )
}

function Section({ id, title, sub, children }: { id: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="lg-col sv-gap0">
      <div className="lg-split sv-rowhead"><h2 id={id} className="sv-h2">{title}</h2><span className="lg-dim lg-small">{sub}</span></div>
      {children}
    </section>
  )
}

function Dot({ on }: { on: boolean }) {
  return <span aria-hidden="true" className={`sv-dot ${on ? '' : 'sv-dot-off'}`} />
}

function Stacks({ data, act, isBusy, onLogs }: { data: State; act: Act; isBusy: Busy; onLogs: (name: string) => void }) {
  if (!data.stacks.length) return null
  return (
    <Section id="sv-stacks-h" title="Stacks" sub="Docker Compose · up or down as a whole">
      {data.stacks.map(s => (
        <div key={s.name} className="sv-stack">
          <div className="lg-col sv-gap4 sv-min0">
            <span className="lg-row lg-wrap sv-gap10"><span className="sv-name">{s.name}</span><span className={`lg-row sv-gap6 lg-small ${s.running ? '' : 'lg-dim'}`}><Dot on={!!s.running} />{s.state}</span></span>
            <span className="lg-dim lg-small sv-ellipsis">{s.files.join(', ')} · {s.containers} container{s.containers === 1 ? '' : 's'}{s.used ? ` · ${size(s.used)}` : ''}</span>
          </div>
          <div className="lg-row sv-gap6">
            <button type="button" className="lg-btn" onClick={() => onLogs(s.name)} disabled={!s.containers}>Logs</button>
            {s.running
              ? <button type="button" className="lg-btn sv-tall" disabled={isBusy('stack', s.name, 'down')} onClick={() => void act('stack', s.name, 'down', `Bring ${s.name} down? Its containers stop and are removed; volumes and data stay.`)}>{isBusy('stack', s.name, 'down') ? 'Stopping…' : 'Down'}</button>
              : <button type="button" className="lg-btn lg-btn-primary sv-tall" disabled={isBusy('stack', s.name, 'up')} onClick={() => void act('stack', s.name, 'up')}>{isBusy('stack', s.name, 'up') ? 'Starting…' : 'Up'}</button>}
          </div>
        </div>
      ))}
    </Section>
  )
}

function Containers({ data, act, isBusy, onLimit, onLogs }: { data: State; act: Act; isBusy: Busy; onLimit: (c: Container) => void; onLogs: (c: Container) => void }) {
  if (!data.containers.length) return null
  return (
    <Section id="sv-ct-h" title="Containers" sub="memory now · limit · CPU">
      {data.containers.map(c => {
        const on = c.state === 'running'
        const full = on && c.limit ? c.used / c.limit : 0
        return (
          <div key={c.name} className={`sv-ct ${on ? '' : 'sv-off'}`}>
            <div className="lg-col sv-gap2 sv-min0">
              <span className="lg-row sv-gap8 sv-b"><Dot on={on} />{c.name}</span>
              <span className="lg-dim lg-xs sv-ellipsis">{c.image}{c.project ? ` · ${c.project}` : ''}{c.built ? ' · built here' : ''}
                {c.update && <button type="button" className="sv-update" onClick={() => onLogs(c)}>update available</button>}</span>
            </div>
            <div className="lg-col sv-gap6">
              <div className="sv-meter"><span style={{ width: on ? `${Math.max(2, Math.min(100, (c.limit ? full : data.total ? c.used / data.total : 0) * 100))}%` : '0%' }} className={full > 0.9 ? 'sv-hot' : ''} /></div>
              <span className="lg-dim lg-xs">{on ? `${size(c.used)} of ${c.limit ? size(c.limit) : 'no limit'}` : `${c.status.toLowerCase()} · limit ${c.limit ? size(c.limit) : 'none'}`}</span>
            </div>
            <span className="lg-dim sv-right">{on ? c.cpu : '–'}</span>
            <div className="lg-row lg-wrap sv-gap6 sv-actions">
              <button type="button" className="lg-btn lg-btn-sm sv-pill" aria-label={`Set memory limit for ${c.name}, now ${c.limit ? size(c.limit) : 'none'}`} onClick={() => onLimit(c)}>{c.limit ? size(c.limit) : 'No limit'}</button>
              <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" onClick={() => onLogs(c)}>Logs</button>
              {on && <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" disabled={isBusy('container', c.name, 'stop')} onClick={() => void act('container', c.name, 'stop', `Stop ${c.name}?`)}>Stop</button>}
              {on
                ? <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" disabled={isBusy('container', c.name, 'restart')} onClick={() => void act('container', c.name, 'restart', `Restart ${c.name}?`)}>{isBusy('container', c.name, 'restart') ? 'Restarting…' : 'Restart'}</button>
                : <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" disabled={isBusy('container', c.name, 'start')} onClick={() => void act('container', c.name, 'start')}>{isBusy('container', c.name, 'start') ? 'Starting…' : 'Start'}</button>}
            </div>
          </div>
        )
      })}
    </Section>
  )
}

function Apps({ data, act, isBusy, onLogs }: { data: State; act: Act; isBusy: Busy; onLogs: (name: string) => void }) {
  return (
    <Section id="sv-apps-h" title="Apps" sub="pm2">
      {data.apps.map(a => {
        const on = a.status === 'online'
        return (
          <div key={a.name} className="sv-app">
            <div className="lg-col sv-gap2 sv-min0">
              <span className="lg-row sv-gap8 sv-b"><Dot on={on} />{a.name}</span>
              <span className="lg-dim lg-xs sv-ellipsis">{a.cron ? `scheduled · ${a.cron}` : `${a.status} · ${a.restarts} restart${a.restarts === 1 ? '' : 's'}`}</span>
            </div>
            <span className="lg-soft sv-right">{on ? size(a.used) : '–'}</span>
            <div className="lg-row sv-gap6 sv-actions">
              <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" onClick={() => onLogs(a.name)}>Logs</button>
              <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" disabled={isBusy('app', a.name, 'restart')}
                onClick={() => void act('app', a.name, 'restart', a.cron ? undefined : `Restart ${a.name}?`)}>{isBusy('app', a.name, 'restart') ? '…' : a.cron ? 'Run now' : 'Restart'}</button>
            </div>
          </div>
        )
      })}
    </Section>
  )
}

function OllamaPanel({ o, act, isBusy }: { o: Ollama; act: Act; isBusy: Busy }) {
  const loaded = o.loaded[0]
  return (
    <Section id="sv-ollama-h" title="Ollama" sub="the model Lifehub uses">
      <div className="sv-ollama">
        <div className="lg-split lg-wrap">
          <div className="lg-col sv-gap4">
            <span className="lg-dim lg-xs">{o.up ? 'Loaded now' : 'Ollama isn’t answering'}</span>
            <span className="lg-big">{loaded ? loaded.name : o.up ? 'Nothing loaded' : '–'}</span>
            {loaded && <span className="lg-dim lg-small">{size(loaded.size)} · unloads {new Date(loaded.until).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })} if idle</span>}
          </div>
          <div className="lg-row sv-gap6">
            {loaded && <button type="button" className="lg-btn" disabled={isBusy('ollama', '', 'unload')} onClick={() => void act('ollama', '', 'unload')}>Unload now</button>}
          </div>
        </div>
      </div>
      <span className="lg-dim lg-xs sv-subhead">Installed models</span>
      {o.installed.map(m => {
        const isLoaded = o.loaded.some(l => l.name === m.name)
        return (
          <div key={m.name} className="sv-model">
            <span className="sv-b">{m.name}<span className="lg-dim lg-xs sv-note">{m.inUse ? 'in use · Lifehub mail and briefs' : isLoaded ? 'loaded' : 'not used'}</span></span>
            <span className="lg-dim">{size(m.size)}</span>
            {isLoaded
              ? <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" onClick={() => void act('ollama', m.name, 'unload')}>Unload</button>
              : m.inUse ? <span className="lg-dim lg-xs">in use</span>
              : <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" disabled={isBusy('ollama', m.name, 'remove')} onClick={() => void act('ollama', m.name, 'remove', `Remove ${m.name}? It frees ${size(m.size)} of disk; pulling it again takes a while.`)}>Remove</button>}
          </div>
        )
      })}
    </Section>
  )
}

const PRESETS = [256 * MB, 512 * MB, 768 * MB, GB, 2 * GB]

function LimitDrawer({ t, data, onClose, onSave }: { t: Target; data: State; onClose: () => void; onSave: (v: number | null) => void }) {
  const [value, setValue] = useState<number | null>(t.limit)
  const [custom, setCustom] = useState(t.limit ? size(t.limit) : '')
  const [saving, setSaving] = useState(false)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const pick = (v: number | null) => { setValue(v); setCustom(v ? size(v) : '') }
  // the budget with this one limit swapped: for a container in a stack, its share of the stack's total
  const after = data.limits - (t.limit ?? 0) + (value ?? 0)
  const scale = Math.max(t.total, data.limits, after)
  const tight = value !== null && t.used > 0 && value < t.used * 1.15
  const noun = 'limit'
  const save = () => { setSaving(true); onSave(value) }
  return (
    <>
      <div className="lg-backdrop" onClick={onClose} />
      <aside className="lg-drawer sv-drawer" role="dialog" aria-modal="true" aria-labelledby="sv-lim-h">
        <div className="lg-split">
          <div className="lg-col sv-gap4">
            <span className="lg-dim lg-small">Memory limit · container</span>
            <h2 id="sv-lim-h" className="sv-dh">{t.name}</h2>
            <span className="lg-dim lg-small">{t.label}</span>
          </div>
          <button type="button" ref={first} className="lg-iconbtn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="sv-facts">
          <div><span className="lg-dim lg-xs">Now</span><span className="sv-b">{t.used ? size(t.used) : 'not running'}</span></div>
          <div><span className="lg-dim lg-xs">Limit now</span><span className="sv-b">{t.limit ? size(t.limit) : 'none'}</span></div>
        </div>
        <fieldset className="sv-fieldset">
          <legend className="sv-b">New {noun}</legend>
          <div role="radiogroup" aria-label="Preset" className="lg-row lg-wrap sv-gap6">
            {PRESETS.map(p => <button key={p} type="button" role="radio" aria-checked={value === p} className={`lg-btn ${value === p ? 'lg-btn-primary' : ''}`} onClick={() => pick(p)}>{size(p)}</button>)}
            <button type="button" role="radio" aria-checked={value === null} className={`lg-btn ${value === null ? 'lg-btn-primary' : ''}`} onClick={() => pick(null)}>No {noun}</button>
          </div>
          <div className="lg-row lg-wrap sv-gap10">
            <label htmlFor="sv-custom" className="lg-dim lg-small">Custom</label>
            <input id="sv-custom" className="lg-input sv-custom" value={custom} placeholder="e.g. 768 MB" onChange={e => { setCustom(e.target.value); const v = parseSize(e.target.value); if (v) setValue(v) }} />
            <span className="lg-dim lg-xs">MB or GB</span>
          </div>
        </fieldset>
        <div className="lg-col sv-gap8">
          <div className="lg-split lg-dim lg-xs"><span>Limits on this machine</span><span>{t.total ? `${size(t.total)} total` : ''}</span></div>
          {[['Before', data.limits], ['After', after]].map(([label, v]) => (
            <div key={label as string} className="lg-row sv-gap10">
              <span className="lg-xs sv-w48">{label}</span>
              <div className="sv-bar sv-bar-thin sv-grow"><span style={{ width: `${(v as number) / scale * 100}%`, background: label === 'After' ? '#F5F5F5' : '#6B6B6B' }} /></div>
              <span className={`lg-xs sv-w64 sv-right ${t.total && (v as number) > t.total ? 'lg-yellow' : 'lg-dim'}`}>{size(v as number)}</span>
            </div>
          ))}
        </div>
        {tight && <p className="sv-warn">{size(value)} leaves little room above what it uses now ({size(t.used)}). A container that hits its limit is killed and restarted.</p>}
        <p className="lg-dim lg-xs sv-where">Applies right away. Saved to the stack’s compose override file so it survives rebuilds; the compose file itself isn’t touched. Removing a limit recreates the container.</p>
        <div className="lg-row sv-end">
          <button type="button" className="lg-btn sv-tall" onClick={onClose}>Cancel</button>
          <button type="button" className="lg-btn lg-btn-primary sv-tall" disabled={saving || value === t.limit} onClick={save}>{saving ? 'Saving…' : value ? `Set to ${size(value)}` : `Remove ${noun}`}</button>
        </div>
      </aside>
    </>
  )
}

const ERRORS = /error|warn|fatal|exception|traceback|panic|fail/i

function LogsDrawer({ target, onClose, onUpdate, onRebuild }: { target: { kind: Kind; name: string; container?: Container }; onClose: () => void; onUpdate: (c: Container) => void; onRebuild: (c: Container) => void }) {
  const [lines, setLines] = useState<string[] | null>(null)
  const [err, setErr] = useState('')
  const [paused, setPaused] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [filter, setFilter] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  useEffect(() => {
    if (paused) return
    const get = () => fetch(`/api/server/logs/?kind=${target.kind}&name=${encodeURIComponent(target.name)}`, { credentials: 'same-origin' })
      .then(r => r.json() as Promise<{ lines?: string[]; error?: string }>)
      .then(d => { if (d.error) setErr(d.error); else { setLines(d.lines ?? []); setErr('') } }, () => setErr('Couldn’t read the logs'))
    void get()
    const t = setInterval(get, 2_000)
    return () => clearInterval(t)
  }, [target, paused])
  useEffect(() => { if (!paused && box.current) box.current.scrollTop = box.current.scrollHeight }, [lines, paused])
  const f = filter.trim().toLowerCase()
  const shown = (lines ?? []).filter(l => (!errorsOnly || ERRORS.test(l)) && (!f || l.toLowerCase().includes(f)))
  const c = target.container
  return (
    <>
      <div className="lg-backdrop" onClick={onClose} />
      <aside className="lg-drawer sv-drawer sv-logs" role="dialog" aria-modal="true" aria-labelledby="sv-log-h">
        <div className="lg-split">
          <div className="lg-col sv-gap4">
            <span className="lg-dim lg-small">Logs · {target.kind === 'app' ? 'pm2 app' : target.kind} · {paused ? 'paused' : 'following live'}</span>
            <h2 id="sv-log-h" className="sv-dh">{target.name}</h2>
            {c && <span className="lg-dim lg-small">{c.image} · {c.status.toLowerCase()}{c.state === 'running' ? ` · ${size(c.used)} of ${c.limit ? size(c.limit) : 'no limit'}` : ''}</span>}
          </div>
          <button type="button" ref={first} className="lg-iconbtn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="lg-row lg-wrap sv-gap8">
          <label htmlFor="sv-log-filter" className="visually-hidden">Filter log lines</label>
          <input id="sv-log-filter" type="search" className="lg-input sv-grow sv-filter" placeholder="Filter lines" value={filter} onChange={e => setFilter(e.target.value)} />
          <div className="lg-seg" role="group" aria-label="Which lines">
            <button type="button" aria-pressed={!errorsOnly} onClick={() => setErrorsOnly(false)}>All</button>
            <button type="button" aria-pressed={errorsOnly} onClick={() => setErrorsOnly(true)}>Errors</button>
          </div>
          <button type="button" className="lg-btn" aria-pressed={paused} onClick={() => setPaused(p => !p)}>{paused ? 'Resume' : 'Pause'}</button>
        </div>
        <div ref={box} role="log" aria-label={`${target.name} log`} className="sv-logbox">
          {err ? <p className="lg-error">{err}</p> : !lines ? <p className="lg-dim">Loading…</p> : !shown.length ? <p className="lg-dim">{lines.length ? 'No lines match.' : 'Nothing logged yet.'}</p>
            : shown.map((l, i) => <div key={i} className={ERRORS.test(l) ? 'lg-yellow' : ''}>{l}</div>)}
        </div>
        {c?.built && c.project && (
          <section aria-labelledby="sv-rb-h" className="sv-update-box">
            <div className="lg-split lg-wrap"><h3 id="sv-rb-h" className="sv-h3">Built here</h3><span className="lg-dim lg-small">{c.image}</span></div>
            <p className="lg-soft sv-m0">This image comes from source, not a registry, so there’s no update to check for. Rebuild pulls newer base images, builds again from the stack’s files and recreates every container that runs it.</p>
            <div className="lg-row sv-end">
              <button type="button" className="lg-btn lg-btn-primary sv-tall" onClick={() => onRebuild(c)}>Rebuild and recreate</button>
            </div>
          </section>
        )}
        {c?.update && (
          <section aria-labelledby="sv-upd-h" className="sv-update-box">
            <div className="lg-split lg-wrap"><h3 id="sv-upd-h" className="sv-h3">Update available</h3><span className="lg-dim lg-small">{c.image}</span></div>
            <p className="lg-soft sv-m0">Pulls the newest image and recreates the container. Data in its volumes stays; it is offline for a few seconds{c.limit ? `, and its ${size(c.limit)} limit carries over` : ''}.</p>
            <div className="lg-row sv-end">
              <button type="button" className="lg-btn sv-tall" onClick={onClose}>Not now</button>
              <button type="button" className="lg-btn lg-btn-primary sv-tall" onClick={() => onUpdate(c)}>Update and recreate</button>
            </div>
          </section>
        )}
      </aside>
    </>
  )
}
