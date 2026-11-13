import { loadLocal, saveLocal } from './api'

// Which windows show where, and in what order: saved per device, edited on the layout.cpl page
export const LAYOUT: Record<string, string[]> = {
  act: ['approvals', 'today', 'tasks', 'prices'], inbox: ['inbox'], read: ['news', 'social'],
  row4: ['streak', 'week', 'packages', 'renewals'], row2: ['notes'],
}
export const NAMES: Record<string, string> = {
  approvals: 'needs_your_stamp', tasks: 'todo.lst', today: 'today.cal', inbox: 'inbox.exe', news: 'news_brief.htm', social: 'social.feed',
  streak: 'inbox_zero_streak', packages: 'packages', renewals: 'renewing', week: 'email_week.log', notes: 'notes.txt', prices: 'price_watch.exe',
}

// the ledger dashboard: a wide main column and two rails (side by side on wide screens, stacked otherwise); edited in Settings → Dashboard layout
export const LEDGER_LAYOUT: Record<string, string[]> = {
  main: ['approvals', 'inbox', 'mail'],
  side: ['today', 'learn', 'tasks', 'streak'],
  more: ['prices', 'reading', 'notes'],
}
export const LEDGER_NAMES: Record<string, string> = {
  approvals: 'Needs your stamp', inbox: 'Inbox', mail: 'Mail this week',
  today: 'Today', tasks: 'To-do', streak: 'Inbox zero', prices: 'Price watch', learn: 'AI daily', reading: 'Reading', notes: 'Notes',
}

export type Layout = { order: Record<string, string[]>; hidden: string[] }

export const DEFAULT_LAYOUT: Layout = { order: LAYOUT, hidden: [] }
export const DEFAULT_LEDGER_LAYOUT: Layout = { order: LEDGER_LAYOUT, hidden: [] }

export function loadLayout(key = 'layout', groups = LAYOUT): Layout {
  const saved = loadLocal<Partial<Layout>>(key, {})
  // windows added since the layout was saved go at the end of their group
  const order = Object.fromEntries(Object.entries(groups).map(([g, ids]) => {
    const kept = (saved.order?.[g] ?? []).filter(id => ids.includes(id))
    return [g, [...kept, ...ids.filter(id => !kept.includes(id))]]
  }))
  return { order, hidden: saved.hidden ?? [] }
}

export const saveLayout = (l: Layout, key = 'layout') => saveLocal(key, l)
export const loadLedgerLayout = () => loadLayout('ledgerLayout', LEDGER_LAYOUT)
export const saveLedgerLayout = (l: Layout) => saveLayout(l, 'ledgerLayout')
