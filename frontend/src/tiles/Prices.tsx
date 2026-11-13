import { useState } from 'react'

import { post } from '../api'
import type { TileState } from '../api'
import { Tile, shownState } from '../components/Tile'
import { Btn } from '../components/ui'
import { ago } from '../time'
import type { Watch, WatchSource } from '../types'

export const PRICES_MS = 10 * 60_000

type Editing = { id?: string; name: string; target: string; urls: string; sources: WatchSource[] }
type Found = { url: string; store: string }

const money = (p: number) => `$${p.toFixed(2)}`
const linesOf = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)
const cheapest = (w: Watch) => w.sources.find(s => s.price === w.best && s.inStock !== false)

function sourceLine(s: WatchSource) {
  if (s.price === undefined) return s.error ? `couldn’t check · ${s.error}` : 'not checked yet'
  const stock = s.inStock === false ? 'out of stock' : 'in stock'
  return `${money(s.price)} · ${stock}${s.error ? ' · couldn’t check last time' : ''}`
}

export function Prices({ t }: { t: TileState<Watch> }) {
  const items = t.res?.items ?? []
  const [editing, setEditing] = useState<Editing | null>(null)
  const [found, setFound] = useState<Found[] | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const open = (e: Editing | null) => { setEditing(e); setFound(null); setErr('') }
  const done = () => { open(null); t.refresh() }
  const run = (what: string, p: Promise<unknown>) => {
    setBusy(what); setErr('')
    return p.catch((e: Error) => setErr(e.message)).finally(() => setBusy(''))
  }
  const save = () => editing && run('checking stores…', post(editing.id ? `/api/prices/${editing.id}/` : '/api/prices/', { name: editing.name, target: editing.target, urls: linesOf(editing.urls) }).then(done))
  const remove = () => editing?.id && run('deleting…', post(`/api/prices/${editing.id}/`, { delete: true }).then(done))
  const find = () => editing && run('searching stores…', post<{ items: Found[] }>('/api/prices/find/', { name: editing.name, known: linesOf(editing.urls) }).then(r => setFound(r.items)))
  const add = (url: string) => {
    if (!editing) return
    setEditing({ ...editing, urls: [...linesOf(editing.urls), url].join('\n') })
    setFound(f => f && f.filter(x => x.url !== url))
  }

  const editor = editing && (
    <div className="col gap8">
      <label htmlFor="watch-name" className="visually-hidden">Product</label>
      <input id="watch-name" className="field" placeholder="Product, e.g. Sony WH-1000XM6" value={editing.name} autoFocus onChange={e => setEditing({ ...editing, name: e.target.value })} />
      <label htmlFor="watch-target" className="visually-hidden">Target price</label>
      <input id="watch-target" className="field" inputMode="decimal" placeholder="Target price (blank = alert on any drop)" value={editing.target} onChange={e => setEditing({ ...editing, target: e.target.value })} />
      <label htmlFor="watch-urls" className="visually-hidden">Store links, one per line</label>
      <textarea id="watch-urls" className="field" rows={4} placeholder="Store links, one per line (optional: sellers are found daily)" value={editing.urls} onChange={e => setEditing({ ...editing, urls: e.target.value })} />
      {editing.sources.map(s => (
        <span key={s.url} className="sub small">{s.store} · {sourceLine(s)}</span>
      ))}
      {found && (found.length === 0
        ? <span className="sub small">no new store pages found</span>
        : found.map(f => (
          <div key={f.url} className="split small">
            <a href={f.url} target="_blank" rel="noopener" className="ellipsis grow">{f.store} ↗</a>
            <Btn tone="face" size="sm" lower onClick={() => add(f.url)}>+ add</Btn>
          </div>
        )))}
      {err && <span role="alert" className="small magenta">{err}</span>}
      <div className="actions">
        <Btn tone="mint" size="sm" disabled={!!busy} onClick={save}>{busy === 'checking stores…' ? busy : 'Save'}</Btn>
        <Btn tone="face" size="sm" disabled={!!busy || !editing.name.trim()} onClick={find}>{busy === 'searching stores…' ? busy : 'Find stores'}</Btn>
        <Btn tone="gray" size="sm" disabled={!!busy} onClick={() => open(null)}>Cancel</Btn>
        {editing.id && <Btn tone="pink" size="sm" disabled={!!busy} style={{ marginLeft: 'auto' }} onClick={remove}>Delete</Btn>}
      </div>
    </div>
  )

  return (
    <Tile
      title="price_watch.exe" grad={1} jp="値段"
      right={!editing && <Btn tone="face" size="sm" lower onClick={() => open({ name: '', target: '', urls: '', sources: [] })}>+ watch</Btn>}
      state={editing ? 'ok' : shownState(t, PRICES_MS, r => r.items.length === 0)} updatedAt={t.res?.updatedAt}
      error={t.res?.error ?? { source: 'prices' }} empty="nothing watched. add a product with + watch: it finds sellers itself, or paste store links."
    >
      {editor || (
        <div className="col gap8">
          {items.map(w => {
            const low = cheapest(w)
            return (
              <button
                key={w.id} type="button" data-nav className="note"
                onClick={() => open({ id: w.id, name: w.name, target: w.target?.toString() ?? '', urls: w.sources.map(s => s.url).join('\n'), sources: w.sources })}
              >
                <span className="split">
                  <span className="strong small ellipsis">{w.name}</span>
                  <span className="strong small">{w.best !== null ? money(w.best) : 'out of stock'}</span>
                </span>
                <span className="sub small ellipsis">
                  {low ? `at ${low.store}` : `${w.sources.length} store${w.sources.length === 1 ? '' : 's'}`}
                  {w.target !== null ? ` · target ${money(w.target)}` : ''}
                  {w.checkedAt ? ` · checked ${ago(w.checkedAt)}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </Tile>
  )
}
