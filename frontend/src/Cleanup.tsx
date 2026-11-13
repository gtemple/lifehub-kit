import { useCallback, useEffect, useRef, useState } from 'react'

import { post } from './api'
import { AccountTag, Btn, LinkBtn, Stat, Tag, Window, wide } from './components/ui'
import type { TagTone } from './components/ui'
import { Shell } from './Shell'
import { ago, clock } from './time'
import type { Approval, EmailAccount } from './types'

export type Suggestion = 'delete' | 'file' | 'archive' | 'read' | 'keep'
export type Sender = {
  id: string; account: EmailAccount; address: string; name: string; total: number; unread: number; category: string
  protected: number; subjects: string[]; replied: boolean; oneClick: boolean; unsubscribeLink: string; suggestion: Suggestion | ''; reason: string; folder: string; newFolder: boolean; done: string
}
type Scan = { running?: boolean; startedAt?: string; finishedAt?: string; unread?: number; senders?: number; error?: string; account?: string; step?: number; of?: number }
export type Deleting = { title: string; senders: number; done: number; approvedAt: string | null; error: string }
export type Data = { scan: Scan; deleting?: Deleting[]; ollamaUp: boolean; folders: Record<string, string[]>; protected: Record<string, Record<string, number>>; senders: Sender[] }
export type Tab = 'suggested' | 'all' | 'done'

// what Ollama suggested, as the chips inside the suggested tab
const KINDS: { key: Suggestion | 'pending'; label: string; tone: TagTone }[] = [
  { key: 'delete', label: 'delete', tone: 'pink' },
  { key: 'file', label: 'file in folders', tone: 'yellow' },
  { key: 'archive', label: 'archive', tone: 'cyan' },
  { key: 'read', label: 'mute (mark read)', tone: 'gray' },
  { key: 'keep', label: 'keep', tone: 'mint' },
  { key: 'pending', label: 'not looked at yet', tone: 'face' },
]
export const TABS: Tab[] = ['suggested', 'all', 'done']
const CATEGORY_TONE: Record<string, TagTone> = { promotions: 'pink', social: 'mint', updates: 'cyan', forums: 'purple', primary: 'gray' }
export const PAGE = 50
export const BATCH = 25 // the biggest senders first, a stamp you can actually skim
export const n = (x: number) => x.toLocaleString('en-CA')
export const working = (s: Sender) => s.done.startsWith('working')
export const isDone = (s: Sender) => !!s.done && !working(s)
export const LEAVES = ['delete', 'keep', 'read', 'file', 'archive', 'undo-keep']
const still = () => document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches

