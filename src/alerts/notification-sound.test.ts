import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ALERT_SOUNDS, isAlertSoundId, playAlertNotificationSound } from './notification-sound'

describe('alert notification sound', () => {
  it('fails safely when browser audio is unavailable', () => {
    vi.stubGlobal('window', {})
    expect(playAlertNotificationSound('minor-soft')).toBe(false)
  })

  it('keeps a distinct default sound for each alert severity', () => {
    expect(DEFAULT_ALERT_SOUNDS).toEqual({
      minorSound: 'minor-soft',
      majorSound: 'major-chime',
      criticalSound: 'critical-pulse',
    })
    expect(isAlertSoundId('critical-pulse')).toBe(true)
    expect(isAlertSoundId('unknown')).toBe(false)
  })
})
