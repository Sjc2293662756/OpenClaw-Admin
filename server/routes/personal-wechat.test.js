import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import { migratePersonalWechatMetadata } from '../lib/personal-wechat-metadata.js'
import { createPersonalWechatOnboarding } from '../lib/personal-wechat-onboarding.js'
import { createPersonalWechatMetadataStore } from '../lib/personal-wechat-metadata.js'
import { createPersonalWechatRouter } from './personal-wechat.js'

function deferred() {
  let resolve
  const promise = new Promise((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function startTestServer() {
  const db = new Database(':memory:')
  migratePersonalWechatMetadata(db)
  const metadataStore = createPersonalWechatMetadataStore(db)
  const calls = []
  const audits = []
  const wait = deferred()
  const runtimeAccounts = new Map()
  const runtime = {
    async getStatus() {
      calls.push({ method: 'status' })
      return { available: true, version: 'test-version', accounts: Array.from(runtimeAccounts.values()) }
    },
    async startQr() {
      calls.push({ method: 'qr.start' })
      return {
        loginId: 'private-login-id',
        status: 'waiting',
        qrText: 'private-qr-text',
        expiresAt: Date.now() + 60_000,
      }
    },
    async waitQr() {
      calls.push({ method: 'qr.wait' })
      const result = await wait.promise
      runtimeAccounts.set(result.accountId, {
        accountId: result.accountId,
        wechatId: result.wechatId,
        enabled: true,
        configured: true,
        running: true,
      })
      return result
    },
    async cancelQr(loginId) {
      calls.push({ method: 'qr.cancel', loginId })
      return { loginId, status: 'canceled' }
    },
    async verifyQr(loginId) {
      calls.push({ method: 'qr.verify', loginId })
      return { loginId, status: 'waiting' }
    },
    async setAccountEnabled(accountId, enabled) {
      calls.push({ method: 'account.setEnabled', accountId, enabled })
      const current = runtimeAccounts.get(accountId)
      const updated = { ...current, accountId, enabled, running: enabled }
      runtimeAccounts.set(accountId, updated)
      return updated
    },
    async deleteAccount(accountId) {
      calls.push({ method: 'account.delete', accountId })
      runtimeAccounts.delete(accountId)
      return { accountId, deleted: true }
    },
  }
  const onboarding = createPersonalWechatOnboarding({
    runtime,
    metadataStore,
    toDataUrl: async () => 'data:image/png;base64,safe-qr-image',
    onConnected: ({ actor, account }) => audits.push({
      actor,
      action: '完成个人微信扫码接入',
      target: account.accountId,
      detail: `账户名称：${account.displayName}`,
    }),
  })

  const app = express()
  app.use(express.json())
  const adminMiddleware = (req, res, next) => {
    const role = req.get('x-test-role') || 'standard'
    req.user = {
      id: req.get('x-test-user-id') || `${role}-1`,
      username: role,
      role,
    }
    if (role !== 'admin') return res.status(403).json({ ok: false, code: 'PERMISSION_DENIED' })
    next()
  }
  app.use('/personal-wechat', createPersonalWechatRouter({
    db,
    adminMiddleware,
    metadataStore,
    runtime,
    onboarding,
    recordAudit: (actor, action, target, detail) => audits.push({ actor, action, target, detail }),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    db,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/personal-wechat`,
    calls,
    audits,
    wait,
    runtimeAccounts,
  }
}

test('personal WeChat REST is admin-only, owner-bound, no-store and never projects login secrets', async () => {
  const context = await startTestServer()
  try {
    const denied = await fetch(context.baseUrl, { headers: { 'x-test-role': 'standard' } })
    assert.equal(denied.status, 403)
    assert.equal(context.calls.length, 0)

    const startedResponse = await fetch(`${context.baseUrl}/onboarding`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-role': 'admin',
        'x-test-user-id': 'admin-one',
      },
      body: JSON.stringify({ displayName: '杨硕微信', note: '管理备注' }),
    })
    const started = await startedResponse.json()
    assert.equal(startedResponse.status, 200)
    assert.equal(startedResponse.headers.get('cache-control'), 'no-store, private')
    assert.equal(started.session.status, 'waiting_for_scan')
    assert.equal(started.session.qrDataUrl, 'data:image/png;base64,safe-qr-image')
    assert.equal(JSON.stringify(started).includes('private-login-id'), false)
    assert.equal(JSON.stringify(started).includes('private-qr-text'), false)

    const otherOwner = await fetch(`${context.baseUrl}/onboarding/${started.session.id}`, {
      headers: { 'x-test-role': 'admin', 'x-test-user-id': 'admin-two' },
    })
    assert.equal(otherOwner.status, 404)

    context.wait.resolve({
      loginId: 'private-login-id',
      status: 'connected',
      accountId: 'wx-account-one',
      wechatId: 'wx-user-one',
    })
    await nextTurn()
    const completedResponse = await fetch(`${context.baseUrl}/onboarding/${started.session.id}`, {
      headers: { 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
    })
    const completed = await completedResponse.json()
    assert.equal(completed.session.status, 'success')
    assert.equal(completed.session.accountId, 'wx-account-one')
    assert.equal(completed.session.qrDataUrl, undefined)

    const collectionResponse = await fetch(context.baseUrl, {
      headers: { 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
    })
    const collection = await collectionResponse.json()
    assert.deepEqual(collection.plugin, {
      installed: true,
      available: true,
      version: 'test-version',
    })
    assert.equal(collection.accounts.length, 1)
    assert.deepEqual(collection.accounts[0], {
      accountId: 'wx-account-one',
      displayName: '杨硕微信',
      note: '管理备注',
      wechatId: 'wx-user-one',
      enabled: true,
      status: 'online',
    })
    assert.equal(JSON.stringify(context.audits).includes('private-login-id'), false)
    assert.equal(JSON.stringify(context.audits).includes('private-qr-text'), false)
  } finally {
    context.server.close()
    context.db.close()
  }
})

test('personal WeChat enable, disable and delete target only one account and never manage the plugin lifecycle', async () => {
  const context = await startTestServer()
  try {
    await fetch(`${context.baseUrl}/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
      body: JSON.stringify({ displayName: '售后微信' }),
    })
    context.wait.resolve({
      loginId: 'private-login-id',
      status: 'connected',
      accountId: 'wx-account-one',
      wechatId: 'wx-user-one',
    })
    await nextTurn()

    const disabledResponse = await fetch(`${context.baseUrl}/accounts/wx-account-one/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
      body: JSON.stringify({ enabled: false }),
    })
    const disabled = await disabledResponse.json()
    assert.equal(disabledResponse.status, 200)
    assert.equal(disabled.account.enabled, false)
    assert.equal(disabled.account.status, 'disabled')

    const enabledResponse = await fetch(`${context.baseUrl}/accounts/wx-account-one/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(enabledResponse.status, 200)
    const enabled = await enabledResponse.json()
    assert.equal(enabled.account.enabled, true)
    assert.notEqual(enabled.account.status, 'error')
    assert.equal(enabled.account.status, 'online')

    const deletedResponse = await fetch(`${context.baseUrl}/accounts/wx-account-one`, {
      method: 'DELETE',
      headers: { 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
    })
    const deleted = await deletedResponse.json()
    assert.deepEqual(deleted, { ok: true, deleted: true, accountId: 'wx-account-one' })

    const accountCalls = context.calls.filter((item) => item.method.startsWith('account.'))
    assert.deepEqual(accountCalls, [
      { method: 'account.setEnabled', accountId: 'wx-account-one', enabled: false },
      { method: 'account.setEnabled', accountId: 'wx-account-one', enabled: true },
      { method: 'account.delete', accountId: 'wx-account-one' },
    ])
    assert.equal(context.calls.some((item) => /install|update|uninstall|npm|npx/i.test(item.method)), false)
  } finally {
    context.server.close()
    context.db.close()
  }
})

test('personal WeChat shows unknown (not offline) when Gateway runtime state is unavailable', async () => {
  const context = await startTestServer()
  try {
    await fetch(`${context.baseUrl}/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
      body: JSON.stringify({ displayName: '状态测试' }),
    })
    context.wait.resolve({
      loginId: 'private-login-id',
      status: 'connected',
      accountId: 'wx-account-one',
      wechatId: 'wx-user-one',
    })
    await nextTurn()

    // Adapter-only snapshot without a running flag (Gateway status merge failed).
    context.runtimeAccounts.set('wx-account-one', {
      accountId: 'wx-account-one',
      enabled: true,
      configured: true,
    })

    const collectionResponse = await fetch(context.baseUrl, {
      headers: { 'x-test-role': 'admin', 'x-test-user-id': 'admin-one' },
    })
    const collection = await collectionResponse.json()
    assert.equal(collection.accounts[0].status, 'unknown')
    assert.notEqual(collection.accounts[0].status, 'offline')
  } finally {
    context.server.close()
    context.db.close()
  }
})
