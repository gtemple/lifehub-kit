import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import type { TileState } from './api'
import { wide } from './components/ui'
import { Approvals } from './tiles/Act'
import { Inbox } from './tiles/Inbox'
import { News } from './tiles/Read'
import type { Approval, Email, InboxTile, NewsTile, Story, TileResponse, TileStatus } from './types'

// The Tile states screen, built from the real tiles fed fixed responses.
function fake<T, D>(res: TileResponse<T, D> | null, extra: Partial<TileState<T, D>> = {}): TileState<T, D> {
  return { res, loading: false, failed: false, refresh: () => {}, ...extra }
}

function useSample<D>(name: string) {
  const [res, setRes] = useState<TileResponse<never, D> | null>(null)
  useEffect(() => { fetch(`/api/tiles/${name}/`).then(r => r.json()).then(setRes) }, [name])
  return res
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

export function States() {
  const inbox = useSample<InboxTile>('inbox') as TileResponse<Email, InboxTile> | null
  const news = useSample<NewsTile>('news') as TileResponse<Story, NewsTile> | null
  if (!inbox || !news) return null
  const as = (status: TileStatus, more: Partial<TileResponse<Email, InboxTile>> = {}) => ({ ...inbox, status, ...more })
  const cards: [string, string, ReactNode][] = [
    ['01 · normal + new', '★ marks unseen items; the badge clears once the window scrolls into view.', <Inbox t={fake(as('ok', { newSince: 3 }))} />],
    ['02 · loading', 'a chunky progress bar plus a line saying what’s happening.', <Inbox t={fake<Email, InboxTile>(null, { loading: true })} />],
    ['03 · empty', 'empty states get the sunset: a small reward, not a blank box.', <Approvals t={fake<Approval, undefined>({ tile: 'approvals', items: [], updatedAt: minsAgo(0), status: 'ok' })} onDecided={() => {}} />],
    ['04 · error', 'an old-school error dialog over the dimmed last good data. it names the account.', <Inbox t={fake(as('error', { updatedAt: minsAgo(20), error: { source: 'personal_email', message: 'Work email is fine.' } }))} />],
    ['05 · stale', 'older than 3× its refresh interval: the age flips to a dark badge with refresh.', <News t={fake({ ...news, updatedAt: minsAgo(120) })} />],
    ['06 · waiting for a model', 'follows the routing rule: private work waits instead of going to the cloud.', <Inbox t={fake(as('waiting_for_model', { items: Array(12).fill(inbox.items[0]) }))} />],
  ]
  return (
    <main className="shell">
      <header className="page-head">
        <h1 className="page-title">{wide('TILE STATES')}</h1>
        <span className="on-sky" style={{ fontSize: 16 }}>every window uses the same title bar and the same six states.</span>
      </header>
      <div className="columns">
        {cards.map(([label, note, el]) => (
          <div key={label} className="col gap8">
            <span className="chip-yellow" style={{ alignSelf: 'flex-start', background: 'var(--ink)', color: 'var(--yellow)' }}>{label}</span>
            {el}
            <span className="on-sky" style={{ fontSize: 16 }}>{note}</span>
          </div>
        ))}
      </div>
    </main>
  )
}
