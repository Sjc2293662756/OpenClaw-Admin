import { describe, expect, it } from 'vitest'
import { alertActionLabel, alertSeverityLabel, alertSeverityType } from './presentation'
import { alertNotificationDuration, alertNotificationType } from './notification-policy'

describe('alert presentation', () => {
  it('uses the one three-level severity mapping everywhere', () => {
    expect(alertSeverityLabel('轻微', 'en-US')).toBe('Minor')
    expect(alertSeverityLabel('重大', 'en-US')).toBe('Major')
    expect(alertSeverityLabel('紧急', 'en-US')).toBe('Critical')
    expect(alertSeverityType('轻微')).toBe('default')
    expect(alertSeverityType('重大')).toBe('warning')
    expect(alertSeverityType('紧急')).toBe('error')
  })

  it('uses bounded notification escalation and explicit recovery labels', () => {
    expect(alertNotificationDuration('轻微')).toBe(5_000)
    expect(alertNotificationDuration('重大')).toBe(12_000)
    expect(alertNotificationDuration('紧急')).toBe(0)
    expect(alertNotificationType('紧急')).toBe('error')
    expect(alertActionLabel('recovered', 'en-US')).toBe('Recovered')
  })
})
