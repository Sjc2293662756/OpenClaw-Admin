import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  DEFAULT_PLATFORM_BRANDING,
  readBrandingSettings,
  saveBrandingSettings,
  validateBrandingSettings,
} from './branding-settings.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE branding_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_short_zh TEXT NOT NULL,
      company_legal_zh TEXT NOT NULL,
      company_english TEXT NOT NULL,
      company_brand_en TEXT NOT NULL,
      product_code TEXT NOT NULL,
      product_short_zh TEXT NOT NULL,
      product_full_zh TEXT NOT NULL,
      product_full_en TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  return db
}

test('branding settings use the canonical defaults until customized', () => {
  const db = createDb()
  try {
    assert.deepEqual(readBrandingSettings(db), { branding: DEFAULT_PLATFORM_BRANDING, updatedAt: null })
  } finally {
    db.close()
  }
})

test('branding settings validate and persist all eight fields', () => {
  const db = createDb()
  try {
    const customized = { ...DEFAULT_PLATFORM_BRANDING, productCode: 'CUSTOM' }
    const saved = saveBrandingSettings(db, customized, 'initial-admin', 1234)
    assert.equal(saved.ok, true)
    assert.deepEqual(readBrandingSettings(db), { branding: customized, updatedAt: 1234 })
    assert.equal(validateBrandingSettings({ ...customized, companyShortZh: ' ' }).ok, false)
  } finally {
    db.close()
  }
})
