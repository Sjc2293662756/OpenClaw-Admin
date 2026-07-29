import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { createAlertsRouter } from './alerts.js'

async function startTestServer(readAlertSource) {
  const audits = []
  const app = express()
  app.use('/alerts', createAlertsRouter({
    authMiddleware: (req, _res, next) => {
      req.user = { id: 'admin-1', username: 'admin', role: 'admin' }
      next()
    },
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
    readAlertSource,
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${server.address().port}/alerts`, audits, server }
}

test('alert list uses the formal receiver read model without changing the browser response shape', async () => {
  const context = await startTestServer(async () => ({
    alerts: [{ id: 'event-1', occurredAt: '2026-07-16T01:00:00.000Z', sourceHost: '10.0.0.8', category: 'appAlerts', severity: 'major', name: 'timeout', metrics: [] }],
    availableCount: 1,
    hasMore: false,
  }))
  try {
    const response = await fetch(`${context.baseUrl}?page=1&pageSize=10`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.alerts.length, 1)
    assert.equal(payload.alerts[0].id, 'event-1')
    assert.equal(payload.pagination.availableCount, 1)
    assert.equal(context.audits.length, 1)
  } finally {
    context.server.close()
  }
})

test('filters a historical custom range before applying the browser TOP limit', async () => {
  let receivedFilters = null
  const historicalTime = new Date('2026-07-20T01:00:00.000Z').getTime()
  const context = await startTestServer(async (_env, filters) => {
    receivedFilters = filters
    return {
      alerts: [
        { id: 'historical', occurredAt: new Date(historicalTime).toISOString(), sourceHost: '10.0.0.8', category: 'appAlerts', severity: 'major', name: 'historical alert', metrics: [] },
      ],
      availableCount: 1,
      hasMore: false,
    }
  })
  try {
    const response = await fetch(
      `${context.baseUrl}?page=1&pageSize=10&maxResults=200&startAt=${historicalTime - 1}&endAt=${historicalTime + 1}`
    )
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.alerts.length, 1)
    assert.equal(payload.alerts[0].id, 'historical')
    assert.equal(receivedFilters.startAt, historicalTime - 1)
    assert.equal(receivedFilters.endAt, historicalTime + 1)
  } finally {
    context.server.close()
  }
})

test('alert list reports an unavailable formal receiver instead of falling back to SSH log reads', async () => {
  const context = await startTestServer(async () => { throw new Error('receiver unavailable') })
  try {
    const response = await fetch(context.baseUrl)
    const payload = await response.json()
    assert.equal(response.status, 503)
    assert.equal(payload.code, 'ALERT_SOURCE_UNAVAILABLE')
  } finally {
    context.server.close()
  }
})
