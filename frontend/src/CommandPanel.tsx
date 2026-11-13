import { useEffect, useRef, useState } from 'react'

import { placeholders } from './ApprovalEdit'
import { addTodos, blocks, listItems, useAsk, useAskKeys } from './askCore'
import { post } from './api'
import { AccountTag, Btn, LinkBtn, Stamp, Window } from './components/ui'
import type { Approval, EmailAccount } from './types'

const TRY = ['What needs a reply?', "What's on today?", 'Archive the newsletters']

const ACCOUNT = /([([](?:work|personal)[)\]])/i

// **bold** inside a line, and (work) / (personal) as account tags
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.split(ACCOUNT).map((bit, j) => (ACCOUNT.test(bit) ? <AccountTag key={`${i}.${j}`} account={bit.slice(1, -1).toLowerCase() as EmailAccount} /> : bit))
  ))
}

// the line before a list is its summary, in bold
function Answer({ text }: { text: string }) {
  const bs = blocks(text)
  const hasList = bs.some(x => 'items' in x)
  return (
    <div className="answer">
      {bs.map((x, i) => 'p' in x ? <p key={i}>{hasList && i === 0 ? <strong>{inline(x.p.replace(/\*\*/g, ''))}</strong> : inline(x.p)}</p>
        : x.ordered ? <ol key={i}>{x.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>
        : <ul key={i}>{x.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>)}
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
    <Btn tone="gray" disabled={state === 'busy' || state === 'done'} onClick={add}>
      {state === 'done' ? (added ? `added ${added} to todo.lst` : 'already on todo.lst') : state === 'failed' ? 'couldn’t add, try again' : state === 'busy' ? 'adding…' : 'Add all to todo'}
    </Btn>
  )
}

function ApprovalCard({ id }: { id: string }) {
  const [a, setA] = useState<Approval | null>(null)
  const [stamped, setStamped] = useState<'yes' | 'no' | null>(null)
  useEffect(() => { fetch(`/api/approvals/${id}/`).then(r => r.json()).then(d => setA(d.approval)) }, [id])
  if (!a) return null
  const body = String((a.payload as { body?: string })?.body ?? '')
  const gaps = placeholders(body).length > 0
  const decide = (v: 'yes' | 'no') => post(`/api/approvals/${id}/decide/`, { decision: v === 'yes' ? 'approve' : 'decline' }).then(() => setStamped(v))
  return (
    <div className={`stamp-card ${stamped ? 'dim' : ''}`} data-card>
      <span className="head">!! needs your stamp · {a.kind === 'cleanup' ? 'delete' : 'email'} · {a.account === 'work' ? 'work' : 'personal'}</span>
      <b className="small">{a.title}</b>
      <span className="small">{a.kind === 'email' ? `“${body.split('\n\n')[0]}”` : a.detail}</span>
      {!stamped && (
        <div className="actions">
          {gaps
            ? <LinkBtn tone="mint" href={`/approvals/${id}`}>Fill in &amp; send</LinkBtn>
            : <Btn tone="mint" k="A" data-approve onClick={() => decide('yes')}>{a.kind === 'email' ? 'Approve & send' : 'Approve'}</Btn>}
          {a.kind === 'email' && <LinkBtn tone="gray" href={`/approvals/${id}`}>Edit</LinkBtn>}
          <Btn tone="pink" k="N" data-decline onClick={() => decide('no')}>Nope</Btn>
        </div>
      )}
      {stamped && <Stamp yes={stamped === 'yes'} />}
    </div>
  )
}

export function CommandPanel({ onClose }: { onClose: () => void }) {
  const { q, setQ, asked, running, model, ask, steps, doingNow, end } = useAsk()
  const input = useRef<HTMLInputElement>(null)
  useAskKeys(input, setQ, onClose)
  const mac = navigator.platform.startsWith('Mac')

  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Ask LifeHub" aria-modal="true" className="cmd">
        <Window name={<>ask.exe — LifeHub · <span className="jp" aria-hidden="true">質問</span></>} grad={4} dialog onClose={onClose}
          foot={<><span className="vt" style={{ fontSize: 20 }}>↵ ask · {mac ? '⌘' : 'Ctrl+'}↵ ask gemini · ↑ last question · esc close</span><span className="vt grow" style={{ fontSize: 20, textAlign: 'right' }}>anything that sends waits for your stamp</span></>}
        >
          <div className="term">
            <form className="cmd-input" onSubmit={e => { e.preventDefault(); void ask(q) }}>
              <span className="prompt">C:\LIFEHUB&gt;</span>
              <label htmlFor="cmd" className="visually-hidden">Ask LifeHub</label>
              <input id="cmd" ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder={`ask anything (${mac ? '⌘K' : 'Ctrl+K'})`} autoComplete="off"
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(q, 'gemini') } }} />
              <button type="button" className="chip" aria-keyshortcuts="Meta+Enter" disabled={running || !q.trim()} onClick={() => void ask(q, 'gemini')}>ask gemini</button>
            </form>
            {steps.map((s, i) => <div key={i}>{s.ok === false ? <span className="magenta">[ !! ]</span> : <span className="ok">[ OK ]</span>} {s.step}</div>)}
            {running && <div className="cursor"><span className="wait">[ .. ]</span> {doingNow ?? 'thinking'}</div>}
            {asked && <div className="soft">{model === 'gemini' ? 'model: gemini.cloud · you allowed it for private data in Settings' : 'model: ollama.local · private data stays home'}</div>}
          </div>

          {end?.error && <div role="alert" className="note-line err">couldn’t answer. {end.error}</div>}

          {end?.answer !== undefined && (
            <div className="answer-box">
              <span className="head">&gt;&gt; answer.txt</span>
              <Answer text={end.answer} />
              {(!!end.approvals?.length || listItems(end.answer).length > 0) && (
                <div className="actions">
                  {!!end.approvals?.length && <Btn tone="gray" onClick={onClose}>Open approvals</Btn>}
                  {listItems(end.answer).length > 0 && <AddAll items={listItems(end.answer)} />}
                </div>
              )}
            </div>
          )}

          {end?.approvals?.map(id => <ApprovalCard key={id} id={id} />)}

          {!running && (
            <div className="row wrap gap8">
              <span className="vt" style={{ fontSize: 24 }}>{asked ? 'try next:' : 'try:'}</span>
              {TRY.filter(t => t !== asked).map(t => <button key={t} type="button" className="chip" onClick={() => void ask(t)}>{t}</button>)}
            </div>
          )}
        </Window>
      </div>
    </div>
  )
}
