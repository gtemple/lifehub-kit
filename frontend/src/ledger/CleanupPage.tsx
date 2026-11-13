import { useCallback, useEffect, useRef, useState } from 'react'

import { post, useTile } from '../api'
import { BATCH, FolderPick, LEAVES, PAGE, TABS, foldAway, groupByDomain, isDone, n, working } from '../Cleanup'
import type { Data, Sender, Suggestion, Tab } from '../Cleanup'
import { useActivityTray } from '../components/Notifications'
import { Shell } from '../Shell'
import { ago } from '../time'
import type { Approval, EmailAccount } from '../types'
import { TopBar } from './TopBar'
import './cleanup.css'

type Kind = Suggestion | 'pending'
const KINDS: [Kind, string][] = [['delete', 'Delete'], ['file', 'File in folders'], ['archive', 'Archive'], ['read', 'Mute'], ['keep', 'Keep'], ['pending', 'Not looked at yet']]
const TAB_LABEL: Record<Tab, string> = { suggested: 'Suggested', all: 'All senders', done: 'Done' }
const ACCTS: ['all' | EmailAccount, string][] = [['all', 'Both'], ['personal', 'Personal'], ['work', 'Work']]
const VERB: Record<string, string> = { delete: 'Delete', file: 'File', archive: 'Archive', read: 'Mute' }
const emails = (list: Sender[]) => list.reduce((t, s) => t + s.total, 0)
const senderCount = (k: number) => `${n(k)} sender${k === 1 ? '' : 's'}`

