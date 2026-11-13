import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { design } from './design'
import { Keycap, Window, keyLabel } from './components/ui'
import keymap from './hotkeys.json'

// One key handler for the whole page, driven by hotkeys.json. A key runs a screen's own handler when it
// has one; otherwise it presses the visible button carrying that shortcut (aria-keyshortcuts), first
// inside the selected list item, then on the page. So every key has a button, and they can't drift.

export type Screen = keyof typeof keymap.screens
type Entry = { keys: string[]; alt?: string[]; action: string; label: string }
export type Handlers = Partial<Record<string, () => void>>

const SEQ_MS = 1000
// each design loads only its own Ask panel, and only once you open it
const AskPanel = lazy(() => design === 'retro'
  ? import('./CommandPanel').then(m => ({ default: m.CommandPanel }))
  : import('./ledger/Ask').then(m => ({ default: m.Ask })))
const isField = (el: Element | null) => !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (el as HTMLElement).isContentEditable)
const visible = (el: Element) => (el as HTMLElement).offsetParent !== null || getComputedStyle(el).position === 'fixed'

// a keydown as hotkeys.json spells it: "J", "Shift+U", "Meta+Enter", "Alt+1", "?"
export function eventKey(e: KeyboardEvent) {
  let k = e.key === ' ' ? 'Space' : e.key
  // Alt and ⌘ change what e.key says on a Mac; the physical key doesn't lie
  const phys = e.code.match(/^(?:Key|Digit)(.)$/)?.[1]
  if ((e.altKey || e.metaKey || e.ctrlKey) && phys) k = phys
  if (k.length === 1) k = k.toUpperCase()
  const mods = [
    (e.metaKey || e.ctrlKey) && 'Meta',
    e.altKey && 'Alt',
    e.shiftKey && (k.length > 1 || /^[A-Z]$/.test(k)) && 'Shift',
  ].filter(Boolean)
  return [...mods, k].join('+')
}

function navItems() {
  return [...document.querySelectorAll<HTMLElement>('[data-nav]')].filter(visible)
}

function move(by: number) {
  const items = navItems()
  if (!items.length) return
  const at = items.findIndex(el => el.contains(document.activeElement))
  const next = items[at < 0 ? (by > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + by))]!
  next.focus()
  next.scrollIntoView({ block: 'nearest' })
}

// the button for this key: inside the focused window with its own keys (e.g. a focused card), else the selected item,
// else anywhere on the page outside list items and outside those windows
function press(key: string) {
  const sel = `[aria-keyshortcuts~="${CSS.escape(key)}"]`
  const usable = (el: HTMLElement) => !el.matches(':disabled') && (visible(el) || el.classList.contains('visually-hidden'))
  const scope = document.activeElement?.closest('[data-scope]')
  const item = document.activeElement?.closest('[data-nav]')
  const target = (scope && [...scope.querySelectorAll<HTMLElement>(sel)].find(usable))
    ?? (item && [...item.querySelectorAll<HTMLElement>(sel)].find(el => !el.matches(':disabled')))
    ?? [...document.querySelectorAll<HTMLElement>(sel)].find(el => !el.closest('[data-nav]') && !el.closest('[data-scope]') && usable(el))
  if (!target) return false
  if (target instanceof HTMLSelectElement) target.focus()
  else target.click()
  return true
}

type ShellApi = { openAsk: () => void }
const ShellContext = createContext<ShellApi>({ openAsk: () => {} })
export const useShell = () => useContext(ShellContext)

