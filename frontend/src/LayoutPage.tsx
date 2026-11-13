import { useState } from 'react'

import { Btn, Window } from './components/ui'
import { DEFAULT_LAYOUT, NAMES, loadLayout, saveLayout } from './layout'
import type { Layout } from './layout'
import { Shell } from './Shell'

const COLUMNS = ['act', 'inbox', 'read']
const BOTTOM = ['wide', 'row4', 'row2']

// layout.cpl (design/screens/VWCustomize.dc.html) at /layout: reorder and hide windows, saved on this device
export function LayoutPage() {
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [sel, setSel] = useState('approvals')
  const change = (l: Layout) => { setLayout(l); saveLayout(l) }

  const where = (id: string) => Object.entries(layout.order).find(([, ids]) => ids.includes(id))![0]
  const move = (id: string, by: number) => {
    const g = where(id)
    const ids = [...layout.order[g]!]
    const i = ids.indexOf(id)
    if (i + by < 0 || i + by >= ids.length) return
    ids.splice(i, 1)
    ids.splice(i + by, 0, id)
    change({ ...layout, order: { ...layout.order, [g]: ids } })
  }
  const toggle = (id: string) => change({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter(h => h !== id) : [...layout.hidden, id] })
  const all = COLUMNS.flatMap(g => layout.order[g]!)
  const step = (by: number) => setSel(s => all[Math.min(all.length - 1, Math.max(0, all.indexOf(s) + by))] ?? s)
  const done = () => { location.href = '/' }

  const handlers = {
    next: () => step(1), prev: () => step(-1),
    moveUp: () => move(sel, -1), moveDown: () => move(sel, 1),
    toggleHidden: () => toggle(sel),
    reset: () => change(DEFAULT_LAYOUT), done, closeOrBack: done,
  }

  return (
    <Shell screen="layout" handlers={handlers}>
      <main className="shell" style={{ paddingTop: 24 }}>
        <Window
          name={<>layout.cpl — display properties · <span className="jp" aria-hidden="true">レイアウト</span></>} grad={1} dialog headingLevel="h1" onClose={done}
          foot={<><span className="grow" /><Btn tone="face" k="R" onClick={handlers.reset}>Reset</Btn><Btn tone="mint" k="Enter" onClick={done}>OK</Btn></>}
        >
          <p style={{ margin: 0, fontSize: 16 }}>select a window, then move it with the arrows (Shift ↑ / Shift ↓) or hide it (H). saved on this device.</p>
          <div className="lay-grid">
            {COLUMNS.map(g => (
              <fieldset key={g} className="lay">
                <legend>{g}/</legend>
                {layout.order[g]!.map((id, i, ids) => {
                  const hidden = layout.hidden.includes(id)
                  return (
                    <div key={id} className={`lay-row ${hidden ? 'off' : ''}`} aria-selected={sel === id} onClick={() => setSel(id)}>
                      <span className="lay-name">{NAMES[id]}</span>
                      <button type="button" className="lay-arrow" aria-label={`Move ${NAMES[id]} up`} disabled={i === 0} onClick={() => move(id, -1)}>▲</button>
                      <button type="button" className="lay-arrow" aria-label={`Move ${NAMES[id]} down`} disabled={i === ids.length - 1} onClick={() => move(id, 1)}>▼</button>
                      <label className="lay-show"><input type="checkbox" checked={!hidden} onChange={() => toggle(id)} />show</label>
                    </div>
                  )
                })}
              </fieldset>
            ))}
          </div>
          <fieldset className="lay">
            <legend>bottom_row/</legend>
            <div className="lay-bottom">
              {BOTTOM.flatMap(g => layout.order[g]!).map(id => (
                <label key={id} className="lay-check"><input type="checkbox" checked={!layout.hidden.includes(id)} onChange={() => toggle(id)} />{NAMES[id]}</label>
              ))}
            </div>
          </fieldset>
        </Window>
      </main>
    </Shell>
  )
}
