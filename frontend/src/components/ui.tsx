import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

import type { EmailAccount, EmailGroup } from '../types'

// The Vaporwave primitives. Bevels, gradients and colours live in styles.css; these only pick the classes.

type WindowProps = {
  name: ReactNode // file-style title: inbox.exe, todo.lst
  grad?: number // which of the five title-bar gradients
  bar?: string // a one-off title-bar background, for windows the design paints differently
  jp?: string // small decorative label, always paired with the English name
  right?: ReactNode
  controls?: boolean // the decorative _ □ ×
  onClose?: () => void // a working × (dialogs and pages: close or back)
  closeHref?: string
  dialog?: boolean
  light?: boolean // dark title text, for the pale gradients
  className?: string
  bodyClass?: string
  id?: string
  label?: string
  children?: ReactNode
  foot?: ReactNode
  headingLevel?: 'h1' | 'h2' | 'h3'
}

// mint→cyan and pink→yellow are too pale for white titles
const PALE = [2, 3]

export function Window(p: WindowProps) {
  const H = p.headingLevel ?? 'h3'
  return (
    <section id={p.id} className={`win ${p.dialog ? 'dialog' : ''} ${p.className ?? ''}`} aria-label={p.label}>
      <div className={`win-bar ${p.light ?? PALE.includes((p.grad ?? 0) % 5) ? 'light' : ''}`} style={{ background: p.bar ?? `var(--grad-${(p.grad ?? 0) % 5})` }}>
        <H className="win-name">{p.name}</H>
        {p.right && <span className="win-right">{p.right}</span>}
        {p.jp && <span className="win-jp" aria-hidden="true">{p.jp}</span>}
        {p.controls && !p.onClose && !p.closeHref && (
          <span className="win-ctrl" aria-hidden="true"><span>_</span><span>□</span><span>×</span></span>
        )}
        {p.onClose && <button type="button" className="win-x" aria-label="Close" aria-keyshortcuts="Escape" onClick={p.onClose}>×</button>}
        {p.closeHref && <a className="win-x" href={p.closeHref} aria-label="Close">×</a>}
      </div>
      <div className={`win-body ${p.bodyClass ?? ''}`}>{p.children}</div>
      {p.foot && <div className="win-foot">{p.foot}</div>}
    </section>
  )
}

export type Tone = 'mint' | 'pink' | 'gray' | 'face' | 'yellow' | 'cyan' | 'ink'

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; k?: string; hint?: string; size?: 'sm' | 'lg'; lower?: boolean }

const cls = (tone: Tone, size?: 'sm' | 'lg', lower?: boolean, extra = '') => `bv bv-${tone} ${size ? `bv-${size}` : ''} ${lower ? 'bv-lower' : ''} ${extra}`

// a bevelled button; k is its hotkey, shown as a dimmed suffix and exposed with aria-keyshortcuts
export function Btn({ tone = 'gray', k, hint, size, lower, className, children, type = 'button', ...rest }: BtnProps) {
  return (
    <button type={type} className={cls(tone, size, lower, className)} aria-keyshortcuts={k} {...rest}>
      {children}{(hint ?? k) && <span className="hint" aria-hidden="true">{hint ?? keyLabel(k!)}</span>}
    </button>
  )
}

type LinkBtnProps = AnchorHTMLAttributes<HTMLAnchorElement> & { tone?: Tone; k?: string; hint?: string; size?: 'sm' | 'lg'; lower?: boolean }

export function LinkBtn({ tone = 'gray', k, hint, size, lower, className, children, ...rest }: LinkBtnProps) {
  return (
    <a className={cls(tone, size, lower, className)} aria-keyshortcuts={k} {...rest}>
      {children}{(hint ?? k) && <span className="hint" aria-hidden="true">{hint ?? keyLabel(k!)}</span>}
    </a>
  )
}

// "Meta+Enter" -> "Ctrl+↵" (⌘↵ on a Mac), "Shift+U" -> "⇧U", "G I" stays "G I"
export function keyLabel(k: string) {
  const mac = navigator.platform.startsWith('Mac')
  return k
    .replace('Meta+', mac ? '⌘' : 'Ctrl+').replace('Shift+', '⇧').replace('Alt+', mac ? '⌥' : 'Alt+')
    .replace('Enter', '↵').replace('Backspace', '⌫').replace('Escape', 'Esc').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→')
}

export function Keycap({ children }: { children: ReactNode }) {
  return <kbd className="keycap">{children}</kbd>
}

export type TagTone = 'cyan' | 'yellow' | 'pink' | 'gray' | 'mint' | 'purple' | 'face'

export function Tag({ tone = 'face', big, children }: { tone?: TagTone; big?: boolean; children: ReactNode }) {
  return <span className={`tag tag-${tone} ${big ? 'tag-lg' : ''}`}>{children}</span>
}

export const ACCT_TONE: Record<EmailAccount, TagTone> = { work: 'cyan', personal: 'yellow' }
export const GROUP_TONE: Record<EmailGroup, TagTone> = { needs_reply: 'pink', fyi: 'gray', newsletter: 'cyan', receipt: 'yellow' }
export const groupColor = (g: EmailGroup | '') => (g ? `var(--${GROUP_TONE[g]})` : 'var(--face)')

export function AccountTag({ account }: { account: EmailAccount }) {
  return <Tag tone={ACCT_TONE[account]}>{account === 'work' ? 'Work' : 'Personal'}</Tag>
}

export function Stamp({ yes }: { yes: boolean }) {
  return <div className={`stamp ${yes ? 'yes' : 'no'}`} role="status">{yes ? '承認 APPROVED' : '却下 NOPE'}</div>
}

export type Accent = 'pink' | 'cyan' | 'mint' | 'yellow' | 'purple'

export function Stat({ label, value, accent = 'pink', mini, color, children }: { label: ReactNode; value?: ReactNode; accent?: Accent; mini?: boolean; color?: string; children?: ReactNode }) {
  return (
    <div className={`stat a-${accent} ${mini ? 'stat-mini' : ''}`}>
      {!mini && <span className="stat-label" style={color ? { color } : undefined}>{label}</span>}
      {value !== undefined && <span className="stat-num">{value}</span>}
      {mini && <span className="stat-small">{label}</span>}
      {children}
    </div>
  )
}

export function MiniSun() {
  return <div className="mini-sun" aria-hidden="true" />
}

// full-width forms of ASCII, for the ＧＯＯＤ ＭＯＲＮＩＮＧ style headings
export const wide = (s: string) => s.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xfee0))
