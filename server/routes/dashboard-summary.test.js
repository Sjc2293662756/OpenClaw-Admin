import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createDashboardSummaryRouter } from './dashboard-summary.js'

function fakeDb() {
  return {
    prepare() {
      return {
        all(ownerId) {
          assert.equal(ownerId, 'basic-1')
          return [{ session_key: 'owned-session' }]
        },
      }
    },
  }
}

test('dashboard summary exposes aggregates only and filters basic sessions by ownership', async () => {
  const payloads = {
    'sessions.list': { sessions: [{ key: 'owned-session' }, { key: 'other-session' }] },
    'cron.list': { jobs: [{ enabled: true }, { enabled: false }] },
    'models.list': { models: [{ id: 'm1' }, { id: 'm2' }] },
    'skills.status': { skills: [{ installed: true }, { installed: false }] },
  }
  const gateway = {
    isConnected: true,
    call: async (method) => payloads[method],
  }
  const app = express()
  app.use('/summary', createDashboardSummaryRouter({
    authMiddleware(req, _res, next) {
      req.user = { id: 'basic-1', role: 'basic' }
      next()
    },
    getGateway: () => gateway,
    db: fakeDb(),
  }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/summary`)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(body.summary, {
      sessionCount: 1,
      cronCount: 1,
      modelCount: 2,
      installedSkills: 1,
    })
    assert.equal(JSON.stringify(body).includes('owned-session'), false)
    assert.equal(JSON.stringify(body).includes('other-session'), false)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
