import { dayInitial } from './data'

// seven bars (today white) with an optional dashed comparison line, drawn as the design's 700×150 box
export function Bars({ days, bars, line, label, today }: { days: string[]; bars: number[]; line?: number[]; label: string; today: number }) {
  const max = Math.max(1, ...bars, ...(line ?? []))
  const path = line?.map((v, i) => `${i ? 'L' : 'M'}${i * 100 + 50} ${(140 - v / max * 130).toFixed(1)}`).join(' ')
  return (
    <div className="lgd-chart">
      <svg viewBox="0 0 700 150" preserveAspectRatio="none" role="img" aria-label={label}>
        <line x1="0" y1="140" x2="700" y2="140" stroke="var(--lg-line)" />
        {bars.map((v, i) => {
          const h = Math.max(v ? 4 : 0, Math.round(v / max * 130))
          return <rect key={i} x={i * 100 + 22} y={140 - h} width="56" height={h} rx="6" fill={i === today ? 'var(--lg-ink)' : '#3A3A3A'} />
        })}
        {path && <path d={path} fill="none" stroke="var(--lg-decor)" strokeWidth="1.5" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="lgd-chart-days" aria-hidden="true">{days.map(d => <span key={d}>{dayInitial(d)}</span>)}</div>
    </div>
  )
}
