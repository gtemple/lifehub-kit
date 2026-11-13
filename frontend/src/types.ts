// Data shapes from SPEC.md. Every tile endpoint returns a TileResponse.

export type TileStatus = 'ok' | 'loading' | 'error' | 'stale' | 'waiting_for_model'

export type TileResponse<T, D = undefined> = {
  tile: string
  items: T[]
  data?: D
  updatedAt: string
  status: TileStatus
  error?: { source: string; message: string }
  newSince?: number
}

export type ModelName = 'ollama' | 'gemini' | 'none'
export type EmailAccount = 'work' | 'personal'
export type EmailGroup = 'needs_reply' | 'fyi' | 'newsletter' | 'receipt'

export type Approval = {
  id: string
  kind: 'email' | 'calendar' | 'post' | 'cleanup' | 'purchase'
  account?: EmailAccount
  title: string
  detail: string
  reason: string
  payload: unknown
  createdAt: string
  model: ModelName
  status: 'pending' | 'approved' | 'declined' | 'edited'
}

export type Email = {
  id: string
  account: EmailAccount
  from: { name: string; address: string }
  subject: string
  summary: string
  receivedAt: string
  group: EmailGroup | ''
  draftId?: string
  url?: string
  unread?: boolean
}

export type InboxTile = {
  counts: Record<EmailGroup, number>
  byAccount: Record<EmailAccount, number>
  needsReply: Email[]
  others: { group: Exclude<EmailGroup, 'needs_reply'>; count: number; preview: Email[] }[]
  unsorted?: number
}

export type Brief = { text: string; writtenAt: string; model: ModelName; sources: string[] }

export type Story = { id: string; topic: string; source: string; title: string; url: string; minutes?: number; at?: string }

export type NewsTile = { brief: Brief | null; stories: Story[]; sourceCount?: number; storyCount?: number }

export type MorningBrief = { kind: 'morning' | 'evening'; text: string; writtenAt: string; model: ModelName }

export type ComingEvent = { id: string; title: string; start: string; end: string | null; allDay: boolean; where: string; account: EmailAccount; url: string; add: string }

export type CalendarEvent = { id: string; start: string; end: string; title: string; where?: string; calendar: EmailAccount; highlight?: boolean; allDay?: boolean }

export type Task = {
  id: string; text: string; source: string; due?: string | null; done: boolean
  repeat?: '' | 'daily' | 'weekly' | 'monthly'; snoozed?: string | null
  email?: { id: string; from: string; account: EmailAccount; subject: string; summary: string; snippet: string; receivedAt: string }
  context?: string; url?: string
}

export type Waiting = { id: string; to: string; subject: string; summary: string; sentAt: string; url: string; account: EmailAccount }

export type ActivityEntry = { id: string; at: string; text: string; via: string; model: ModelName; undo?: { approvalId: string; until: string } }

export type RadioNow = { title?: string; artist?: string; genre?: string; seconds?: number; dj?: boolean; station?: string; started?: string; genres: string[]; choice: string }

export type AgentStatus = { online: boolean; activeModel: ModelName; ollamaUp: boolean; geminiUp: boolean; lastRunAt?: string }

export type FantasyMatchup = {
  week: number
  myTeam: string
  opponent: string
  status?: 'leading' | 'trailing' | 'tied'
  categories: { key: string; result: 'W' | 'L' | 'T' }[]
}

export type SocialPost = { id: string; network: string; who: string; text: string; at: string; url?: string }

export type Note = { id: string; title: string; body: string; updatedAt: string }

export type Package = { id: string; item: string; carrier: string; status: string; progress: number; eta: string; url?: string }

export type Renewal = { id: string; name: string; date: string; amount: number | null; url?: string }

export type EmailWeekAccount = {
  key: string; name: string; error?: string; received?: number; sent?: number; unread?: number
  top?: { name: string; count: number }[]; receivedBefore: number | null; waiting: number; oldestWaiting: string | null
}
export type EmailWeek = { weekStart: string; weekEnd: string; writtenAt: string; accounts: EmailWeekAccount[] }

export type Streak = { days: number; week: boolean[] }

export type WatchSource = { url: string; store: string; price?: number; currency?: string; inStock?: boolean; title?: string; checkedAt?: string; error?: string }

export type Watch = { id: string; name: string; target: number | null; best: number | null; low90: number | null; checkedAt: string | null; sources: WatchSource[] }
