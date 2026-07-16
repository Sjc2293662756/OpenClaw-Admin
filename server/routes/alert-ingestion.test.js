import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import { createAlertIngestionRouter } from './alert-ingestion.js'

function createDb() {
  let row = null
  return {
    prepare: () => ({
      get: () => row,
      run: (enabled, updatedAt) => { row = { enabled, updated_at: updatedAt } },
    }),
  }
}

async function startTestServer() {
  const audits = []
  const app = express()
  app.use(express.json())
  app.use('/ingestion', createAlertIngestionRouter({
    db: createDb(),
    adminMiddleware: (req, _res, next) => {
      req.user = { id: 'admin-1', username: 'admin', role: 'admin' }
      next()
    },
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
    readRuntime: async () => ({ state: 'failed', receiver: 'unavailable', lastReceivedAt: null, lastErrorCode: 'ALERT_RECEIVER_UNAVAILABLE' }),
    applyRuntime: async () => ({ state: 'failed', receiver: 'unavailable', lastReceivedAt: null, lastErrorCode: 'ALERT_RECEIVER_APPLY_FAILED' }),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${server.address().port}/ingestion`, audits, server }
}

test('alert ingestion configuration defaults to Syslog UDP 514 and reports a failed local bridge when the tunnel is absent', async () => {
  const context = await startTestServer()
  try {
    const response = await fetch(context.baseUrl)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(payload.settings, { enabled: true, protocol: 'udp', port: 514, updatedAt: null })
    assert.equal(payload.runtime.state, 'failed')
    assert.equal(payload.runtime.receiver, 'unavailable')
  } finally {
    context.server.close()
  }
})

test('alert ingestion configuration saves only the enabled target and audits no sensitive values', async () => {
  const context = await startTestServer()
  try {
    const response = await fetch(context.baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.settings.enabled, false)
    assert.equal(payload.runtime.state, 'failed')
    assert.equal(context.audits.length, 1)
    assert.match(context.audits[0].detail, /目标：停用/)
  } finally {
    context.server.close()
  }
})

test('alert ingestion configuration rejects non-boolean enabled values', async () => {
  const context = await startTestServer()
  try {
    const response = await fetch(context.baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'true' }),
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.equal(payload.code, 'ALERT_INGESTION_CONFIG_INVALID')
  } finally {
    context.server.close()
  }
})
