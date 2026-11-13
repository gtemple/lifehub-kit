import { useEffect, useState } from 'react'

import { post } from './api'
import { AccountTag, Btn, LinkBtn, Stamp, Window, wide } from './components/ui'
import { Shell } from './Shell'
import { clock, when } from './time'
import type { Approval, Email, EmailAccount } from './types'

type Detail = {
  approval: Approval
  email: (Email & { body: string }) | null
  accounts: { account: EmailAccount; name: string; address: string }[]
  position: [number, number]
}
type Draft = { to: string; subject: string; body: string }

// newTime offers open times from your calendars instead
const STYLES: [string, string][] = [['shorter', 'Shorter'], ['warmer', 'Warmer'], ['formal', 'More formal'], ['newTime', 'Suggest another time']]
export const placeholders = (body: string) => body.match(/\[[^\]\n]{1,60}\]/g) ?? []

// "Edit before you stamp" (design/screens/Approval.dc.html), opened at /?approval=<id>
export function ApprovalEdit({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null)
  const [draft, setDraft] = useState<Draft>({ to: '', subject: '', body: '' })
  const [account, setAccount] = useState<EmailAccount>('work')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [stamped, setStamped] = useState<'yes' | 'no' | null>(null)

  useEffect(() => {
    fetch(`/api/approvals/${id}/`, { credentials: 'same-origin' }).then(r => r.json()).then((x: Detail) => {
      setD(x)
      const p = x.approval.payload as Draft
      setDraft({ to: p.to ?? '', subject: p.subject ?? '', body: p.body ?? '' })
      if (x.approval.account) setAccount(x.approval.account)
    })
  }, [id])

  if (!d) return null
  const a = d.approval
  const pending = a.status === 'pending' && !stamped
  const gaps = placeholders(draft.body)
  const back = () => { location.href = '/' }
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

  const switchFrom = () => {
    const i = d.accounts.findIndex(x => x.account === account)
    setAccount(d.accounts[(i + 1) % d.accounts.length]!.account)
  }

  return (
    <Shell screen="approvalEdit" handlers={{ switchFromAccount: switchFrom, closeOrBack: back }}>
      <main className="shell">
        <header className="page-head">
          <LinkBtn tone="face" lower href="/">← dashboard</LinkBtn>
          <h1 className="page-title">{wide('EDIT BEFORE YOU STAMP')}</h1>
        </header>
        <div style={{ alignSelf: 'flex-end' }}>
          <span className="chip-yellow">
            {d.position[0] ? `approval ${d.position[0]} of ${d.position[1]} · ` : ''}drafted {clock(a.createdAt)}{a.model !== 'none' ? ` by ${a.model}` : ''}
          </span>
        </div>

        <div className="edit-grid">
          <div style={{ flex: '1 1 380px', minWidth: 0 }}><Window name="original_message.eml" grad={1} jp="受信" headingLevel="h2">
            {d.email ? (
              <>
                <div className="split">
                  <span className="mail-who"><strong>{d.email.from.name}</strong><AccountTag account={d.email.account} /></span>
                  <span className="mail-time">{when(d.email.receivedAt)}</span>
                </div>
                <div className="one-line"><b>in one line:</b> {d.email.summary}</div>
                <p className="original">{d.email.body}</p>
                {d.email.url && <a href={d.email.url} target="_blank" rel="noopener" className="text-link">open in gmail ↗</a>}
              </>
            ) : <p className="sub">The original email is no longer in your inbox.</p>}
            <span className="vt sub" style={{ fontSize: 24 }}>why lifehub wrote this:</span>
            <span className="small">{a.reason || a.detail}</span>
          </Window></div>

          <div style={{ flex: '2 1 560px', minWidth: 0 }}>
            <Window
              name={`reply_draft.txt${pending ? ' *' : ''}`} grad={0} jp="下書き" headingLevel="h2"
              foot={pending ? (
                <>
                  <Btn tone="mint" size="lg" k="Meta+Enter" disabled={!!busy || gaps.length > 0} onClick={() => decide('yes')}>Approve &amp; send</Btn>
                  <Btn tone="face" size="lg" k="Meta+S" hint="" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Btn>
                  <Btn tone="pink" size="lg" k="Meta+Backspace" hint="" disabled={!!busy} onClick={() => decide('no')}>Discard</Btn>
                  <span className="vt grow" style={{ fontSize: 22, textAlign: 'right' }}>undo available 30s after sending</span>
                </>
              ) : undefined}
            >
              <div className={`col gap8 ${stamped ? 'dimmed' : ''}`} style={{ position: 'relative' }}>
                <div className="form-grid">
                  <label htmlFor="from">FROM:</label>
                  <select id="from" className="field" style={{ fontFamily: 'var(--font-body)', fontSize: 13 }} value={account} onChange={e => setAccount(e.target.value as EmailAccount)} disabled={!pending} aria-keyshortcuts="Alt+F">
                    {d.accounts.map(x => <option key={x.account} value={x.account}>{x.account} · {x.address}</option>)}
                  </select>
                  <label htmlFor="to">TO:</label>
                  <input id="to" className="field" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} disabled={!pending} />
                  <label htmlFor="subj">SUBJ:</label>
                  <input id="subj" className="field" value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} disabled={!pending} />
                </div>
                <label htmlFor="body" className="visually-hidden">Message</label>
                <textarea id="body" className="field" rows={9} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} disabled={!pending} />
                {gaps.length > 0 && <span className="small magenta strong">fill in {gaps.join(', ')} before sending.</span>}
                <div className="row gap8 wrap">
                  <span className="vt" style={{ fontSize: 24 }}>rewrite:</span>
                  {STYLES.map(([k, label], i) => (
                    <button key={k} type="button" className={`chip ${['chip-cyan', 'chip-pink', 'chip-gray', 'chip-yellow-btn'][i]}`} aria-keyshortcuts={`Alt+${i + 1}`} disabled={!pending || !!busy} onClick={() => rewrite(k)}>
                      {busy === k ? 'rewriting…' : label.toLowerCase()}
                    </button>
                  ))}
                </div>
              </div>
              {error && <div role="alert" className="note-line err">Couldn’t do that. {error}</div>}
              {!pending && !stamped && <span className="sub">This one is already {a.status}.</span>}
              {stamped && <Stamp yes={stamped === 'yes'} />}
            </Window>
          </div>
        </div>
      </main>
    </Shell>
  )
}
