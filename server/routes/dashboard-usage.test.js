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

test('dashboard usage runtime filters and fully aggregates owned sessions before projection', async () => {
  const payload = sampleUsage()
  payload.sessions.push({
    key: 'other-session',
    label: 'other-user',
    modelProvider: 'secret-provider',
    model: 'secret-model',
    usage: {
      totalTokens: 999,
      messageCounts: { total: 9, user: 4, assistant: 4, toolCalls: 1, toolResults: 0, errors: 0 },
      toolUsage: { totalCalls: 1, tools: [{ name: 'secret-tool', count: 1 }] },
      dailyBreakdown: [{ date: '2026-07-30', tokens: 999, cost: 9.99 }],
    },
  })
  payload.sessions[0].modelProvider = 'provider-a'
  payload.sessions[0].model = 'model-a'
  payload.sessions[0].usage.messageCounts = {
    total: 2,
    user: 1,
    assistant: 1,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  }
  payload.sessions[0].usage.toolUsage = {
    totalCalls: 1,
    tools: [{ name: 'query', count: 1 }],
  }

  const runtime = createDashboardUsageRuntime({ loadUsage: async () => payload })
  const result = await runtime.read({
    principal: 'standard:user-1',
    startDate: '2026-07-01',
    endDate: '2026-07-30',
    allowedKeys: new Set(['agent:main:main:dm:webchat-example']),
  })

  assert.equal(result.usage.totals.totalTokens, 42)
  assert.equal(result.usage.aggregates.messages.total, 2)
  assert.deepEqual(result.usage.aggregates.tools.tools, [{ name: 'query', count: 1 }])
  assert.deepEqual(result.usage.aggregates.byModel.map((item) => item.model), ['model-a'])
  assert.deepEqual(result.usage.aggregates.daily, [{
    date: '2026-07-30',
    tokens: 42,
    cost: 0,
    messages: 0,
    toolCalls: 0,
    errors: 0,
  }])
  assert.equal(JSON.stringify(result.usage).includes('other-user'), false)
  assert.equal(JSON.stringify(result.usage).includes('secret-model'), false)
})

test('dashboard usage route validates ranges and returns cache metadata', async () => {
  const app = express()
  const runtime = {
    async read(params) {
      assert.equal(params.principal, 'standard:user-1')
      assert.equal(params.allowedKeys, null)
      return { usage: projectDashboardUsage(sampleUsage()), cache: 'hit' }
    },
  }
  app.use('/dashboard', createDashboardUsageRouter({
    authMiddleware: (req, _res, next) => {
      req.user = {
        id: 'user-1',
        role: 'standard',
        effectiveModules: { dashboard: true, 'data.allUsers': true },
      }
      next()
    },
    runtime,
    db: { prepare: () => { throw new Error('ownership query must not run for all-user scope') } },
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
