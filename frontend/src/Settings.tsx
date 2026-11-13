import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { post, saveLocal } from './api'
import { ConnForm, ConnList } from './Connections'
import type { Conns } from './Connections'
import { Btn, LinkBtn, Window, wide } from './components/ui'
import { Shell } from './Shell'
import { applyMotion, applyTheme, initialReduceMotion, initialTheme, themeFor } from './theme'
import type { ThemeChoice } from './theme'
import tokens from './tokens.json'
import { ago } from './time'

type Settings = {
  email: { name: string; address: string; account: string; okAt: string | null; error: string }[]
  calendars: string[]
  feeds: { count: number; failing: string[] }
  models: { ollamaUp: boolean; geminiUp: boolean; ollamaModel: string; ollamaWhere: 'pc' | 'mac'; geminiKey: boolean }
  sendEmail: boolean
  geminiPrivate: boolean
  permissions: Record<Perm, Rule>
}
type Perm = 'sort' | 'tasks' | 'reply' | 'delete'
type Rule = 'allowed' | 'ask first' | 'never'

const SKIES: { value: ThemeChoice; label: string; preview: string }[] = [
  { value: 'auto', label: 'auto', preview: 'linear-gradient(90deg, #ff9ad5 0 33%, #8fd3ff 33% 66%, #2b1250 66%)' },
  { value: 'sunrise', label: 'sunrise', preview: tokens.sky.sunrise.background },
  { value: 'daydream', label: 'daydream', preview: tokens.sky.daydream.background },
  { value: 'midnight', label: 'midnight', preview: tokens.sky.midnight.background },
]

// what LifeHub may do on its own (the fetch run and ask.exe); your own clicks aren't limited by these.
// Each row is either a choice (Perm, its options) or fixed by how LifeHub is built.
const PERMS: { title: string; sub: string; perm?: Perm; options?: Rule[]; fixed?: Rule }[] = [
  { title: 'Read email, calendar and feeds', sub: 'both email accounts', fixed: 'allowed' },
  { title: 'Sort, label and archive email', sub: 'reply / fyi / newsletters / receipts, mark read', perm: 'sort', options: ['allowed', 'never'] },
  { title: 'Create tasks, notes and reminders', sub: 'to-dos found in email, and when you ask', perm: 'tasks', options: ['allowed', 'never'] },
  { title: 'Draft replies to email', sub: 'either account, for your stamp', perm: 'reply', options: ['ask first', 'never'] },
  { title: 'Delete email', sub: 'when you ask in ask.exe; moves to Trash after your stamp', perm: 'delete', options: ['ask first', 'never'] },
  { title: 'Accept, decline or move events', sub: 'not built: calendars are read-only', fixed: 'never' },
  { title: 'Post, comment or DM on social', sub: 'not connected', fixed: 'never' },
  { title: 'Unsubscribe from newsletters', sub: 'only from cleanup.exe, with your stamp', fixed: 'ask first' },
  { title: 'Spend money or buy anything', sub: '', fixed: 'never' },
]
const tone = (r: Rule) => (r === 'ask first' ? 'ask' : r === 'never' ? 'never' : '')

function Row({ ok, warn, title, sub, status, open, onManage, children }: { ok: boolean; warn?: boolean; title: string; sub?: string; status: string; open?: boolean; onManage?: () => void; children?: ReactNode }) {
  return (
    <>
      <div className="setting-row" data-nav tabIndex={-1}>
        <span className="what">
          <span className="status-sq" style={{ background: ok ? 'var(--mint)' : warn ? 'var(--yellow)' : 'var(--pink)' }} aria-hidden="true" />
          <span><b>{title}</b>{sub && <small>{sub}</small>}</span>
        </span>
        <span className="row gap8">
          <span className={`vt ${ok ? 'green' : 'magenta'}`} style={{ fontSize: 22 }}>{status}</span>
          {onManage && <Btn tone="face" size="sm" lower aria-expanded={open} onClick={onManage}>{open ? 'close' : 'manage'}</Btn>}
        </span>
      </div>
      {open && children}
    </>
  )
}

