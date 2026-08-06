const MAX_QR_SOURCE_LENGTH = 4 * 1024 * 1024
const QR_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,([a-z0-9+/=\r\n]+)$/i
const ONBOARDING_QR_PATH_PATTERN = /^\/api\/channels\/personal-wechat\/onboarding\/[^/]+\/qr$/

/**
 * Only allow non-scriptable raster data URLs or a same-origin onboarding QR endpoint.
 * SVG, cross-origin URLs, credentials in URLs, and executable schemes are rejected.
 */
export function normalizePersonalWechatQrSource(value: unknown, explicitOrigin?: string): string | null {
  if (typeof value !== 'string') return null
  const source = value.trim()
  if (!source || source.length > MAX_QR_SOURCE_LENGTH) return null

  const dataMatch = source.match(QR_DATA_URL_PATTERN)
  if (dataMatch) return dataMatch[1]?.length ? source : null

  const origin = explicitOrigin
    || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '')
  if (!origin) return null

  try {
    const base = new URL(origin)
    const url = new URL(source, base)
    if (url.origin !== base.origin || url.username || url.password) return null
    if (!ONBOARDING_QR_PATH_PATTERN.test(url.pathname)) return null
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}

export function isPersonalWechatOnboardingTerminal(status: string): boolean {
  return ['success', 'expired', 'failed', 'cancelled'].includes(status)
}
