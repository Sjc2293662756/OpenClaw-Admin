import type { SessionsUsageDailyItem } from '@/api/types'

export type TimeRange = [number, number]
export type TimeRangePreset = 'today' | 'last7days' | 'last30days' | 'thisMonth' | 'custom'
export type TrendGrain = 'day' | 'week' | 'month'

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addCalendarDays(value: number, days: number): number {
  const date = new Date(value)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

export function rangeForPreset(
  preset: Exclude<TimeRangePreset, 'custom'>,
  now = Date.now()
): TimeRange {
  const today = startOfDay(now)

  if (preset === 'today') return [today, now]
  if (preset === 'last7days') return [addCalendarDays(today, -6), now]
  if (preset === 'last30days') return [addCalendarDays(today, -29), now]

  const monthStart = new Date(now)
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  return [monthStart.getTime(), now]
}

export function validateTimeRange(
  range: TimeRange | null,
  now = Date.now()
): 'empty' | 'reversed' | 'future' | null {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) return 'empty'
  if (range[0] > range[1]) return 'reversed'
  if (range[1] > now) return 'future'
  return null
}

export function formatDateTime(value: number): string {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

export function formatYmd(value: number): string {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatTimeRange(range: TimeRange): string {
  return `${formatDateTime(range[0])} - ${formatDateTime(range[1])}`
}

export function calendarDayCount(range: TimeRange): number {
  const start = startOfDay(range[0])
  const end = startOfDay(range[1])
  return Math.max(1, Math.round((end - start) / DAY_MS) + 1)
}

export function trendGrainForRange(range: TimeRange): TrendGrain {
  const days = calendarDayCount(range)
  if (days <= 31) return 'day'
  if (days <= 180) return 'week'
  return 'month'
}

function parseYmd(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year || 1970, (month || 1) - 1, day || 1)
}

function naturalWeekStart(value: string): string {
  const date = parseYmd(value)
  const day = date.getDay()
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1))
  return formatYmd(date.getTime())
}

function bucketKey(date: string, grain: TrendGrain): string {
  if (grain === 'day') return date
  if (grain === 'week') return naturalWeekStart(date)
  return date.slice(0, 7)
}

export function aggregateUsageTrend(
  rows: SessionsUsageDailyItem[],
  grain: TrendGrain
): SessionsUsageDailyItem[] {
  if (grain === 'day') return [...rows].sort((a, b) => a.date.localeCompare(b.date))

  const buckets = new Map<string, SessionsUsageDailyItem>()
  for (const row of rows) {
    const key = bucketKey(row.date, grain)
    const current = buckets.get(key) || {
      date: key,
      tokens: 0,
      cost: 0,
      messages: 0,
      toolCalls: 0,
      errors: 0,
    }
    current.tokens += row.tokens || 0
    current.cost += row.cost || 0
    current.messages += row.messages || 0
    current.toolCalls += row.toolCalls || 0
    current.errors += row.errors || 0
    buckets.set(key, current)
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export function createLatestRequestTracker() {
  let latest = 0
  return {
    begin() {
      latest += 1
      return latest
    },
    isCurrent(requestId: number) {
      return requestId === latest
    },
  }
}
