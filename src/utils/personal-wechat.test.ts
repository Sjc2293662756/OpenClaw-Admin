import { describe, expect, it } from 'vitest'
import {
  isPersonalWechatOnboardingTerminal,
  normalizePersonalWechatQrSource,
} from './personal-wechat'

describe('personal WeChat QR source boundary', () => {
  it('accepts raster data URLs and controlled same-origin QR endpoints', () => {
    expect(normalizePersonalWechatQrSource('data:image/png;base64,QUJDRA==')).toBe('data:image/png;base64,QUJDRA==')
    expect(normalizePersonalWechatQrSource(
      '/api/channels/personal-wechat/onboarding/session-1/qr?nonce=public',
      'https://admin.example.test',
    )).toBe('/api/channels/personal-wechat/onboarding/session-1/qr?nonce=public')
  })

  it('rejects scriptable, credential-bearing, cross-origin, and unrelated sources', () => {
    expect(normalizePersonalWechatQrSource('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(normalizePersonalWechatQrSource('javascript:alert(1)', 'https://admin.example.test')).toBeNull()
    expect(normalizePersonalWechatQrSource(
      'https://evil.example.test/api/channels/personal-wechat/onboarding/session-1/qr',
      'https://admin.example.test',
    )).toBeNull()
    expect(normalizePersonalWechatQrSource(
      'https://user:pass@admin.example.test/api/channels/personal-wechat/onboarding/session-1/qr',
      'https://admin.example.test',
    )).toBeNull()
    expect(normalizePersonalWechatQrSource('/assets/untrusted.png', 'https://admin.example.test')).toBeNull()
  })

  it('recognizes only terminal onboarding states', () => {
    expect(isPersonalWechatOnboardingTerminal('success')).toBe(true)
    expect(isPersonalWechatOnboardingTerminal('expired')).toBe(true)
    expect(isPersonalWechatOnboardingTerminal('failed')).toBe(true)
    expect(isPersonalWechatOnboardingTerminal('cancelled')).toBe(true)
    expect(isPersonalWechatOnboardingTerminal('waiting_for_scan')).toBe(false)
    expect(isPersonalWechatOnboardingTerminal('verification_required')).toBe(false)
  })
})
