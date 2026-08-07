import assert from 'node:assert/strict'
import test from 'node:test'
import { createPersonalWechatRuntime } from './personal-wechat-runtime.js'

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  }
}

function createFetchStub(handler) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({
      url: String(url),
      method: options?.method || 'GET',
      body: options?.body,
      headers: options?.headers || {},
    })
    return handler(url, options)
  }
  return { calls, fetchImpl }
}

test('personal WeChat runtime calls only the local loopback adapter surface', async () => {
  const { calls, fetchImpl } = createFetchStub((url, options) => {
    if (url.endsWith('/status')) {
      return jsonResponse(200, {
        available: true,
        version: '2.4.4',
        channelEnabled: false,
        accounts: [{
          accountId: 'wx-account-one',
          userId: 'wx-user-one',
          enabled: true,
          configured: true,
          token: 'must-not-leak',
        }],
      })
    }
    if (url.endsWith('/qr/start')) {
      return jsonResponse(200, {
        sessionKey: 'login-one',
        status: 'waiting_for_scan',
        qrcodeUrl: 'qr-private-text',
        expiresAtMs: Date.now() + 60_000,
      })
    }
    if (url.endsWith('/qr/wait')) {
      return jsonResponse(200, {
        sessionKey: 'login-one',
        status: 'connected',
        accountId: 'wx-account-one',
        userId: 'wx-user-one',
      })
    }
    if (url.endsWith('/channel/enabled')) {
      const body = JSON.parse(options?.body || '{}')
      return jsonResponse(200, { ok: true, enabled: body.enabled })
    }
    if (url.includes('/accounts/wx-account-one/enabled')) {
      return jsonResponse(200, { accountId: 'wx-account-one', enabled: false, configured: true })
    }
    if (url.endsWith('/accounts/wx-account-one')) {
      return jsonResponse(200, { accountId: 'wx-account-one', deleted: true })
    }
    throw new Error(`unexpected adapter call ${url}`)
  })
  const runtime = createPersonalWechatRuntime({
    adapterBaseUrl: 'http://127.0.0.1:19091',
    adapterToken: 'adapter-token-test',
    fetchImpl,
  })

  const status = await runtime.getStatus()
  assert.equal(status.available, true)
  assert.equal(status.channelEnabled, false)
  assert.equal(status.accounts[0].running, undefined)
  assert.equal(status.accounts[0].lastErrorCode, undefined)
  assert.equal(JSON.stringify(status).includes('must-not-leak'), false)

  const started = await runtime.startQr()
  assert.equal(started.loginId, 'login-one')
  assert.equal(started.status, 'waiting')
  assert.equal(started.qrText, 'qr-private-text')
  assert.equal((await runtime.waitQr(started.loginId)).accountId, 'wx-account-one')
  assert.equal((await runtime.setAccountEnabled('wx-account-one', false)).enabled, false)
  assert.deepEqual(await runtime.setChannelEnabled(false), { enabled: false })
  assert.deepEqual(await runtime.deleteAccount('wx-account-one'), { accountId: 'wx-account-one', deleted: true })

  assert.deepEqual(calls.map((item) => `${item.method} ${item.url}`), [
    'GET http://127.0.0.1:19091/status',
    'POST http://127.0.0.1:19091/qr/start',
    'POST http://127.0.0.1:19091/qr/wait',
    'PUT http://127.0.0.1:19091/accounts/wx-account-one/enabled',
    'PUT http://127.0.0.1:19091/channel/enabled',
    'DELETE http://127.0.0.1:19091/accounts/wx-account-one',
  ])
  for (const call of calls) {
    assert.equal(call.headers['X-GAIOP-Weixin-Token'], 'adapter-token-test')
  }
  assert.equal(calls.some((item) => /install|update|uninstall|npm|npx|plugin/i.test(item.url)), false)
})

test('personal WeChat runtime does not send an invalid verification code to the adapter', async () => {
  let callCount = 0
  const runtime = createPersonalWechatRuntime({
    adapterBaseUrl: 'http://127.0.0.1:19091',
    fetchImpl: async () => {
      callCount += 1
      throw new Error('must not be called')
    },
  })
  await assert.rejects(
    runtime.verifyQr('login-one', 'code with spaces'),
    (error) => error.code === 'PERSONAL_WECHAT_VERIFICATION_CODE_INVALID',
  )
  assert.equal(callCount, 0)
})

test('personal WeChat runtime maps an unreachable adapter without leaking raw details', async () => {
  const runtime = createPersonalWechatRuntime({
    adapterBaseUrl: 'http://127.0.0.1:19091',
    fetchImpl: async () => {
      const error = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:19091 private-detail')
      throw error
    },
  })
  await assert.rejects(runtime.getStatus(), (error) => {
    assert.equal(error.code, 'GATEWAY_UNAVAILABLE')
    assert.equal(error.message.includes('private-detail'), false)
    return true
  })
})

test('personal WeChat runtime maps adapter error payloads to safe error codes', async () => {
  const { fetchImpl } = createFetchStub(() => jsonResponse(404, {
    ok: false,
    error: { code: 'PERSONAL_WECHAT_ACCOUNT_NOT_FOUND', message: '个人微信账号不存在' },
  }))
  const runtime = createPersonalWechatRuntime({ adapterBaseUrl: 'http://127.0.0.1:19091', fetchImpl })
  await assert.rejects(runtime.deleteAccount('missing-account'), (error) => {
    assert.equal(error.code, 'PERSONAL_WECHAT_ACCOUNT_NOT_FOUND')
    return true
  })
})
