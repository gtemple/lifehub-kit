import { useCallback, useEffect, useRef, useState } from 'react'

import { post } from './api'
import { AccountTag, Btn, LinkBtn, Window, groupColor } from './components/ui'
import { Shell } from './Shell'
import { ago, when } from './time'
import type { Email, EmailAccount, EmailGroup } from './types'

type Mail = Email & { body: string; draft: string; trashId: string | null }
type Data = { emails: Mail[]; accounts: { account: EmailAccount; name: string; address: string }[]; updatedAt: string | null }

const GROUPS: { key: EmailGroup; label: string }[] = [
  { key: 'needs_reply', label: 'needs_a_reply' }, { key: 'fyi', label: 'fyi' }, { key: 'newsletter', label: 'newsletters' }, { key: 'receipt', label: 'receipts' },
]
const groupLabel = (g: EmailGroup | '') => GROUPS.find(x => x.key === g)?.label ?? 'not_sorted_yet'
const ACCTS: ('all' | EmailAccount)[] = ['all', 'work', 'personal']

// inbox.exe (design/screens/VWInbox.dc.html) at /inbox or /inbox?id=<email>
export function InboxPage({ initial }: { initial: string }) {
  const [d, setD] = useState<Data | null>(null)
  const [acct, setAcct] = useState<'all' | EmailAccount>('all')
  const [group, setGroup] = useState<'all' | EmailGroup>('all')
  const [sel, setSel] = useState(initial)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const move = useRef<HTMLSelectElement>(null)

  const load = useCallback(() => fetch('/api/inbox/', { credentials: 'same-origin' }).then(r => {
    if (r.redirected) location.href = '/login/?next=/inbox'
    return r.json()
  }).then(setD), [])
  useEffect(() => { void load() }, [load])

  const all = d?.emails ?? []
  const vis = all.filter(m => (acct === 'all' || m.account === acct) && (group === 'all' || m.group === group))
  const sections = [...GROUPS.map(g => g.key), '' as const].map(g => ({ g, items: vis.filter(m => m.group === g) })).filter(s => s.items.length)
  const ordered = sections.flatMap(s => s.items)
  const cur = all.find(m => m.id === sel) ?? ordered[0]
  const count = (f: (m: Mail) => boolean) => all.filter(f).length

  const pick = (id: string, focus = false) => {
    setSel(id); setNote(null)
    history.replaceState(null, '', `/inbox?id=${id}`)
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus())
  }
  const step = (by: number) => {
    const at = cur ? ordered.indexOf(cur) : -1
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + by))]
    if (next) pick(next.id, true)
  }
  const groupKeys: ('all' | EmailGroup)[] = ['all', ...GROUPS.map(g => g.key)]
  const stepGroup = (by: number) => setGroup(g => groupKeys[(groupKeys.indexOf(g) + by + groupKeys.length) % groupKeys.length]!)

  // archive, delete and friends: on success the list reloads and the next email opens
  const act = async (action: string, body: object = {}, done?: string) => {
    if (!cur) return
    setBusy(action); setNote(null)
    try {
      await post(`/api/emails/${cur.id}/${action}/`, body)
      if (action === 'archive') {
        const next = ordered[ordered.indexOf(cur) + 1] ?? ordered[ordered.indexOf(cur) - 1]
        if (next) pick(next.id)
      }
      if (done) setNote({ ok: true, text: done })
      await load()
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      setBusy('')
    }
  }
  const decide = async (id: string, decision: 'approve' | 'decline', done: string) => {
    setBusy(decision)
    try {
      await post(`/api/approvals/${id}/decide/`, { decision })
      setNote({ ok: true, text: done })
      await load()
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      setBusy('')
    }
  }

  const handlers = {
    next: () => step(1), prev: () => step(-1),
    open: () => document.getElementById('reading')?.focus(),
    moveTo: () => move.current?.focus(),
    cycleAccount: () => setAcct(a => ACCTS[(ACCTS.indexOf(a) + 1) % ACCTS.length]!),
    prevGroup: () => stepGroup(-1), nextGroup: () => stepGroup(1),
  }
  const replies = count(m => m.group === 'needs_reply')

  return (
    <Shell screen="inbox" handlers={handlers}>
      <main className="shell">
        <Window
          className="mc" grad={0} dialog headingLevel="h2" closeHref="/"
          name={<>inbox.exe — both accounts · sorted by ollama · <span className="jp" aria-hidden="true">受信箱</span></>}
        >
          {!d ? <span className="loading-line cursor">loading</span> : (
            <div style={{ margin: -12 }}>
              <div className="mc-toolbar" role="toolbar" aria-label="Email actions">
                {cur && !cur.draftId && <Btn tone="face" size="sm" lower k="R" disabled={!!busy} onClick={() => void act('draft', {}, 'Drafted. It is waiting for your stamp below.')}>{busy === 'draft' ? '✎ drafting…' : '✎ draft reply'}</Btn>}
                <Btn tone="face" size="sm" lower k="T" disabled={!cur || !!busy} onClick={() => void act('task', {}, 'Added to your to-do list.')}>☐ make task</Btn>
                <label className="visually-hidden" htmlFor="move">Move to</label>
                <select id="move" ref={move} className="bv bv-face bv-sm bv-lower" aria-keyshortcuts="M" value="" disabled={!cur || !!busy} onChange={e => void act('group', { group: e.target.value }, `Moved to ${groupLabel(e.target.value as EmailGroup)}.`)}>
                  <option value="" disabled>→ move to</option>
                  {GROUPS.filter(g => g.key !== cur?.group).map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
                <Btn tone="face" size="sm" lower k="Y" disabled={!cur || !!busy} onClick={() => void act('archive', {}, 'Archived in Gmail.')}>{busy === 'archive' ? '▣ archiving…' : '▣ archive'}</Btn>
                {cur?.unread && <Btn tone="face" size="sm" lower disabled={!!busy} onClick={() => void act('read')}>{busy === 'read' ? 'marking…' : '○ mark read'}</Btn>}
                {cur && !cur.trashId && <Btn tone="pink" size="sm" lower disabled={!!busy} onClick={() => void act('delete')}>✕ delete…</Btn>}
                {cur?.url && <LinkBtn tone="face" size="sm" lower href={cur.url} target="_blank" rel="noopener">open in gmail ↗</LinkBtn>}
                <span className="grow">{d.updatedAt ? `updated ${ago(d.updatedAt)}` : ''}</span>
              </div>

              <div className="mc-grid">
                <nav aria-label="Inbox folders" className="mc-folders">
                  <span className="head">accounts/</span>
                  {ACCTS.map(a => {
                    const info = d.accounts.find(x => x.account === a)
                    return (
                      <button key={a} type="button" className="folder" aria-pressed={acct === a} aria-keyshortcuts={a === 'all' ? 'F' : undefined} onClick={() => setAcct(a)}>
                        <span className="sw" style={{ background: a === 'all' ? 'var(--paper)' : `var(--${a === 'work' ? 'cyan' : 'yellow'})` }} />
                        <span>{a === 'all' ? 'all_accounts' : a}{info && <span className="addr">{info.address}</span>}</span>
                        <span className="n">{count(m => a === 'all' || m.account === a)}</span>
                      </button>
                    )
                  })}
                  <span className="head">sorted_into/</span>
                  {[{ key: 'all' as const, label: 'everything' }, ...GROUPS].map(g => (
                    <button key={g.key} type="button" className="folder" aria-pressed={group === g.key} onClick={() => setGroup(g.key)}>
                      <span className="sw" style={{ background: g.key === 'all' ? 'var(--paper)' : groupColor(g.key) }} />
                      <span>{g.label}</span>
                      <span className="n">{count(m => g.key === 'all' || m.group === g.key)}</span>
                    </button>
                  ))}
                  <button type="button" className="visually-hidden" aria-keyshortcuts="[" onClick={() => stepGroup(-1)}>Previous group</button>
                  <button type="button" className="visually-hidden" aria-keyshortcuts="]" onClick={() => stepGroup(1)}>Next group</button>
                  <LinkBtn tone="yellow" lower href="/cleanup" k="G C" style={{ marginTop: 14, justifyContent: 'space-between' }}>sender_cleanup.exe</LinkBtn>
                </nav>

                <div className="mc-list" ref={list} aria-label="Emails">
                  {sections.map(s => (
                    <div key={s.g}>
                      <div className="mc-group" style={{ background: groupColor(s.g) }}>&gt;&gt; {groupLabel(s.g)} ({s.items.length})</div>
                      {s.items.map(m => (
                        <button key={m.id} type="button" data-id={m.id} data-nav className={`mc-row ${m.unread ? 'unread' : ''}`} aria-current={m.id === cur?.id} onClick={() => pick(m.id)}>
                          <span className="mail-who"><strong>{m.from.name}</strong><AccountTag account={m.account} /></span>
                          <span className="mail-time">{when(m.receivedAt)}{m.draftId && ' ✎'}{m.trashId && ' ✕?'}</span>
                          <span className="mail-summary">{m.summary || m.subject}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {!sections.length && <div className="empty-state"><div className="mini-sun" aria-hidden="true" /><span className="empty-title">ｎｏｔｈｉｎｇ</span><span className="small">nothing here. nice.</span></div>}
                </div>

                {cur ? (
                  <article className="mc-read" id="reading" tabIndex={-1} aria-label="Reading pane">
                    <div className="col gap4">
                      <span className="vt sub" style={{ fontSize: 22 }}>{groupLabel(cur.group)} · {cur.account.toUpperCase()} inbox</span>
                      <h2 className="read-subject">{cur.subject}</h2>
                      <span className="small">{cur.from.name} &lt;{cur.from.address}&gt; · {when(cur.receivedAt)}</span>
                    </div>
                    {cur.summary && <div className="one-line"><b>in one line:</b> {cur.summary}</div>}
                    <p className="original">{cur.body || '(no text)'}</p>

                    {cur.draftId && (
                      <div className="draft-box">
                        <span className="head">!! reply drafted · waiting for your stamp</span>
                        <span className="small" style={{ whiteSpace: 'pre-line' }}>{cur.draft}</span>
                        <div><LinkBtn tone="mint" href={`/approvals/${cur.draftId}`}>Review &amp; stamp</LinkBtn></div>
                      </div>
                    )}

                    {cur.trashId && (
                      <div className="draft-box">
                        <span className="head">!! delete · waiting for your stamp</span>
                        <span className="small">Moves to Gmail Trash 30 s after you stamp it; Gmail keeps it there for 30 days.</span>
                        <div className="actions">
                          <Btn tone="mint" disabled={!!busy} onClick={() => void decide(cur.trashId!, 'approve', 'Deleting in 30 s. Undo from the bell on the dashboard.')}>Delete it</Btn>
                          <Btn tone="gray" disabled={!!busy} onClick={() => void decide(cur.trashId!, 'decline', 'Kept.')}>Keep it</Btn>
                        </div>
                      </div>
                    )}

                    {note && <div role="status" className={`note-line ${note.ok ? '' : 'err'}`}>{note.text}</div>}
                  </article>
                ) : <div className="mc-read" />}
              </div>

              <div className="mc-status">
                <span>{ordered.length} messages shown · {replies} need a reply</span>
                <span>J/K move · R reply · Y archive · ? keys</span>
              </div>
            </div>
          )}
        </Window>
      </main>
    </Shell>
  )
}
