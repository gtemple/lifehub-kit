import { loadLocal } from './api'
import tokens from './tokens.json'

export type ThemeName = keyof typeof tokens.sky
export type ThemeChoice = ThemeName | 'auto'

// the control panel picks a sky per device; ?theme=sunrise|daydream|midnight still wins, for previews
export const initialTheme = (new URLSearchParams(location.search).get('theme') ?? loadLocal('theme', 'auto')) as ThemeChoice

export function themeFor(date: Date, choice: ThemeChoice): ThemeName {
  if (choice !== 'auto' && choice in tokens.sky) return choice
  const h = date.getHours()
  return h < 12 ? 'sunrise' : h < 18 ? 'daydream' : 'midnight'
}

// every colour and font in tokens.json becomes a CSS variable; components only read var(--…)
export function applyTheme(name: ThemeName) {
  const c = tokens.color
  const vars: Record<string, string> = {
    ink: c.ink, 'ink-soft': c.inkSoft, face: c.face, paper: c.paper, gray: c.gray,
    pink: c.pink, cyan: c.cyan, mint: c.mint, purple: c.purple, yellow: c.yellow,
    'magenta-text': c.magentaText, 'green-text': c.greenText,
    sky: tokens.sky[name].background,
    'font-display': tokens.font.display, 'font-body': tokens.font.body, 'font-jp': tokens.font.jp,
    ...Object.fromEntries(tokens.titleBarGradients.map((g, i) => [`grad-${i}`, g])),
  }
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(`--${k}`, v)
  root.dataset.theme = name
}

// "Reduce motion" in the control panel, on top of the OS setting
export function applyMotion(reduce: boolean) {
  document.documentElement.classList.toggle('reduce-motion', reduce)
}
export const initialReduceMotion = loadLocal('reduceMotion', false)

// every topic shares the magenta hashtag look
export function topicVar(_topic: string) {
  return 'var(--magenta-text)'
}
