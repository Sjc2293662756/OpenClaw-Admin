export type PlatformBranding = {
  companyShortZh: string
  companyLegalZh: string
  companyEnglish: string
  companyBrandEn: string
  productCode: string
  productShortZh: string
  productFullZh: string
  productFullEn: string
}

export const DEFAULT_PLATFORM_BRANDING: Readonly<PlatformBranding> = Object.freeze({
  ...defaultBranding,
})

export const PLATFORM_BRANDING_KEYS = Object.freeze(
  Object.keys(DEFAULT_PLATFORM_BRANDING) as Array<keyof PlatformBranding>,
)

export const platformBranding: PlatformBranding = { ...DEFAULT_PLATFORM_BRANDING }

export function usesDefaultPlatformBranding(): boolean {
  return PLATFORM_BRANDING_KEYS.every(
    key => platformBranding[key] === DEFAULT_PLATFORM_BRANDING[key],
  )
}

const LOCAL_PREVIEW_KEY = 'gaiop_platform_branding_preview'

function normalizeBranding(input: unknown): PlatformBranding | null {
  if (!input || typeof input !== 'object') return null
  const source = input as Record<string, unknown>
  const normalized = {} as PlatformBranding
  for (const key of PLATFORM_BRANDING_KEYS) {
    const value = source[key]
    if (typeof value !== 'string' || !value.trim() || value.length > 200) return null
    normalized[key] = value.trim()
  }
  return normalized
}

function readLocalPreview(): PlatformBranding | null {
  if (!import.meta.env.DEV || typeof localStorage === 'undefined') return null
  try {
    return normalizeBranding(JSON.parse(localStorage.getItem(LOCAL_PREVIEW_KEY) || 'null'))
  } catch {
    return null
  }
}

function writeLocalPreview(branding: PlatformBranding) {
  if (import.meta.env.DEV && typeof localStorage !== 'undefined') {
    localStorage.setItem(LOCAL_PREVIEW_KEY, JSON.stringify(branding))
  }
}

export function applyPlatformBranding(input: unknown): PlatformBranding {
  const branding = normalizeBranding(input) || { ...DEFAULT_PLATFORM_BRANDING }
  Object.assign(platformBranding, branding)
  return { ...platformBranding }
}

export async function loadPlatformBranding(): Promise<PlatformBranding> {
  try {
    const response = await fetch('/api/system-settings/branding', { cache: 'no-store' })
    if (response.ok) {
      const data = await response.json()
      const branding = normalizeBranding(data.branding)
      if (branding) {
        writeLocalPreview(branding)
        return applyPlatformBranding(branding)
      }
    }
  } catch {
    // The built-in defaults remain available when the management service is offline.
  }
  return applyPlatformBranding(readLocalPreview() || DEFAULT_PLATFORM_BRANDING)
}

export async function savePlatformBranding(branding: PlatformBranding, token: string): Promise<PlatformBranding> {
  const normalized = normalizeBranding(branding)
  if (!normalized) throw new Error('八项名称均不能为空，且每项不得超过 200 个字符')

  const response = await fetch('/api/system-settings/branding', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized),
  })
  if (response.status === 404 && import.meta.env.DEV) {
    writeLocalPreview(normalized)
    return applyPlatformBranding(normalized)
  }
  const data = await response.json()
  if (!response.ok || !data.ok) throw new Error(data?.error?.message || data?.error || '保存品牌名称失败')
  writeLocalPreview(data.branding)
  return applyPlatformBranding(data.branding)
}

export async function resetPlatformBranding(token: string): Promise<PlatformBranding> {
  const response = await fetch('/api/system-settings/branding/reset', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (response.status === 404 && import.meta.env.DEV) {
    writeLocalPreview({ ...DEFAULT_PLATFORM_BRANDING })
    return applyPlatformBranding(DEFAULT_PLATFORM_BRANDING)
  }
  const data = await response.json()
  if (!response.ok || !data.ok) throw new Error(data?.error?.message || data?.error || '恢复默认名称失败')
  writeLocalPreview(data.branding)
  return applyPlatformBranding(data.branding)
}
import defaultBranding from '../../server/platform-branding.json'
