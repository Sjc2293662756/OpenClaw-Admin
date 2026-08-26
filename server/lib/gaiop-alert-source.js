import { ALERT_CATEGORY_LABELS } from './syslog-alerts.js'

export function readGAIOPAlertReceiverUrl(env) {
  const explicitUrl = String(env.GAIOP_ALERT_RECEIVER_URL || '').trim()
  const raw = explicitUrl || (env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:3004')
  if (!raw) throw new Error('GAIOP alert receiver is not configured')
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol')
    return url
  } catch {
    throw new Error('GAIOP alert receiver is not configured')
  }
}

function toMillis(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}

export function mapGAIOPAlertEvent(event) {
  const metrics = Array.isArray(event?.metrics) ? event.metrics.map((metric) => ({
    name: String(metric?.name || ''),
    value: String(metric?.value || ''),
    unit: String(metric?.unit || ''),
  })) : []
  const restored = event?.status === 'recovered' || (metrics.length > 0 && metrics.every((metric) => metric.value === 'N/D'))
  const occurredAt = toMillis(event?.occurredAt) || toMillis(event?.receivedAt) || Date.now()
  return {
    id: String(event?.id || event?.eventId || `${occurredAt}:${event?.category || 'unknown'}:${event?.ruleId || ''}`),
    occurredAt: new Date(occurredAt).toISOString(),
    sourceHost: String(event?.sourceIp || '未记录'),
    category: String(event?.category || 'unknown'),
    categoryLabel: ALERT_CATEGORY_LABELS[event?.category] || String(event?.category || '未知类型'),
    severity: String(event?.severity || '未知'),
    name: String(event?.name || '未命名告警'),
    ruleId: Number(event?.ruleId) || 0,
    metrics,
    description: event?.description || null,
    triggerCondition: event?.triggerCondition || null,
    groupPath: event?.groupPath || null,
    startTime: event?.start ? String(event.start) : null,
    endTime: event?.end ? String(event.end) : null,
    eventId: event?.eventId || null,
    restored,
  }
}

export async function readGAIOPAlerts(env = process.env, filters = {}, fetchImpl = fetch) {
  const baseUrl = readGAIOPAlertReceiverUrl(env)
  const url = new URL('/alerts', baseUrl)
  url.searchParams.set('page', '1')
  url.searchParams.set('pageSize', '3000')
  for (const key of ['severity', 'category', 'keyword', 'startAt', 'endAt']) {
    const value = filters?.[key]
    if (value !== null && value !== undefined && String(value).trim()) {
      url.searchParams.set(key, String(value).trim())
    }
  }
  const token = String(env.GAIOP_ALERT_RECEIVER_TOKEN || '')
  let response
  try {
    response = await fetchImpl(url, {
      headers: token ? { 'x-gaiop-alert-token': token } : {},
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new Error('GAIOP alert receiver is unavailable')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok || !Array.isArray(payload.alerts)) throw new Error('GAIOP alert receiver is unavailable')
  // The receiver stores newest-first; filterAlerts retains the old parser's final reverse.
  return {
    alerts: payload.alerts.map(mapGAIOPAlertEvent).reverse(),
    availableCount: Number(payload.availableCount) || 0,
    hasMore: Boolean(payload.hasMore),
  }
}

function sequenceOf(alert) {
  const value = Number(alert?.streamSequence)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

// The receiver's /alerts resource is newest-first and bounded to 3000 entries.
// Only its contiguous suffix is safe to present as a browser replay window.
export async function readGAIOPAlertChanges(env = process.env, {
  afterSequence = null,
  limit = 200,
} = {}, fetchImpl = fetch) {
  const baseUrl = readGAIOPAlertReceiverUrl(env)
  const url = new URL('/alerts', baseUrl)
  url.searchParams.set('page', '1')
  url.searchParams.set('pageSize', '3000')
  const token = String(env.GAIOP_ALERT_RECEIVER_TOKEN || '')
  let response
  try {
    response = await fetchImpl(url, {
      headers: token ? { 'x-gaiop-alert-token': token } : {},
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    throw new Error('GAIOP alert receiver is unavailable')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.ok || !Array.isArray(payload.alerts)) {
    throw new Error('GAIOP alert receiver is unavailable')
  }

  const ordered = payload.alerts
    .map((alert) => ({ alert, sequence: sequenceOf(alert) }))
    .filter((item) => item.sequence !== null)
    .sort((left, right) => left.sequence - right.sequence)
  const latestSequence = ordered.at(-1)?.sequence || 0
  let oldestAvailableSequence = latestSequence || null
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const expected = latestSequence - (ordered.length - 1 - index)
    if (ordered[index].sequence !== expected) break
    oldestAvailableSequence = ordered[index].sequence
  }
  const contiguous = ordered.filter((item) => item.sequence >= (oldestAvailableSequence || Infinity))
  const normalizedAfter = afterSequence === null ? null : Number(afterSequence)
  if (normalizedAfter === null) {
    return { events: [], latestSequence, hasMore: false, historyRefreshRequired: false }
  }
  if (normalizedAfter > latestSequence || normalizedAfter < (oldestAvailableSequence || 1) - 1) {
    return { events: [], latestSequence, hasMore: false, historyRefreshRequired: true, oldestAvailableSequence }
  }
  const pending = contiguous.filter((item) => item.sequence > normalizedAfter)
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 300)
  return {
    events: pending.slice(0, safeLimit).map(({ alert, sequence }) => {
      const payload = mapGAIOPAlertEvent(alert)
      return { type: 'alert', action: payload.restored ? 'recovered' : 'triggered', cursor: sequence, payload }
    }),
    latestSequence,
    oldestAvailableSequence,
    hasMore: pending.length > safeLimit,
    historyRefreshRequired: false,
  }
}
