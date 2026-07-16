import { ALERT_CATEGORY_LABELS } from './syslog-alerts.js'

function readReceiverUrl(env) {
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

export async function readGAIOPAlerts(env = process.env, maxResults = 200, fetchImpl = fetch) {
  const baseUrl = readReceiverUrl(env)
  const pageSize = Math.min(Math.max(Number(maxResults) || 200, 10), 3000)
  const url = new URL('/alerts', baseUrl)
  url.searchParams.set('page', '1')
  url.searchParams.set('pageSize', String(pageSize))
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
