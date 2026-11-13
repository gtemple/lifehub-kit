import { useEffect, useState } from 'react'

import { placeholders } from '../ApprovalEdit'
import { post } from '../api'
import { Shell } from '../Shell'
import { clock, when } from '../time'
import type { Approval, Email, EmailAccount } from '../types'
import { mac } from './TopBar'
import './draft.css'

type Detail = {
  approval: Approval
  email: (Email & { body: string }) | null
  accounts: { account: EmailAccount; name: string; address: string }[]
  position: [number, number]
}
type Draft = { to: string; cc: string; subject: string; body: string }

// newTime offers open times from your calendars instead
// polish goes to Gemini (only the draft, never the email it answers), even with Gemini off for private mail
const STYLES: [string, string][] = [['shorter', 'Shorter'], ['warmer', 'Warmer'], ['formal', 'More formal'], ['newTime', 'Suggest another time'], ['polish', 'Polish with Gemini']]
const MODEL = { ollama: 'Ollama', gemini: 'Gemini', none: '' }

export function DraftEditor({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState<Draft>({ to: '', cc: '', subject: '', body: '' })
  const [account, setAccount] = useState<EmailAccount>('work')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [stamped, setStamped] = useState<'yes' | 'no' | null>(null)

  useEffect(() => {
    fetch(`/api/approvals/${id}/`, { credentials: 'same-origin' }).then(r => r.json()).then((x: Detail) => {
      setD(x)
      const p = x.approval.payload as Draft
      setDraft({ to: p.to ?? '', cc: p.cc ?? '', subject: p.subject ?? '', body: p.body ?? '' })
      if (x.approval.account) setAccount(x.approval.account)
    }, () => setFailed(true))
  }, [id])

  const back = () => { location.href = '/' }
  const switchFrom = () => {
    if (!d) return
    const i = d.accounts.findIndex(x => x.account === account)
    setAccount(d.accounts[(i + 1) % d.accounts.length]!.account)
  }

  const a = d?.approval
  const pending = a?.status === 'pending' && !stamped
  const gaps = placeholders(draft.body)
  const edits = { payload: draft, account }

  const run = (label: string, f: () => Promise<unknown>) => {
    setBusy(label); setError('')
    f().catch(e => setError(String(e.message || e))).finally(() => setBusy(''))
  }
  const rewrite = (style: string) => run(style, async () => {
    const r = await post<{ body: string }>(`/api/approvals/${id}/rewrite/`, { style, body: draft.body })
    setDraft(x => ({ ...x, body: r.body }))
  })
  const decide = (v: 'yes' | 'no') => run(v, async () => {
    await post(`/api/approvals/${id}/decide/`, v === 'yes' ? { decision: 'approve', ...edits } : { decision: 'decline' })
    setStamped(v)
    setTimeout(back, 1600)
  })
  const save = () => run('save', () => post(`/api/approvals/${id}/save/`, edits))

  return (
    <Shell screen="approvalEdit" handlers={{ switchFromAccount: switchFrom, closeOrBack: back }}>
      <header className="lg-top">
        <div className="lg-top-in de-top">
          <a href="/" className="lg-link de-back">← Dashboard</a>
          <span className="lg-decor" aria-hidden="true">/</span>
          <h1 className="lg-strong de-crumb">Draft reply</h1>
          {a && (
            <span className={`de-status lg-small ${pending ? 'lg-yellow' : 'lg-dim'}`}>
              {stamped ? (stamped === 'yes' ? 'stamped · sending' : 'discarded') : pending ? 'waiting for your stamp' : `already ${a.status}`}
              {pending && d.position[0] ? <span className="lg-dim"> · {d.position[0]} of {d.position[1]}</span> : null}
            </span>
          )}
        </div>
      </header>

      <main className="lg-main de">
        {failed && <p className="lg-error">Couldn’t load this draft.</p>}
        {!d && !failed && <p className="lg-empty">Loading…</p>}
        {d && a && (
          <>
            <article aria-label="Original email" className="de-orig">
              <span className="lg-dim lg-small">Replying to</span>
              {d.email ? (
                <div className="de-card">
                  <span className="lg-dim lg-small">{d.email.from.name} · {d.email.account} · {when(d.email.receivedAt)}</span>
                  <h2 className="de-h2">{d.email.subject}</h2>
                  <div className="de-orig-body">{d.email.body}</div>
                  {d.email.url && <a href={d.email.url} target="_blank" rel="noopener" className="lg-link">Open in Gmail ↗</a>}
                </div>
              ) : <p className="lg-empty">The original email is no longer in your inbox.</p>}
              <span className="lg-dim lg-xs de-why">
                Drafted {clock(a.createdAt)}{a.model !== 'none' ? ` by ${MODEL[a.model]}` : ''}{(a.reason || a.detail) ? ` · ${a.reason || a.detail}` : ''}
              </span>
            </article>

            <section aria-label="Your reply" className="de-reply">
              <div className="de-fields">
                <label htmlFor="de-to">To</label>
                <input id="de-to" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} disabled={!pending} />
                <label htmlFor="de-cc">Cc</label>
                <input id="de-cc" value={draft.cc} placeholder="nobody" onChange={e => setDraft({ ...draft, cc: e.target.value })} disabled={!pending} />
                <label htmlFor="de-subj">Subject</label>
                <input id="de-subj" value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} disabled={!pending} />
                <label htmlFor="de-from">From</label>
                <select id="de-from" value={account} onChange={e => setAccount(e.target.value as EmailAccount)} disabled={!pending} aria-keyshortcuts="Alt+F">
                  {d.accounts.map(x => <option key={x.account} value={x.account}>{x.account === 'work' ? 'Work' : 'Personal'} · {x.address}</option>)}
                </select>
              </div>
              <label htmlFor="de-body" className="visually-hidden">Message</label>
              <textarea id="de-body" className="de-body" rows={9} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} disabled={!pending} />
              {gaps.length > 0 && pending && <span className="lg-yellow lg-small">Fill in {gaps.join(', ')} before sending.</span>}
              <div className="lg-row lg-wrap de-styles">
                <span className="lg-dim lg-small">Rewrite</span>
                {STYLES.map(([k, name], i) => (
                  <button key={k} type="button" className="de-style" aria-keyshortcuts={`Alt+${i + 1}`} title={k === 'polish' ? 'Sends just this draft (not the email it answers) to Google Gemini' : undefined} disabled={!pending || !!busy} onClick={() => rewrite(k)}>
                    {busy === k ? 'Rewriting…' : name}
                  </button>
                ))}
              </div>
              {pending && (
                <div className="lg-row lg-wrap de-actions">
                  <button type="button" className="lg-btn lg-btn-lg lg-btn-primary" aria-keyshortcuts="Meta+Enter" disabled={!!busy || gaps.length > 0} onClick={() => decide('yes')}>
                    {busy === 'yes' ? 'Sending…' : 'Approve & send'} <span className="lg-hint">{mac ? '⌘↵' : 'Ctrl ↵'}</span>
                  </button>
                  <button type="button" className="lg-btn lg-btn-lg" aria-keyshortcuts="Meta+S" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>
                  <button type="button" className="lg-btn lg-btn-lg lg-btn-danger" aria-keyshortcuts="Meta+Backspace" disabled={!!busy} onClick={() => decide('no')}>Discard</button>
                  <span className="lg-dim lg-xs de-note">Sends from Gmail · undo for 30 s from the bell</span>
                </div>
              )}
              {stamped && <p role="status" className="lg-small">{stamped === 'yes' ? 'Stamped. Sending from Gmail — undo from the bell for 30 s.' : 'Discarded.'} Back to the dashboard…</p>}
              {error && <p role="alert" className="lg-error">Couldn’t do that. {error}</p>}
            </section>
          </>
        )}
      </main>
    </Shell>
  )
}
