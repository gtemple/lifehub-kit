import { useState } from 'react'

import { post } from '../api'
import type { TileState } from '../api'
import { Tile, shownState } from '../components/Tile'
import { Btn } from '../components/ui'
import type { Note } from '../types'

export const ACTIVITY_MS = 15_000
export const NOTES_MS = 60_000

type Editing = { id?: string; title: string; body: string }

export function Notes({ t }: { t: TileState<Note> }) {
  const items = t.res?.items ?? []
  const [editing, setEditing] = useState<Editing | null>(null)
  const done = () => { setEditing(null); t.refresh() }
  const save = () => editing && post(editing.id ? `/api/notes/${editing.id}/` : '/api/notes/', editing).then(done)
  const remove = () => editing?.id && post(`/api/notes/${editing.id}/`, { delete: true }).then(done)
  const editor = editing && (
    <div className="col gap8">
      <label htmlFor="note-title" className="visually-hidden">Title</label>
      <input id="note-title" className="field" placeholder="Title" value={editing.title} autoFocus onChange={e => setEditing({ ...editing, title: e.target.value })} />
      <label htmlFor="note-body" className="visually-hidden">Note</label>
      <textarea id="note-body" className="field" rows={5} placeholder="Write it down…" value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })} />
      <div className="actions">
        <Btn tone="mint" size="sm" onClick={save}>Save</Btn>
        <Btn tone="gray" size="sm" onClick={() => setEditing(null)}>Cancel</Btn>
        {editing.id && <Btn tone="pink" size="sm" style={{ marginLeft: 'auto' }} onClick={remove}>Delete</Btn>}
      </div>
    </div>
  )
  return (
    <Tile
      title="notes.txt · メモ" grad={2} right={!editing && <Btn tone="face" size="sm" lower onClick={() => setEditing({ title: '', body: '' })}>+ new note</Btn>}
      state={editing ? 'ok' : shownState(t, NOTES_MS, r => r.items.length === 0)} updatedAt={t.res?.updatedAt}
      error={{ source: 'notes' }} empty="no notes yet. start one with + new note."
    >
      {editor || (
        <div className="notes-grid">
          {items.map(o => (
            <button key={o.id} type="button" data-nav className="note" onClick={() => setEditing({ id: o.id, title: o.title, body: o.body })}>
              <span className="strong small">{o.title}</span>
              <span className="sub small ellipsis">{o.body}</span>
            </button>
          ))}
        </div>
      )}
    </Tile>
  )
}
