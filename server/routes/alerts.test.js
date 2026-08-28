import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { createAlertsRouter } from './alerts.js'

async function startTestServer(readAlertSource, { role = 'admin', readAlertChanges } = {}) {
  const audits = []
  const app = express()
  app.use('/alerts', createAlertsRouter({
    authMiddleware: (req, _res, next) => {
      req.user = { id: 'admin-1', username: 'admin', role }
      next()
    },
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
    readAlertSource,
    readAlertChanges,
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${server.address().port}/alerts`, audits, server }
}

test('alert list uses the formal receiver read model without changing the browser response shape or adding refresh audit noise', async () => {
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
    assert.equal(context.audits.length, 0)
  } finally {
    context.server.close()
  }
})

test('alert changes returns a baseline without a cursor and replays continuous pages in cursor order', async () => {
  const calls = []
  const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
    readAlertChanges: async (_env, options) => {
      calls.push(options)
      if (options.afterSequence === null) return { events: [], latestSequence: 20, hasMore: false, historyRefreshRequired: false }
      return {
        events: [{ type: 'alert', action: 'triggered', cursor: 21, payload: { id: 'alert-21' } }],
        latestSequence: 21,
        hasMore: false,
        historyRefreshRequired: false,
      }
    },
  })
  try {
    const baseline = await fetch(`${context.baseUrl}/changes`)
    assert.equal(baseline.status, 200)
    assert.deepEqual((await baseline.json()).events, [])
    const replay = await fetch(`${context.baseUrl}/changes?afterSequence=20&limit=1`)
    assert.equal(replay.status, 200)
    assert.equal((await replay.json()).events[0].cursor, 21)
    assert.deepEqual(calls, [{ afterSequence: null, limit: 200 }, { afterSequence: 20, limit: 1 }])
  } finally {
    context.server.close()
  }
})

test('alert changes rejects basic users and invalid cursors, and reports receiver failure safely', async () => {
  const basic = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), { role: 'basic' })
  try {
    assert.equal((await fetch(`${basic.baseUrl}/changes?afterSequence=0`)).status, 403)
  } finally { basic.server.close() }

  const invalid = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }))
  try {
    assert.equal((await fetch(`${invalid.baseUrl}/changes?afterSequence=nope`)).status, 400)
  } finally { invalid.server.close() }

  const unavailable = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
    readAlertChanges: async () => { throw new Error('unavailable') },
  })
  try {
    const response = await fetch(`${unavailable.baseUrl}/changes?afterSequence=0`)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'ALERT_SOURCE_UNAVAILABLE')
  } finally { unavailable.server.close() }
})

test('alert changes permits standard, auditor and admin roles', async () => {
  for (const role of ['standard', 'auditor', 'admin']) {
    const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
      role,
      readAlertChanges: async () => ({ events: [], latestSequence: 0, hasMore: false, historyRefreshRequired: false }),
    })
    try {
      assert.equal((await fetch(`${context.baseUrl}/changes`)).status, 200)
    } finally { context.server.close() }
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

test('exact locate uses an internal business ID without changing keyword semantics and returns its chronological page', async () => {
  let receivedFilters = null
  const context = await startTestServer(async (_env, filters) => {
    receivedFilters = filters
    return {
      alerts: Array.from({ length: 12 }, (_item, index) => ({
        id: index === 1 ? 'target-internal-id' : `alert-${index}`,
        occurredAt: `2026-08-27T${String(index).padStart(2, '0')}:00:00.000Z`,
        severity: '重大', category: 'appAlerts', name: `alert-${index}`, metrics: [],
      })),
      availableCount: 12,
      hasMore: false,
    }
  })
  try {
    const response = await fetch(`${context.baseUrl}?locateId=target-internal-id&pageSize=2&maxResults=2`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(receivedFilters, {})
    assert.equal(payload.pagination.page, 2)
    assert.equal(payload.pagination.maxResults, 12)
    assert.equal(payload.alerts[0].id, 'target-internal-id')
  } finally { context.server.close() }
})