export function Shell({ screen, handlers = {}, onAskClosed, children }: { screen: Screen; handlers?: Handlers; onAskClosed?: () => void; children: ReactNode }) {
  const [panel, setPanel] = useState(false)
  const [asking, setAsking] = useState(false)
  const latest = useRef({ handlers, panel, asking, screen })
  latest.current = { handlers, panel, asking, screen }
  const pendingG = useRef<ReturnType<typeof setTimeout> | null>(null)

  const closeAsk = useCallback(() => { setAsking(false); onAskClosed?.() }, [onAskClosed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      const { handlers: h, panel: p, asking: a, screen: s } = latest.current
      const key = eventKey(e)
      const typing = isField(document.activeElement)

      if (key === 'Escape') {
        if (typing || document.activeElement?.closest('[data-scope]')) { (document.activeElement as HTMLElement).blur(); return }
        if (a) return // the ask dialog closes itself
        if (p) { setPanel(false); return }
        if (h.closeOrBack) { h.closeOrBack(); return }
        if (s !== 'dashboard') location.href = '/'
        return
      }
      if (key === 'Meta+K' || (key === '/' && !typing)) { e.preventDefault(); setAsking(true); return }
      if (a) return // ask.exe has its own keys

      const modified = key.includes('Meta+') || key.includes('Alt+')
      if (typing && !modified) return
      // Ctrl+Backspace deletes a word on Windows: inside a field it never discards a draft
      if (typing && key === 'Meta+Backspace') return

      // G then a letter: go somewhere
      if (pendingG.current) {
        clearTimeout(pendingG.current)
        pendingG.current = null
        const go = (keymap.global as Entry[]).find(g => g.keys[0] === 'G' && g.keys[1] === key)
        if (go) { e.preventDefault(); location.href = go.action.slice('goto:'.length) }
        return
      }
      if (key === 'G') { pendingG.current = setTimeout(() => { pendingG.current = null }, SEQ_MS); return }
      if (key === '?' || key === 'Shift+?') { setPanel(v => !v); return }
      if (key === 'B' && h.toggleActivityTray) { h.toggleActivityTray(); return }

      // a window with its own keys (e.g. a focused card) takes them while it has focus
      const scope = document.activeElement?.closest<HTMLElement>('[data-scope]')?.dataset.scope as Screen | undefined
      const entry = (keymap.screens[scope ?? s] as Entry[]).find(x => x.keys.length === 1 ? x.keys[0] === key : x.keys.includes(key))
      if (!entry) return
      const [action, arg] = entry.action.split(':')
      if (h[entry.action]) { e.preventDefault(); h[entry.action]!(); return }
      if (action === 'next' || action === 'prev') { e.preventDefault(); move(action === 'next' ? 1 : -1); return }
      if (action === 'focusWindow') {
        const win = document.querySelector<HTMLElement>(`[data-scope="${arg}"]`)
        win?.focus(); win?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (action === 'focusColumn') {
        const first = document.querySelector<HTMLElement>(`[data-column="${arg}"] [data-nav]`)
        first?.focus(); first?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (action === 'open' && !typing) {
        const item = document.activeElement?.closest<HTMLElement>('[data-nav]')
        // the item's own "open" control first (a to-do's ▸), else its first link
        const target = item?.matches('a, button') ? item : item?.querySelector<HTMLElement>('[aria-keyshortcuts~="Enter"]') ?? item?.querySelector<HTMLElement>('a')
        if (item && document.activeElement === item && target) { e.preventDefault(); target.click() }
        return
      }
      if (press(key)) e.preventDefault()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  return (
    <ShellContext.Provider value={{ openAsk: () => setAsking(true) }}>
      {design === 'retro' && <div className="scanband" aria-hidden="true" />}
      {children}
      {design === 'retro'
        ? <HotkeysPanel screen={screen} open={panel} onToggle={() => setPanel(v => !v)} />
        : <LedgerKeys screen={screen} open={panel} onToggle={() => setPanel(v => !v)} />}
      {asking && <Suspense fallback={null}><AskPanel onClose={closeAsk} /></Suspense>}
    </ShellContext.Provider>
  )
}

const SCREEN_LABEL: Record<Screen, string> = {
  dashboard: 'on the dashboard', inbox: 'in the inbox', cleanup: 'in cleanup', approvalEdit: 'editing a draft',
  command: 'in ask.exe', settings: 'in the control panel', layout: 'in layout', activityTray: 'in the activity log',
  resources: 'on Resources',
}

function Keys({ e }: { e: Entry }) {
  const seq = e.keys.length > 1 && e.keys[0] === 'G'
  const list = seq ? [e.keys.join(' ')] : e.keys
  return (
    <span className="hk-keys">
      {list.map(k => (seq ? k.split(' ') : [k]).map((part, i) => <Keycap key={`${k}${i}`}>{keyLabel(part)}</Keycap>))}
      {e.alt?.map(k => <span key={k} className="row gap4 small">or <Keycap>{keyLabel(k)}</Keycap></span>)}
    </span>
  )
}

// the yellow [?] button in the bottom-left, and the list it opens; rows come straight from hotkeys.json
function HotkeysPanel({ screen, open, onToggle }: { screen: Screen; open: boolean; onToggle: () => void }) {
  const mine = keymap.screens[screen] as Entry[]
  const button = useRef<HTMLButtonElement>(null)
  // focus the list when it opens so ↑ ↓, Page Up/Down and Space scroll it; give focus back when it closes
  useEffect(() => {
    if (!open) return
    const list = document.querySelector<HTMLElement>('.hk-win .win-body')
    if (list) { list.tabIndex = -1; list.focus() }
    return () => button.current?.focus()
  }, [open])
  return (
    <div className="hk">
      {open && (
        <Window name="hotkeys.hlp · キー" grad={0} dialog className="hk-win" onClose={onToggle} label="Hotkeys">
          <span className="hk-head">&gt;&gt; {SCREEN_LABEL[screen]}</span>
          {mine.map(e => <div key={e.action + e.keys.join()} className="hk-row"><Keys e={e} /><span>{e.label}</span></div>)}
          <span className="hk-head">&gt;&gt; everywhere</span>
          {(keymap.global as Entry[]).map(e => <div key={e.action} className="hk-row"><Keys e={e} /><span>{e.label}</span></div>)}
        </Window>
      )}
      <button ref={button} type="button" className="hk-btn" aria-expanded={open} aria-keyshortcuts="?" onClick={onToggle}>
        <Keycap>?</Keycap>{open ? 'hide hotkeys' : 'hotkeys'}
      </button>
    </div>
  )
}

// the ledger's keys list: a quiet "?" in the corner and a panel above it
function LedgerKeys({ screen, open, onToggle }: { screen: Screen; open: boolean; onToggle: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    list.current?.focus()
    return () => button.current?.focus()
  }, [open])
  const rows = (entries: Entry[]) => entries.map(e => <div key={e.action + e.keys.join()} className="lg-keys-row"><span>{e.label}</span><Keys e={e} /></div>)
  return (
    <div className="lg-keys">
      {open && (
        <div ref={list} className="lg-keys-panel" role="dialog" aria-label="Keyboard shortcuts" tabIndex={-1}>
          <span className="lg-keys-head">Keys {SCREEN_LABEL[screen]}</span>
          {rows(keymap.screens[screen] as Entry[])}
          <span className="lg-keys-head">Everywhere</span>
          {rows(keymap.global as Entry[])}
        </div>
      )}
      <button ref={button} type="button" className="lg-iconbtn" aria-label={open ? 'Hide keyboard shortcuts' : 'Keyboard shortcuts'} aria-expanded={open} aria-keyshortcuts="?" onClick={onToggle}>?</button>
    </div>
  )
}
