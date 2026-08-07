import { describe, expect, it } from 'vitest'
import {
  applyPlatformBranding,
  DEFAULT_PLATFORM_BRANDING,
  PLATFORM_BRANDING_KEYS,
  platformBranding,
  usesDefaultPlatformBranding,
} from './platform'

describe('platformBranding', () => {
  it('defines the approved company and product names', () => {
    expect(PLATFORM_BRANDING_KEYS).toHaveLength(8)
    expect(platformBranding).toEqual(DEFAULT_PLATFORM_BRANDING)
  })

  it('identifies whether the active branding remains at its defaults', () => {
    applyPlatformBranding({ ...DEFAULT_PLATFORM_BRANDING, companyBrandEn: 'Example' })
    expect(usesDefaultPlatformBranding()).toBe(false)

    applyPlatformBranding(DEFAULT_PLATFORM_BRANDING)
    expect(usesDefaultPlatformBranding()).toBe(true)
  })
})
