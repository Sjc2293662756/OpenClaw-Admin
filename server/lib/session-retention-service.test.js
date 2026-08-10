import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  __test__,
  cancelPendingDeletion,
  getSessionAttachmentDeletionBlock,
  getSessionRetention,
  markManualGatewaySessionDeleted,
  migrateSessionRetentionTables,
  registerSessionAttachment,
  runSessionRetentionCycle,
  setLongTermRetention,
} from './session-retention-service.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspace_sessions (
      session_key TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      session_title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  migrateSessionRetentionTables(db)
  return db
}

function own(db, key, now) {
  db.prepare(`
    INSERT INTO workspace_sessions (session_key, owner_user_id, status, created_at, updated_at)
    VALUES (?, 'user-1', 'active', ?, ?)
  `).run(key, now, now)
}

function webSession(key, lastActivity, overrides = {}) {
  return {
    key,
    originKind: 'web',
    sourceChannel: 'web',
    conversationLastActivity: new Date(lastActivity).toISOString(),
    conversationLastActivitySource: 'lastInteractionAt',
    ...overrides,
  }
}

test('automatic marking uses conversation activity and protects uncertain or active sessions', async () => {
  const db = createDb()
  const now = Date.UTC(2026, 7, 10, 12)
  const old = now - 181 * __test__.DAY_MS
  const eligible = 'agent:main:main:dm:webchat-eligible'
  const recent = 'agent:main:main:dm:webchat-recent'
  const active = 'agent:main:main:dm:webchat-active'
  const activeRunId = 'agent:main:main:dm:webchat-active-run-id'
  const missing = 'agent:main:main:dm:webchat-missing'
  const createdOnly = 'agent:main:main:dm:webchat-created-only'
  const longTerm = 'agent:main:main:dm:webchat-long-term'
  for (const key of [eligible, recent, active, activeRunId, missing, createdOnly, longTerm]) own(db, key, now)
  setLongTermRetention(db, longTerm, true, now)

  const result = await runSessionRetentionCycle({
    db,
    autoMark: true,
    autoDelete: false,
    now,
    listGatewaySessions: async () => [
      webSession(eligible, old),
      webSession(recent, now - 100 * __test__.DAY_MS),
      webSession(active, old, { pendingTasks: [{ id: 'task-1' }] }),
      webSession(activeRunId, old, { activeRunId: 'run-1' }),
      { key: missing, originKind: 'web', sourceChannel: 'web', updatedAt: old },
      { key: createdOnly, originKind: 'web', sourceChannel: 'web', createdAt: old },
      webSession(longTerm, old),
      { key: 'agent:main:lark:direct:peer', originKind: 'channel', sourceChannel: 'lark', conversationLastActivity: new Date(old).toISOString(), channels: ['lark', 'wecom'], peer: 'peer' },
      { key: 'agent:main:unknown:direct:peer', conversationLastActivity: new Date(old).toISOString() },
    ],
  })

  assert.equal(result.marking.success, 1)
  const record = getSessionRetention(db, eligible)
  assert.equal(record.lifecycle_state, 'pending_delete')
  assert.equal(record.last_activity_at, old)
  assert.equal(record.delete_after, now + 7 * __test__.DAY_MS)
  assert.equal(getSessionRetention(db, recent), null)
  assert.equal(getSessionRetention(db, active), null)
  assert.equal(getSessionRetention(db, activeRunId), null)
  assert.equal(getSessionRetention(db, missing), null)
  assert.equal(getSessionRetention(db, createdOnly), null)
  assert.equal(getSessionRetention(db, longTerm).lifecycle_state, 'active')
  assert.equal(result.marking.reasons.last_activity_missing > 0, true)
  assert.equal(result.marking.reasons.active_or_pending_work > 0, true)
  assert.equal(result.marking.reasons.multi_channel_shared > 0, true)
  assert.equal(result.marking.reasons.ownership_unknown > 0, true)
  assert.equal(result.deletion.reasons.auto_delete_disabled, 1)
  db.close()
})

