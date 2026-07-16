import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import { createGAIOPServiceRouter } from './gaiop-service.js'

async function startTestServer() {
  let savedInput = null
  const audits = []
  const app = express()
  app.use(express.json())
  app.use('/service', createGAIOPServiceRouter({
    adminMiddleware: (req, _res, next) => {
      req.user = { id: 'admin-1', username: 'admin', role: 'admin' }
      next()
    },
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
    getServiceConfig: () => ({
      endpoint: 'ws://127.0.0.1:3003',
      accessTokenConfigured: true,
      state: 'disconnected',
    }),
    saveServiceConfig: (input) => {
      savedInput = input
      return {
        endpoint: input.endpoint,
        accessTokenConfigured: true,
        state: 'disconnected',
      }
    },
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}/service`, audits, getSavedInput: () => savedInput, server }
}

test('GAIOP service configuration never returns the access token', async () => {
  const context = await startTestServer()
  try {
    const response = await fetch(context.baseUrl)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.service.accessTokenConfigured, true)
    assert.equal(Object.hasOwn(payload.service, 'accessToken'), false)
  } finally {
    context.server.close()
  }
})

test('GAIOP service configuration validates endpoint and audits redacted token updates', async () => {
  const context = await startTestServer()
  try {
    const invalid = await fetch(context.baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://invalid.example' }),
    })
    assert.equal(invalid.status, 400)

    const token = 'test-only-token-value'
    const valid = await fetch(context.baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'ws://127.0.0.1:3003', accessToken: token }),
    })
    const payload = await valid.json()
    assert.equal(valid.status, 200)
    assert.equal(payload.service.endpoint, 'ws://127.0.0.1:3003')
    assert.equal(JSON.stringify(payload).includes(token), false)
    assert.equal(context.getSavedInput().accessToken, token)
    assert.equal(context.audits[0].detail.includes(token), false)
    assert.match(context.audits[0].detail, /已更新/)
  } finally {
    context.server.close()
  }
})
