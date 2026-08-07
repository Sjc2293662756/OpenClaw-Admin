import { readFileSync } from 'node:fs'

const defaultBranding = Object.freeze(JSON.parse(
  readFileSync(new URL('../platform-branding.json', import.meta.url), 'utf8'),
))

export const BRANDING_FIELDS = Object.freeze([
  'companyShortZh',
  'companyLegalZh',
  'companyEnglish',
  'companyBrandEn',
  'productCode',
  'productShortZh',
  'productFullZh',
  'productFullEn',
])

export const DEFAULT_PLATFORM_BRANDING = defaultBranding

const COLUMNS = Object.freeze({
  companyShortZh: 'company_short_zh',
  companyLegalZh: 'company_legal_zh',
  companyEnglish: 'company_english',
  companyBrandEn: 'company_brand_en',
  productCode: 'product_code',
  productShortZh: 'product_short_zh',
  productFullZh: 'product_full_zh',
  productFullEn: 'product_full_en',
})

export function validateBrandingSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '必须提供八项品牌名称' }
  }
  const value = {}
  for (const key of BRANDING_FIELDS) {
    const item = input[key]
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `${key} 不能为空` }
    }
    if (item.trim().length > 200) {
      return { ok: false, error: `${key} 不得超过 200 个字符` }
    }
    value[key] = item.trim()
  }
  return { ok: true, value }
}

export function readBrandingSettings(db) {
  const row = db.prepare('SELECT * FROM branding_settings WHERE id = 1').get()
  if (!row) return { branding: { ...DEFAULT_PLATFORM_BRANDING }, updatedAt: null }
  const branding = {}
  for (const key of BRANDING_FIELDS) branding[key] = row[COLUMNS[key]]
  return { branding, updatedAt: row.updated_at }
}

export function saveBrandingSettings(db, input, userId, updatedAt = Date.now()) {
  const validated = validateBrandingSettings(input)
  if (!validated.ok) return validated
  const value = validated.value
  db.prepare(`
    INSERT INTO branding_settings (
      id, company_short_zh, company_legal_zh, company_english, company_brand_en,
      product_code, product_short_zh, product_full_zh, product_full_en,
      updated_by_user_id, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company_short_zh = excluded.company_short_zh,
      company_legal_zh = excluded.company_legal_zh,
      company_english = excluded.company_english,
      company_brand_en = excluded.company_brand_en,
      product_code = excluded.product_code,
      product_short_zh = excluded.product_short_zh,
      product_full_zh = excluded.product_full_zh,
      product_full_en = excluded.product_full_en,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = excluded.updated_at
  `).run(
    value.companyShortZh,
    value.companyLegalZh,
    value.companyEnglish,
    value.companyBrandEn,
    value.productCode,
    value.productShortZh,
    value.productFullZh,
    value.productFullEn,
    userId,
    updatedAt,
  )
  return { ok: true, value: readBrandingSettings(db) }
}
