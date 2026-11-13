import { useEffect, useRef, useState } from 'react'

import { post } from '../../api'
import { ago } from '../../time'
import type { Watch, WatchSource } from '../../types'

type Found = { url: string; store: string }

const money = (p: number) => `$${p.toFixed(2)}`
// in stock and priced first, cheapest at the top; then out of stock; then not read yet
const rank = (s: WatchSource) => s.price == null ? 2e9 : s.inStock === false ? 1e9 + s.price : s.price

function status(s: WatchSource) {
  if (s.price == null) return s.error ? 'couldn’t read the page' : 'not checked yet'
  return `${s.inStock === false ? 'out of stock' : 'in stock'}${s.error ? ' · last check failed' : ''}`
}

// add or change a watched product: its name, target, and the stores it's checked at
export function PriceEditor({ watch, onClose, onSaved }: { watch: Watch | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(watch?.name ?? '')
  const [target, setTarget] = useState(watch?.target?.toString() ?? '')
  const [urls, setUrls] = useState(watch?.sources.map(s => s.url) ?? [])
  const [link, setLink] = useState('')
  const [found, setFound] = useState<Found[] | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    first.current?.focus()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', esc)
    return () => removeEventListener('keydown', esc)
  }, [onClose])

  const known = new Map((watch?.sources ?? []).map(s => [s.url, s]))
  const rows = urls.map(u => known.get(u) ?? { url: u, store: new URL(u).hostname.replace(/^www\./, '') }).sort((a, b) => rank(a) - rank(b))
  const cheapest = rows[0]?.price != null && rows[0].inStock !== false ? rows[0].url : ''

  const run = (what: string, p: Promise<unknown>) => {
    setBusy(what); setErr('')
    return p.catch((e: Error) => setErr(e.message)).finally(() => setBusy(''))
  }
  const save = () => run('save', post(watch ? `/api/prices/${watch.id}/` : '/api/prices/', { name, target, urls }).then(onSaved))
  const remove = () => watch && confirm(`Stop watching ${watch.name}?`) && run('delete', post(`/api/prices/${watch.id}/`, { delete: true }).then(onSaved))
  const find = () => run('find', post<{ items: Found[] }>('/api/prices/find/', { name, known: urls }).then(r => setFound(r.items)))
  const add = (u: string) => {
    const url = u.trim()
    if (!/^https?:\/\//.test(url)) { setErr('Store links start with http:// or https://'); return }
    if (!urls.includes(url)) setUrls([...urls, url])
    setFound(f => f && f.filter(x => x.url !== url)); setLink(''); setErr('')
  }

  return (
    <>
      <div className="lg-backdrop" onClick={onClose} />
      <aside className="lg-drawer pe-drawer" role="dialog" aria-modal="true" aria-labelledby="pe-title">
        <div className="pe-head">
          <h2 id="pe-title" className="pe-title">{watch ? 'Edit watch' : 'Watch a product'}</h2>
          <button type="button" className="lg-iconbtn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <form className="pe-body" onSubmit={e => { e.preventDefault(); if (name.trim()) void save() }}>
          <label className="pe-field"><span className="lg-dim lg-xs">Product</span>
            <input ref={first} className="lg-input" value={name} placeholder="e.g. Sony WH-1000XM6" onChange={e => setName(e.target.value)} /></label>
          <label className="pe-field"><span className="lg-dim lg-xs">Target price · blank alerts on any drop</span>
            <input className="lg-input" inputMode="decimal" value={target} placeholder="$" onChange={e => setTarget(e.target.value)} /></label>

          <section className="pe-stores" aria-label="Stores">
            <div className="lg-split"><span className="lg-dim lg-xs">Stores · the cheapest in-stock one is the price you see</span>
              {watch?.checkedAt && <span className="lg-decor lg-xs">{watch.low90 != null ? `90-day low ${money(watch.low90)} · ` : ''}checked {ago(watch.checkedAt)}</span>}</div>
            {!rows.length && <p className="lg-dim lg-small">No stores yet. Find some, or paste a link. Saving also searches once on its own.</p>}
            {rows.map(s => (
              <div key={s.url} className={`pe-store${s.url === cheapest ? ' pe-cheapest' : ''}`}>
                <a href={s.url} target="_blank" rel="noopener" className="lg-col pe-store-name">
                  <span className="lg-ellipsis">{s.store}{s.url === cheapest && <span className="pe-tag">cheapest</span>}</span>
                  <span className="lg-dim lg-xs">{status(s)}</span>
                </a>
                <span className="pe-price">{s.price != null ? money(s.price) : '—'}</span>
                <button type="button" className="lg-iconbtn pe-x" aria-label={`Remove ${s.store}`} onClick={() => setUrls(urls.filter(u => u !== s.url))}>×</button>
              </div>
            ))}
            <div className="pe-add">
              <input className="lg-input lg-grow" value={link} placeholder="Paste a store link" aria-label="Store link"
                onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(link) } }} />
              <button type="button" className="lg-btn" disabled={!link.trim()} onClick={() => add(link)}>Add</button>
            </div>
            <button type="button" className="lg-btn lg-btn-quiet pe-find" disabled={!!busy || !name.trim()} onClick={() => void find()}>{busy === 'find' ? 'Searching stores…' : 'Find stores'}</button>
            {found && (found.length ? found.map(f => (
              <div key={f.url} className="pe-found">
                <a href={f.url} target="_blank" rel="noopener" className="lg-ellipsis lg-grow">{f.store} ↗</a>
                <button type="button" className="lg-btn lg-btn-sm" onClick={() => add(f.url)}>+ Add</button>
              </div>
            )) : <p className="lg-dim lg-small">No new store pages found.</p>)}
          </section>

          {err && <p role="alert" className="lg-red lg-small">{err}</p>}
          <div className="pe-foot">
            {watch && <button type="button" className="lg-btn lg-btn-danger" disabled={!!busy} onClick={() => void remove()}>Stop watching</button>}
            <span className="lg-grow" />
            <button type="button" className="lg-btn lg-btn-quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="lg-btn lg-btn-primary" disabled={!!busy || !name.trim()}>{busy === 'save' ? 'Checking stores…' : 'Save'}</button>
          </div>
        </form>
      </aside>
    </>
  )
}
