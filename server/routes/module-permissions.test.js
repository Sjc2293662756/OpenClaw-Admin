import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import { createInitialAdminMiddleware } from '../lib/permissions.js'
import { migrateModulePermissions } from '../lib/module-permissions.js'
import { createModulePermissionsRouter } from './module-permissions.js'

async function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL,
      status TEXT NOT NULL, is_initial_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  migrateModulePermissions(db)
  const insert = db.prepare(`INSERT INTO users (
    id, username, role, status, is_initial_admin, created_at, updated_at
  ) VALUES (?, ?, ?, 'active', ?, 1, 1)`)
  insert.run('initial', 'initial-admin', 'admin', 1)
  insert.run('admin', 'ordinary-admin', 'admin', 0)
  insert.run('target', 'target-basic', 'basic', 0)
  const users = new Map(db.prepare('SELECT * FROM users').all().map((user) => [user.id, user]))
  const authMiddleware = (req, res, next) => {
    const user = users.get(String(req.get('x-user') || ''))
    if (!user) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' })
    req.user = { id: user.id, username: user.username, role: user.role, isInitialAdmin: Boolean(user.is_initial_admin) }
    next()
  }
  const initialAdminMiddleware = createInitialAdminMiddleware(authMiddleware)
  let auditSequence = 0
  const recordAudit = (actor, action, target, detail) => {
    auditSequence += 1
    db.prepare(`INSERT INTO audit_logs (
      id, actor_user_id, actor_username, actor_role, action, target, detail, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`audit-${auditSequence}`, actor.id, actor.username, actor.role, action, target, detail, Date.now())
  }
  const notifications = []
  const routers = createModulePermissionsRouter({
    db, authMiddleware, initialAdminMiddleware, recordAudit,
    notifyPermissionsChanged: (userId, version) => notifications.push({ userId, version }),
  })
  const app = express()
  app.use(express.json())
  app.use('/api/module-permissions/catalog', routers.catalogRouter)
  app.use('/api/users/:id/module-permissions', routers.userRouter)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  async function request(path, user, init = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'x-user': user, 'Content-Type': 'application/json', ...(init.headers || {}) },
    })
    return { response, body: await response.json() }
  }
  return { db, notifications, request, async close() { server.close(); await once(server, 'close'); db.close() } }
}

test('catalog and target projections expose the fixed server directory without role-derived browser policy', async () => {
  const context = await fixture()
  try {
    const catalog = await context.request('/api/module-permissions/catalog', 'target')
    assert.equal(catalog.response.status, 200)
    assert.equal(catalog.body.modules.length, 21)
    assert.equal(catalog.body.modules.some((row) => row.moduleKey === 'alerts.export'), true)
    assert.equal((await context.request('/api/users/target/module-permissions', 'admin')).response.status, 403)
    const projection = await context.request('/api/users/target/module-permissions', 'initial')
    assert.equal(projection.response.status, 200)
    assert.equal(projection.body.permissionVersion, 0)
    assert.equal(projection.body.effectiveModules['alerts.records'], true)
  } finally {
    await context.close()
  }
})

test('initial administrator atomically replaces overrides, audits the diff and notifies only the target version', async () => {
  const context = await fixture()
  try {
    const updated = await context.request('/api/users/target/module-permissions', 'initial', {
      method: 'PUT',
      body: JSON.stringify({
        expectedVersion: 0,
        overrides: [
          { moduleKey: 'dashboard', effect: 'allow' },
          { moduleKey: 'alerts.records', effect: 'deny' },
          { moduleKey: 'alerts.export', effect: 'deny' },
        ],
      }),
    })
    assert.equal(updated.response.status, 200)
    assert.equal(updated.body.permissionVersion, 1)
    assert.equal(updated.body.effectiveModules.dashboard, true)
    assert.equal(updated.body.effectiveModules['alerts.records'], false)
    assert.deepEqual(context.notifications, [{ userId: 'target', version: 1 }])
    const rows = context.db.prepare('SELECT module_key, effect, updated_by FROM user_module_permission_overrides ORDER BY module_key').all()
    assert.equal(rows.length, 3)
    assert.equal(rows.every((row) => row.updated_by === 'initial'), true)
    const audits = context.db.prepare('SELECT * FROM audit_logs ORDER BY created_at, id').all()
    assert.equal(audits.every((audit) => audit.actor_user_id === 'initial'), true)
    assert.match(audits[0].detail, /"beforeVersion":0/)
    assert.match(audits[0].detail, /"deniedCount":2/)
    assert.equal(audits.some((audit) => /dashboard:i>a:0>1/.test(audit.detail)), true)

    const conflict = await context.request('/api/users/target/module-permissions', 'initial', {
      method: 'PUT', body: JSON.stringify({ expectedVersion: 0, overrides: [] }),
    })
    assert.equal(conflict.response.status, 409)
    assert.equal(conflict.body.code, 'PERMISSION_VERSION_CONFLICT')
    assert.equal(conflict.body.currentVersion, 1)

    const restored = await context.request('/api/users/target/module-permissions', 'initial', {
      method: 'DELETE', body: JSON.stringify({ expectedVersion: 1 }),
    })
    assert.equal(restored.response.status, 200)
    assert.equal(restored.body.permissionVersion, 2)
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM user_module_permission_overrides').get().count, 0)
  } finally {
    await context.close()
  }
})
