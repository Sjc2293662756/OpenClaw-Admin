import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import Database from 'better-sqlite3'
import { createInitialAdminMiddleware } from '../lib/permissions.js'
import { createBrandingSettingsRouter } from './branding-settings.js'
import { DEFAULT_PLATFORM_BRANDING } from '../lib/branding-settings.js'

function createFixture() {
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
  const authMiddleware = (req, res, next) => {
    const role = req.get('x-test-role')
    if (!role) return res.status(401).json({ ok: false })
    req.user = {
      id: role === 'initial' ? 'initial-admin' : 'ordinary-admin',
      role: 'admin',
      isInitialAdmin: role === 'initial',
    }
    next()
  }
  const audits = []
  const app = express()
  app.use(express.json())
  app.use('/api/system-settings/branding', createBrandingSettingsRouter({
    db,
    initialAdminMiddleware: createInitialAdminMiddleware(authMiddleware),
    recordAudit: (...args) => audits.push(args),
  }))
  return { app, db, audits }
}

test('branding endpoint is publicly readable but only the initial administrator can write or reset', async () => {
  const fixture = createFixture()
  const server = fixture.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/api/system-settings/branding`
  try {
    const initialRead = await fetch(url)
    assert.equal(initialRead.status, 200)
    assert.deepEqual((await initialRead.json()).branding, DEFAULT_PLATFORM_BRANDING)

    const customized = { ...DEFAULT_PLATFORM_BRANDING, productCode: 'CUSTOM' }
    assert.equal((await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': 'ordinary' },
      body: JSON.stringify(customized),
    })).status, 403)
    assert.equal((await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': 'initial' },
      body: JSON.stringify(customized),
    })).status, 200)

    const customizedRead = await fetch(url)
    assert.equal((await customizedRead.json()).branding.productCode, 'CUSTOM')
    assert.equal((await fetch(`${url}/reset`, {
      method: 'POST',
      headers: { 'x-test-role': 'initial' },
    })).status, 200)
    assert.equal(fixture.audits.length, 2)
  } finally {
    server.close()
    await once(server, 'close')
    fixture.db.close()
  }
})
