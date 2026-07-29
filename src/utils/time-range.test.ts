import { describe, expect, it } from 'vitest'
import {
  aggregateUsageTrend,
  calendarDayCount,
  createLatestRequestTracker,
  formatYmd,
  rangeForPreset,
  timeRangeAxisValues,
  trendPointTime,
  trendGrainForRange,
  validateTimeRange,
} from './time-range'

describe('time range', () => {
  const now = new Date(2026, 6, 28, 15, 30).getTime()

  it('builds calendar-aligned presets', () => {
    const sevenDays = rangeForPreset('last7days', now)
    expect(formatYmd(sevenDays[0])).toBe('2026-07-22')
    expect(sevenDays[1]).toBe(now)
    expect(calendarDayCount(sevenDays)).toBe(7)
    expect(formatYmd(rangeForPreset('thisMonth', now)[0])).toBe('2026-07-01')
  })

  it('validates invalid and future ranges', () => {
    expect(validateTimeRange(null, now)).toBe('empty')
    expect(validateTimeRange([now, now - 1], now)).toBe('reversed')
    expect(validateTimeRange([now - 1, now + 1], now)).toBe('future')
    expect(validateTimeRange([now - 1, now], now)).toBeNull()
  })

  it('selects day, natural-week and month grains', () => {
    expect(trendGrainForRange([now - 30 * 86400000, now])).toBe('day')
    expect(trendGrainForRange([now - 31 * 86400000, now])).toBe('week')
    expect(trendGrainForRange([now - 181 * 86400000, now])).toBe('month')
  })

  it('builds axis labels from the selected range instead of sparse data points', () => {
    const start = new Date(2026, 5, 3).getTime()
    const end = new Date(2026, 6, 29).getTime()
    const [axisStart, axisMid, axisEnd] = timeRangeAxisValues([start, end])
    expect(formatYmd(axisStart)).toBe('2026-06-03')
    expect(formatYmd(axisMid)).toBe('2026-07-01')
    expect(formatYmd(axisEnd)).toBe('2026-07-29')
  })

  it('parses day, week and month bucket dates for proportional positioning', () => {
    expect(formatYmd(trendPointTime('2026-06-08'))).toBe('2026-06-08')
    expect(formatYmd(trendPointTime('2026-07'))).toBe('2026-07-01')
  })

  it('aggregates every usage metric into natural weeks', () => {
    const result = aggregateUsageTrend([
      { date: '2026-07-26', tokens: 10, cost: 1, messages: 2, toolCalls: 3, errors: 1 },
      { date: '2026-07-27', tokens: 20, cost: 2, messages: 4, toolCalls: 5, errors: 0 },
    ], 'week')
    expect(result).toEqual([
      { date: '2026-07-20', tokens: 10, cost: 1, messages: 2, toolCalls: 3, errors: 1 },
      { date: '2026-07-27', tokens: 20, cost: 2, messages: 4, toolCalls: 5, errors: 0 },
    ])
  })

  it('only accepts the latest request generation', () => {
    const tracker = createLatestRequestTracker()
    const first = tracker.begin()
    const second = tracker.begin()
    expect(tracker.isCurrent(first)).toBe(false)
    expect(tracker.isCurrent(second)).toBe(true)
  })
})
