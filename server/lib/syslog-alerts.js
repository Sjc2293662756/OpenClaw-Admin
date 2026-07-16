import { TextDecoder } from 'util'

// Mirrors GAIOP skills/openclaw-napm-alert-query/services/AlertConstants.js.
// Keep this Admin read-model mapping aligned when GAIOP introduces a category.
export const ALERT_CATEGORY_LABELS = Object.freeze({
  networkAlerts: '网络性能告警',
  networkIssueAlerts: '网络异常告警',
  appAlerts: '应用性能告警',
  busAlerts: '业务故障告警',
  userAlerts: '用户体验告警',
  securityAlerts: '安全事件告警',
  AIAlerts: '智能分析告警',
})

function decodeSyslogBuffer(buffer) {
  const utf8 = Buffer.from(buffer).toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gb18030').decode(buffer)
  } catch {
    return utf8
  }
}

export function parseSyslogAlert(line) {
  if (!line || typeof line !== 'string') return null
  const header = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2})\s+from=([^\s]+)\s+host=([^\s]+)\s+facility=([^\s]+)\s+severity=([^\s]+)\s+tag=([^:]+):\s*(.*)$/)
  if (!header) return null
  const [, occurredAt, fromHost, host, facility, syslogSeverity, tag, body] = header
  const alertMatch = body.match(/(\w+Alerts)\s+severity=([^\s]+)\s+name=(.+?)\s+alertid=(\d+)/)
  if (!alertMatch) return null
  const [, category, severity, name, alertId] = alertMatch
  const pairs = {}
  for (const match of body.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/g)) {
    pairs[match[1]] = match[2] ?? match[3] ?? ''
  }
  const metrics = []
  for (let index = 1; pairs[`metric${index}`]; index += 1) {
    metrics.push({ name: pairs[`metric${index}`], value: pairs[`value${index}`] || '', unit: pairs[`units${index}`] || '' })
  }
  const extra = {}
  for (const [key, value] of Object.entries(pairs)) {
    if (['severity', 'name', 'alertid'].includes(key) || /^(metric|value|units)\d+$/.test(key)) continue
    extra[key] = value
  }
  const restored = metrics.length > 0 && metrics.every((metric) => metric.value === 'N/D')
  return {
    id: String(extra.elogid || `${occurredAt}:${category}:${alertId}`),
    occurredAt,
    sourceHost: fromHost,
    host,
    facility,
    syslogSeverity,
    tag: tag.trim(),
    category,
    categoryLabel: ALERT_CATEGORY_LABELS[category] || category,
    severity,
    name,
    ruleId: Number(alertId),
    metrics,
    description: extra.alertdesc || null,
    triggerCondition: extra.condition || extra.triggerCondition || null,
    groupPath: extra.canongrouppath || extra.grouppath || null,
    startTime: extra.starttime || null,
    endTime: extra.endtime || null,
    eventId: extra.elogid || null,
    restored,
  }
}

export function parseSyslogAlerts(buffer) {
  const lines = decodeSyslogBuffer(buffer).split(/\r?\n/).filter(Boolean)
  const alerts = lines.map(parseSyslogAlert).filter(Boolean)
  return { lines: lines.length, alerts }
}

export function filterAlerts(alerts, { severity, category, keyword, startAt, endAt } = {}) {
  const normalizedSeverity = String(severity || '').trim()
  const normalizedCategory = String(category || '').trim()
  const normalizedKeyword = String(keyword || '').trim().toLocaleLowerCase()
  const start = Number.isFinite(Number(startAt)) ? Number(startAt) : null
  const end = Number.isFinite(Number(endAt)) ? Number(endAt) : null
  return alerts.filter((alert) => {
    const occurredAt = Date.parse(alert.occurredAt)
    if (start !== null && (!Number.isFinite(occurredAt) || occurredAt < start)) return false
    if (end !== null && (!Number.isFinite(occurredAt) || occurredAt > end)) return false
    if (normalizedSeverity && alert.severity !== normalizedSeverity) return false
    if (normalizedCategory && alert.category !== normalizedCategory) return false
    if (!normalizedKeyword) return true
    return [alert.name, alert.sourceHost, alert.eventId]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(normalizedKeyword))
  }).reverse()
}
