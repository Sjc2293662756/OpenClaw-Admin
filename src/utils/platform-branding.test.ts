import { describe, expect, it } from 'vitest'
import { formatGAIOPDisplayText } from './platform-branding'
import { platformBranding } from '@/branding/platform'

describe('formatGAIOPDisplayText', () => {
  it('rebrands OpenClaw NAPM names while preserving the display separator', () => {
    expect(formatGAIOPDisplayText('openclaw-napm')).toBe('GAIOP-NAPM')
    expect(formatGAIOPDisplayText('OpenClaw NAPM connector')).toBe('GAIOP NAPM connector')
  })

  it('rebrands every case variation without changing the upstream value', () => {
    expect(formatGAIOPDisplayText('OpenClaw / OPENCLAW / openclaw')).toBe('GAIOP / GAIOP / GAIOP')
    expect(formatGAIOPDisplayText(undefined)).toBe('')
  })

  it('uses the current configurable product code', () => {
    const original = platformBranding.productCode
    platformBranding.productCode = 'CUSTOM'
    try {
      expect(formatGAIOPDisplayText('OpenClaw NAPM')).toBe('CUSTOM NAPM')
    } finally {
      platformBranding.productCode = original
    }
  })
})
