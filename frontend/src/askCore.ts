import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

import { loadLocal, post, saveLocal } from './api'

// What both Ask panels (retro ask.exe and the ledger dialog) share: the NDJSON stream, the keys, the answer's
// structure and "add all to to-do". Each panel only draws it.

export type AskEvent = { doing?: string; step?: string; ok?: boolean; answer?: string; approvals?: string[]; error?: string }
export type Model = 'ollama' | 'gemini'

export function useAsk() {
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const [events, setEvents] = useState<AskEvent[]>([])
  const [running, setRunning] = useState(false)
  const [model, setModel] = useState<Model>('ollama')

  const ask = async (question: string, using: Model = 'ollama') => {
    if (!question.trim() || running) return
    setQ(question); setAsked(question); setEvents([]); setRunning(true); setModel(using); saveLocal('lastQuestion', question)
    try {
      const r = await fetch('/api/ask/', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': document.cookie.match(/csrftoken=([^;]+)/)?.[1] ?? '' },
        body: JSON.stringify({ question, model: using }),
      })
      if (!r.ok) throw new Error(`Lifehub said ${r.status}.`)
      const reader = r.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const l of lines) if (l.trim()) setEvents(ev => [...ev, JSON.parse(l) as AskEvent])
      }
    } catch (e) {
      setEvents(ev => [...ev, { error: e instanceof Error && e.message.startsWith('Lifehub') ? e.message : 'Lost the connection to Lifehub.' }])
    } finally {
      setRunning(false)
    }
  }

  const steps = events.filter(e => e.step)
  // the step under way: the last "doing" that no finished step has followed yet
  const lastDoing = events.map(e => !!e.doing).lastIndexOf(true)
  const doingNow = lastDoing > events.map(e => !!e.step).lastIndexOf(true) ? events[lastDoing]!.doing : undefined
  const end = events.find(e => e.answer !== undefined || e.error)
  return { q, setQ, asked, running, model, ask, steps, doingNow, end }
}

// Esc closes, ↑ in the field recalls the last question, A / N stamp the drafted card
export function useAskKeys(input: RefObject<HTMLInputElement | null>, setQ: (q: string) => void, onClose: () => void) {
  useEffect(() => {
    input.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      const typing = document.activeElement === input.current
      if (e.key === 'ArrowUp' && typing) { e.preventDefault(); setQ(loadLocal('lastQuestion', '')) }
      if (!typing && !e.metaKey && !e.ctrlKey && (e.key === 'a' || e.key === 'n')) {
        document.querySelector<HTMLElement>(e.key === 'a' ? '[data-card] [data-approve]' : '[data-card] [data-decline]')?.click()
      }
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [input, setQ, onClose])
}

// the answer's list items as plain to-dos: no markdown, no account tags
export const listItems = (text: string) => text.split('\n')
  .map(l => l.match(/^\s*(?:\d+\.|[-*•])\s+(.*)$/)?.[1])
  .filter((x): x is string => !!x)
  .map(x => x.replace(/\*\*/g, '').replace(/[([](?:work|personal)[)\]]/gi, '').replace(/\s+([.,])/g, '$1').replace(/\s{2,}/g, ' ').trim())

export type Block = { p: string } | { ordered: boolean; items: string[] }

// the model answers in light markdown: paragraphs and numbered or bulleted lists
export function blocks(text: string): Block[] {
  const out: Block[] = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+\.|[-*•])\s+(.*)$/)
    const last = out.at(-1)
    if (m) {
      const ordered = /\d/.test(m[1]!)
      if (last && 'items' in last && last.ordered === ordered) last.items.push(m[2]!)
      else out.push({ ordered, items: [m[2]!] })
    } else if (line.trim()) out.push({ p: line })
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// adds the items not already on the list (answers often repeat your own to-dos); returns how many it added
export async function addTodos(items: string[]) {
  const tasks = (await (await fetch('/api/tiles/tasks/')).json()).items as { text: string; done: boolean }[]
  // a to-do that's only emoji or punctuation normalizes to '' and would otherwise match everything
  const open = tasks.filter(t => !t.done).map(t => norm(t.text)).filter(Boolean)
  const fresh = items.filter(text => !open.some(o => norm(text).includes(o)))
  for (const text of fresh) await post('/api/tasks/', { text })
  return fresh.length
}
