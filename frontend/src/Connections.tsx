import { useState } from 'react'

import { post } from './api'
import { Btn } from './components/ui'

export type Kind = 'email' | 'calendar' | 'feed'
type Item = { name: string; account?: string; user?: string; host?: string; hasPassword?: boolean; urlHint?: string; url?: string; topic?: string }
export type Conns = Record<Kind, Item[]> & { topics: string[] }

// what each kind asks for; the secret field is write-only (blank keeps what's stored)
const FIELDS: Record<Kind, { key: string; label: string; secret?: boolean; hint?: string }[]> = {
  email: [
    { key: 'name', label: 'name' },
    { key: 'user', label: 'address' },
    { key: 'password', label: 'app password', secret: true, hint: 'Google Account > Security > App passwords' },
    { key: 'host', label: 'IMAP server', hint: 'blank: imap.gmail.com' },
  ],
  calendar: [
    { key: 'name', label: 'name' },
    { key: 'account', label: 'account', hint: 'work or personal' },
    { key: 'url', label: 'secret iCal address', secret: true, hint: 'Google Calendar > the calendar > Integrate calendar' },
  ],
  feed: [
    { key: 'name', label: 'name' },
    { key: 'url', label: 'RSS or Atom address' },
    { key: 'topic', label: 'topic' },
  ],
}
const LABEL: Record<Kind, string> = { email: 'email account', calendar: 'calendar', feed: 'news feed' }

const send = (body: object) => post<Conns & { ok?: string }>('/api/connections/', body)

// one connection's form: test it as entered, save, or remove
export function ConnForm({ kind, item, topics, onSaved, onCancel }: { kind: Kind; item?: Item; topics: string[]; onSaved: (c: Conns) => void; onCancel: () => void }) {
  const [data, setData] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS[kind].map(f => [f.key, f.secret ? '' : String((item as Record<string, unknown> | undefined)?.[f.key] ?? '')])))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const original = item?.name ?? ''

  const run = async (op: 'test' | 'save' | 'remove') => {
    if (op === 'remove' && !confirm(`Remove the ${LABEL[kind]} ${original}? Lifehub stops reading it.`)) return
    setBusy(true); setNote(null)
    try {
      const r = await send({ kind, op, original, data })
      if (op === 'test') setNote({ ok: true, text: r.ok! })
      else onSaved(r)
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="conn-form" onSubmit={e => { e.preventDefault(); void run('save') }}>
      {FIELDS[kind].map(f => {
        const id = `conn-${kind}-${f.key}`
        const placeholder = f.secret && item ? (kind === 'email' ? (item.hasPassword ? '•••••• (stored; type to replace)' : '') : `${item.urlHint ?? ''} (stored; paste to replace)`) : f.hint ?? ''
        return (
          <label key={f.key} htmlFor={id} className="conn-field">
            <span className="small">{f.label}</span>
            <input id={id} className="field" type={f.secret && kind === 'email' ? 'password' : 'text'} autoComplete={f.secret ? 'new-password' : 'off'} value={data[f.key]} placeholder={placeholder}
              list={f.key === 'topic' ? 'conn-topics' : undefined} disabled={f.key === 'account' && kind === 'email'}
              onChange={e => setData({ ...data, [f.key]: e.target.value })} />
          </label>
        )
      })}
      <datalist id="conn-topics">{topics.map(t => <option key={t} value={t} />)}</datalist>
      <div className="row gap8 wrap">
        <Btn tone="face" size="sm" lower disabled={busy} onClick={() => void run('test')}>test</Btn>
        <Btn tone="mint" size="sm" lower disabled={busy} onClick={() => void run('save')}>{item ? 'save' : `add ${LABEL[kind]}`}</Btn>
        {item && <Btn tone="pink" size="sm" lower disabled={busy} onClick={() => void run('remove')}>remove</Btn>}
        <Btn tone="gray" size="sm" lower disabled={busy} onClick={onCancel}>cancel</Btn>
      </div>
      {note && <span role="status" className={`small ${note.ok ? 'green' : 'magenta'}`}>{note.text}</span>}
    </form>
  )
}

// calendars and feeds are lists: each one editable, plus add
export function ConnList({ kind, conns, onSaved }: { kind: Kind; conns: Conns; onSaved: (c: Conns) => void }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="conn-list">
      {conns[kind].map(x => (
        <div key={x.name}>
          <div className="conn-item">
            <span><b>{x.name}</b> <span className="small sub">{kind === 'feed' ? `${x.topic || 'no topic'} · ${x.url}` : `${x.account} · ${x.urlHint}`}</span></span>
            <Btn tone="face" size="sm" lower onClick={() => setOpen(open === x.name ? null : x.name)}>{open === x.name ? 'close' : 'edit'}</Btn>
          </div>
          {open === x.name && <ConnForm kind={kind} item={x} topics={conns.topics} onSaved={c => { setOpen(null); onSaved(c) }} onCancel={() => setOpen(null)} />}
        </div>
      ))}
      {open === '' ? <ConnForm kind={kind} topics={conns.topics} onSaved={c => { setOpen(null); onSaved(c) }} onCancel={() => setOpen(null)} />
        : <div><Btn tone="face" size="sm" lower onClick={() => setOpen('')}>+ add {LABEL[kind]}</Btn></div>}
    </div>
  )
}

