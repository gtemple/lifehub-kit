import { useTile } from '../api'
import { useActivityTray } from '../components/Notifications'
import { Shell } from '../Shell'
import { NAV_ICONS } from './navIcons'
import { MORE_PAGES, TopBar } from './TopBar'

// the phone's More tab: the pages that don't fit the bottom bar
export function MorePage() {
  const tray = useActivityTray()
  const server = useTile<never, { server: boolean }>('nav', 60_000).res?.data?.server
  return (
    <Shell screen="dashboard" handlers={{ toggleActivityTray: tray.toggle }}>
      <TopBar page="more" tray={tray} />
      <main className="lg-main lg-more">
        <section aria-labelledby="more-pages">
          <h2 id="more-pages" className="lg-more-label">Pages</h2>
          <div className="lg-more-grid">
            {MORE_PAGES.filter(p => p[0] !== 'server' || server).map(([id, href, label]) => (
              <a key={id} href={href} className="lg-more-tile">
                <svg width="24" height="24" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d={NAV_ICONS[id][0]} /></svg>
                {label}
              </a>
            ))}
          </div>
        </section>
      </main>
    </Shell>
  )
}
