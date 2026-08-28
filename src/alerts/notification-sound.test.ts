import { describe, expect, it, vi } from 'vitest'
import { playAlertNotificationSound } from './notification-sound'

describe('alert notification sound', () => {
  it('fails safely when browser audio is unavailable', () => {
    vi.stubGlobal('window', {})
    expect(playAlertNotificationSound()).toBe(false)
  })
})
