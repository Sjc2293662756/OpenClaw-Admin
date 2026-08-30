import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { FORMAL_RPC_METHODS, createBasicWorkspaceOnlyMiddleware, createInitialAdminMiddleware, createRoleMiddleware, getRpcPermissionDecision, isBasicWorkspaceApiRequest, isReadOnlyRpcMethod, rpcPermissionMiddleware } from './permissions.js'

test('RPC permission matrix keeps privileged writes and sensitive reads restricted', () => {
  assert.equal(getRpcPermissionDecision({ role: 'admin' }, 'config.set').allowed, true)

  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'chat.send').allowed, true)
  const standardConfig = getRpcPermissionDecision({ role: 'standard' }, 'config.set')
  assert.equal(standardConfig.allowed, false)
  assert.equal(standardConfig.code, 'STANDARD_ROLE_RESTRICTED')

  const auditorWrite = getRpcPermissionDecision({ role: 'auditor' }, 'chat.send')
  assert.equal(auditorWrite.allowed, false)
  assert.equal(auditorWrite.code, 'AUDITOR_READ_ONLY')

  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'chat.send').allowed, true)

  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'status').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'sessions.history').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'logs.tail').allowed, false)
})

test('first-stage role matrix restricts management reads and all delegated writes', () => {
  assert.equal(getRpcPermissionDecision({ role: 'auditor' }, 'cron.list').allowed, true)
  assert.equal(getRpcPermissionDecision({ role: 'standard' }, 'cron.list').allowed, false)
  assert.equal(getRpcPermissionDecision({ role: 'basic' }, 'cron.list').allowed, false)

  for (const method of ['channels.status', 'channels.list', 'plugins.list', 'plugins.status']) {
    assert.equal(getRpcPermissionDecision({ role: 'auditor' }, method).allowed, true)
    assert.equal(getRpcPermissionDecision({ role: 'standard' }, method).allowed, true)
    const basicDecision = getRpcPermissionDecision({ role: 'basic' }, method)
    assert.equal(basicDecision.allowed, false)
    assert.equal(basicDecision.code, 'BASIC_WORKSPACE_ONLY')
  }

  for (const method of ['skills.list', 'skills.status']) {
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

test('basic and standard users can request workspace deletion while ownership remains enforced separately', () => {
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

test('unknown read-like RPC names are denied for every role including administrator', () => {
  for (const role of ['basic', 'standard', 'auditor', 'admin']) {
    for (const method of [
      'unknown.list',
      'unknown.get',
      'unknown.status',
      'gaiop.weixin.status',
      'gaiop.weixin.qr.start',
      'gaiop.weixin.account.delete',
    ]) {
      const decision = getRpcPermissionDecision({ role }, method)
      assert.equal(decision.allowed, false, `${role} ${method}`)
      assert.equal(decision.code, 'RPC_METHOD_NOT_SUPPORTED')
    }
  }

  const basicMethods = new Set([
    'sessions.list', 'session.list', 'sessions.get', 'session.get',
    'sessions.history', 'session.history', 'chat.history', 'sessions.usage', 'usage.sessions',
    'sessions.delete', 'session.delete', 'status', 'health',
    'agent', 'chat.send', 'chat.abort', 'agent.abort',
  ])
  const standardMethods = new Set([
    ...basicMethods,
    'agent', 'chat.send', 'chat.abort', 'agent.abort',
    'sessions.reset', 'session.reset', 'sessions.spawn', 'session.spawn',
    'sessions.send', 'session.send', 'sessions.patch', 'session.patch',
    'channels.status', 'channels.list', 'channel.list', 'channel.status',
    'plugins.list', 'plugin.list', 'plugins.status', 'plugin.status',
    'skills.status', 'skills.list', 'system-presence', 'node.list', 'config.get',
  ])
  const auditorMethods = new Set([
    'sessions.list', 'session.list', 'sessions.get', 'session.get',
    'sessions.history', 'session.history', 'chat.history', 'sessions.usage', 'usage.sessions',
    'usage.cost', 'cost.usage', 'status', 'health', 'system-presence', 'node.list',
    'channels.status', 'channels.list', 'channel.list', 'channel.status',
    'plugins.list', 'plugin.list', 'plugins.status', 'plugin.status',
    'skills.status', 'skills.list',
    'cron.list', 'crons.list', 'schedule.list', 'schedules.list',
    'cron.status', 'crons.status', 'schedule.status', 'schedules.status',
    'cron.runs', 'crons.runs', 'cron.history', 'crons.history',
  ])
  for (const method of FORMAL_RPC_METHODS) {
    assert.equal(getRpcPermissionDecision({ role: 'admin' }, method).allowed, true, `admin ${method}`)
    assert.equal(getRpcPermissionDecision({ role: 'basic' }, method).allowed, basicMethods.has(method), `basic ${method}`)
    assert.equal(getRpcPermissionDecision({ role: 'standard' }, method).allowed, standardMethods.has(method), `standard ${method}`)
    assert.equal(getRpcPermissionDecision({ role: 'auditor' }, method).allowed, auditorMethods.has(method), `auditor ${method}`)
  }
})

test('basic REST boundary allows workspace transport, alert reads/preferences, and personal report reads', () => {
  const basic = { id: 'basic-1', role: 'basic' }
  const standard = { id: 'standard-1', role: 'standard' }
  for (const [method, path] of [
    ['POST', '/api/rpc'],
    ['POST', '/api/workspace/sessions'],
    ['GET', '/api/events'],
    ['GET', '/api/media?path=image.png'],
    ['GET', '/api/alerts?page=1'],
    ['GET', '/api/alerts/time'],
    ['GET', '/api/alerts/changes?afterSequence=1'],
    ['GET', '/api/alerts/preferences'],
    ['PUT', '/api/alerts/preferences'],
    ['GET', '/api/reports?sourceSessionId=owned'],
    ['GET', '/api/reports/owned-report/download'],
    ['GET', '/api/reports/owned-report/preview'],
    ['PUT', '/api/users/basic-1/password'],
  ]) {
    assert.equal(isBasicWorkspaceApiRequest(basic, method, path), true, `${method} ${path}`)
  }
  for (const [method, path] of [
    ['GET', '/api/dashboard/summary'],
    ['POST', '/api/alerts/export'],
    ['GET', '/api/reports/retention/recovery'],
    ['DELETE', '/api/reports/owned-report'],
    ['GET', '/api/channels/config'],
    ['GET', '/api/system-settings/sessions'],
    ['PUT', '/api/users/other-user/password'],
  ]) {
    assert.equal(isBasicWorkspaceApiRequest(basic, method, path), false, `${method} ${path}`)
  }
  assert.equal(isBasicWorkspaceApiRequest(standard, 'GET', '/api/reports'), true)
})

test('basic REST middleware rejects direct management requests and preserves health', async () => {
  const app = express()
  app.use(express.json())
  const authMiddleware = (req, _res, next) => {
    req.user = { id: 'basic-1', role: req.get('x-test-role') || 'basic' }
    next()
  }
  app.use('/api', createBasicWorkspaceOnlyMiddleware(authMiddleware))
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.post('/api/rpc', (_req, res) => res.json({ ok: true }))
  app.get('/api/reports', (_req, res) => res.json({ ok: true }))
  app.get('/api/reports/:id/download', (_req, res) => res.json({ ok: true }))
  app.get('/api/reports/:id/preview', (_req, res) => res.json({ ok: true }))
  app.get('/api/alerts', (_req, res) => res.json({ ok: true }))
  app.get('/api/alerts/time', (_req, res) => res.json({ ok: true }))
  app.get('/api/alerts/changes', (_req, res) => res.json({ ok: true }))
  app.get('/api/alerts/preferences', (_req, res) => res.json({ ok: true }))
  app.put('/api/alerts/preferences', (_req, res) => res.json({ ok: true }))
  app.post('/api/alerts/export', (_req, res) => res.json({ ok: true }))
  app.put('/api/users/:id/password', (_req, res) => res.json({ ok: true }))

  const server = app.listen(0)
  await once(server, 'listening')
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/rpc`, { method: 'POST' })).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/reports?sourceSessionId=owned`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/reports/owned-report/download`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/reports/owned-report/preview`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/alerts`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/alerts/time`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/alerts/changes`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/alerts/preferences`)).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/alerts/preferences`, { method: 'PUT' })).status, 200)
    const denied = await fetch(`${baseUrl}/api/alerts/export`, { method: 'POST' })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).code, 'BASIC_WORKSPACE_ONLY')
    assert.equal((await fetch(`${baseUrl}/api/users/basic-1/password`, { method: 'PUT' })).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/users/other/password`, { method: 'PUT' })).status, 403)
    assert.equal((await fetch(`${baseUrl}/api/reports`, { headers: { 'x-test-role': 'standard' } })).status, 200)
  } finally {
    server.close()
    await once(server, 'close')
  }
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

test('initial administrator middleware rejects ordinary administrators', async () => {
  const app = express()
  const authMiddleware = (req, _res, next) => {
    req.user = {
      id: 'test-user',
      role: req.get('x-test-role') || 'basic',
      isInitialAdmin: req.get('x-test-initial-admin') === 'true',
    }
    next()
  }
  app.put('/branding', createInitialAdminMiddleware(authMiddleware), (_req, res) => res.json({ ok: true }))

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/branding`
  try {
    const ordinaryAdmin = await fetch(url, { method: 'PUT', headers: { 'x-test-role': 'admin' } })
    assert.equal(ordinaryAdmin.status, 403)
    assert.equal((await ordinaryAdmin.json()).code, 'INITIAL_ADMIN_REQUIRED')
    assert.equal((await fetch(url, {
      method: 'PUT',
      headers: { 'x-test-role': 'admin', 'x-test-initial-admin': 'true' },
    })).status, 200)
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('direct /api/rpc requests cannot bypass the registered method and role matrix', async () => {
  const app = express()
  app.use(express.json())
  app.post('/api/rpc', (req, _res, next) => {
    req.user = { role: req.get('x-test-role') || 'basic' }
    next()
  }, rpcPermissionMiddleware, (_req, res) => res.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/api/rpc`
  const call = (role, method) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-role': role },
    body: JSON.stringify({ method }),
  })
  try {
    assert.equal((await call('standard', 'chat.send')).status, 200)
    assert.equal((await call('standard', 'skills.update')).status, 403)
    assert.equal((await call('auditor', 'chat.send')).status, 403)
    assert.equal((await call('admin', 'unknown.status')).status, 403)
    assert.equal((await call('admin', '')).status, 400)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
