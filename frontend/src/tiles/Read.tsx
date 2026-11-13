import type { TileState } from '../api'
import { Tile, shownState } from '../components/Tile'
import { ago, clock } from '../time'
import type { NewsTile, SocialPost, Story } from '../types'

export const NEWS_MS = 30 * 60_000
export const SOCIAL_MS = 15 * 60_000

const hashtag = (topic: string) => `#${topic.toLowerCase().replace(/\s+/g, '_')}`

export function News({ t }: { t: TileState<Story, NewsTile> }) {
  const d = t.res?.data
  const stories = d?.stories ?? []
  const sources = d?.sourceCount ?? new Set(stories.map(s => s.source)).size
  const count = d?.storyCount ?? stories.length
  return (
    <Tile
      title="news_brief.htm" grad={3} jp="ニュース"
      state={shownState(t, NEWS_MS, () => stories.length === 0 && !d?.brief)} updatedAt={t.res?.updatedAt} onRefresh={t.refresh}
      error={t.res?.error ?? { source: 'news feeds' }}
      empty={`no new stories since ${t.res ? clock(t.res.updatedAt) : 'this morning'}`}
    >
      {d?.brief && (
        <div className="brief-box">
          <span className="eyebrow">today in brief · {clock(d.brief.writtenAt)}{d.brief.model !== 'none' ? ` · ${d.brief.model}` : ''}</span>
          <p style={{ margin: 0 }}>{d.brief.text}</p>
        </div>
      )}
      {d && <span className="sub small">{count} stories from {sources} sources today</span>}
      <div className="col">
        {stories.map(n => (
          <a key={n.id} href={n.url} target="_blank" rel="noopener" className="story" data-nav>
            <span className="hash">{hashtag(n.topic || n.source)}</span>
            <span className="story-title">{n.title}</span>
            <span className="sub small">{n.source}{n.at ? ` · ${ago(n.at)}` : ''}</span>
          </a>
        ))}
      </div>
    </Tile>
  )
}

export function Social({ t }: { t: TileState<SocialPost, { kept: number; scanned: number }> }) {
  const items = t.res?.items ?? []
  const d = t.res?.data
  return (
    <Tile
      title="social.feed" grad={2} right={d && `${d.kept} of ${d.scanned} kept`}
      state={shownState(t, SOCIAL_MS, r => r.items.length === 0)} updatedAt={t.res?.updatedAt} onRefresh={t.refresh}
      error={t.res?.error ?? { source: 'social' }} empty="quiet out there"
    >
      <div className="col">
        {items.map(s => {
          const body = <><span className="net">{s.network}</span><span>{s.who} · {s.text}</span></>
          return s.url
            ? <a key={s.id} href={s.url} target="_blank" rel="noopener" className="social" data-nav>{body}</a>
            : <div key={s.id} className="social" data-nav tabIndex={-1}>{body}</div>
        })}
      </div>
    </Tile>
  )
}
