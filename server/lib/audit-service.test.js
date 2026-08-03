import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import { createAuditRecorder, createAuditRejectionMiddleware, migrateAuditLogColumns } from './audit-service.js'
import { createRoleMiddleware, rpcPermissionMiddleware } from './permissions.js'
import { registerRetiredApiBarriers } from './legacy-api.js'
import { createAuditRouter } from '../routes/audit.js'

function createAuditDatabase() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
  `)
  return db
}

test('audit migration is repeatable and preserves legacy records without guessing new fields', () => {
  const db = createAuditDatabase()
  try {
    db.prepare(`INSERT INTO audit_logs (id, actor_user_id, actor_username, actor_role, action, target, detail, created_at)
      VALUES ('legacy', 'old-user', 'old-user', 'admin', '旧操作', '旧对象', '旧说明', 1)`).run()
    migrateAuditLogColumns(db)
    migrateAuditLogColumns(db)
    const columns = new Set(db.prepare('PRAGMA table_info(audit_logs)').all().map((column) => column.name))
    for (const column of ['category', 'result', 'source', 'rest_method', 'rest_path', 'rpc_method', 'error_code', 'request_id', 'source_address']) {
      assert.equal(columns.has(column), true, column)
    }
    const legacy = db.prepare('SELECT * FROM audit_logs WHERE id = ?').get('legacy')
    assert.equal(legacy.detail, '旧说明')
    assert.equal(legacy.category, null)
    assert.equal(legacy.request_id, null)
  } finally {
    db.close()
  }
})

test('structured recorder remains compatible with recordAudit and redacts sensitive text', () => {
  const db = createAuditDatabase()
  try {
    migrateAuditLogColumns(db)
    let currentTime = 10
    const { recordAudit, recordAuditEvent } = createAuditRecorder(db, { createId: () => `id-${currentTime}`, now: () => currentTime++ })
    recordAudit({ id: 'user-1', username: 'admin', role: 'admin' }, '保存配置', '系统设置', 'password=ShouldNeverPersist token=Nope')
    recordAuditEvent({
      user: { id: 'user-2', username: 'basic', role: 'basic' }, action: '权限校验被拒绝', category: 'authorization',
      result: 'denied', source: 'rpc', restMethod: 'POST', restPath: '/api/rpc', rpcMethod: 'config.set',
      errorCode: 'BASIC_READ_ONLY', requestId: '11111111-1111-4111-8111-111111111111', sourceAddress: '127.0.0.1',
    })
    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at').all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].result, 'success')
    assert.equal(rows[0].source, 'system')
    assert.equal(rows[0].detail.includes('ShouldNeverPersist'), false)
    assert.equal(rows[0].detail.includes('Nope'), false)
    assert.equal(rows[1].result, 'denied')
    assert.equal(rows[1].rpc_method, 'config.set')
    assert.equal(rows[1].error_code, 'BASIC_READ_ONLY')
  } finally {
    db.close()
  }
})

test('rejection auditing covers four roles, hidden resources, retired endpoints, bounded anonymous noise, and server filtering', async () => {
  const db = createAuditDatabase()
  migrateAuditLogColumns(db)
  const { recordAudit, recordAuditEvent } = createAuditRecorder(db)
  const app = express()
  app.use(express.json())
  app.use(createAuditRejectionMiddleware({ recordAuditEvent }))
  registerRetiredApiBarriers(app)
  const authMiddleware = (req, res, next) => {
    const role = req.get('x-test-role')
    if (!role) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' })
    req.user = { id: `${role}-id`, username: `${role}-user`, role }
    next()
  }
  const adminMiddleware = createRoleMiddleware(authMiddleware, ['admin'], '仅管理员可以执行此操作')
  const auditViewerMiddleware = createRoleMiddleware(authMiddleware, ['auditor', 'admin'], '审计信息仅审计用户和管理员可查看')
  app.post('/api/rest/admin', adminMiddleware, (_req, res) => res.json({ ok: true }))
  app.post('/api/rpc', authMiddleware, rpcPermissionMiddleware, (_req, res) => res.json({ ok: true }))
  app.post('/api/business-action', authMiddleware, (req, res) => {
    recordAudit(req.user, '保存测试业务', '测试对象', '不含请求体')
    res.json({ ok: true })
  })
  app.get('/api/reports/:id/download', authMiddleware, (_req, res) => res.status(404).json({ ok: false, code: 'REPORT_NOT_FOUND' }))
  app.get('/api/protected', authMiddleware, (_req, res) => res.json({ ok: true }))
  app.use('/api/audit-logs', createAuditRouter({ db, auditViewerMiddleware }))

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const request = (path, options = {}) => fetch(`${baseUrl}${path}`, options)
  const headersFor = (role, headers = {}) => ({ ...headers, 'x-test-role': role })
  try {
    for (const role of ['basic', 'standard', 'auditor']) {
      assert.equal((await request('/api/rest/admin', { method: 'POST', headers: headersFor(role) })).status, 403)
    }
    assert.equal((await request('/api/rest/admin', { method: 'POST', headers: headersFor('admin') })).status, 200)

    for (const [role, method] of [['basic', 'chat.send'], ['standard', 'config.set'], ['auditor', 'chat.send'], ['admin', 'unknown.status']]) {
      const response = await request('/api/rpc', {
        method: 'POST', headers: headersFor(role, { 'content-type': 'application/json' }), body: JSON.stringify({ method, params: { secret: 'not-recorded' } }),
      })
      assert.equal(response.status, 403)
    }
    assert.equal((await request('/api/reports/other-user-report/download', { headers: headersFor('basic') })).status, 404)
    assert.equal((await request('/api/business-action', { method: 'POST', headers: headersFor('admin') })).status, 200)
    for (let index = 0; index < 10; index += 1) assert.equal((await request('/api/protected')).status, 401)
    for (let index = 0; index < 10; index += 1) assert.equal((await request(`/api/files/private-${index}`)).status, 410)

    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC').all()
    assert.equal(rows.some((row) => row.source === 'rpc' && row.rpc_method === 'unknown.status' && row.error_code === 'RPC_METHOD_NOT_SUPPORTED'), true)
    assert.equal(rows.some((row) => row.source === 'rest' && row.error_code === 'REPORT_NOT_FOUND' && row.result === 'denied'), true)
    assert.equal(rows.some((row) => row.action === '保存测试业务' && row.source === 'rest' && row.rest_path === '/api/business-action' && row.request_id), true)
    assert.equal(rows.some((row) => row.detail.includes('not-recorded')), false)
    assert.equal(rows.filter((row) => row.error_code === 'UNAUTHORIZED').length, 8)
    assert.equal(rows.filter((row) => row.error_code === 'ENDPOINT_RETIRED').length, 8)
    assert.equal(rows.every((row) => row.request_id && row.source_address), true)

    const filtered = await request('/api/audit-logs?source=rpc&result=denied&page=1&pageSize=2', { headers: headersFor('auditor') })
    assert.equal(filtered.status, 200)
    const body = await filtered.json()
    assert.equal(body.pagination.pageSize, 2)
    assert.equal(body.pagination.total, 4)
    assert.equal(body.summary.denied, 4)
    assert.equal(body.logs.every((row) => row.source === 'rpc' && row.result === 'denied'), true)
    const legacy = await request('/api/audit-logs?limit=200', { headers: headersFor('auditor') })
    assert.equal((await legacy.json()).logs.length <= 200, true)
  } finally {
    server.close()
    await once(server, 'close')
    db.close()
  }
})