test('both disabled switches avoid every Gateway call and the exact 180-day boundary remains protected', async () => {
  const db = createDb()
  const now = Date.UTC(2026, 7, 10, 12)
  const key = 'agent:main:main:dm:webchat-boundary'
  own(db, key, now)
  let listCalls = 0
  let deleteCalls = 0
  const disabled = await runSessionRetentionCycle({
    db,
    now,
    listGatewaySessions: async () => { listCalls += 1; return [webSession(key, now - 181 * __test__.DAY_MS)] },
    deleteGatewaySession: async () => { deleteCalls += 1 },
  })
  assert.equal(listCalls, 0)
  assert.equal(deleteCalls, 0)
  assert.equal(disabled.marking.reasons.auto_mark_disabled, 1)
  assert.equal(disabled.deletion.reasons.auto_delete_disabled, 1)

  const boundary = await runSessionRetentionCycle({
    db,
    autoMark: true,
    now,
    listGatewaySessions: async () => [webSession(key, now - 180 * __test__.DAY_MS)],
  })
  assert.equal(boundary.marking.success, 0)
  assert.equal(boundary.marking.reasons.within_retention, 1)
  assert.equal(getSessionRetention(db, key), null)
  assert.equal(__test__.resolveLastActivity({
    conversationLastActivity: new Date(now - 181 * __test__.DAY_MS).toISOString(),
    conversationLastActivitySource: 'updatedAt',
  }), null)
  assert.equal(__test__.resolveLastActivity({
    conversationLastActivity: new Date(now - 181 * __test__.DAY_MS).toISOString(),
  }), null)
  assert.equal(__test__.resolveLastActivity({
    conversationLastActivity: new Date(now - 181 * __test__.DAY_MS).toISOString(),
    conversationLastActivitySource: 'lastInteractionAt',
  }), now - 181 * __test__.DAY_MS)
  db.close()
})

test('cancelling pending deletion holds the same activity snapshot but permits a later stale snapshot', async () => {
  const db = createDb()
  const now = Date.UTC(2026, 7, 10, 12)
  const key = 'agent:main:main:dm:webchat-cancel'
  const old = now - 182 * __test__.DAY_MS
  own(db, key, now)
  const run = (activity) => runSessionRetentionCycle({
    db,
    autoMark: true,
    now,
    listGatewaySessions: async () => [webSession(key, activity)],
  })

  await run(old)
  assert.equal(cancelPendingDeletion(db, key, now + 1).status, 'active')
  await run(old)
  assert.equal(getSessionRetention(db, key).lifecycle_state, 'active')
  await run(old + __test__.DAY_MS)
  assert.equal(getSessionRetention(db, key).lifecycle_state, 'pending_delete')
  db.close()
})

test('Gateway delete failure leaves all Admin metadata unchanged and success commits afterward', async () => {
  const db = createDb()
  const markNow = Date.UTC(2026, 7, 1, 12)
  const deleteNow = markNow + 8 * __test__.DAY_MS
  const key = 'agent:main:main:dm:webchat-delete'
  const activity = markNow - 181 * __test__.DAY_MS
  own(db, key, markNow)
  await runSessionRetentionCycle({
    db,
    autoMark: true,
    now: markNow,
    listGatewaySessions: async () => [webSession(key, activity)],
  })
  const before = getSessionRetention(db, key)

  let changedActivityDeleteCalled = false
  const changedActivity = await runSessionRetentionCycle({
    db,
    autoDelete: true,
    now: deleteNow,
    listGatewaySessions: async () => [webSession(key, activity + __test__.DAY_MS)],
    deleteGatewaySession: async () => { changedActivityDeleteCalled = true },
  })
  assert.equal(changedActivityDeleteCalled, false)
  assert.equal(changedActivity.deletion.reasons.activity_changed_after_mark, 1)
  assert.deepEqual(getSessionRetention(db, key), before)

  const failed = await runSessionRetentionCycle({
    db,
    autoDelete: true,
    now: deleteNow,
    listGatewaySessions: async () => [webSession(key, activity)],
    deleteGatewaySession: async () => { throw Object.assign(new Error('do not persist'), { code: 'RPC_FAILED' }) },
  })
  assert.equal(failed.deletion.failed, 1)
  assert.deepEqual(getSessionRetention(db, key), before)
  assert.equal(db.prepare('SELECT status FROM workspace_sessions WHERE session_key = ?').get(key).status, 'active')

  const calls = []
  const completed = await runSessionRetentionCycle({
    db,
    autoDelete: true,
    now: deleteNow,
    listGatewaySessions: async () => [webSession(key, activity)],
    deleteGatewaySession: async (sessionKey) => { calls.push(sessionKey); return { deleted: true } },
  })
  assert.deepEqual(calls, [key])
  assert.equal(completed.deletion.success, 1)
  assert.equal(getSessionRetention(db, key).lifecycle_state, 'deleted')
  assert.equal(db.prepare('SELECT status FROM workspace_sessions WHERE session_key = ?').get(key).status, 'deleted')
  db.close()
})

