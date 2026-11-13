const MIN = 60_000
const DAY = 24 * 60 * MIN

export function ago(iso: string, now = Date.now()) {
  const ms = now - Date.parse(iso)
  if (ms < MIN) return 'just now'
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)} min ago`
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))} h ago`
  return `${Math.round(ms / DAY)} d ago`
}

// "09:30", 24-hour, as the design shows it
export function clock(iso: string) {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

// today -> "7:58", earlier this week -> "Sun"
export function when(iso: string, now = new Date()) {
  const d = new Date(iso)
  if (sameDay(d, now)) return clock(iso)
  if (now.getTime() - d.getTime() < 6 * DAY) return d.toLocaleDateString('en-CA', { weekday: 'short' })
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}

// activity log: "7:42" today, "Sun 9:15p" before
export function stamp(iso: string, now = new Date()) {
  const d = new Date(iso)
  if (sameDay(d, now)) return clock(iso)
  return `${d.toLocaleDateString('en-CA', { weekday: 'short' })} ${clock(iso)}`
}

// tasks: a time today, the weekday this week, otherwise the date
export function due(iso: string, now = new Date()) {
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso)
  if (iso.length > 10 && sameDay(d, now)) return clock(iso)
  // a weekday only means something within the week either side
  return Math.abs(d.getTime() - now.getTime()) < 6 * DAY ? d.toLocaleDateString('en-CA', { weekday: 'short' }) : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
}
