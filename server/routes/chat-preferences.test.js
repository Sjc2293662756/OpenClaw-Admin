import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import { migrateChatDisplayPreferences } from '../lib/chat-display-preferences.js'
import { createChatPreferencesRouter } from './chat-preferences.js'

async function startServer() {
  const db = new Database(':memory:')
  migrateChatDisplayPreferences(db)
  const audits = []
  const app = express()
  app.use(express.json())
  app.use('/api/chat/preferences', createChatPreferencesRouter({
    db,
    authMiddleware: (req, _res, next) => {
      req.user = {
        id: req.get('x-test-user-id') || 'default-user',
        username: req.get('x-test-user-id') || 'default-user',
        role: req.get('x-test-role') || 'basic',
      }
      next()
    },
    recordAudit: (user, action, target, detail) => audits.push({ user, action, target, detail }),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    audits,
    db,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/api/chat/preferences`,
  }
}

function headers(role, userId) {
  return { 'Content-Type': 'application/json', 'x-test-role': role, 'x-test-user-id': userId }
}

test('basic, standard, admin, and auditor accounts can read and update only their own chat display preference', async () => {
  const context = await startServer()
  try {
    for (const [index, role] of ['basic', 'standard', 'admin', 'auditor'].entries()) {
      const userId = `${role}-user`
      const initial = await fetch(context.baseUrl, { headers: headers(role, userId) })
      assert.equal(initial.status, 200, `${role} initial read`)
      assert.equal((await initial.json()).preferences.showThinkingProcess, true)

      const saved = await fetch(context.baseUrl, {
        method: 'PUT',
        headers: headers(role, userId),
        body: JSON.stringify({ showThinkingProcess: index % 2 === 1 }),
      })
      assert.equal(saved.status, 200, `${role} save`)
      assert.equal((await saved.json()).preferences.showThinkingProcess, index % 2 === 1)
    }

    const basicOwn = await fetch(`${context.baseUrl}?userId=admin-user`, { headers: headers('basic', 'basic-user') })
    assert.equal((await basicOwn.json()).preferences.showThinkingProcess, false)
    const adminOwn = await fetch(context.baseUrl, { headers: headers('admin', 'admin-user') })
    assert.equal((await adminOwn.json()).preferences.showThinkingProcess, false)
    assert.equal(context.audits.length, 4)
    assert.ok(context.audits.every((entry) => entry.action === '保存对话显示设置'))
  } finally {
    context.server.close()
    await once(context.server, 'close')
    context.db.close()
  }
})

test('chat display preference route rejects extra account fields and non-boolean values', async () => {
  const context = await startServer()
  try {
    for (const body of [
      { showThinkingProcess: 'false' },
      { showThinkingProcess: false, userId: 'other-user' },
      {},
    ]) {
      const response = await fetch(context.baseUrl, {
        method: 'PUT',
        headers: headers('basic', 'basic-user'),
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'CHAT_PREFERENCES_INVALID')
    }
  } finally {
    context.server.close()
    await once(context.server, 'close')
    context.db.close()
  }
})