// control_panel (design/screens/VWSettings.dc.html) at /settings
export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [err, setErr] = useState('')
  const [sky, setSky] = useState<ThemeChoice>(initialTheme)
  const [still, setStill] = useState(initialReduceMotion)
  const [conns, setConns] = useState<Conns | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const loadSettings = () => fetch('/api/settings/', { credentials: 'same-origin' }).then(r => r.json()).then(setS)
  const manage = (key: string) => {
    setOpen(open === key ? null : key)
    if (!conns) fetch('/api/connections/', { credentials: 'same-origin' }).then(r => r.json()).then(setConns).catch(() => setErr('Couldn’t load connections.'))
  }
  const saved = (c: Conns) => { setConns(c); setOpen(null); void loadSettings() }
  const email = (name: string) => conns?.email.find(x => x.name === name)

  useEffect(() => {
    fetch('/api/settings/', { credentials: 'same-origin' }).then(r => {
      if (r.redirected) location.href = '/login/?next=/settings'
      return r.json()
    }).then(setS).catch(() => setErr('Couldn’t load settings.'))
  }, [])

  const pickSky = (t: ThemeChoice) => { setSky(t); saveLocal('theme', t); applyTheme(themeFor(new Date(), t)) }
  const setMotion = (v: boolean) => { setStill(v); saveLocal('reduceMotion', v); applyMotion(v) }
  const save = (change: object) => post<Settings>('/api/settings/', change).then(setS).catch(() => setErr('Couldn’t save.'))
  const setSend = (on: boolean) => save({ sendEmail: on })
  const cycleSky = (by: number) => pickSky(SKIES[(SKIES.findIndex(x => x.value === sky) + by + SKIES.length) % SKIES.length]!.value)

  return (
    <Shell screen="settings">
      <main className="shell">
        <header className="page-head">
          <LinkBtn tone="face" lower href="/">← dashboard</LinkBtn>
          <h1 className="page-title">{wide('CONTROL PANEL')}</h1>
          <span className="jp on-sky" aria-hidden="true">設定</span>
        </header>
        {err && <div role="alert" className="note-line err">{err}</div>}

        <div className="cp-grid">
          <Window name="connections.cpl" grad={1}>
            {!s ? <span className="loading-line cursor">loading</span> : (
              <>
                {s.email.map(a => (
                  <Row key={a.name} ok={!a.error && !!a.okAt} title={`${a.name} email`} sub={a.address}
                    status={a.error ? 'failing' : a.okAt ? `checked ${ago(a.okAt)}` : 'not fetched yet'} open={open === `email:${a.name}`} onManage={() => manage(`email:${a.name}`)}>
                    {conns ? <ConnForm kind="email" item={email(a.name)} topics={[]} onSaved={saved} onCancel={() => setOpen(null)} /> : <span className="loading-line cursor">loading</span>}
                  </Row>
                ))}
                <Row ok={s.calendars.length > 0} title="Calendars" sub={s.calendars.join(' + ') || 'none yet'} status={s.calendars.length ? 'connected' : 'none yet'} open={open === 'calendar'} onManage={() => manage('calendar')}>
                  {conns ? <ConnList kind="calendar" conns={conns} onSaved={saved} /> : <span className="loading-line cursor">loading</span>}
                </Row>
                <Row ok={!s.feeds.failing.length} warn title="News sources" sub={s.feeds.failing.length ? `failing: ${s.feeds.failing.join(', ')}` : `${s.feeds.count} feeds`} status={s.feeds.failing.length ? `${s.feeds.failing.length} of ${s.feeds.count} failing` : 'connected'} open={open === 'feed'} onManage={() => manage('feed')}>
                  {conns ? <ConnList kind="feed" conns={conns} onSaved={saved} /> : <span className="loading-line cursor">loading</span>}
                </Row>
                <Row ok={false} warn title="Social accounts" sub="LinkedIn, X, Instagram, Reddit" status="not built" />
                {open === 'new-email' ? (conns ? <ConnForm kind="email" topics={[]} onSaved={saved} onCancel={() => setOpen(null)} /> : <span className="loading-line cursor">loading</span>)
                  : <div className="row gap8 wrap">
                    <span className="small sub">add:</span>
                    {(['new-email', 'calendar', 'feed'] as const).map(k => (
                      <button key={k} type="button" className="add-conn" onClick={() => manage(k)}>+ {k === 'new-email' ? 'email account' : k === 'calendar' ? 'calendar' : 'news feed'}</button>
                    ))}
                  </div>}
                <span className="small sub">Changes here take over from lifehub.toml. Passwords and calendar addresses are stored in Lifehub's database and never shown again.</span>
              </>
            )}
          </Window>

          <div className="col" style={{ gap: 24 }}>
            <Window name="models.cpl" grad={4}>
              {s && (
                <div className="row wrap gap8">
                  <div className="model-card"><b style={{ color: 'var(--mint)' }}>● OLLAMA.LOCAL</b><span className="small">{s.models.ollamaModel} · {s.models.ollamaUp ? 'up' : 'away'}</span></div>
                  <div className="model-card"><b style={{ color: 'var(--cyan)' }}>● GEMINI.CLOUD</b><span className="small">{s.models.geminiUp ? 'up' : s.models.geminiKey ? 'down' : 'no API key'} · public data only</span></div>
                </div>
              )}
              {s && (
                <label className="row gap8" style={{ alignItems: 'flex-start' }} data-nav>
                  <input type="checkbox" checked={s.geminiPrivate} disabled={!s.models.geminiKey} onChange={e => void save({ geminiPrivate: e.target.checked })} />
                  <span><b>Allow Gemini for private data</b><br /><span className="small">
                    {s.models.geminiKey
                      ? (s.geminiPrivate ? 'On: email sorting, drafts, rewrites, the day brief, receipts and cleanup use Gemini first, Ollama if Gemini fails. ask.exe asks Gemini with Ctrl+Enter.'
                        : 'Off: email, notes, DMs and calendar run only on Ollama and wait if it’s down.')
                      : 'Needs gemini_api_key in lifehub.toml.'}
                  </span></span>
                </label>
              )}
              <label className="row gap8" style={{ alignItems: 'flex-start' }} data-nav>
                <input type="checkbox" checked={still} onChange={e => setMotion(e.target.checked)} />
                <span><b>Reduce motion</b><br /><span className="small">Turns off scanlines, blinking cursors and stamp animation on this device.</span></span>
              </label>
            </Window>

            <Window name="display.cpl · sky" grad={3} light>
              <div className="skies" role="radiogroup" aria-label="Sky">
                {SKIES.map(o => (
                  <label key={o.value} className="sky-opt">
                    <input type="radio" name="sky" className="visually-hidden" checked={sky === o.value} onChange={() => pickSky(o.value)} />
                    <span className="sky-swatch" style={{ background: o.preview }} />
                    <span>{sky === o.value ? '◉' : '○'} {o.label}</span>
                  </label>
                ))}
              </div>
              <span className="small">auto: sunrise before 12:00, daydream before 18:00, midnight after. Saved on this device.</span>
              <button type="button" className="visually-hidden" aria-keyshortcuts="ArrowRight" onClick={() => cycleSky(1)}>Next sky</button>
              <button type="button" className="visually-hidden" aria-keyshortcuts="ArrowLeft" onClick={() => cycleSky(-1)}>Previous sky</button>
            </Window>
          </div>
        </div>

        <Window name="permissions.cpl — what lifehub can do on its own" grad={1} jp="権限">
          {s && (
            <div className="setting-row" data-nav tabIndex={-1}>
              <span className="what"><span><b>Send or reply to email</b><small>approved replies, either account</small></span></span>
              <label className="visually-hidden" htmlFor="perm-send">Send or reply to email</label>
              <select id="perm-send" className={`field perm ${s.sendEmail ? 'ask' : 'never'}`} value={s.sendEmail ? 'send' : 'log'} onChange={e => void setSend(e.target.value === 'send')}>
                <option value="send">ask first, then send</option>
                <option value="log">ask first, only log</option>
              </select>
            </div>
          )}
          {s && PERMS.map(p => (
            <div key={p.title} className="setting-row" data-nav={p.perm ? true : undefined} tabIndex={p.perm ? -1 : undefined}>
              <span className="what"><span><b>{p.title}</b>{p.sub && <small>{p.sub}</small>}</span></span>
              {p.perm ? (
                <>
                  <label className="visually-hidden" htmlFor={`perm-${p.perm}`}>{p.title}</label>
                  <select id={`perm-${p.perm}`} className={`field perm ${tone(s.permissions[p.perm])}`} value={s.permissions[p.perm]}
                    onChange={e => void save({ permissions: { [p.perm!]: e.target.value } })}>
                    {p.options!.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </>
              ) : <span className={`perm-fixed ${tone(p.fixed!)}`}>{p.fixed}</span>}
            </div>
          ))}
          <span className="vt" style={{ fontSize: 24 }}>anything set to “ask first” lands in needs_your_stamp</span>
          <div><Btn tone="face" lower size="sm" onClick={() => (location.href = '/layout')}>layout.cpl →</Btn></div>
        </Window>
      </main>
    </Shell>
  )
}
