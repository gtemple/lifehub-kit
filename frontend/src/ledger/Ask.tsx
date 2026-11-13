import { useEffect, useRef, useState } from 'react'

import { placeholders } from '../ApprovalEdit'
import { addTodos, blocks, listItems, useAsk, useAskKeys } from '../askCore'
import { post } from '../api'
import type { Approval } from '../types'
import './ask.css'

const TRY = ['What needs a reply?', 'What’s on today?', 'Archive the newsletters']
const mac = navigator.platform.startsWith('Mac')

const bold = (text: string) => text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
  part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part
))

function Answer({ text }: { text: string }) {
  return (
    <div className="ask-answer">
      {blocks(text).map((b, i) => 'p' in b ? <p key={i}>{bold(b.p)}</p>
        : b.ordered ? <ol key={i}>{b.items.map((t, j) => <li key={j}>{bold(t)}</li>)}</ol>
        : <ul key={i}>{b.items.map((t, j) => <li key={j}>{bold(t)}</li>)}</ul>)}
    </div>
  )
}

function AddAll({ items }: { items: string[] }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  const [added, setAdded] = useState(0)
  const add = () => {
    setState('busy')
    addTodos(items).then(n => { setAdded(n); setState('done') }, () => setState('failed'))
  }
  return (
    <button type="button" className="lg-btn" disabled={state === 'busy' || state === 'done'} onClick={add}>
      {state === 'done' ? (added ? `Added ${added} to to-do` : 'Already on your to-do') : state === 'failed' ? 'Couldn’t add, try again' : state === 'busy' ? 'Adding…' : 'Add all to to-do'}
    </button>
  )
}

function StampCard({ id }: { id: string }) {
  const [a, setA] = useState<Approval | null>(null)
  const [stamped, setStamped] = useState<'yes' | 'no' | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => { fetch(`/api/approvals/${id}/`).then(r => r.json()).then(d => setA(d.approval)) }, [id])
  if (!a) return null
  const body = String((a.payload as { body?: string })?.body ?? '')
  const gaps = placeholders(body).length > 0
  const decide = (v: 'yes' | 'no') => post(`/api/approvals/${id}/decide/`, { decision: v === 'yes' ? 'approve' : 'decline' }).then(() => setStamped(v), () => setFailed(true))
  return (
    <div className="lg-card lg-card-stamp ask-card" data-card={stamped ? undefined : ''}>
      <span className="lg-xs">
        <span className="lg-yellow lg-strong">{stamped ? (stamped === 'yes' ? 'Stamped' : 'Declined') : 'Waiting for your stamp'}</span>
        <span className="lg-dim"> · {a.kind === 'cleanup' ? 'delete' : a.kind}{a.account ? ` · ${a.account}` : ''}</span>
      </span>
      <b className="lg-small">{a.title}</b>
      <span className="lg-small lg-soft">{a.kind === 'email' ? `“${body.split('\n\n')[0]}”` : a.detail}</span>
      {failed && <span className="lg-error">Couldn’t stamp that.</span>}
      {!stamped && (
        <div className="lg-row lg-wrap ask-pills">
          {gaps
            ? <a className="lg-btn lg-btn-sm lg-btn-primary" href={`/approvals/${id}`}>Fill in &amp; send</a>
            : <button type="button" className="lg-btn lg-btn-sm lg-btn-primary" data-approve onClick={() => void decide('yes')}>{a.kind === 'email' ? 'Approve & send' : 'Approve'} <span className="lg-hint">A</span></button>}
          {a.kind === 'email' && <a className="lg-btn lg-btn-sm" href={`/approvals/${id}`}>Edit</a>}
          <button type="button" className="lg-btn lg-btn-sm lg-btn-danger" data-decline onClick={() => void decide('no')}>Nope <span className="lg-hint">N</span></button>
        </div>
      )}
    </div>
  )
}

type Match = { kind: 'mail' | 'todo' | 'note' | 'news'; id: string; title: string; detail: string; url: string }
const KIND = { mail: 'Mail', todo: 'To-do', note: 'Note', news: 'News' }