test('registered attachments follow the session metadata and block deletion without a formal Gateway attachment API', async () => {
  const db = createDb()
  const markNow = Date.UTC(2026, 7, 1, 12)
  const deleteNow = markNow + 8 * __test__.DAY_MS
  const key = 'agent:main:main:dm:webchat-attachment'
  const activity = markNow - 181 * __test__.DAY_MS
  own(db, key, markNow)
  const attachment = registerSessionAttachment(db, {
    id: 'attachment-1',
    sessionKey: key,
    attachmentRef: 'browser/image.png',
    retentionClass: 'temporary',
    createdAt: markNow,
    now: markNow,
  })
  assert.equal(attachment.ownership_state, 'verified')
  assert.equal(attachment.expires_at, markNow + 7 * __test__.DAY_MS)
  assert.deepEqual(getSessionAttachmentDeletionBlock(db, key), {
    blocked: true,
    count: 1,
    reason: 'attachment_delete_api_unavailable',
  })

  await runSessionRetentionCycle({
    db,
    autoMark: true,
    now: markNow,
    listGatewaySessions: async () => [webSession(key, activity)],
  })
  let deleteCalled = false
  const result = await runSessionRetentionCycle({
    db,
    autoDelete: true,
    now: deleteNow,
    listGatewaySessions: async () => [webSession(key, activity)],
    deleteGatewaySession: async () => { deleteCalled = true },
  })
  assert.equal(deleteCalled, false)
  assert.equal(result.deletion.reasons.attachment_delete_api_unavailable, 1)
  assert.equal(result.attachments.dueTemporary, 1)
  assert.equal(getSessionRetention(db, key).lifecycle_state, 'pending_delete')
  assert.equal(db.prepare('SELECT lifecycle_state FROM session_retention_attachments WHERE id = ?').get('attachment-1').lifecycle_state, 'pending_delete')
  db.close()
})

test('long-term retention always removes automatic pending state', () => {
  const db = createDb()
  const key = 'agent:main:main:dm:webchat-long-term-toggle'
  const now = Date.UTC(2026, 7, 10, 12)
  own(db, key, now)
  const enabled = setLongTermRetention(db, key, true, now)
  assert.equal(enabled.mode, 'long_term')
  assert.equal(enabled.status, 'active')
  const disabled = setLongTermRetention(db, key, false, now + 1)
  assert.equal(disabled.mode, 'standard')
  assert.equal(disabled.status, 'active')
  db.close()
})

test('disabling long-term retention does not create a synthetic cancellation hold', async () => {
  const db = createDb()
  const now = Date.UTC(2026, 7, 10, 12)
  const key = 'agent:main:main:dm:webchat-long-term-resume'
  const old = now - 181 * __test__.DAY_MS
  own(db, key, now)
  await runSessionRetentionCycle({
    db,
    autoMark: true,
    now,
    listGatewaySessions: async () => [webSession(key, old)],
  })
  setLongTermRetention(db, key, true, now + 1)
  setLongTermRetention(db, key, false, now + 2)
  await runSessionRetentionCycle({
    db,
    autoMark: true,
    now: now + 3,
    listGatewaySessions: async () => [webSession(key, old)],
  })
  assert.equal(getSessionRetention(db, key).lifecycle_state, 'pending_delete')
  db.close()
})

test('manual Gateway success updates retention and workspace metadata in one local transaction', () => {
  const db = createDb()
  const now = Date.UTC(2026, 7, 10, 12)
  const key = 'agent:main:main:dm:webchat-manual-delete'
  own(db, key, now)
  setLongTermRetention(db, key, true, now)
  const result = markManualGatewaySessionDeleted(db, key, now + 1)
  assert.equal(result.status, 'deleted')
  assert.equal(db.prepare('SELECT status FROM workspace_sessions WHERE session_key = ?').get(key).status, 'deleted')
  db.close()
})

test('the direct RPC path blocks registered attachments before Gateway and records metadata only afterward', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const cleanupSource = readFileSync(new URL('../session-retention-cleanup.js', import.meta.url), 'utf8')
  const attachmentGuard = source.indexOf('getSessionAttachmentDeletionBlock(db, sessionKey)')
  const gatewayCall = source.indexOf('await gateway.call(method, reportProvenance.params)')
  const metadataUpdate = source.indexOf('markManualGatewaySessionDeleted(db, sessionKey)')
  assert.ok(attachmentGuard >= 0)
  assert.ok(gatewayCall > attachmentGuard)
  assert.ok(metadataUpdate > gatewayCall)
  assert.doesNotMatch(source.slice(attachmentGuard, metadataUpdate), /unlink|rmSync|removeSync|deleteFile/)
  assert.match(cleanupSource, /gateway\.call\('sessions\.delete', \{ key: sessionKey, deleteTranscript: true \}\)/)
  assert.doesNotMatch(cleanupSource, /\b(?:unlink|rmSync|removeSync|deleteFile|memory|reports?)\b/)
})