// rows that are about to drop out of the list fold up first, so everything below slides up instead of jumping
export function foldAway(ids: string[]) {
  const rows = ids.map(id => document.querySelector<HTMLElement>(`[data-sender="${id}"]`)).filter((el): el is HTMLElement => !!el)
  const groups = new Set(rows.map(r => r.closest<HTMLElement>('[data-group]')).filter((g): g is HTMLElement => !!g && [...g.querySelectorAll('[data-sender]')].every(r => rows.includes(r as HTMLElement))))
  const targets = [...rows.filter(r => ![...groups].some(g => g.contains(r))), ...groups]
  const all = [...document.querySelectorAll<HTMLElement>('.sender[data-sender]')]
  const next = all.slice(all.indexOf(rows.at(-1)!) + 1).find(r => !rows.includes(r)) ?? all.filter(r => !rows.includes(r)).at(-1)
  const anims = targets.map(el => {
    el.style.overflow = 'hidden'
    return el.animate([{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', borderBottomWidth: '0px' }],
      { duration: still() ? 0 : 260, easing: 'ease-in', fill: 'forwards' })
  })
  return {
    done: Promise.all(anims.map(a => a.finished)),
    // a row that didn't leave after all (the request failed) comes back
    settle: () => { anims.forEach(a => a.cancel()); targets.forEach(el => { el.style.overflow = '' }); next?.focus({ preventScroll: true }) },
  }
}
// e.bestbuy.ca -> bestbuy.ca, mail.amazon.co.uk -> amazon.co.uk: one company's many sending addresses together
const domainOf = (address: string) => {
  const parts = (address.split('@')[1] ?? address).toLowerCase().split('.')
  const keep = parts.length > 2 && parts.at(-1)!.length === 2 && ['co', 'com', 'org', 'net'].includes(parts.at(-2)!) ? 3 : 2
  return parts.slice(-keep).join('.')
}
// ordered by each company's size when the page first saw it: handled senders drop to 0 emails once Gmail is done,
// and re-sorting then would move a whole group out from under you
export const groupByDomain = (list: Sender[], everyone: Sender[], seen: Map<string, number>) => {
  const size = new Map<string, number>()
  for (const s of everyone) size.set(domainOf(s.address), (size.get(domainOf(s.address)) ?? 0) + s.total)
  for (const [domain, total] of size) if (!seen.has(domain)) seen.set(domain, total)
  const by = new Map<string, Sender[]>()
  for (const s of list) by.set(domainOf(s.address), [...(by.get(domainOf(s.address)) ?? []), s])
  return [...by.entries()].map(([domain, senders]) => ({ domain, senders, total: senders.reduce((t, x) => t + x.total, 0) }))
    .sort((a, b) => seen.get(b.domain)! - seen.get(a.domain)! || a.domain.localeCompare(b.domain))
}

// cleanup.exe (design/screens/VWSenders.dc.html): Ollama suggests what to do with each sender's pile; you apply it
export function CleanupPage() {
  const [d, setD] = useState<Data | null>(null)
  const [acct, setAcct] = useState<'all' | EmailAccount>('all')
  const [tab, setTab] = useState<Tab>('suggested')
  const [kind, setKind] = useState<Suggestion | 'pending'>('delete')
  const [shown, setShown] = useState(PAGE)
  const [unsub, setUnsub] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stamp, setStamp] = useState<Approval | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const seenSize = useRef(new Map<string, number>())

  const load = useCallback(() => fetch('/api/cleanup/', { credentials: 'same-origin' }).then(r => {
    if (r.redirected) location.href = '/login/?next=/cleanup'
    return r.json()
  }).then(setD), [])
  const active = !!d && (!!d.scan.running || d.senders.some(working))
  useEffect(() => {
    void load()
    const id = setInterval(load, active ? 4000 : 60_000)
    return () => clearInterval(id)
  }, [load, active])

  const senders = (d?.senders ?? []).filter(s => acct === 'all' || s.account === acct)
  const rows = tab === 'done' ? senders.filter(isDone)
    : tab === 'all' ? senders.filter(s => !isDone(s))
    : senders.filter(s => !isDone(s) && (s.suggestion || 'pending') === kind)
  const open = rows.filter(s => !s.done)
  const emails = (list: Sender[]) => list.reduce((t, s) => t + s.total, 0)
  const batch = open.slice(0, BATCH)
  const groups = tab === 'done' ? rows.map(s => ({ domain: s.address, senders: [s], total: s.total })) : groupByDomain(rows, d?.senders ?? [], seenSize.current)
  const kindVerb = tab === 'suggested' && kind !== 'keep' && kind !== 'pending' ? kind : null

  const run = async (action: string, ids: string[], ok: string, extra: object = {}) => {
    setBusy(true); setNote(null)
    let fold: ReturnType<typeof foldAway> | null = null
    try {
      const res = await post<Approval & { started?: number }>('/api/cleanup/apply/', { ids, action, unsubscribe: unsub, ...extra })
      if (LEAVES.includes(action)) { fold = foldAway(ids); await fold.done }
      if (action === 'delete') setStamp(res)
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
      setNote({ ok: true, text: decision === 'approve' ? 'Stamped. Moving to Trash in 30 s; undo from the bell on the dashboard.' : 'Kept them all.' })
      setStamp(null)
      await load()
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  // ok notes go away on their own: they sit over the list now
  useEffect(() => {
    if (!note?.ok) return
    const id = setTimeout(() => setNote(null), 5000)
    return () => clearTimeout(id)
  }, [note])
  const scan = () => post('/api/cleanup/scan/').then(load)
  const apply = (list: Sender[]) => {
    if (!list.length || busy || !kindVerb) return
    void run(kindVerb, list.map(s => s.id), kindVerb === 'file' ? 'Filing in Gmail…' : kindVerb === 'archive' ? 'Archiving in Gmail…' : kindVerb === 'delete' ? '' : 'Marking read in Gmail…')
  }
  const queueAll = () => apply(batch)
  const handlers = {
    queueAllSuggested: queueAll,
    prevTab: () => setTab(t => TABS[(TABS.indexOf(t) + TABS.length - 1) % TABS.length]!),
    nextTab: () => setTab(t => TABS[(TABS.indexOf(t) + 1) % TABS.length]!),
  }

  const scanned = d?.scan.finishedAt
  const looked = (d?.senders ?? []).filter(s => s.suggestion).length
  const keptAside = Object.values(d?.protected ?? {}).reduce((t, c) => t + Object.values(c).reduce((a, b) => a + b, 0), 0)
  const deleteSuggested = (d?.senders ?? []).filter(s => !isDone(s) && s.suggestion === 'delete')
  const suggested = (d?.senders ?? []).filter(s => !isDone(s) && s.suggestion && s.suggestion !== 'keep')
  const handled = (d?.senders ?? []).filter(isDone)
  const oneClicks = open.filter(s => s.oneClick).length

  return (
    <Shell screen="cleanup" handlers={handlers}>
      <main className={`shell${stamp ? ' docked' : ''}`}>
        <header className="page-head">
          <LinkBtn tone="face" lower href="/inbox">← inbox</LinkBtn>
          <div className="col gap4">
            <h1 className="page-title">{wide('CLEANUP.EXE')}</h1>
            <span className="page-sub">
              {d?.scan.running ? <span className="cursor">scanning both inboxes (headers only), started {ago(d.scan.startedAt!)}</span>
                : scanned ? <>scanned {n(d!.scan.unread ?? 0)} unread emails from {n(d!.scan.senders ?? 0)} senders · {clock(scanned)} · {d!.ollamaUp ? 'ollama.local' : 'ollama away'}</>
                : 'not scanned yet'}
              {' · '}<span className="jp" aria-hidden="true">掃除</span>
            </span>
          </div>
          {d && !d.scan.running && <Btn tone={scanned ? 'face' : 'mint'} lower onClick={() => void scan()}>{scanned ? 'scan again' : 'scan inboxes'}</Btn>}
        </header>

        {d?.scan.error && <div className="note-line err" role="alert">last scan failed: {d.scan.error}</div>}

        {d && d.senders.length > 0 && (
          <>
            <div className="row wrap gap12">
              <div className="seg" role="tablist" aria-label="Senders">
                {TABS.map(t => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => { setTab(t); setShown(PAGE) }}>
                    {t === 'suggested' ? `suggested (${n(suggested.length)})` : t === 'all' ? `all senders (${n(senders.filter(s => !isDone(s)).length)})` : `done (${n(handled.length)})`}
                  </button>
                ))}
              </div>
              <button type="button" className="visually-hidden" aria-keyshortcuts="[" onClick={handlers.prevTab}>Previous tab</button>
              <button type="button" className="visually-hidden" aria-keyshortcuts="]" onClick={handlers.nextTab}>Next tab</button>
              <div className="seg" role="group" aria-label="Account">
                {(['all', 'work', 'personal'] as const).map(a => <button key={a} type="button" aria-pressed={acct === a} onClick={() => { setAcct(a); setShown(PAGE) }}>{a === 'all' ? 'both' : a}</button>)}
              </div>
            </div>

            <div className="stats-row">
              <Stat mini label="unread scanned" value={n(d.scan.unread ?? 0)} accent="pink" />
              <Stat mini label="senders" value={n(d.senders.length)} accent="cyan" />
              <Stat mini label="suggested to delete" value={n(deleteSuggested.length)} accent="yellow" />
              <Stat mini label="emails in those piles" value={n(emails(deleteSuggested))} accent="purple" />
              <Stat mini label="looked at by ollama" value={`${Math.round((looked / d.senders.length) * 100)}%`} accent="mint" />
              <Stat mini label="receipts & tickets kept aside" value={n(keptAside)} accent="cyan" />
              <Stat mini label="senders handled" value={n(handled.length)} accent="pink" />
            </div>

            {keptAside > 0 && (
              <Window name="kept_aside.lst · one email at a time" grad={3} light jp="保管">
                <span className="small">Gmail tags each receipt, ticket and statement. They are never deleted, archived or filed with their sender; file them here.</span>
                {['Travel', 'Receipts', 'Finance'].map(f => {
                  const count = Object.values(d.protected).reduce((t, c) => t + (c[f] ?? 0), 0)
                  if (!count) return null
                  const exists = Object.values(d.folders).some(list => list.includes(f))
                  return (
                    <div key={f} className="setting-row">
                      <span><b className="vt" style={{ fontSize: 26 }}>{n(count)}</b> {f === 'Travel' ? 'tickets and bookings' : f === 'Receipts' ? 'receipts and orders' : 'bank and finance emails'}</span>
                      <Btn tone="yellow" size="sm" lower disabled={busy} onClick={() => void run('protect', [], `Filing ${f.toLowerCase()} in Gmail…`, { folder: f })}>file in {f}{exists ? '' : ' (new)'}</Btn>
                    </div>
                  )
                })}
              </Window>
            )}

            {tab === 'suggested' && (
              <div className="row wrap gap6" role="group" aria-label="What Ollama suggests">
                {KINDS.map(k => {
                  const c = senders.filter(s => !isDone(s) && (s.suggestion || 'pending') === k.key).length
                  return <button key={k.key} type="button" className={`chip chip-${k.tone === 'yellow' ? 'yellow-btn' : k.tone}`} aria-pressed={kind === k.key} onClick={() => { setKind(k.key); setShown(PAGE); setStamp(null) }} style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>{k.label} · {n(c)}</button>
                })}
                <span className="small on-sky">
                  ollama has looked at {n(looked)} of {n(d.senders.length)}{looked < d.senders.length && (d.ollamaUp ? ', more every 5 min' : ', paused while Ollama is away')}
                </span>
              </div>
            )}

            {tab === 'suggested' && open.length > 0 && kind !== 'keep' && kind !== 'pending' && (
              <div className="suggest">
                <div className="col gap4 grow">
                  <span className="head">!! lifehub suggests · next {n(batch.length)} biggest</span>
                  <b>
                    {kind === 'delete' ? `Clear ${n(batch.length)} senders: ${n(emails(batch))} emails.`
                      : kind === 'file' ? `File ${n(emails(batch))} emails from ${n(batch.length)} senders into ${n(new Set(batch.map(s => s.folder)).size)} folders (${n(new Set(batch.filter(s => s.newFolder).map(s => s.folder)).size)} new).`
                      : kind === 'archive' ? `Archive ${n(emails(batch))} emails from ${n(batch.length)} senders.`
                      : `Mute ${n(batch.length)} senders: mark ${n(batch.reduce((t, s) => t + s.unread, 0))} emails read.`}
                  </b>
                  <span className="small">
                    {emails(open) ? `${Math.round((emails(batch) / emails(open)) * 100)}% of this pile` : ''} ({n(open.length)} senders, {n(emails(open))} emails in all). They're the ones numbered 01–{String(batch.length).padStart(2, '0')} below; skim them, change any, then go.
                  </span>
                  <span className="small">
                    {kind === 'delete' ? 'Everything goes to Trash (kept 30 days) and lands in needs_your_stamp before anything happens.'
                      : kind === 'file' ? 'Out of the inbox into each folder; new folders are created in Gmail. Change a folder on any row first.'
                      : kind === 'archive' ? 'Out of the inbox, still in All Mail and search. Happens right away.'
                      : 'They stay in the inbox, just not flagged. Happens right away.'}
                  </span>
                  {kind === 'delete' && oneClicks > 0 && <label className="row gap8 small"><input type="checkbox" checked={unsub} onChange={e => setUnsub(e.target.checked)} />also unsubscribe from the {n(oneClicks)} with one-click unsubscribe</label>}
                </div>
                <Btn tone="mint" k="Shift+U" disabled={busy || !!stamp} onClick={queueAll}>{kind === 'delete' ? `queue ${n(batch.length)} for stamp` : `${kind === 'file' ? 'file' : kind === 'archive' ? 'archive' : 'mute'} these ${n(batch.length)}`}</Btn>
                <Btn tone="face" disabled={busy} onClick={() => document.querySelector<HTMLElement>('.sender[data-nav]')?.focus()}>review one by one</Btn>
              </div>
            )}

            <div className="cleanup-dock">
            {stamp && (
              <div className="stamp-card">
                <span className="head">!! waiting for your stamp</span>
                <b>{stamp.title}</b>
                <span className="small">{stamp.detail}</span>
                <div className="actions">
                  <Btn tone="mint" disabled={busy} onClick={() => void decide('approve')}>Approve</Btn>
                  <Btn tone="pink" disabled={busy} onClick={() => void decide('decline')}>Nope</Btn>
                </div>
              </div>
            )}

            {note && <div role="status" className={`note-line ${note.ok ? '' : 'err'}`}>{note.text}</div>}
            </div>

            <Window name={<span className="split"><span># &nbsp;sender · what lifehub sees</span><span>action</span></span>} grad={4} dialog bodyClass="tight">
              <div style={{ margin: -12 }}>
                {groups.slice(0, shown).map(g => (
                  <div key={g.domain} data-group>
                    {tab !== 'done' && (
                      <div className="sender-group">
                        <span><b>{g.domain}</b> · {g.senders.length > 1 ? `${n(g.senders.length)} senders · ` : ''}{n(g.total)} emails</span>
                        {kindVerb && g.senders.filter(s => !s.done).length > 1 && (
                          <Btn tone={kindVerb === 'delete' ? 'pink' : 'cyan'} size="sm" lower disabled={busy} onClick={() => apply(g.senders.filter(s => !s.done))}>
                            {kindVerb === 'delete' ? 'stamp' : kindVerb === 'file' ? 'file' : kindVerb === 'archive' ? 'archive' : 'mute'} all {n(g.senders.filter(s => !s.done).length)}
                          </Btn>
                        )}
                      </div>
                    )}
                    {g.senders.map(s => <SenderRow key={s.id} s={s} rank={rows.indexOf(s) + 1} busy={busy} folders={d.folders[s.account] ?? []} run={run} />)}
                  </div>
                ))}
                {rows.length === 0 && <div className="empty-state"><div className="mini-sun" aria-hidden="true" /><span className="empty-title">{wide('all clear')}</span><span className="small">nothing here.</span></div>}
                {groups.length > shown && (
                  <div style={{ padding: 12, textAlign: 'center', background: 'var(--face)' }}>
                    <Btn tone="face" lower onClick={() => setShown(shown + PAGE)}>load more ▼ ({n(groups.length - shown)} more {tab === 'done' ? 'senders' : 'companies'})</Btn>
                  </div>
                )}
              </div>
            </Window>
          </>
        )}
      </main>
    </Shell>
  )
}

function SenderRow({ s, rank, busy, folders, run }: { s: Sender; rank: number; busy: boolean; folders: string[]; run: (action: string, ids: string[], ok: string, extra?: object) => Promise<void> }) {
  return (
    <div className="sender" data-nav data-sender={s.id} tabIndex={-1}>
      <span className="rank">{String(rank).padStart(2, '0')}</span>
      <div className="col gap4" style={{ minWidth: 0 }}>
        <span className="who">{s.name}<AccountTag account={s.account} /><Tag tone={CATEGORY_TONE[s.category] ?? 'gray'}>{s.category}</Tag><span className="sub small" style={{ fontWeight: 400 }}>{s.address}</span></span>
        <span className="nums">{n(s.unread)} unread · {n(s.total)} in inbox{s.protected ? ` · ${n(s.protected)} receipts kept aside` : ''}</span>
        <span className="small sub">
          “{s.subjects[0] ?? ''}”{s.reason && <> · {s.reason}</>}
          {s.suggestion === 'file' && !s.done && <> · <FolderPick s={s} folders={folders} onPick={f => void run('folder', [s.id], '', { folder: f })} /></>}
        </span>
      </div>
      {s.done ? (
        <div className="col gap6" style={{ alignItems: 'flex-end' }}>
          <span className="sender-done"><span className="label">{working(s) ? 'working…' : s.done}</span></span>
          {s.done === 'kept' && <Btn tone="face" size="sm" lower onClick={() => void run('undo-keep', [s.id], '')}>undo</Btn>}
        </div>
      ) : (
        <div className="sender-actions">
          <Btn tone="pink" size="sm" k="Y" disabled={busy} onClick={() => void run('delete', [s.id], '', { unsubscribe: false })}>delete all</Btn>
          {s.oneClick
            ? <Btn tone="yellow" size="sm" k="U" disabled={busy} onClick={() => void run('delete', [s.id], '', { unsubscribe: true })}>unsub+del</Btn>
            : s.unsubscribeLink ? <LinkBtn tone="yellow" size="sm" href={s.unsubscribeLink} target="_blank" rel="noopener">unsub ↗</LinkBtn> : <span />}
          <Btn tone="face" size="sm" k="P" disabled={busy} onClick={() => void run('keep', [s.id], `Keeping ${s.name}.`)}>keep</Btn>
          {s.unread > 0 ? <Btn tone="gray" size="sm" k="M" disabled={busy} onClick={() => void run('read', [s.id], `Muting ${s.name}: marking read…`)}>mute</Btn> : <span />}
          {s.folder && <Btn tone="cyan" size="sm" disabled={busy} onClick={() => void run('file', [s.id], `Filing ${s.name} in ${s.folder}…`)}>file</Btn>}
          <Btn tone="gray" size="sm" disabled={busy} onClick={() => void run('archive', [s.id], `Archiving ${s.name}…`)}>archive</Btn>
        </div>
      )}
    </div>
  )
}

// the suggested folder, editable: any existing folder, or type a new name
export function FolderPick({ s, folders, onPick }: { s: Sender; folders: string[]; onPick: (f: string) => void }) {
  const [value, setValue] = useState(s.folder)
  useEffect(() => setValue(s.folder), [s.folder])
  const save = () => { if (value.trim() && value.trim() !== s.folder) onPick(value.trim()) }
  return (
    <span className="folder-pick">
      →
      <label className="visually-hidden" htmlFor={`f${s.id}`}>Folder for {s.name}</label>
      <input id={`f${s.id}`} list={`folders-${s.account}`} value={value} onChange={e => setValue(e.target.value)} onBlur={save} onKeyDown={e => e.key === 'Enter' && save()} />
      <datalist id={`folders-${s.account}`}>{folders.map(f => <option key={f} value={f} />)}</datalist>
      {s.newFolder && <Tag tone="yellow">new</Tag>}
    </span>
  )
}
