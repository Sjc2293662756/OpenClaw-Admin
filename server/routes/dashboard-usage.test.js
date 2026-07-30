import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createDashboardUsageRuntime, projectDashboardUsage } from '../lib/dashboard-usage-runtime.js'
import { createDashboardUsageRouter } from './dashboard-usage.js'

function sampleUsage() {
  return {
    updatedAt: 123,
    startDate: '2026-07-01',
    endDate: '2026-07-30',
    sessions: [
      {
        key: 'agent:main:main:dm:webchat-example',
        label: 'must-not-leave-bff',
        usage: { totalTokens: 42, dailyBreakdown: [{ date: '2026-07-30', tokens: 42 }] },
      },
    ],
    totals: { totalTokens: 42, totalCost: 0.01 },
    aggregates: {
      messages: { total: 2 },
      tools: { totalCalls: 1, tools: [{ name: 'query', count: 1 }] },
      byModel: [{ model: 'model-a', count: 1, totals: { totalTokens: 42 } }],
      byProvider: [{ provider: 'provider-a', count: 1, totals: { totalTokens: 42 } }],
      byAgent: [{ agentId: 'main', totals: { totalTokens: 42 } }],
      byChannel: [{ channel: 'web', totals: { totalTokens: 42 } }],
      daily: [{ date: '2026-07-30', tokens: 42, cost: 0.01 }],
    },
  }
}

test('dashboard usage projection removes unnecessary session detail', () => {
  const projected = projectDashboardUsage(sampleUsage())
  assert.deepEqual(projected.sessions, [{
    key: 'agent:main:main:dm:webchat-example',
    usage: { totalTokens: 42 },
  }])
  assert.deepEqual(projected.aggregates.byAgent, [])
  assert.deepEqual(projected.aggregates.byChannel, [])
  assert.equal(JSON.stringify(projected).includes('must-not-leave-bff'), false)
  assert.equal(JSON.stringify(projected).includes('dailyBreakdown'), false)
})

test('dashboard usage runtime shares concurrent work and caches by principal and range', async () => {
  let calls = 0
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const runtime = createDashboardUsageRuntime({
    loadUsage: async () => {
      calls += 1
      await pending
      return sampleUsage()
    },
  })
  const params = {
    principal: 'admin:one',
    startDate: '2026-07-01',
    endDate: '2026-07-30',
  }
  const first = runtime.read(params)
  const second = runtime.read(params)
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.cache, 'miss')
  assert.equal(secondResult.cache, 'shared')
  assert.equal((await runtime.read(params)).cache, 'hit')
  assert.equal(calls, 1)
  assert.equal((await runtime.read({ ...params, principal: 'admin:two' })).cache, 'miss')
  assert.equal(calls, 2)
})

test('dashboard usage route validates ranges and returns cache metadata', async () => {
  const app = express()
  const runtime = {
    async read(params) {
      assert.equal(params.principal, 'admin:user-1')
      return { usage: projectDashboardUsage(sampleUsage()), cache: 'hit' }
    },
  }
  app.use('/dashboard', createDashboardUsageRouter({
    authMiddleware: (req, _res, next) => {
      req.user = { id: 'user-1', role: 'admin' }
      next()
    },
    runtime,
  }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  try {
    const invalid = await fetch(`http://127.0.0.1:${port}/dashboard?startDate=bad&endDate=2026-07-30`)
    assert.equal(invalid.status, 400)
    const response = await fetch(`http://127.0.0.1:${port}/dashboard?startDate=2026-07-01&endDate=2026-07-30`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.cache, 'hit')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
