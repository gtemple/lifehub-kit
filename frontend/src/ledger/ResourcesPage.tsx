import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { post } from '../api'
import { useActivityTray } from '../components/Notifications'
import { Shell } from '../Shell'
import { TopBar } from './TopBar'
import './resources.css'

// Resources: learning tools. AI daily is the first: one card a day from hub/learn.py

type Term = { name: string; id: number | null }
type Lite = { id: number; term: string; kind: string; day: string; status: 'new' | 'known' | 'review'; trending: boolean; summary: string }
type Card = Lite & {
  body: string; depth: string; buildsOn: Term[]; leadsTo: Term[]; tryIt: string; tryLang: string; tryNote: string; followups: string[]
  whyNow: string; whyUrl: string; whySource: string; sources: { url: string; site: string }[]; questions: { q: string; a: string }[]
  reviewRound: number; reviewDue: string | null
}
export type Learn = { card: Card | null; today: boolean; reviews: Lite[]; archive: Lite[]; stats: { streak: number; cards: number; known: number }; writesAt: string }

const KINDS = ['All', 'Concept', 'Technique', 'Tool', 'Trend']
const dayText = (iso: string) => new Date(`${iso}T12:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })
const longDay = (iso: string) => new Date(`${iso}T12:00`).toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })

// a readable name from the link's last path part, minus Medium-style hash suffixes
const pageName = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/\/$/, '').split('/').pop() ?? '').replace(/\.\w+$/, '').replace(/-[0-9a-f]{8,}$/, '').replace(/[-_]/g, ' ')

export function useLearn(id: string, everyMs = 0) {
  const [data, setData] = useState<Learn | null>(null)
  const [failed, setFailed] = useState(false)
  const load = useCallback(() => fetch(`/api/learn/${id ? `?id=${id}` : ''}`, { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() as Promise<Learn> : Promise.reject(new Error(String(r.status)))))
    .then(d => { setData(d); setFailed(false) }, () => setFailed(true)), [id])
  useEffect(() => {
    void load()
    if (!everyMs) return
    const t = setInterval(load, everyMs)
    return () => clearInterval(t)
  }, [load, everyMs])
  return { data, setData, failed }
}

function markText(c: Card) {
  if (c.status === 'known') return 'Known'
  if (c.status === 'review' && c.reviewDue) return `Back on ${dayText(c.reviewDue)}`
  return ''
}

function Marks({ card, onDone }: { card: Card; onDone: (d: Learn) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const mark = (how: 'known' | 'review') => {
    setBusy(true); setErr('')
    post<Learn>(`/api/learn/${card.id}/mark/`, { mark: how }).then(onDone, (e: Error) => setErr(e.message)).finally(() => setBusy(false))
  }
  return (
    <div className="lg-row lg-wrap rs-marks">
      {err ? <span role="alert" className="lg-red lg-small">{err}</span> : <span role="status" className="lg-dim lg-small">{markText(card)}</span>}
      <button type="button" className="lg-btn rs-tall" disabled={busy} onClick={() => mark('review')}>Review again</button>
      <button type="button" className="lg-btn lg-btn-primary rs-tall" disabled={busy} onClick={() => mark('known')}>Got it</button>
    </div>
  )
}

function Terms({ label, terms }: { label: string; terms: Term[] }) {
  if (!terms.length) return null
  return (
    <section className="lg-col rs-terms" aria-label={label}>
      <span className="lg-dim lg-xs">{label}</span>
      <div className="lg-row lg-wrap">
        {terms.map(t => (t.id
          ? <a key={t.name} className="lg-chip" href={`/resources?id=${t.id}`}>{t.name}</a>
          : <span key={t.name} className="lg-chip rs-new">{t.name}<span className="lg-dim lg-xs">not covered yet</span></span>))}
      </div>
    </section>
  )
}

function Ask({ card, onDone }: { card: Card; onDone: (d: Learn) => void }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const ask = (question: string) => {
    if (!question.trim()) return
    setBusy(question); setErr('')
    post<Learn>(`/api/learn/${card.id}/ask/`, { question }).then(d => { onDone(d); setQ('') }, (e: Error) => setErr(e.message)).finally(() => setBusy(''))
  }
  const submit = (e: FormEvent) => { e.preventDefault(); ask(q) }
  const asked = card.questions.map(x => x.q)
  const chips = card.followups.filter(f => !asked.includes(f))
  return (
    <section className="lg-col rs-ask" aria-labelledby="rs-ask-h">
      <h3 id="rs-ask-h" className="rs-h3">Ask about {card.term}</h3>
      {card.questions.map((x, i) => (
        <div key={i} className="rs-qa">
          <p className="lg-dim lg-small">You asked: <span className="rs-ink">{x.q}</span></p>
          <p className="lg-soft rs-pre">{x.a}</p>
        </div>
      ))}
      {busy && <p role="status" className="lg-dim lg-small">Asking Gemini: {busy}</p>}
      {chips.length > 0 && (
        <div className="lg-row lg-wrap">
          {chips.map(f => <button key={f} type="button" className="lg-chip rs-follow" disabled={!!busy} onClick={() => ask(f)}>{f}</button>)}
        </div>
      )}
      <form className="lg-row rs-askform" onSubmit={submit}>
        <label htmlFor="rs-q" className="visually-hidden">Ask a follow-up about {card.term}</label>
        <input id="rs-q" className="lg-input lg-grow" placeholder="Ask a follow-up…" value={q} onChange={e => setQ(e.target.value)} disabled={!!busy} />
        <button type="submit" className="lg-btn lg-btn-primary rs-tall" disabled={!!busy || !q.trim()}>Ask</button>
      </form>
      {err && <p role="alert" className="lg-red lg-small">{err}</p>}
    </section>
  )
}

function CardView({ card, today, onDone }: { card: Card; today: boolean; onDone: (d: Learn) => void }) {
  const [deep, setDeep] = useState(false)
  return (
    <article className="rs-card" aria-labelledby="rs-term">
      <div className="lg-row lg-wrap rs-meta lg-dim lg-small">
        <span>{today ? 'Today · ' : ''}{longDay(card.day)} · <span className="rs-ink">{card.kind}</span>{card.trending ? ' · trending' : ''}</span>
        {!today && <a className="lg-link" href="/resources">Today’s card →</a>}
      </div>
      <div className="lg-col rs-gap12">
        <h2 id="rs-term" className="rs-term">{card.term}</h2>
        <p className="rs-summary">{card.summary}</p>
      </div>
      <p className="lg-soft rs-body">{card.body}</p>
      {card.whyNow && (
        <p className="lg-soft rs-why"><span className="rs-ink rs-b">Why now:</span> {card.whyNow}{card.whyUrl && <> <a className="lg-link" href={card.whyUrl} target="_blank" rel="noopener">{card.whySource || 'Source'} →</a></>}</p>
      )}
      <div className="lg-row lg-wrap rs-actions">
        <button type="button" className="lg-btn rs-tall" aria-expanded={deep} aria-controls="rs-deep" onClick={() => setDeep(v => !v)}>{deep ? 'Less' : 'Go deeper'}</button>
        <Marks card={card} onDone={onDone} />
      </div>
      {deep && (
        <div id="rs-deep" className="rs-deep">
          {card.depth && (
            <section className="lg-col rs-gap10" aria-labelledby="rs-depth-h">
              <h3 id="rs-depth-h" className="rs-h3">In depth</h3>
              {card.depth.split(/\n\s*\n/).map((p, i) => <p key={i} className="lg-soft rs-body">{p}</p>)}
            </section>
          )}
          <div className="rs-termgrid">
            <Terms label="Builds on" terms={card.buildsOn} />
            <Terms label="Leads to" terms={card.leadsTo} />
          </div>
          {card.tryIt && (
            <section className="lg-col rs-gap10" aria-labelledby="rs-try-h">
              <div className="lg-row rs-between"><h3 id="rs-try-h" className="rs-h3">Try it</h3><span className="lg-dim lg-xs">{card.tryNote || card.tryLang}</span></div>
              <pre className="rs-code" aria-label={`${card.tryLang} example`}>{card.tryIt}</pre>
              <span className="lg-dim lg-xs">Written by Gemini and not run: check model names and versions before you copy it.</span>
            </section>
          )}
          <Ask card={card} onDone={onDone} />
          {card.sources.length > 0 && (
            <section className="lg-col" aria-labelledby="rs-src-h">
              <span id="rs-src-h" className="lg-dim lg-xs rs-rowhead">Sources · found by Gemini search</span>
              {card.sources.map(s => (
                <a key={s.url} className="rs-src" href={s.url} target="_blank" rel="noopener">
                  <span className="lg-ellipsis">{pageName(s.url) || s.site}</span>
                  <span className="lg-dim lg-xs">{s.site}</span>
                </a>
              ))}
            </section>
          )}
        </div>
      )}
    </article>
  )
}

function NoCard({ writesAt, onDone }: { writesAt: string; onDone: (d: Learn) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const write = () => {
    setBusy(true); setErr('')
    post<Learn>('/api/learn/write/').then(onDone, (e: Error) => setErr(e.message)).finally(() => setBusy(false))
  }
  return (
    <article className="rs-card">
      <p className="rs-summary">Today’s card isn’t written yet. It writes itself at {writesAt}.</p>
      <div className="lg-row lg-wrap">
        <button type="button" className="lg-btn lg-btn-primary rs-tall" disabled={busy} onClick={write}>{busy ? 'Writing… about 20 s' : 'Write it now'}</button>
        {err && <span role="alert" className="lg-red lg-small">{err}</span>}
      </div>
    </article>
  )
}

export function ResourcesPage() {
  const tray = useActivityTray()
  const id = new URLSearchParams(location.search).get('id') ?? ''
  const { data, setData, failed } = useLearn(id)
  const [kind, setKind] = useState('All')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const archive = (data?.archive ?? []).filter(a => (kind === 'All' || a.kind === kind) && (!q || a.term.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q)))

  return (
    <Shell screen="resources" handlers={{ toggleActivityTray: tray.toggle }}>
      <TopBar page="resources" tray={tray} />
      <main className="lg-main rs-main">
        <header className="rs-head">
          <div className="lg-col rs-gap6">
            <span className="lg-dim">Resources</span>
            <h1 className="lg-h1">AI daily</h1>
          </div>
          <div className="lg-row lg-wrap rs-gap20">
            {data && <span className="lg-dim"><span className="rs-ink rs-b">{data.stats.streak}-day streak</span> · {data.stats.cards} cards · {data.stats.known} known</span>}
            <div className="lg-seg" role="group" aria-label="Resources section"><button type="button" aria-pressed="true">AI daily</button></div>
          </div>
        </header>

        {!data ? <p className={failed ? 'lg-error' : 'lg-empty'}>{failed ? 'Couldn’t load AI daily.' : 'Loading…'}</p> : (
          <div className="rs-cols">
            <div className="rs-left">
              {data.card ? <CardView key={data.card.id} card={data.card} today={data.today} onDone={setData} />
                : id ? <p className="lg-error">That card doesn’t exist. <a href="/resources">Today’s card →</a></p>
                : <NoCard writesAt={data.writesAt} onDone={setData} />}

              <section aria-labelledby="rs-rev-h" className="lg-col">
                <div className="lg-row rs-between rs-rowhead"><h2 id="rs-rev-h" className="lg-h2">Due for review</h2><span className="lg-dim lg-small">{data.reviews.length ? `${data.reviews.length} today · ` : ''}back after 3, 7, 30 days</span></div>
                {data.reviews.length === 0 ? <p className="lg-empty">Nothing due.</p> : data.reviews.map(r => (
                  <a key={r.id} href={`/resources?id=${r.id}`} className="rs-review">
                    <span className="lg-col rs-gap3">
                      <span className="lg-row lg-wrap rs-gap10"><span className="rs-rterm">{r.term}</span><span className="lg-dim lg-xs">{r.kind} · {dayText(r.day)}</span></span>
                      <span className="lg-dim">{r.summary}</span>
                    </span>
                    <span className="lg-btn lg-btn-sm">Show</span>
                  </a>
                ))}
              </section>
            </div>

            <aside aria-labelledby="rs-arch-h" className="rs-archive">
              <div className="lg-row rs-between"><h2 id="rs-arch-h" className="lg-h2">Archive</h2><span className="lg-dim lg-small">{data.archive.length} cards</span></div>
              <label htmlFor="rs-search" className="visually-hidden">Search past cards</label>
              <input id="rs-search" type="search" className="lg-input" placeholder="Search past cards" value={query} onChange={e => setQuery(e.target.value)} />
              <div className="lg-row lg-wrap rs-gap6" role="group" aria-label="Kind">
                {KINDS.map(k => <button key={k} type="button" className="lg-chip rs-kind" aria-pressed={k === kind} onClick={() => setKind(k)}>{k}</button>)}
              </div>
              <div className="lg-col">
                {archive.length === 0 ? <p className="lg-empty">{data.archive.length ? 'No match.' : 'No cards yet.'}</p> : archive.map(a => (
                  <a key={a.id} href={`/resources?id=${a.id}`} className="rs-arow" aria-current={a.id === data.card?.id ? 'page' : undefined}>
                    <span className="rs-b">{a.term}</span>
                    <span className={`lg-xs rs-right ${a.status === 'review' ? 'lg-yellow' : 'lg-dim'}`}>{a.status === 'known' ? 'known' : a.status === 'review' ? 'reviewing' : 'new'}</span>
                    <span className="lg-dim lg-xs">{a.kind} · {dayText(a.day)}</span>
                  </a>
                ))}
              </div>
            </aside>
          </div>
        )}
      </main>
    </Shell>
  )
}

// the dashboard's AI daily card
export function AiDaily() {
  const { data, setData, failed } = useLearn('', 30 * 60_000)
  const c = data?.today ? data.card : null
  return (
    <section aria-labelledby="lgd-learn-h" className="rs-tile">
      <div className="lg-row rs-between">
        <h2 id="lgd-learn-h" className="lgd-h3">AI daily</h2>
        {data && <span className="lg-dim lg-xs">{c ? `${c.kind} · ` : ''}{data.stats.streak}-day streak</span>}
      </div>
      {!data ? <p className={failed ? 'lg-error' : 'lg-empty'}>{failed ? 'Couldn’t load AI daily.' : 'Loading…'}</p>
        : !c ? <p className="lg-dim lg-small">Today’s card comes at {data.writesAt}. <a className="lg-link" href="/resources">Open →</a></p> : (
          <>
            <div className="lg-col rs-gap6">
              <a href="/resources" className="rs-tterm">{c.term}</a>
              <p className="lg-soft rs-tsum">{c.summary}</p>
            </div>
            {c.whyNow && <p className="lg-dim lg-small rs-why"><span className="rs-ink">Why now:</span> {c.whyNow}</p>}
            <div className="lg-row lg-wrap rs-gap8">
              {c.status === 'new'
                ? <>
                    <button type="button" className="lg-btn lg-btn-primary" onClick={() => void post<Learn>(`/api/learn/${c.id}/mark/`, { mark: 'known' }).then(setData)}>Got it</button>
                    <button type="button" className="lg-btn" onClick={() => void post<Learn>(`/api/learn/${c.id}/mark/`, { mark: 'review' }).then(setData)}>Review again</button>
                  </>
                : <span className="lg-dim lg-small">{markText(c)}</span>}
              <a href="/resources" className="lg-link rs-right">Go deeper →</a>
            </div>
          </>
        )}
      {data && data.reviews.length > 0 && (
        <div className="lg-col">
          <div className="lg-row rs-between rs-rowhead"><span className="lg-dim lg-xs">Due for review</span><span className="lg-dim lg-xs">{data.reviews.length} today</span></div>
          {data.reviews.slice(0, 3).map(r => (
            <a key={r.id} href={`/resources?id=${r.id}`} className="rs-trow"><span>{r.term}</span><span className="lg-dim lg-xs">{r.kind}</span></a>
          ))}
        </div>
      )}
    </section>
  )
}
