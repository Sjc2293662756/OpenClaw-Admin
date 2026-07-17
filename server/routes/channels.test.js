import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { createChannelsRouter } from './channels.js'

async function startTestServer() {
  const calls = []
  const audits = []
  const raw = JSON.stringify({
    channels: {
      feishu: { appId: 'existing-feishu-app', appSecret: 'existing-feishu-secret' },
      wecom: { botId: 'bot-public', secret: 'old-private-value' },
    },
    plugins: {
      allow: ['wecom-openclaw-plugin'],
      entries: {
        'wecom-openclaw-plugin': { enabled: true, config: { privateToken: 'must-not-leak' } },
      },
    },
  })
  const gateway = {
    isConnected: true,
    async call(method, params) {
      calls.push({ method, params })
      if (method === 'config.get') return { exists: true, hash: 'snapshot-hash', raw }
      if (method === 'config.patch') return { ok: true }
      throw new Error(`unexpected method ${method}`)
    },
  }
  const app = express()
  app.use(express.json())
  const asUser = (role) => (req, _res, next) => {
    req.user = { id: `${role}-1`, username: role, role }
    next()
  }
  app.use('/channels', createChannelsRouter({
    authMiddleware: asUser('standard'),
    adminMiddleware: asUser('admin'),
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
    gateway,
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}/channels`, calls, audits, server }
}

test('channel config read masks existing credentials', async () => {
  const context = await startTestServer()
  try {
    const response = await fetch(`${context.baseUrl}/config`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.config.channels.wecom.botId, 'bot-public')
    assert.equal(payload.config.channels.wecom.secret, '******')
    assert.equal(JSON.stringify(payload).includes('old-private-value'), false)
    assert.equal(JSON.stringify(payload).includes('must-not-leak'), false)
    assert.deepEqual(payload.config.plugins, {
      allow: ['wecom-openclaw-plugin'],
      entries: { 'wecom-openclaw-plugin': { enabled: true } },
    })
  } finally {
    context.server.close()
  }
})

test('channel config write sends a scoped merge patch and audits no credential value', async () => {
  const context = await startTestServer()
  try {
    const newSecret = 'new-private-value'
    const response = await fetch(`${context.baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patches: [
        { path: 'channels.wecom.enabled', value: true },
        { path: 'channels.wecom.secret', value: newSecret },
        { path: 'channels.dingtalk-connector.clientId', value: 'public-client-id' },
        { path: 'channels.dingtalk-connector.dmPolicy', value: 'pairing' },
        { path: 'channels.feishu.dmPolicy', value: 'pairing' },
        { path: 'channels.wecom.dmPolicy', value: 'allowlist' },
      ] }),
    })
    const payload = await response.json()
    const patchCall = context.calls.find((item) => item.method === 'config.patch')
    const rawPatch = JSON.parse(patchCall.params.raw)

    assert.equal(response.status, 200)
    assert.equal(payload.saved, true)
    assert.equal(patchCall.params.baseHash, 'snapshot-hash')
    assert.equal(rawPatch.channels.wecom.secret, newSecret)
    assert.equal(rawPatch.channels['dingtalk-connector'].clientId, 'public-client-id')
    assert.equal(rawPatch.channels['dingtalk-connector'].dmPolicy, 'open')
    assert.equal(rawPatch.channels.feishu.dmPolicy, 'open')
    assert.equal(rawPatch.channels.wecom.dmPolicy, 'open')
    assert.equal(JSON.stringify(context.audits).includes(newSecret), false)
  } finally {
    context.server.close()
  }
})

test('channel config rejects mask values and non-channel paths', async () => {
  const context = await startTestServer()
  try {
    for (const patch of [
      { path: 'channels.wecom.secret', value: '******' },
      { path: 'models.providers.example.apiKey', value: 'value' },
    ]) {
      const response = await fetch(`${context.baseUrl}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patches: [patch] }),
      })
      assert.equal(response.status, 400)
    }
  } finally {
    context.server.close()
  }
})

test('Feishu QR onboarding rejects creation of a second app when an existing app is configured', async () => {
  const context = await startTestServer()
  try {
    const response = await fetch(`${context.baseUrl}/feishu/onboarding`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appName: 'GAIOP 智能助手', replaceExisting: true }),
    })
    const payload = await response.json()

    assert.equal(response.status, 409)
    assert.equal(payload.code, 'FEISHU_ONBOARDING_EXISTING_APP_MANUAL_CONFIG_REQUIRED')
    assert.equal(JSON.stringify(payload).includes('existing-feishu-secret'), false)
    assert.equal(context.calls.some((item) => item.method === 'config.patch'), false)
  } finally {
    context.server.close()
  }
})
