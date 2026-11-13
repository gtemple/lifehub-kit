import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { design } from './design'
import { applyMotion, applyTheme, initialReduceMotion, initialTheme, themeFor } from './theme'

applyMotion(initialReduceMotion)

// old ?inbox / ?approval=… links still land on the right page
const q = new URLSearchParams(location.search)
const legacy = q.has('cleanup') ? '/cleanup' : q.get('approval') ? `/approvals/${q.get('approval')}` : q.has('inbox') ? `/inbox${q.get('inbox') ? `?id=${q.get('inbox')}` : ''}` : q.has('states') ? '/states' : null
if (legacy && location.pathname === '/') history.replaceState(null, '', legacy)

const path = location.pathname.replace(/\/$/, '') || '/'
const approval = path.match(/^\/approvals\/(\d+)$/)?.[1]
const inboxId = new URLSearchParams(location.search).get('id') ?? ''

// each design loads only its own stylesheet, so the two never fight over body and html
async function ledger(): Promise<ReactNode> {
  await import('./ledger/ledger.css')
  const L = await import('./ledger/pages')
  return approval ? <L.DraftEditor id={approval} />
    : path === '/inbox' ? <L.InboxPage initial={inboxId} />
    : path === '/cleanup' ? <L.CleanupPage />
    : path === '/settings' || path === '/layout' ? <L.SettingsPage />
    : path === '/resources' ? <L.ResourcesPage />
    : path === '/more' ? <L.MorePage />
    : <L.Dashboard />
}

async function retro(): Promise<ReactNode> {
  applyTheme(themeFor(new Date(), initialTheme))
  await import('./styles.css')
  const [{ App }, { ApprovalEdit }, { CleanupPage }, { InboxPage }, { LayoutPage }, { SettingsPage }, { States }] = await Promise.all([
    import('./App'), import('./ApprovalEdit'), import('./Cleanup'), import('./InboxPage'), import('./LayoutPage'), import('./Settings'), import('./States'),
  ])
  return approval ? <ApprovalEdit id={approval} />
    : path === '/inbox' ? <InboxPage initial={inboxId} />
    : path === '/cleanup' ? <CleanupPage />
    : path === '/settings' ? <SettingsPage />
    : path === '/layout' ? <LayoutPage />
    : path === '/states' ? <States />
    : <App themeChoice={initialTheme} />
}

void (design === 'ledger' && path !== '/states' ? ledger() : retro()).then(page => {
  createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>)
})