// Ollama suggests what to do with each sender's pile; you apply it. Logic as in the retro cleanup.exe.
export function CleanupPage() {
  const tray = useActivityTray()
  const approvals = useTile<Approval>('approvals', 60_000)
  const [d, setD] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  const [acct, setAcct] = useState<'all' | EmailAccount>('all')
  const [tab, setTab] = useState<Tab>('suggested')
  const [kind, setKind] = useState<Kind>('delete')
  const [shown, setShown] = useState(PAGE)
  const [unsub, setUnsub] = useState(true)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState<Approval | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const seenSize = useRef(new Map<string, number>())

  const load = useCallback(() => fetch('/api/cleanup/', { credentials: 'same-origin' }).then(r => {
    if (r.redirected) location.href = '/login/?next=/cleanup'
    return r.json()
  }).then(x => { setD(x); setFailed(false) }).catch(() => setFailed(true)), [])
  const active = !!d && (!!d.scan.running || d.senders.some(working) || !!d.deleting?.length)
  useEffect(() => {
    void load()
    const id = setInterval(load, active ? 4000 : 60_000)
    return () => clearInterval(id)
  }, [load, active])

  // the one you just queued, else any cleanup stamp still waiting from before
  const stamp = queued ?? approvals.res?.items.find(a => a.kind === 'cleanup') ?? null

  const all = d?.senders ?? []
  const senders = all.filter(s => acct === 'all' || s.account === acct)
  const rows = tab === 'done' ? senders.filter(isDone)
    : tab === 'all' ? senders.filter(s => !isDone(s))
    : senders.filter(s => !isDone(s) && (s.suggestion || 'pending') === kind)
  const open = rows.filter(s => !s.done)
  const batch = open.slice(0, BATCH)
  const groups = tab === 'done' ? rows.map(s => ({ domain: s.address, senders: [s], total: s.total })) : groupByDomain(rows, all, seenSize.current)
  const kindVerb = tab === 'suggested' && kind !== 'keep' && kind !== 'pending' ? kind : null

  const run = async (action: string, ids: string[], ok: string, extra: object = {}) => {
    setBusy(true); setNote(null)
    let fold: ReturnType<typeof foldAway> | null = null
    try {
      const res = await post<Approval & { started?: number }>('/api/cleanup/apply/', { ids, action, unsubscribe: unsub, ...extra })
      if (LEAVES.includes(action)) { fold = foldAway(ids); await fold.done }
      if (action === 'delete') { setQueued(res); approvals.refresh() }
      else if (ok) setNote({ ok: true, text: ok })
      await load()
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      fold?.settle()
      setBusy(false)
    }
  }
  const decide = async (decision: 'approve' | 'decline') => {
    if (!stamp) return
    setBusy(true)
    try {
      await post(`/api/approvals/${stamp.id}/decide/`, { decision })
      setNote({ ok: true, text: decision === 'approve' ? 'Stamped. Moving to Trash in 30 s; undo from the bell.' : 'Kept them all.' })
      setQueued(null)
      approvals.refresh()
      await load()
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!note?.ok) return
    const id = setTimeout(() => setNote(null), 5000)
    return () => clearTimeout(id)
  }, [note])

  const scan = () => post('/api/cleanup/scan/').then(load).catch(e => setNote({ ok: false, text: (e as Error).message }))
  const apply = (list: Sender[]) => {
    if (!list.length || busy || !kindVerb) return
    void run(kindVerb, list.map(s => s.id), kindVerb === 'file' ? 'Filing in Gmail…' : kindVerb === 'archive' ? 'Archiving in Gmail…' : kindVerb === 'delete' ? '' : 'Marking read in Gmail…')
  }
  const pickTab = (t: Tab) => { setTab(t); setShown(PAGE) }
  const handlers = {
    toggleActivityTray: tray.toggle,
    queueAllSuggested: () => apply(batch),
    prevTab: () => pickTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]!),
    nextTab: () => pickTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]!),
  }

  const scanned = d?.scan.finishedAt
  const keptAside = Object.values(d?.protected ?? {}).reduce((t, c) => t + Object.values(c).reduce((a, b) => a + b, 0), 0)
  const deleteSuggested = all.filter(s => !isDone(s) && s.suggestion === 'delete')
  const handled = all.filter(isDone)
  const oneClicks = open.filter(s => s.oneClick).length
  const stats: [string, string, boolean?][] = d ? [
    [n(d.scan.unread ?? 0), 'unread scanned'], [n(all.length), 'senders'], [n(emails(deleteSuggested)), 'suggested to delete', true],
    [n(all.filter(s => s.suggestion).length), 'looked at by Ollama'], [n(keptAside), 'receipts & tickets kept aside'], [n(handled.length), 'senders handled'],
  ] : []

  return (
    <Shell screen="cleanup" handlers={handlers}>
      <TopBar page="cleanup" tray={tray} onUndone={approvals.refresh} />
      <main className="lg-main cl-main">
        <div className="cl-head">
          <div className="lg-col cl-title">
            <span className="lg-dim lg-small">
              {d?.scan.running ? `Scanning ${acct === 'all' ? 'both inboxes' : `the ${acct} inbox`}, started ${ago(d.scan.startedAt!)}`
                : scanned ? `Scanned ${ago(scanned)} · ${n(d!.scan.senders ?? 0)} senders${d!.ollamaUp ? '' : ' · Ollama away'}`
                : d ? 'Not scanned yet' : ' '}
            </span>
            <h1 className="lg-h1">Cleanup</h1>
          </div>
          <div className="lg-row lg-wrap">
            <div className="lg-seg" role="group" aria-label="Account">
              {ACCTS.map(([a, label]) => <button key={a} type="button" aria-pressed={acct === a} onClick={() => { setAcct(a); setShown(PAGE) }}>{label}</button>)}
            </div>
            {d && !d.scan.running && <button type="button" className={`lg-btn ${scanned ? '' : 'lg-btn-primary'}`} onClick={() => void scan()}>{scanned ? 'Scan again' : 'Scan inboxes'}</button>}
          </div>
        </div>

        {failed && !d && <div className="lg-error" role="alert">Couldn’t load cleanup.</div>}
        {d?.scan.error && !d.scan.running && <div className="lg-error" role="alert">Last scan failed: {d.scan.error}</div>}
        {d && <Progress d={d} />}
        {!d && !failed && <div className="lg-empty">Loading…</div>}

        {d && d.senders.length > 0 && (
          <>
            <section className="cl-stats" aria-label="Scan">
              {stats.map(([v, label, red]) => <div key={label}><span className={`cl-stat${red ? ' lg-red' : ''}`}>{v}</span><span className="lg-dim lg-xs">{label}</span></div>)}
            </section>

            {stamp && (
              <section className="lg-card lg-card-stamp cl-stamp" aria-labelledby="cl-stamp-h">
                <div className="cl-stamp-body">
                  <span className="cl-stamp-eyebrow lg-xs">Needs your OK</span>
                  <h2 id="cl-stamp-h" className="cl-stamp-title">{stamp.title}</h2>
                  {stamp.detail && <p className="lg-soft lg-small">{stamp.detail}</p>}
                  <p className="lg-dim lg-xs">They go to Gmail Trash and can be restored for 30 days.</p>
                </div>
                <div className="cl-stamp-actions">
                  <button type="button" className="lg-btn" disabled={busy} onClick={() => void decide('decline')}>Not now</button>
                  <button type="button" className="lg-btn lg-btn-primary" disabled={busy} onClick={() => void decide('approve')}>Delete</button>
                </div>
              </section>
            )}

            <div className="cl-bar">
              {tab === 'suggested' ? (
                <div className="lg-row lg-wrap cl-kinds" role="group" aria-label="What Ollama suggests">
                  {KINDS.map(([k, label]) => {
                    const c = senders.filter(s => !isDone(s) && (s.suggestion || 'pending') === k)
                    if (!c.length && k !== kind) return null
                    return (
                      <button key={k} type="button" className="lg-chip" aria-pressed={kind === k} onClick={() => { setKind(k); setShown(PAGE) }}>
                        {label}<span className={kind === k && k === 'delete' ? 'lg-red' : 'lg-dim'}>{n(emails(c))}</span>
                      </button>
                    )
                  })}
                </div>
              ) : <span className="lg-dim lg-small">{tab === 'done' ? `${n(handled.length)} senders handled` : senderCount(rows.length)}</span>}
              <div className="lg-seg" role="group" aria-label="Senders">
                {TABS.map(t => <button key={t} type="button" aria-pressed={tab === t} onClick={() => pickTab(t)}>{TAB_LABEL[t]}</button>)}
              </div>
            </div>

            {kindVerb && open.length > 0 && (
              <div className="cl-summary">
                <div className="lg-col cl-summary-text">
                  <span className="lg-soft">
                    {kindVerb === 'delete' ? <>Ollama suggests deleting <b>{n(emails(open))} emails</b> from {senderCount(open.length)}. Nothing goes until you stamp it.</>
                      : kindVerb === 'file' ? <>Ollama suggests filing <b>{n(emails(open))} emails</b> from {senderCount(open.length)} into {n(new Set(open.map(s => s.folder)).size)} folders. Happens right away.</>
                      : kindVerb === 'archive' ? <>Ollama suggests archiving <b>{n(emails(open))} emails</b> from {senderCount(open.length)}. Still in All Mail and search.</>
                      : <>Ollama suggests muting {senderCount(open.length)}: <b>{n(open.reduce((t, s) => t + s.unread, 0))} emails</b> marked read.</>}
                    {open.length > BATCH && ` The biggest ${BATCH} go first.`}
                  </span>
                  {kindVerb === 'delete' && oneClicks > 0 && (
                    <label className="lg-row lg-small lg-dim"><input type="checkbox" className="lg-check" checked={unsub} onChange={e => setUnsub(e.target.checked)} />Also unsubscribe from the {n(oneClicks)} with one-click unsubscribe</label>
                  )}
                </div>
                <div className="lg-row">
                  <button type="button" className="lg-btn lg-btn-primary" aria-keyshortcuts="Shift+U" disabled={busy || (kindVerb === 'delete' && !!queued)} onClick={handlers.queueAllSuggested}>
                    {kindVerb === 'delete' ? (open.length > BATCH ? `Queue ${BATCH} for stamp` : 'Queue all for stamp') : `${VERB[kindVerb]} ${open.length > BATCH ? `these ${BATCH}` : 'all'}`}
                  </button>
                  <button type="button" className="lg-btn" onClick={() => document.querySelector<HTMLElement>('.cl-sender[data-nav]')?.focus()}>Review one by one</button>
                </div>
              </div>
            )}

            {note && <div role="status" className={note.ok ? 'lg-soft lg-small' : 'lg-error'}>{note.text}</div>}

            <section aria-label="Senders" className="cl-list">
              {groups.slice(0, shown).map(g => {
                const left = g.senders.filter(s => !s.done)
                return (
                  <div key={g.domain} className="cl-group" data-group>
                    {tab !== 'done' && (
                      <div className="cl-group-head">
                        <h2 className="cl-company">{g.domain} <span className="lg-dim lg-small">{senderCount(g.senders.length)} · {[...new Set(g.senders.map(s => s.account))].join(' + ')}</span></h2>
                        {kindVerb && left.length > 1 && (
                          <button type="button" className={`lg-btn lg-btn-sm${kindVerb === 'delete' ? ' lg-btn-danger' : ''}`} disabled={busy} aria-label={`${VERB[kindVerb]} all ${n(emails(left))} emails from ${g.domain}`} onClick={() => apply(left)}>
                            {VERB[kindVerb]} all {n(emails(left))}
                          </button>
                        )}
                      </div>
                    )}
                    {g.senders.map(s => <SenderRow key={s.id} s={s} busy={busy} folders={d.folders[s.account] ?? []} run={run} />)}
                  </div>
                )
              })}
              {rows.length === 0 && <div className="lg-empty">Nothing here.</div>}
              <p className="lg-dim lg-small cl-foot">
                {groups.length > shown && <><button type="button" className="lg-link cl-more" onClick={() => setShown(shown + PAGE)}>{n(groups.length - shown)} more {tab === 'done' ? 'senders' : 'companies'} · load more ↓</button> · </>}
                receipts and tickets are kept aside and never suggested for deletion
              </p>
              {keptAside > 0 && tab !== 'done' && (
                <div className="lg-row lg-wrap">
                  {['Travel', 'Receipts', 'Finance'].map(f => {
                    const count = Object.values(d.protected).reduce((t, c) => t + (c[f] ?? 0), 0)
                    if (!count) return null
                    const exists = Object.values(d.folders).some(list => list.includes(f))
                    return <button key={f} type="button" className="lg-btn lg-btn-sm lg-btn-quiet" disabled={busy} onClick={() => void run('protect', [], `Filing ${f.toLowerCase()} in Gmail…`, { folder: f })}>File {n(count)} in {f}{exists ? '' : ' (new)'}</button>
                  })}
                </div>
              )}
            </section>
          </>
        )}
        {d && !d.senders.length && !d.scan.running && <div className="lg-empty">Nothing scanned yet. Scan to see who fills your inbox.</div>}
      </main>
    </Shell>
  )
}

