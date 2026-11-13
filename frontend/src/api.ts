import { useCallback, useEffect, useState } from 'react'

import type { TileResponse } from './types'

export type TileState<T, D = undefined> = {
  res: TileResponse<T, D> | null // last good response, kept when a refresh fails
  loading: boolean
  failed: boolean
  refresh: () => void
}

export function useTile<T, D = undefined>(name: string, everyMs: number): TileState<T, D> {
  const [res, setRes] = useState<TileResponse<T, D> | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    fetch(`/api/tiles/${name}/`, { credentials: 'same-origin' })
      .then(r => {
        if (r.status === 401 || r.redirected) location.href = '/login/?next=/'
        if (!r.ok) throw new Error(String(r.status))
        return r.json() as Promise<TileResponse<T, D>>
      })
      .then(json => { setRes(json); setFailed(false) })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [name])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, everyMs)
    // coming back from Gmail or another tab shows what changed meanwhile
    const back = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', back)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', back) }
  }, [refresh, everyMs])

  return { res, loading, failed, refresh }
}

const csrf = () => document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1] ?? ''

export async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `${r.status}`)
  return r.json() as Promise<T>
}

// per-device preferences; private windows can refuse storage, so fall back quietly
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}

export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* not saved, still applied */ }
}
