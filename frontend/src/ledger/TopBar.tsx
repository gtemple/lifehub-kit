import { Fragment, useEffect, useState } from 'react'

import { useTile } from '../api'
import { useShell } from '../Shell'
import { Activity } from './Activity'
import { NAV_ICONS } from './navIcons'

export type Page = 'more' | 'dashboard' | 'inbox' | 'cleanup' | 'server' | 'resources' | 'settings'

// group: a divider goes between groups; Settings sits alone at the foot of the rail
const PAGES: [Page, string, string, string, number][] = [
  ['dashboard', '/', 'Home', 'G D', 0], ['inbox', '/inbox', 'Inbox', 'G I', 0], ['cleanup', '/cleanup', 'Cleanup', 'G C', 0],
  ['resources', '/resources', 'Resources', 'G R', 2],
  ['server', '/server', 'Server', 'G V', 3],
  ['settings', '/settings', 'Settings', 'G S', 9],
]

export const mac = navigator.platform.startsWith('Mac')

function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}






// the phone's bottom bar: three pages and More, which holds the rest
const TABS: Page[] = ['dashboard', 'inbox', 'cleanup']
const MORE_D = 'M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm56-12a12,12,0,1,0,12,12A12,12,0,0,0,196,116ZM60,116a12,12,0,1,0,12,12A12,12,0,0,0,60,116Z'

export const MORE_PAGES = PAGES.filter(p => !TABS.includes(p[0]))

export function TopBar({ page, tray, onUndone }: { page?: Page; tray: { open: boolean; setOpen: (v: boolean) => void }; onUndone?: () => void }) {
  const { openAsk } = useShell()
  const navTile = useTile<never, { replies: number; private: boolean; server: boolean; down: boolean }>('nav', 60_000)
  const nav = navTile.res?.data
  const weather = useTile<never, { city: string; tempC: number }>('weather', 30 * 60_000).res?.data
  const now = useNow()
  return (
    <>
    <nav className="lg-nav" aria-label="Lifehub">
      <a href="/" className="lg-brand" aria-label="Lifehub home"><img src={`${import.meta.env.BASE_URL}sun.svg`} alt="" width="36" height="36" /></a>
      {PAGES.filter(p => p[0] !== 'server' || nav?.server).map(([id, href, label, keys, group], i, shown) => (
        <Fragment key={id}>
          {i > 0 && group !== 9 && group !== shown[i - 1][4] && <span className="lg-nav-rule" aria-hidden="true" />}
          <a href={href} className={group === 9 ? 'lg-nav-foot' : undefined} aria-current={page === id ? 'page' : undefined} aria-keyshortcuts={keys} data-keys={keys}>
            <svg width="22" height="22" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d={NAV_ICONS[id][page === id ? 1 : 0]} /></svg>
            {label}
            {id === 'inbox' && !!nav?.replies && <span className="lg-badge" aria-label={`, ${nav.replies} need a reply`}>{nav.replies}</span>}
            {id === 'server' && nav?.down && <span className="lg-alert" role="img" aria-label=", a container crashed" />}
          </a>
        </Fragment>
      ))}
    </nav>
    <nav className="lg-tabs" aria-label="Lifehub">
      {[...TABS, 'more' as Page].map(id => {
        const on = id === 'more' ? page === 'more' || MORE_PAGES.some(p => p[0] === page) : page === id
        return (
          <a key={id} href={id === 'more' ? '/more' : PAGES.find(p => p[0] === id)![1]} aria-current={on ? 'page' : undefined}>
            <svg width="24" height="24" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d={id === 'more' ? MORE_D : NAV_ICONS[id][on ? 1 : 0]} /></svg>
            {id === 'more' ? 'More' : PAGES.find(p => p[0] === id)![2]}
            {id === 'inbox' && !!nav?.replies && <span className="lg-badge" aria-label={`, ${nav.replies} need a reply`}>{nav.replies}</span>}
          </a>
        )
      })}
    </nav>
    <header className="lg-top">
      <div className="lg-top-in">
        {MORE_PAGES.some(p => p[0] === page) && <a href="/more" className="lg-back" aria-label="Back to More"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg></a>}
        <span className="lg-top-title">{page === 'more' ? 'More' : PAGES.find(p => p[0] === page)?.[2]}</span>
        <div className="lg-top-right">
          <span>{weather ? `${Math.round(weather.tempC)}° · ` : ''}{now.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[ap]\.?m\.?/i, '')}</span>
          <button type="button" className="lg-ask" aria-keyshortcuts="Meta+K" onClick={openAsk} aria-label="Ask Lifehub"><svg className="lg-ask-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg><span className="lg-ask-text">Ask Lifehub</span><span className="lg-hint">{mac ? '⌘K' : 'Ctrl K'}</span></button>
          <Activity open={tray.open} setOpen={tray.setOpen} onUndone={onUndone} />
        </div>
      </div>
      {navTile.failed
        ? <p role="status" className="lg-offline">Can’t reach Lifehub. What you see is from before; trying again every minute.</p>
        : nav?.private === false && <p role="status" className="lg-offline lg-offline-soft">Ollama is away and Gemini isn’t allowed for private mail, so new mail isn’t sorted or drafted and the morning brief waits.</p>}
    </header>
    </>
  )
}