function SenderRow({ s, busy, folders, run }: { s: Sender; busy: boolean; folders: string[]; run: (action: string, ids: string[], ok: string, extra?: object) => Promise<void> }) {
  const who = s.name || s.address
  return (
    <div className="cl-sender sender" data-nav data-sender={s.id} tabIndex={-1}>
      <div className="lg-grow">
        <div className="lg-ellipsis">{who} <span className="lg-dim lg-xs">{s.name ? `${s.address} · ` : ''}{s.account} · {s.category}</span></div>
        <div className="lg-dim lg-xs cl-latest">
          <span className="lg-ellipsis">latest: {s.subjects[0] ?? ''}{s.reason && ` · ${s.reason}`}</span>
          {s.suggestion === 'file' && !s.done && <FolderPick s={s} folders={folders} onPick={f => void run('folder', [s.id], '', { folder: f })} />}
        </div>
      </div>
      <span className="cl-count"><b>{n(s.total)}</b> <span className="lg-dim lg-xs">emails</span></span>
      {s.done ? (
        <div className="lg-row cl-actions">
          <span className="lg-dim lg-small">{working(s) ? (s.done === 'working:queued to delete' ? 'Queued to delete' : 'Working…') : s.done}</span>
          {s.done === 'kept' && <button type="button" className="lg-btn lg-btn-sm" onClick={() => void run('undo-keep', [s.id], '')}>Undo</button>}
        </div>
      ) : (
        <div className="lg-row cl-actions">
          {s.suggestion === 'file' && s.folder ? <button type="button" className="lg-btn lg-btn-sm lg-btn-primary" disabled={busy} onClick={() => void run('file', [s.id], `Filing ${who} in ${s.folder}…`)}>File</button>
            : s.suggestion === 'archive' ? <button type="button" className="lg-btn lg-btn-sm lg-btn-primary" disabled={busy} onClick={() => void run('archive', [s.id], `Archiving ${who}…`)}>Archive</button>
            : null}
          {s.oneClick
            ? <button type="button" className={`lg-btn lg-btn-sm${s.suggestion === 'delete' || !s.suggestion ? ' lg-btn-primary' : ''}`} aria-keyshortcuts="U" disabled={busy} onClick={() => void run('delete', [s.id], '', { unsubscribe: true })}>Unsub + delete</button>
            : s.unsubscribeLink ? <a className="lg-btn lg-btn-sm" href={s.unsubscribeLink} target="_blank" rel="noopener noreferrer">Unsub ↗</a> : null}
          <button type="button" className="lg-btn lg-btn-sm" aria-keyshortcuts="Y" disabled={busy} onClick={() => void run('delete', [s.id], '', { unsubscribe: false })}>Delete</button>
          {s.unread > 0 && <button type="button" className={`lg-btn lg-btn-sm${s.suggestion === 'read' ? ' lg-btn-primary' : ' lg-btn-quiet'}`} aria-keyshortcuts="M" disabled={busy} onClick={() => void run('read', [s.id], `Muting ${who}: marking read…`)}>Mute</button>}
          <button type="button" className="lg-btn lg-btn-sm lg-btn-quiet" aria-keyshortcuts="P" disabled={busy} onClick={() => void run('keep', [s.id], `Keeping ${who}.`)}>Keep</button>
        </div>
      )}
    </div>
  )
}

