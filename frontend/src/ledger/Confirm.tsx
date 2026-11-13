import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// an in-app confirm for destructive actions: `const [confirm, dialog] = useConfirm()`, render {dialog},
// then `if (!(await confirm({ title, detail, action }))) return`
export type Ask = { title: string; detail?: string; action: string }

export function useConfirm(): [(a: Ask) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<(Ask & { done: (ok: boolean) => void }) | null>(null)
  const confirm = useCallback((a: Ask) => new Promise<boolean>(done => setPending({ ...a, done })), [])
  const finish = (ok: boolean) => { pending?.done(ok); setPending(null) }
  return [confirm, pending && <ConfirmDialog a={pending} onDone={finish} />]
}

function ConfirmDialog({ a, onDone }: { a: Ask; onDone: (ok: boolean) => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    // the page's own hotkeys stay quiet while it's open; Escape cancels
    const key = (e: KeyboardEvent) => {
      e.stopImmediatePropagation()
      if (e.key === 'Escape') done.current(false)
    }
    addEventListener('keydown', key, true)
    return () => { removeEventListener('keydown', key, true); back?.focus() }
  }, [])
  return (
    <>
      <div className="lg-backdrop" onClick={() => onDone(false)} />
      <div className="lg-dialog lg-confirm" role="alertdialog" aria-modal="true" aria-labelledby="lg-confirm-h" aria-describedby={a.detail ? 'lg-confirm-d' : undefined}>
        <h2 id="lg-confirm-h" className="lg-h2 lg-confirm-title">{a.title}</h2>
        {a.detail && <p id="lg-confirm-d" className="lg-dim">{a.detail}</p>}
        <div className="lg-row lg-confirm-actions">
          <button ref={cancel} type="button" className="lg-btn" onClick={() => onDone(false)}>Cancel</button>
          <button type="button" className="lg-btn lg-btn-danger" onClick={() => onDone(true)}>{a.action}</button>
        </div>
      </div>
    </>
  )
}
