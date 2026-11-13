// shapes of the garmin and mailweek tiles, and the small formatters the dashboard shares

export type Vitals = {
  restingHr: number | null; hrvLastNight: number | null; hrvStatus: string | null; bodyBatteryHigh: number | null; bodyBatteryLow: number | null
  stressAvg: number | null; steps: number | null; trainingReadiness: number | null; sleepDurationS: number | null; sleepScore: number | null
}
export type Session = { id: string; date: string; startAt: string; type: string; name: string; durationS: number; distanceM: number | null; avgHr: number | null; trainingLoad: number | null }
export type Garmin = {
  overview?: { latest?: Partial<Vitals>; averages?: Record<string, Partial<Vitals> | undefined>; sync?: { lastRunAt: string | null; running?: boolean; ok: boolean | null; error: string | null } }
  training?: Session[]
  insight?: { title: string; summary: string; createdAt: string } | null
  url?: string | null
}
export type MailWeek = { days: { date: string; received: number; answered: number }[]; received: number; answered: number; lastWeekReceived: number | null }

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const dayInitial = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'narrow' })

// the last n days, oldest first, ending `back` days before today
export function lastDays(n: number, back = 0) {
  return Array.from({ length: n }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - back - (n - 1 - i)); return isoDay(d) })
}

export const hm = (s: number) => `${Math.floor(s / 3600)} h ${pad(Math.round(s % 3600 / 60))}`
export const dur = (s: number) => (s >= 3600 ? hm(s) : `${Math.round(s / 60)} min`)
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0')
export const pct = (now: number, before: number | null | undefined) => {
  if (!before) return ''
  const p = Math.round((now - before) / before * 100)
  return p === 0 ? 'same as before' : `${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%`
}

export const untilText = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