// what's running right now, in one slim line: the scan, senders being read, archived or filed, and stamped deletes
// (rolled up into one); tap it to see each
function Progress({ d }: { d: Data }) {
  const [open, setOpen] = useState(false)
  const busy = d.senders.filter(s => working(s) && s.done !== 'working:queued to delete')
  const dels = d.deleting ?? []
  const delDone = dels.reduce((t, x) => t + x.done, 0), delAll = dels.reduce((t, x) => t + x.senders, 0)
  type Row = { key: string; text: string; sub: string; of?: [number, number]; bad?: boolean }
  const rows: Row[] = []
  if (d.scan.running) rows.push({
    key: 'scan', text: `Scanning${d.scan.account ? ` the ${d.scan.account} inbox` : ''}${d.scan.of ? ` · ${d.scan.step} of ${d.scan.of}` : ''}`,
    sub: `started ${ago(d.scan.startedAt!)} · a big inbox takes a few minutes`, of: d.scan.of ? [d.scan.step! - 1, d.scan.of] : undefined,
  })
  if (busy.length) rows.push({ key: 'busy', text: `Working on ${busy.length} sender${busy.length > 1 ? 's' : ''}`, sub: 'marking read, archiving or filing in Gmail' })
  if (dels.length) rows.push({
    key: 'del', text: `Deleting · ${delDone} of ${delAll} sender${delAll > 1 ? 's' : ''} done`, of: [delDone, delAll], bad: dels.some(x => x.error),
    sub: `${dels.length} stamp${dels.length > 1 ? 's' : ''} · the fetch job works through them every 5 min`,
  })
  if (!rows.length) return null
  const lead = rows[0]
  return (
    <section className={`cl-progress${open ? ' cl-open' : ''}`} aria-label="In progress">
      <button type="button" className={`cl-prog-line${rows.some(r => r.bad) ? ' cl-prog-bad' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cl-spin" aria-hidden="true" />
        <span role="status" aria-live="polite" className="lg-ellipsis lg-grow">{lead.text}{rows.length > 1 && <span className="lg-dim"> · {rows.slice(1).map(r => r.text.toLowerCase()).join(' · ')}</span>}</span>
        {lead.of && <span className="cl-prog-bar cl-prog-mini"><span style={{ width: `${Math.max(4, lead.of[0] / lead.of[1] * 100)}%` }} /></span>}
        <span className="cl-chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="cl-prog-list">
          {rows.map(r => (
            <div key={r.key} className={`cl-prog${r.bad ? ' cl-prog-bad' : ''}`}>
              <b>{r.text}</b>
              <span className="lg-dim lg-xs">{r.sub}</span>
              {r.of && <span className="cl-prog-bar"><span style={{ width: `${Math.max(4, r.of[0] / r.of[1] * 100)}%` }} /></span>}
            </div>
          ))}
          {dels.map(x => (
            <div key={x.title + x.approvedAt} className={`cl-prog-row${x.error ? ' cl-prog-bad' : ''}`}>
              <span className="lg-ellipsis lg-grow">{x.title}</span>
              <span className="lg-dim lg-xs">{x.error ? `stalled: ${x.error}` : x.done === x.senders ? 'done' : x.done ? `${x.done} of ${x.senders}` : 'queued'}{x.approvedAt ? ` · stamped ${ago(x.approvedAt)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
