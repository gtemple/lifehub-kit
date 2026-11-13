import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { post, useTile } from './api'
import type { TileState } from './api'
import { Notifications, useActivityTray } from './components/Notifications'
import { Window, wide } from './components/ui'
import { setDesign } from './design'
import { loadLayout } from './layout'
import { Shell, useShell } from './Shell'
import { applyTheme, themeFor } from './theme'
import type { ThemeChoice, ThemeName } from './theme'
import { clock } from './time'
import { ACTIVITY_MS, NOTES_MS, Notes } from './tiles/Bottom'
import { APPROVALS_MS, Approvals, TASKS_MS, TODAY_MS, Tasks, Today } from './tiles/Act'
import { INBOX_MS, Inbox } from './tiles/Inbox'
import { NEWS_MS, News, SOCIAL_MS, Social } from './tiles/Read'
import { PRICES_MS, Prices } from './tiles/Prices'
import { EmailWeekTile, PACKAGES_MS, Packages, RENEWALS_MS, Renewals, STREAK_MS, StreakTile, WEEK_MS } from './tiles/Small'
import type { ActivityEntry, AgentStatus, Approval, CalendarEvent, Email, EmailWeek, InboxTile, MorningBrief, Note, NewsTile, Package, Renewal, SocialPost, Story, Streak, Task, Watch } from './types'

const STATUS_MS = 60_000
const BRIEF_MS = 10 * 60_000

// the sky follows the clock unless the control panel pins one
export function useTheme(choice: ThemeChoice) {
  const [name, setName] = useState<ThemeName>(themeFor(new Date(), choice))
  useEffect(() => {
    setName(themeFor(new Date(), choice))
    if (choice !== 'auto') return
    const id = setInterval(() => setName(themeFor(new Date(), choice)), 60_000)
    return () => clearInterval(id)
  }, [choice])
  useEffect(() => applyTheme(name), [name])
  return name
}

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

const GREETING: Record<ThemeName, [string, string]> = {
  sunrise: ['GOOD MORNING', 'おはようございます'],
  daydream: ['GOOD AFTERNOON', 'こんにちは'],
  midnight: ['GOOD EVENING', 'こんばんは'],
}
const MODEL_LINE = (s?: AgentStatus) => (!s || !s.online ? ['○ models offline', 'var(--magenta-text)'] : s.activeModel === 'gemini' ? ['● gemini.cloud', 'var(--green-text)'] : ['● ollama.local', 'var(--green-text)'])
const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()

function Taskbar({ status, weather, bell }: { status?: AgentStatus; weather?: { city: string; tempC: number }; bell: ReactNode }) {
  const { openAsk } = useShell()
  const now = useClock()
  const [line, color] = MODEL_LINE(status)
  return (
    <nav className="taskbar" aria-label="Taskbar">
      <a href="/" className="tb-btn tb-logo">✦ LIFEHUB</a>
      <button type="button" className="tb-btn tb-app" aria-keyshortcuts="Meta+K" onClick={openAsk}>ask.exe <span className="hint">⌘K</span></button>
      <a href="/inbox" className="tb-btn tb-app" aria-keyshortcuts="G I">inbox.exe <span className="hint">G I</span></a>
      <a href="/cleanup" className="tb-btn tb-app" aria-keyshortcuts="G C">cleanup.exe <span className="hint">G C</span></a>
      <a href="/layout" className="tb-btn tb-app" aria-keyshortcuts="G L">layout.cpl <span className="hint">G L</span></a>
      <a href="/settings" className="tb-btn tb-app" aria-keyshortcuts="G S">control_panel <span className="hint">G S</span></a>
      <button type="button" className="tb-btn tb-app" onClick={() => setDesign('ledger')}>new look</button>
      <span className="tb-status">
        <span style={{ color }}>{line}</span>
        {weather && <span className="tb-app">{weather.city} {Math.round(weather.tempC)}°</span>}
        <span className="tb-clock">{now.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }).toUpperCase()}</span>
      </span>
      {bell}
    </nav>
  )
}

function Hero({ theme }: { theme: ThemeName }) {
  const [title, jp] = GREETING[theme]
  return (
    <header className="hero">
      <div className="hero-sun" aria-hidden="true" />
      <div className="hero-floor" aria-hidden="true" />
      <svg className="hero-column" aria-hidden="true" width="90" height="210" viewBox="0 0 90 220">
        <rect x="10" y="0" width="70" height="16" fill="var(--face)" stroke="var(--ink)" strokeWidth="2" /><rect x="18" y="16" width="54" height="10" fill="var(--face)" stroke="var(--ink)" strokeWidth="2" /><rect x="22" y="26" width="46" height="170" fill="var(--face)" stroke="var(--ink)" strokeWidth="2" />
        <line x1="34" y1="30" x2="34" y2="192" stroke="#c79bff" strokeWidth="3" /><line x1="45" y1="30" x2="45" y2="192" stroke="#c79bff" strokeWidth="3" /><line x1="56" y1="30" x2="56" y2="192" stroke="#c79bff" strokeWidth="3" />
        <rect x="10" y="196" width="70" height="20" fill="var(--face)" stroke="var(--ink)" strokeWidth="2" />
      </svg>
      <svg className="hero-palm" aria-hidden="true" width="140" height="220" viewBox="0 0 140 230">
        <path d="M70 230 C72 170 66 120 74 60" fill="none" stroke="var(--ink)" strokeWidth="8" strokeLinecap="round" />
        <path d="M74 60 C50 40 20 46 4 70 M74 60 C96 36 124 40 138 64 M74 60 C64 30 40 14 18 16 M74 60 C86 28 110 14 132 18 M74 60 C70 34 74 10 82 2" fill="none" stroke="var(--ink)" strokeWidth="7" strokeLinecap="round" />
      </svg>
      <div className="hero-text">
        <span className="hero-jp" aria-hidden="true">{jp}</span>
        <h1 className="hero-title" aria-label={title.toLowerCase()}>{wide(title)}</h1>
        <span className="hero-name" aria-hidden="true">LIFEHUB.EXE</span>
      </div>
    </header>
  )
}