// plain text matches across Lifehub while you type; Enter still asks
function Matches({ q }: { q: string }) {
  const [items, setItems] = useState<Match[]>([])
  const term = q.trim()
  useEffect(() => {
    if (term.length < 2) { setItems([]); return }
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`/api/search/?q=${encodeURIComponent(term)}`, { credentials: 'same-origin', signal: ctl.signal })
        .then(r => r.ok ? r.json() as Promise<{ items: Match[] }> : { items: [] })
        .then(d => setItems(d.items), () => {})
    }, 200)
    return () => { clearTimeout(t); ctl.abort() }
  }, [term])
  if (term.length < 2 || !items.length) return null
  return (
    <div className="ask-matches" aria-label="Matches">
      <span className="lg-dim lg-xs">In Lifehub</span>
      {items.map(m => {
        const cells = <><span className="ask-kind lg-xs">{KIND[m.kind]}</span><span className="lg-col ask-match-text"><span className="lg-ellipsis">{m.title}</span>{m.detail && <span className="lg-dim lg-xs lg-ellipsis">{m.detail}</span>}</span></>
        return m.url
          ? <a key={m.kind + m.id} className="ask-match" href={m.url} {...(m.kind === 'news' || /^https?:/.test(m.url) ? { target: '_blank', rel: 'noopener' } : {})}>{cells}</a>
          : <div key={m.kind + m.id} className="ask-match">{cells}</div>
      })}
    </div>
  )
}

export function Ask({ onClose }: { onClose: () => void }) {
  const { q, setQ, asked, running, model, ask, steps, doingNow, end } = useAsk()
  const input = useRef<HTMLInputElement>(null)
  useAskKeys(input, setQ, onClose)
  const todos = end?.answer ? listItems(end.answer) : []

  return (
    <>
      <div className="lg-backdrop" onMouseDown={onClose} />
      <div role="dialog" aria-label="Ask Lifehub" aria-modal="true" className="lg-dialog ask">
        <form className="ask-bar" onSubmit={e => { e.preventDefault(); void ask(q) }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <label htmlFor="ask-q" className="visually-hidden">Ask Lifehub</label>
          <input id="ask-q" ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Ask anything" autoComplete="off"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(q, 'gemini') } }} />
          <button type="button" className="lg-link ask-esc" onClick={onClose}>esc</button>
        </form>

        {(asked || running) && (
          <div className="ask-body" aria-live="polite">
            {(steps.length > 0 || running) && (
              <div className="ask-steps">
                {steps.map((s, i) => <span key={i} className={s.ok === false ? 'lg-red' : ''}><span aria-hidden="true">{s.ok === false ? '!' : '✓'}</span>{s.step}</span>)}
                {running && <span className="ask-doing"><span aria-hidden="true">·</span>{doingNow ?? 'thinking'}…</span>}
              </div>
            )}
            {end?.error && <p role="alert" className="lg-error">Couldn’t answer. {end.error}</p>}
            {end?.answer !== undefined && <Answer text={end.answer} />}
            {(!!end?.approvals?.length || todos.length > 0) && (
              <div className="lg-row lg-wrap ask-pills">
                {todos.length > 0 && <AddAll items={todos} />}
                {!!end?.approvals?.length && <a className="lg-btn" href="/">Open approvals</a>}
              </div>
            )}
            {end?.approvals?.map(id => <StampCard key={id} id={id} />)}
          </div>
        )}

        {!running && !asked && <Matches q={q} />}

        {!running && (
          <div className="ask-try">
            <span className="lg-dim lg-xs">{asked ? 'Try next' : 'Try'}</span>
            <div className="lg-row lg-wrap ask-chips">
              {TRY.filter(t => t !== asked).map(t => <button key={t} type="button" className="ask-chip" onClick={() => void ask(t)}>{t}</button>)}
            </div>
          </div>
        )}

        <div className="ask-foot lg-xs">
          <span className="lg-row ask-model"><span className="lg-dot" aria-hidden="true" />{model === 'gemini' ? 'Gemini · you allowed it for private data in Settings' : 'Ollama · private data stays home'}</span>
          <span>↵ ask · {mac ? '⌘' : 'Ctrl '}↵ ask Gemini · ↑ last question</span>
        </div>
      </div>
    </>
  )
}
