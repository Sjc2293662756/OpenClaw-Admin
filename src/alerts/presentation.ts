export type AlertSeverity = '轻微' | '重大' | '紧急'

export const ALERT_SEVERITIES: readonly AlertSeverity[] = ['紧急', '重大', '轻微']

export function alertSeverityType(severity: string): 'error' | 'warning' | 'default' {
  return ({ '紧急': 'error', '重大': 'warning', '轻微': 'default' } as const)[severity as AlertSeverity] || 'default'
}

export function alertSeverityLabel(severity: string, locale: string) {
  const labels: Record<AlertSeverity, string> = locale === 'zh-CN'
    ? { '紧急': '紧急', '重大': '重大', '轻微': '轻微' }
    : { '紧急': 'Critical', '重大': 'Major', '轻微': 'Minor' }
  return labels[severity as AlertSeverity] || severity
}

export function alertActionLabel(action: 'triggered' | 'recovered' | 'compensation', locale: string) {
  if (locale === 'zh-CN') {
    if (action === 'recovered') return '已恢复'
    if (action === 'compensation') return '补偿通知'
    return '已触发'
  }
  if (action === 'recovered') return 'Recovered'
  if (action === 'compensation') return 'Compensation'
  return 'Triggered'
}

export function formatAlertTime(value: unknown, locale: string, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : ''
  const timestamp = Date.parse(text)
  return text && Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(locale) : fallback
}

export function alertSummary(payload: Record<string, unknown>, fallback: string) {
  return String(payload.name || payload.categoryLabel || payload.category || fallback).trim() || fallback
}

export function alertSource(payload: Record<string, unknown>, fallback: string) {
  return String(payload.sourceHost || payload.host || fallback).trim() || fallback
}
