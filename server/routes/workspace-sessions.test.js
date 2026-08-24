import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { createWorkspaceSessionsRouter } from './workspace-sessions.js'

function createDb() {
  const rows = new Map()
  return {
    rows,
    prepare(sql) {
      const normalized = sql.replace(/\s+/gu, ' ').trim()
      return {
        get(...args) {
          if (normalized.startsWith('SELECT id FROM data_sources')) return { id: 'source-238web' }
          if (normalized.startsWith('SELECT session_title, status FROM workspace_sessions')) {
            const row = rows.get(args[0])
            return row ? { session_title: row.session_title, status: row.status } : undefined
          }
          if (normalized.startsWith("SELECT COUNT(*) AS count FROM workspace_sessions WHERE status = 'active'")) {
            return { count: [...rows.values()].filter((row) => row.status === 'active').length }
          }
          return undefined
        },
        run(...args) {
          if (normalized.startsWith('INSERT INTO workspace_sessions')) {
            const [sessionKey, ownerUserId, createdAt, updatedAt] = args
            rows.set(sessionKey, {
              session_key: sessionKey,
              owner_user_id: ownerUserId,
              session_title: null,
              status: 'active',
              created_at: createdAt,
              updated_at: updatedAt,
              deleted_at: null,
            })
            return { changes: 1 }
          }
          if (normalized.includes('SET session_title = ?')) {
            const [title, updatedAt, sessionKey] = args
            const row = rows.get(sessionKey)
            if (!row || row.status !== 'active' || row.session_title) return { changes: 0 }
            row.session_title = title
            row.updated_at = updatedAt
            return { changes: 1 }
          }
          if (normalized.includes("SET status = 'deleted'")) {
            const [updatedAt, deletedAt, sessionKey] = args
            const row = rows.get(sessionKey)
            if (!row || row.status !== 'active') return { changes: 0 }
            row.status = 'deleted'
            row.updated_at = updatedAt
            row.deleted_at = deletedAt
            return { changes: 1 }
          }
          throw new Error(`Unexpected SQL in test: ${normalized}`)
        },
      }
    },
    close() {},
  }
}

function createFixture({ gatewayCall, provenanceStored = true } = {}) {
  const db = createDb()
  const calls = []
  const provenance = []
  const audits = []
  const gateway = {
    isConnected: true,
    async call(method, params, timeout) {
      calls.push({ method, params, timeout })
      if (gatewayCall) return gatewayCall(method, params, timeout)
      return { ok: true, key: params.key, runStarted: true, runId: 'gateway-run-1' }
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/api/workspace/sessions', createWorkspaceSessionsRouter({
    db,
    authMiddleware(req, _res, next) {
      req.user = { id: 'user-1', username: 'alice', role: 'standard' }
      next()
    },
    gateway,
    recordAudit: (...args) => audits.push(args),
    reportProvenanceOptions: { enabled: true, signingKey: 'x'.repeat(32) },
    attachProvenance: (params, user, options) => {
      provenance.push({ params, user, options })
      return { stored: provenanceStored }
    },
  }))
  return { app, db, calls, provenance, audits }
}

async function withServer(fixture, run) {
  const server = fixture.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/workspace/sessions`)
  } finally {
    server.close()
    await once(server, 'close')
    fixture.db.close()
  }
}

test('atomically creates a Gateway transcript with the first WebChat message and provenance', async () => {
  const fixture = createFixture()
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '生成最近七天的综述报告', idempotencyKey: 'web-request-1' }),
    })
    const body = await response.json()

    assert.equal(response.status, 201)
    assert.equal(body.ok, true)
    assert.match(body.sessionKey, /^agent:main:main:dm:webchat-[a-z0-9]{32}$/u)
    assert.equal(body.runStarted, true)
    assert.equal(body.runId, 'gateway-run-1')
    assert.deepEqual(fixture.calls, [{
      method: 'sessions.create',
      params: { key: body.sessionKey, message: '生成最近七天的综述报告' },
      timeout: 120_000,
    }])
    assert.equal(fixture.provenance[0].params.sessionKey, body.sessionKey)
    assert.equal(fixture.provenance[0].params.message, '生成最近七天的综述报告')
    assert.equal(fixture.provenance[0].options.dataSourceId, 'source-238web')
    assert.equal(fixture.provenance[0].options.transportMetadata, false)
    assert.deepEqual(fixture.db.prepare(
      'SELECT session_title, status FROM workspace_sessions WHERE session_key = ?'
    ).get(body.sessionKey), {
      session_title: '生成最近七天的综述报告',
      status: 'active',
    })
  })
})

test('keeps empty-session creation separate from the atomic first-message path', async () => {
  const fixture = createFixture()
  await withServer(fixture, async (url) => {
    const response = await fetch(url, { method: 'POST' })
    const body = await response.json()

    assert.equal(response.status, 201)
    assert.equal(body.initialized, false)
    assert.equal(fixture.calls.length, 0)
    assert.equal(fixture.provenance.length, 0)
  })
})

test('does not expose an active BFF session when Gateway atomic creation fails', async () => {
  const fixture = createFixture({ gatewayCall: async () => { throw new Error('gateway failure') } })
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '首条消息' }),
    })
    const body = await response.json()

    assert.equal(response.status, 502)
    assert.equal(body.ok, false)
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM workspace_sessions WHERE status = 'active'").get().count, 0)
  })
})

test('rejects a partial Gateway result that did not start the first message', async () => {
  const fixture = createFixture({
    gatewayCall: async (_method, params) => ({ ok: true, key: params.key, runStarted: false }),
  })
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '首条消息' }),
    })

    assert.equal(response.status, 502)
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM workspace_sessions WHERE status = 'active'").get().count, 0)
  })
})

test('does not start a conversation when required Web report provenance was not stored', async () => {
  const fixture = createFixture({ provenanceStored: false })
  await withServer(fixture, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '生成最近七天的综述报告' }),
    })

    assert.equal(response.status, 502)
    assert.equal(fixture.calls.length, 0)
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM workspace_sessions WHERE status = 'active'").get().count, 0)
  })
})
