import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import { migrateSessionRetentionTables } from '../lib/session-retention-service.js'
import { createSessionRetentionRouter } from './session-retention.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspace_sessions (
      session_key TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  migrateSessionRetentionTables(db)
  return db
}

test('session retention REST exposes read-only state and keeps mutations admin-only', async () => {
  const db = createDb()
  const now = Date.UTC(2026, 7, 10, 12)
  const key = 'agent:main:main:dm:webchat-route'
  db.prepare(`
    INSERT INTO workspace_sessions (session_key, owner_user_id, status, created_at, updated_at)
    VALUES (?, 'owner', 'active', ?, ?)
  `).run(key, now, now)
  db.prepare(`
    INSERT INTO session_retention_records (
      session_key, retention_mode, lifecycle_state, owner_kind, owner_ref,
      source_channel, last_activity_at, marked_at, delete_after, updated_at
    ) VALUES (?, 'standard', 'pending_delete', 'workspace_user', 'owner', 'web', ?, ?, ?, ?)
  `).run(key, now - 181 * 86_400_000, now, now + 7 * 86_400_000, now)

  const audits = []
  const auth = (req, res, next) => {
    const role = req.get('x-test-role')
    if (!role) return res.status(401).json({ code: 'UNAUTHORIZED' })
    req.user = { id: `${role}-user`, username: role, role }
    next()
  }
  const viewer = (req, res, next) => auth(req, res, () => (
    ['auditor', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ code: 'PERMISSION_DENIED' })
  ))
  const admin = (req, res, next) => auth(req, res, () => (
    req.user.role === 'admin' ? next() : res.status(403).json({ code: 'PERMISSION_DENIED' })
  ))
  const app = express()
  app.use(express.json())
  app.use('/api/session-retention', createSessionRetentionRouter({
    db,
    viewerMiddleware: viewer,
    adminMiddleware: admin,
    recordAudit: (...args) => audits.push(args),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api/session-retention`
  try {
    assert.equal((await fetch(base)).status, 401)
    assert.equal((await fetch(base, { headers: { 'x-test-role': 'basic' } })).status, 403)
    const overview = await (await fetch(base, { headers: { 'x-test-role': 'auditor' } })).json()
    assert.equal(overview.policy.retentionDays, 180)
    assert.equal(overview.policy.graceDays, 7)
    assert.equal(overview.policy.attachmentDeletionSupported, false)
    assert.equal(overview.policy.deletionAuditRetentionDays, 1095)
    assert.equal(overview.records[0].sessionKey, key)

    assert.equal((await fetch(`${base}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'auditor' },
      body: JSON.stringify({ sessionKey: key }),
    })).status, 403)
    const cancelled = await (await fetch(`${base}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
      body: JSON.stringify({ sessionKey: key }),
    })).json()
    assert.equal(cancelled.retention.status, 'active')

    const retained = await (await fetch(`${base}/long-term`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
      body: JSON.stringify({ sessionKey: key, enabled: true }),
    })).json()
    assert.equal(retained.retention.mode, 'long_term')

    const attachment = await (await fetch(`${base}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
      body: JSON.stringify({
        sessionKey: key,
        attachmentRef: 'browser/fixture.png',
        retentionClass: 'temporary',
        createdAt: now,
      }),
    })).json()
    assert.equal(attachment.attachment.ownershipState, 'verified')
    assert.equal(attachment.attachment.deletionSupported, false)
    assert.equal(Object.hasOwn(attachment.attachment, 'attachmentRef'), false)
    assert.equal(audits.length, 3)
    assert.equal(JSON.stringify(audits).includes('fixture.png'), false)
  } finally {
    server.close()
    await once(server, 'close')
    db.close()
  }
})
