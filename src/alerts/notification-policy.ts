import type { AlertSeverity } from './presentation'

// Keep at most three visible notices. Minor alerts auto-close quickly, major
// alerts remain readable, and critical alerts require an explicit close.
export function alertNotificationDuration(severity: string): number {
  if (severity === '紧急') return 0
  if (severity === '重大') return 12_000
  return 5_000
}

export function alertNotificationType(severity: string): 'error' | 'warning' | 'info' {
  if (severity === '紧急') return 'error'
  if (severity === '重大') return 'warning'
  return 'info'
}

export const MAX_VISIBLE_ALERT_NOTIFICATIONS = 3
export const NOTIFIABLE_SEVERITIES: readonly AlertSeverity[] = ['轻微', '重大', '紧急']
