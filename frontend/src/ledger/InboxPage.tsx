import { useCallback, useEffect, useRef, useState } from 'react'

import { post } from '../api'
import { useActivityTray } from '../components/Notifications'
import { Shell } from '../Shell'
import { when } from '../time'
import type { Email, EmailAccount, EmailGroup } from '../types'
import { TopBar } from './TopBar'
import './inbox.css'

type Mail = Email & { body: string; draft: string; trashId: string | null }
type Data = { emails: Mail[]; accounts: { account: EmailAccount; name: string; address: string }[]; updatedAt: string | null }
type Folder = 'all' | EmailGroup | ''

const FOLDERS: [Folder, string][] = [
  ['all', 'Everything'], ['needs_reply', 'Needs a reply'], ['fyi', 'FYI'], ['newsletter', 'Newsletters'], ['receipt', 'Receipts'], ['', 'Not sorted yet'],
]
const ORDER: Folder[] = ['needs_reply', 'fyi', 'newsletter', 'receipt', '']
const label = (f: Folder) => FOLDERS.find(x => x[0] === f)![1]
const ACCTS: ('all' | EmailAccount)[] = ['all', 'work', 'personal']

export function InboxPage({ initial }: { initial: string }) {
  const tray = useActivityTray()
  const [d, setD] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  const [acct, setAcct] = useState<'all' | EmailAccount>('all')
  const [folder, setFolder] = useState<Folder>('all')
  const [sel, setSel] = useState(initial)
  // a phone shows the list or one email, not both; tapping a row opens it
  const [reading, setReading] = useState(!!initial)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const list = useRef<HTMLElement>(null)
  const move = useRef<HTMLSelectElement>(null)

  const load = useCallback(() => fetch('/api/inbox/', { credentials: 'same-origin' }).then(r => {
    if (r.redirected) location.href = '/login/?next=/inbox'
    return r.json()
  }).then(x => { setD(x); setFailed(false) }, () => setFailed(true)), [])
  useEffect(() => { void load() }, [load])

  const inAcct = (d?.emails ?? []).filter(m => acct === 'all' || m.account === acct)
  const shown = ORDER.flatMap(g => inAcct.filter(m => m.group === g && (folder === 'all' || folder === g)))
  const cur = d?.emails.find(m => m.id === sel) ?? shown[0]

  const pick = (id: string, focus = false) => {
    setSel(id); setNote(null)
    history.replaceState(null, '', `/inbox?id=${id}`)
    if (focus) requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus())
  }
  const step = (by: number) => {
    const at = cur ? shown.indexOf(cur) : -1
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + by))]
    if (next) pick(next.id, true)
  }
  const stepFolder = (by: number) => setFolder(f => FOLDERS[(FOLDERS.findIndex(x => x[0] === f) + by + FOLDERS.length) % FOLDERS.length]![0])

  const act = async (action: string, body: object = {}, done?: string) => {
    if (!cur) return
    setBusy(action); setNote(null)
    try {
      await post(`/api/emails/${cur.id}/${action}/`, body)
      if (action === 'archive') {
        const next = shown[shown.indexOf(cur) + 1] ?? shown[shown.indexOf(cur) - 1]
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
    toggleActivityTray: tray.toggle,
    next: () => step(1), prev: () => step(-1),
    open: () => document.getElementById('reading')?.focus(),
    moveTo: () => move.current?.focus(),
    cycleAccount: () => setAcct(a => ACCTS[(ACCTS.indexOf(a) + 1) % ACCTS.length]!),
    prevGroup: () => stepFolder(-1), nextGroup: () => stepFolder(1),
  }

  return (
    <Shell screen="inbox" handlers={handlers}>
      <div className="ib-page">
        <TopBar page="inbox" tray={tray} />
        <main className={`lg-main ib${reading ? ' ib-reading' : ''}`}>
          <nav aria-label="Inbox folders" className="ib-folders">
            <div role="group" aria-label="Account" className="lg-seg ib-accts">
              {ACCTS.map(a => (
                <button key={a} type="button" aria-pressed={acct === a} title={d?.accounts.find(x => x.account === a)?.address} onClick={() => setAcct(a)}>
                  {a === 'all' ? 'All' : a === 'work' ? 'Work' : 'Personal'}
                </button>
              ))}
            </div>
            <div className="ib-folder-list">
              {FOLDERS.map(([f, name]) => {
                const n = inAcct.filter(m => f === 'all' || m.group === f).length
                return (
                  <button key={f || 'unsorted'} type="button" className="ib-folder" aria-pressed={folder === f} onClick={() => setFolder(f)}>
                    {name}<span className={f === 'needs_reply' && n ? 'lg-yellow' : ''}>{n}</span>
                  </button>
                )
              })}
            </div>
            <button type="button" className="visually-hidden" aria-keyshortcuts="[" onClick={() => stepFolder(-1)}>Previous folder</button>
            <button type="button" className="visually-hidden" aria-keyshortcuts="]" onClick={() => stepFolder(1)}>Next folder</button>
            <a href="/cleanup" className="lg-link ib-cleanup">Clean up old senders →</a>
          </nav>

          <section aria-label="Emails" className="ib-list" ref={list}>
            <div className="ib-list-head">
              <h1 className="ib-title">{label(folder)}</h1>
              {d && <span className="lg-dim lg-small">{shown.length} of {inAcct.length}</span>}
            </div>
            {failed && !d && <p className="lg-error ib-pad">Couldn’t load your inbox.</p>}
            {!d && !failed && <p className="lg-empty ib-pad">Loading…</p>}
            {d && !shown.length && <p className="lg-empty ib-pad">Nothing here.</p>}
            {shown.map(m => (
              <button key={m.id} type="button" data-id={m.id} data-nav className={`ib-row ${m.unread ? 'ib-unread' : ''}`} aria-current={m.id === cur?.id} onClick={() => { pick(m.id); setReading(true); scrollTo(0, 0) }}>
                <span aria-hidden="true" className="ib-dot" />
                <span className="ib-row-text">
                  <span className="ib-from lg-ellipsis">{m.from.name}</span>
                  <span className="ib-subject lg-ellipsis">{m.subject}</span>
                  {m.summary && <span className="lg-dim lg-small lg-ellipsis">{m.summary}</span>}
                </span>
                <span className="lg-dim lg-xs">
                  {when(m.receivedAt)}
                  {m.draftId && <span className="lg-yellow" aria-label=", reply drafted"> ✎</span>}
                </span>
              </button>
            ))}
          </section>

          {cur ? (
            <article className="ib-pane" id="reading" tabIndex={-1} aria-label="Reading pane">
              <button type="button" className="lg-link ib-back" onClick={() => setReading(false)}>← {label(folder)}</button>
              <div role="toolbar" aria-label="Email actions" className="lg-row lg-wrap ib-actions">
                {!cur.draftId && (
                  <button type="button" className="lg-btn lg-btn-primary" aria-keyshortcuts="R" disabled={!!busy} onClick={() => void act('draft', {}, 'Drafted. It’s waiting for your stamp below.')}>
                    {busy === 'draft' ? 'Drafting…' : 'Draft reply'}
                  </button>
                )}
                {cur.url && <a className="lg-btn" href={cur.url} target="_blank" rel="noopener">Reply in Gmail ↗</a>}
                <button type="button" className="lg-btn" aria-keyshortcuts="T" disabled={!!busy} onClick={() => void act('task', {}, 'Added to your to-do list.')}>Add to to-do</button>
                <button type="button" className="lg-btn" aria-keyshortcuts="Y" disabled={!!busy} onClick={() => void act('archive', {}, 'Archived in Gmail.')}>{busy === 'archive' ? 'Archiving…' : 'Archive'}</button>
                <label className="visually-hidden" htmlFor="ib-move">Move to</label>
                <select id="ib-move" ref={move} className="lg-btn ib-move" aria-keyshortcuts="M" value="" disabled={!!busy}
                  onChange={e => void act('group', { group: e.target.value }, `Moved to ${label(e.target.value as Folder)}.`)}>
                  <option value="" disabled>Move to ▾</option>
                  {ORDER.filter(g => g && g !== cur.group).map(g => <option key={g} value={g}>{label(g)}</option>)}
                </select>
                {cur.unread && <button type="button" className="lg-btn" disabled={!!busy} onClick={() => void act('read')}>{busy === 'read' ? 'Marking…' : 'Mark read'}</button>}
                {!cur.trashId && <button type="button" className="lg-btn lg-btn-danger" disabled={!!busy} onClick={() => void act('delete')}>Delete</button>}
              </div>

              <div className="lg-col ib-head">
                <span className="lg-dim lg-small">{cur.from.name} &lt;{cur.from.address}&gt; · {cur.account} · {when(cur.receivedAt)}</span>
                <h2 className="ib-h2">{cur.subject}</h2>
              </div>
              {cur.summary && <div className="ib-oneline"><span className="lg-dim">In one line:</span> {cur.summary}</div>}
              <div className="ib-body">
                {cur.body ? cur.body.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>) : <p className="lg-dim">(no text)</p>}
              </div>

              {note && <div role="status" className={note.ok ? 'lg-dim lg-small' : 'lg-error'}>{note.text}</div>}

              <div className="ib-foot">
                {cur.draftId && (
                  <div className="ib-stamp">
                    <span><span className="lg-yellow lg-strong">Reply drafted</span> · waiting for your stamp</span>
                    <a className="lg-btn lg-btn-primary" href={`/approvals/${cur.draftId}`}>Review &amp; stamp</a>
                  </div>
                )}
                {cur.trashId && (
                  <div className="ib-stamp">
                    <span><span className="lg-yellow lg-strong">Delete</span> · waiting for your stamp<br /><span className="lg-dim lg-small">Moves to Gmail Trash 30 s after you stamp it; Gmail keeps it there for 30 days.</span></span>
                    <span className="lg-row">
                      <button type="button" className="lg-btn lg-btn-danger" disabled={!!busy} onClick={() => void decide(cur.trashId!, 'approve', 'Deleting in 30 s. Undo from the bell.')}>Delete it</button>
                      <button type="button" className="lg-btn" disabled={!!busy} onClick={() => void decide(cur.trashId!, 'decline', 'Kept.')}>Keep it</button>
                    </span>
                  </div>
                )}
                <span className="lg-decor lg-xs">J / K move · R reply · Y archive · ? all keys</span>
              </div>
            </article>
          ) : <div className="ib-pane" />}
        </main>
      </div>
    </Shell>
  )
}
