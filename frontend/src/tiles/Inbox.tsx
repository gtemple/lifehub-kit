import { useState } from 'react'

import type { TileState } from '../api'
import { Tile, shownState } from '../components/Tile'
import { AccountTag, Btn, groupColor } from '../components/ui'
import { when } from '../time'
import type { Email, EmailAccount, EmailGroup, InboxTile } from '../types'

export const INBOX_MS = 2 * 60_000

const GROUPS: { key: EmailGroup; label: string; short: string }[] = [
  { key: 'needs_reply', label: 'Needs a reply', short: 'reply' },
  { key: 'fyi', label: 'FYI', short: 'fyi' },
  { key: 'newsletter', label: 'Newsletters', short: 'news' },
  { key: 'receipt', label: 'Receipts', short: 'receipts' },
]
const ACCT: Record<EmailAccount, string> = { work: 'Work', personal: 'Personal' }
const FILTERS: Filter[] = ['all', 'work', 'personal']

export { AccountTag }

type Filter = 'all' | EmailAccount

function MailRow({ m, summary }: { m: Email; summary: string }) {
  return (
    <a href={`/inbox?id=${m.id}`} className="mail" data-nav>
      <span className="mail-who"><strong>{m.from.name}</strong><AccountTag account={m.account} /></span>
      <span className="mail-time">{when(m.receivedAt)}{m.draftId && <span className="drafted"> ✎</span>}</span>
      <span className="mail-summary">{summary}</span>
    </a>
  )
}

export function Inbox({ t }: { t: TileState<Email, InboxTile> }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<Partial<Record<EmailGroup, boolean>>>({})
  const [showUnsorted, setShowUnsorted] = useState(false)
  const d = t.res?.data
  const total = d ? Object.values(d.counts).reduce((a, b) => a + b, 0) : 0
  const pick = (m: Email) => filter === 'all' || m.account === filter
  const replies = (d?.needsReply ?? []).filter(pick)
  const waiting = t.res?.status === 'waiting_for_model'
  const cycle = () => setFilter(f => FILTERS[(FILTERS.indexOf(f) + 1) % FILTERS.length]!)

  return (
    <Tile
      title={d ? `inbox.exe — ${total} sorted` : 'inbox.exe'} grad={4} jp="受信箱"
      newCount={t.res?.newSince}
      state={shownState(t, INBOX_MS, () => total === 0 && !d?.unsorted)} updatedAt={t.res?.updatedAt} onRefresh={t.refresh}
      loadingText="sorting emails"
      error={t.res?.error ? { source: t.res.error.source, also: t.res.error.message } : { source: 'email' }}
      emptyTitle="inbox zero" emptyJp="受信箱ゼロ" empty="nothing left to sort."
      waiting={waiting ? {
        lines: [`${t.res?.items.length ?? 0} new emails queued`, 'private mail only runs on ollama', 'retrying in 60s'],
        actions: <Btn tone="gray" size="sm" aria-expanded={showUnsorted} onClick={() => setShowUnsorted(v => !v)}>{showUnsorted ? 'Hide unsorted' : 'Show unsorted'}</Btn>,
        more: showUnsorted && <div className="col gap6">{(t.res?.items ?? []).map(m => <MailRow key={m.id} m={m} summary={m.subject} />)}</div>,
      } : undefined}
    >
      {d && (
        <>
          <div className="counts">
            {GROUPS.map(g => (
              <div key={g.key} className="count" style={{ background: groupColor(g.key) }}>
                <b>{String(d.counts[g.key]).padStart(2, '0')}</b>
                <span>{g.short}</span>
              </div>
            ))}
          </div>

          <div className="seg" role="group" aria-label="Filter by account">
            {FILTERS.map(f => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f.toUpperCase()}</button>
            ))}
          </div>
          <button type="button" className="visually-hidden" aria-keyshortcuts="F" onClick={cycle}>Cycle account filter</button>

          <span className="section-head">&gt;&gt; needs a reply</span>
          {replies.length === 0 && <span className="empty-plain">nothing needs a reply{filter !== 'all' ? ` in ${ACCT[filter]}` : ''}.</span>}
          <div className="col gap6">
            {replies.map(m => <MailRow key={m.id} m={m} summary={m.summary} />)}
          </div>

          <div className="col">
            {d.others.map(o => {
              const g = GROUPS.find(x => x.key === o.group)!
              const items = o.preview.filter(pick)
              return (
                <div key={o.group} className="other" data-nav tabIndex={-1}>
                  <button type="button" aria-expanded={!!open[o.group]} aria-keyshortcuts="O" onClick={() => setOpen(s => ({ ...s, [o.group]: !s[o.group] }))}>
                    <span>[{open[o.group] ? '−' : '+'}] {g.label}</span><span>{o.count}</span>
                  </button>
                  {open[o.group] && (
                    <div className="other-items">
                      {items.map(i => (
                        <a key={i.id} href={`/inbox?id=${i.id}`} className="other-item">
                          <span><strong>{i.from.name}</strong> <AccountTag account={i.account} /> <span className="sub">· {i.summary}</span></span>
                          <span className="sub">{when(i.receivedAt)}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {!!d.unsorted && !waiting && <span className="sub small">{d.unsorted} more waiting to be sorted</span>}
          <a href="/inbox" className="text-link">open inbox.exe →</a>
        </>
      )}
    </Tile>
  )
}