function Lead({ brief, status }: { brief: TileState<never, MorningBrief>; status?: AgentStatus }) {
  const { openAsk } = useShell()
  const [writing, setWriting] = useState(false)
  const [err, setErr] = useState('')
  const latest = brief.res?.data
  const b = latest && sameDay(latest.writtenAt) ? latest : null
  const write = () => {
    setWriting(true); setErr('')
    post('/api/brief/').then(brief.refresh).catch((e: Error) => setErr(e.message)).finally(() => setWriting(false))
  }
  const [line, color] = MODEL_LINE(status)
  return (
    <div className="lead">
      {brief.res && (
        <Window
          className="brief" grad={0} controls name={`day_brief.txt${b ? ` — ${clock(b.writtenAt)}` : ''}`}
          right={<button type="button" className="age-btn" aria-label={b ? 'Rewrite the brief' : 'Write the brief'} disabled={writing} onClick={write}>{writing ? '…' : '⟳'}</button>}
        >
          <p className={writing ? 'cursor' : ''}>{writing ? 'reading your mail, calendar and to-dos' : b ? b.text : 'nothing written yet today. it writes itself at 7:40, or press ⟳.'}</p>
          {err && <span role="alert" className="small magenta">{err}</span>}
        </Window>
      )}
      <button type="button" className="ask-term" onClick={openAsk} aria-keyshortcuts="Meta+K /">
        <span className="l1 cursor">C:\LIFEHUB&gt; ask</span>
        <span className="l2">Ask anything · {navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'} · <span className="jp" aria-hidden="true">質問する</span></span>
        <span className="l3" style={{ color: color === 'var(--green-text)' ? 'var(--mint)' : 'var(--pink)' }}>{line} {status?.online ? 'running' : ''}</span>
      </button>
    </div>
  )
}

export function App({ themeChoice }: { themeChoice: ThemeChoice }) {
  const theme = useTheme(themeChoice)
  const status = useTile<never, AgentStatus>('agent-status', STATUS_MS)
  const weather = useTile<never, { city: string; tempC: number }>('weather', 30 * 60_000)
  const brief = useTile<never, MorningBrief>('brief', BRIEF_MS)
  const approvals = useTile<Approval>('approvals', APPROVALS_MS)
  const tasks = useTile<Task>('tasks', TASKS_MS)
  const today = useTile<CalendarEvent>('calendar', TODAY_MS)
  const inbox = useTile<Email, InboxTile>('inbox', INBOX_MS)
  const news = useTile<Story, NewsTile>('news', NEWS_MS)
  const social = useTile<SocialPost, { kept: number; scanned: number }>('social', SOCIAL_MS)
  const streak = useTile<never, Streak>('streak', STREAK_MS)
  const packages = useTile<Package>('packages', PACKAGES_MS)
  const renewals = useTile<Renewal>('renewals', RENEWALS_MS)
  const week = useTile<never, EmailWeek>('week', WEEK_MS)
  const activity = useTile<ActivityEntry>('activity', ACTIVITY_MS)
  const notes = useTile<Note>('notes', NOTES_MS)
  const prices = useTile<Watch>('prices', PRICES_MS)
  const tray = useActivityTray()
  const [layout] = useState(loadLayout)

  // the agent may have drafted, added tasks or saved notes
  const askClosed = useCallback(() => {
    approvals.refresh(); tasks.refresh(); notes.refresh(); activity.refresh()
  }, [approvals.refresh, tasks.refresh, notes.refresh, activity.refresh])

  const tiles: Record<string, ReactNode> = {
    approvals: <Approvals t={approvals} onDecided={activity.refresh} />,
    tasks: <Tasks t={tasks} />,
    today: <Today t={today} />,
    inbox: <Inbox t={inbox} />,
    news: <News t={news} />,
    social: <Social t={social} />,
    streak: <StreakTile t={streak} />,
    packages: <Packages t={packages} />,
    renewals: <Renewals t={renewals} />,
    week: <EmailWeekTile t={week} />,
    notes: <Notes t={notes} />,
    prices: <Prices t={prices} />,
  }
  const group = (g: string) => layout.order[g]!.filter(id => !layout.hidden.includes(id)).map(id => <Fragment key={id}>{tiles[id]}</Fragment>)

  return (
    <Shell screen="dashboard" handlers={{ toggleActivityTray: tray.toggle }} onAskClosed={askClosed}>
      <Taskbar status={status.res?.data} weather={weather.res?.data} bell={<Notifications t={activity} onUndone={approvals.refresh} open={tray.open} setOpen={tray.setOpen} />} />
      <Hero theme={theme} />
      <main className="shell">
        <Lead brief={brief} status={status.res?.data} />
        <div className="columns">
          <div className="column" data-column="act"><h2 className="visually-hidden">Act</h2>{group('act')}</div>
          <div className="column" data-column="inbox"><h2 className="visually-hidden">Inbox</h2>{group('inbox')}</div>
          <div className="column" data-column="read"><h2 className="visually-hidden">Read</h2>{group('read')}</div>
        </div>
        {group('wide')}
        <div className="row4">{group('row4')}</div>
        <div className="row2">{group('row2')}</div>
      </main>
    </Shell>
  )
}
