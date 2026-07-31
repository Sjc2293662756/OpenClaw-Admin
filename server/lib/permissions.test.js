import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { createRoleMiddleware, getRpcPermissionDecision, isReadOnlyRpcMethod } from './permissions.js'

test('RPC permission matrix keeps privileged writes and sensitive reads restricted', () => {
  assert.equal(getRpcPermissionDecision({ role: 'admin' }, 'config.set').allowed, true)

  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'chat.send').allowed, true)
  const standardConfig = getRpcPermissionDecision({ role: 'standard' }, 'config.set')
  assert.equal(standardConfig.allowed, false)
  assert.equal(standardConfig.code, 'STANDARD_ROLE_RESTRICTED')

  const auditorWrite = getRpcPermissionDecision({ role: 'auditor' }, 'chat.send')
  assert.equal(auditorWrite.allowed, false)
  assert.equal(auditorWrite.code, 'AUDITOR_READ_ONLY')

  const basicWrite = getRpcPermissionDecision({ role: 'basic' }, 'chat.send')
  assert.equal(basicWrite.allowed, false)
  assert.equal(basicWrite.code, 'BASIC_READ_ONLY')

  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'status').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'sessions.history').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'logs.tail').allowed, false)
})

test('first-stage role matrix restricts management reads and all delegated writes', () => {
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'cron.list').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'cron.list').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'cron.list').allowed, false)

  for (const method of ['skills.list', 'channels.status', 'plugins.list']) {
    assert.equal(getRpcPermissionDecision({ role: 'auditor' }, method).allowed, true)
    assert.equal(getRpcPermissionDecision({ role: 'standard' }, method).allowed, true)
    assert.equal(getRpcPermissionDecision({ role: 'basic' }, method).allowed, false)
  }

  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'config.get').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'config.get').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'models.list').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'agents.list').allowed, false)

  for (const method of [
    'skills.install',
    'skills.update',
    'agent.model.set',
    'cron.add',
    'cron.update',
    'cron.run',
    'cron.delete',
  ]) {
    assert.equal(getRpcPermissionDecision({ role: 'standard' }, method).allowed, false)
    assert.equal(getRpcPermissionDecision({ role: 'auditor' }, method).allowed, false)
    assert.equal(getRpcPermissionDecision({ role: 'admin' }, method).allowed, true)
  }
})

test('basic and standard users can request deletion while ownership remains enforced separately', () => {
  for (const method of ['sessions.delete', 'session.delete']) {
    assert.equal(getRpcPermissionDecision({ role: 'admin' }, method).allowed, true)
    assert.equal(getRpcPermissionDecision({ role: 'basic' }, method).allowed, true)
    assert.equal(getRpcPermissionDecision({ role: 'standard' }, method).allowed, true)
    const auditorDecision = getRpcPermissionDecision({ role: 'auditor' }, method)
    assert.equal(auditorDecision.allowed, false)
    assert.equal(auditorDecision.code, 'AUDITOR_READ_ONLY')
  }
})

test('system monitor RPC is unavailable to basic users', () => {
  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'status').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'node.list').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'node.list').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'system-presence').allowed, true)
})

test('global cost usage is limited to auditor and administrator', () => {
  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'usage.cost').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'cost.usage').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'usage.cost').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'admin' }, 'usage.cost').allowed, true)
})

test('read-only RPC classification is explicit and rejects unsafe lookalikes', () => {
  assert.equal(isReadOnlyRpcMethod('sessions.get'), true)
  assert.equal(isReadOnlyRpcMethod('config.get'), true)
  assert.equal(isReadOnlyRpcMethod('logs.tail'), false)
  assert.equal(isReadOnlyRpcMethod('session.export'), false)
  assert.equal(isReadOnlyRpcMethod('config.set'), false)
  assert.equal(isReadOnlyRpcMethod(''), false)
})

test('HTTP role middleware rejects direct privileged requests', async () => {
  const app = express()
  const authMiddleware = (req, _res, next) => {
    req.user = { id: 'test-user', role: req.get('x-test-role') || 'basic' }
    next()
  }
  const adminMiddleware = createRoleMiddleware(authMiddleware, ['admin'], '仅管理员可以执行此操作')
  const operatorMiddleware = createRoleMiddleware(authMiddleware, ['standard', 'admin'], '当前用户仅有查看权限，不能执行此操作')
  app.post('/admin-only', adminMiddleware, (_req, res) => res.json({ ok: true }))
  app.post('/operator', operatorMiddleware, (_req, res) => res.json({ ok: true }))

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const basicAdmin = await fetch(`${baseUrl}/admin-only`, { method: 'POST', headers: { 'x-test-role': 'basic' } })
    assert.equal(basicAdmin.status, 403)
    assert.equal((await basicAdmin.json()).code, 'PERMISSION_DENIED')

    assert.equal((await fetch(`${baseUrl}/operator`, { method: 'POST', headers: { 'x-test-role': 'standard' } })).status, 200)
    assert.equal((await fetch(`${baseUrl}/operator`, { method: 'POST', headers: { 'x-test-role': 'auditor' } })).status, 403)
    assert.equal((await fetch(`${baseUrl}/admin-only`, { method: 'POST', headers: { 'x-test-role': 'admin' } })).status, 200)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
