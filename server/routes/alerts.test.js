import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import AdmZip from 'adm-zip'
import Database from 'better-sqlite3'
import express from 'express'
import { createAlertsRouter } from './alerts.js'
import { migrateAlertNotificationPreferences } from '../lib/alert-notification-preferences.js'
import { migrateAlertNotificationStore } from '../lib/alert-notification-store.js'

async function startTestServer(readAlertSource, { role = 'admin', userId = 'admin-1', readAlertChanges, db = null, notifyAlertNotificationsChanged } = {}) {
  const audits = []
  const notificationChanges = []
  const database = db || new Database(':memory:')
  migrateAlertNotificationPreferences(database)
  migrateAlertNotificationStore(database)
  const app = express()
  app.use(express.json())
  app.use('/alerts', createAlertsRouter({
    authMiddleware: (req, _res, next) => {
      req.user = { id: userId, username: 'admin', role }
      next()
    },
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
    db: database,
    readAlertSource,
    readAlertChanges,
    notifyAlertNotificationsChanged: notifyAlertNotificationsChanged
      || ((changedUserId, action) => notificationChanges.push({ userId: changedUserId, action })),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { baseUrl: `http://127.0.0.1:${server.address().port}/alerts`, audits, notificationChanges, db: database, server }
}

const defaultPreferences = {
  realtimeEnabled: true, soundEnabled: true,
  minorPopupEnabled: true, minorNotificationEnabled: true,
  majorPopupEnabled: true, majorNotificationEnabled: true,
  criticalPopupEnabled: true, criticalNotificationEnabled: true,
}

function seedNotification(db, {
  eventId,
  userId = 'admin-1',
  severity = '重大',
  readAt = null,
  clearedAt = null,
  createdOffline = false,
  action = 'triggered',
} = {}) {
  const payload = {
    id: `alert-${eventId}`,
    occurredAt: new Date(1_788_000_000_000 + eventId).toISOString(),
    sourceHost: '198.51.100.10',
    category: 'appAlerts',
    categoryLabel: '应用告警',
    severity,
    name: `alert ${eventId}`,
    ruleId: 1,
    metrics: [],
    description: null,
    triggerCondition: null,
    groupPath: null,
    startTime: null,
    endTime: null,
    eventId: `receiver-event-${eventId}`,
    restored: action === 'recovered',
  }
  db.prepare(`
    INSERT INTO alert_notification_events (
      event_id, receiver_generation, stream_sequence, alert_id, action, severity,
      occurred_at, received_at, safe_payload_json, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventId, eventId, payload.id, action, severity, Date.parse(payload.occurredAt), Date.parse(payload.occurredAt), JSON.stringify(payload), eventId)
  db.prepare(`
    INSERT INTO account_alert_notifications (
      user_id, event_id, read_at, cleared_at, created_offline, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, eventId, readAt, clearedAt, createdOffline ? 1 : 0, eventId)
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

test('basic users can read system alert records, time, and export the current six-field page as XLSX', async () => {
  const context = await startTestServer(async () => ({
    alerts: [{ id: 'basic-visible', occurredAt: '2026-08-30T01:00:00.000Z', sourceHost: '10.0.0.8', category: 'appAlerts', severity: '重大', name: 'basic list record', metrics: [] }],
    availableCount: 1,
    hasMore: false,
  }), { role: 'basic', userId: 'basic-1' })
  try {
    const list = await fetch(context.baseUrl)
    assert.equal(list.status, 200)
    assert.equal((await list.json()).alerts[0].id, 'basic-visible')
    assert.equal((await fetch(`${context.baseUrl}/time`)).status, 200)
    const exported = await fetch(`${context.baseUrl}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: [{
        occurredAt: '2026-08-30 09:00', severity: '重大', name: 'basic list record',
        category: 'appAlerts', sourceHost: '10.0.0.8', status: '触发中', hiddenField: 'must-not-export',
      }] }),
    })
    assert.equal(exported.status, 200)
    assert.match(String(exported.headers.get('content-type')), /spreadsheetml/)
    const sheet = new AdmZip(Buffer.from(await exported.arrayBuffer())).readAsText('xl/worksheets/sheet1.xml')
    assert.match(sheet, /basic list record/)
    assert.doesNotMatch(sheet, /must-not-export/)
    assert.equal(context.audits.filter((entry) => entry.action === '导出 Syslog 告警').length, 1)
  } finally { context.server.close(); context.db.close() }
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

test('alert changes permits basic users, rejects invalid cursors, and reports receiver failure safely', async () => {
  const basicChangeCalls = []
  const basic = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
    role: 'basic',
    // This role regression must remain completely offline: no local Receiver,
    // tunnel, or 237 state may influence a unit test.
    readAlertChanges: async (_env, options) => {
      basicChangeCalls.push(options)
      return { events: [], latestSequence: 0, hasMore: false, historyRefreshRequired: false }
    },
  })
  try {
    assert.equal((await fetch(`${basic.baseUrl}/changes?afterSequence=0`)).status, 200)
    assert.deepEqual(basicChangeCalls, [{ afterSequence: 0, limit: 200 }])
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

test('account alert notification preferences use secure defaults, persist per account, validate strictly, and audit saves', async () => {
  const database = new Database(':memory:')
  const first = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), { db: database, userId: 'account-one' })
  const second = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), { db: database, userId: 'account-two' })
  try {
    const initial = await fetch(`${first.baseUrl}/preferences`).then((response) => response.json())
    assert.deepEqual(initial.preferences, { ...defaultPreferences, updatedAt: null })

    const savedValues = { ...defaultPreferences, realtimeEnabled: false, soundEnabled: false, majorNotificationEnabled: false }
    const saved = await fetch(`${first.baseUrl}/preferences`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...savedValues, userId: 'account-two' }),
    })
    assert.equal(saved.status, 400)

    const accepted = await fetch(`${first.baseUrl}/preferences`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savedValues),
    })
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json()).preferences.realtimeEnabled, false)
    assert.equal(first.audits.filter((entry) => entry.action === '保存账户告警通知设置').length, 1)
    assert.equal(first.audits[0].detail.includes('account-two'), false)

    const isolated = await fetch(`${second.baseUrl}/preferences`).then((response) => response.json())
    assert.deepEqual(isolated.preferences, { ...defaultPreferences, updatedAt: null })

    const restarted = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), { db: database, userId: 'account-one' })
    try {
      const afterRestart = await fetch(`${restarted.baseUrl}/preferences`).then((response) => response.json())
      assert.equal(afterRestart.preferences.majorNotificationEnabled, false)
    } finally { restarted.server.close() }

    const invalid = await fetch(`${first.baseUrl}/preferences`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...defaultPreferences, soundEnabled: 'false' }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    first.server.close()
    second.server.close()
    database.close()
  }
})

test('alert notification preferences allow basic users but remain current-account only', async () => {
  const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), { role: 'basic' })
  try {
    assert.equal((await fetch(`${context.baseUrl}/preferences`)).status, 200)
    assert.equal((await fetch(`${context.baseUrl}/preferences`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(defaultPreferences),
    })).status, 200)
    assert.equal((await fetch(`${context.baseUrl}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [{}] }) })).status, 200)
  } finally { context.server.close(); context.db.close() }
})

test('account notifications use stable keyset pagination with server-side filters and exact counts', async () => {
  const db = new Database(':memory:')
  const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
    db,
    userId: 'account-one',
  })
  seedNotification(db, { eventId: 1, userId: 'account-one', severity: '轻微' })
  seedNotification(db, { eventId: 2, userId: 'account-one', severity: '重大', readAt: 20 })
  seedNotification(db, { eventId: 3, userId: 'account-one', severity: '紧急', createdOffline: true })
  seedNotification(db, { eventId: 4, userId: 'account-two', severity: '紧急' })
  seedNotification(db, { eventId: 5, userId: 'account-one', severity: '重大', clearedAt: 50 })
  try {
    const first = await fetch(`${context.baseUrl}/notifications?limit=2`).then((response) => response.json())
    assert.deepEqual(first.notifications.map((item) => item.notificationId), [3, 2])
    assert.equal(first.notifications[0].createdOffline, true)
    assert.equal(first.notifications[1].read, true)
    assert.deepEqual(first.counts, {
      total: 3,
      unread: 2,
      filteredTotal: 3,
      filteredUnread: 2,
      bySeverity: {
        轻微: { total: 1, unread: 1 },
        重大: { total: 1, unread: 0 },
        紧急: { total: 1, unread: 1 },
      },
    })
    assert.deepEqual(first.page, { limit: 2, hasMore: true, nextBeforeId: 2, snapshotThroughId: 3 })

    const second = await fetch(`${context.baseUrl}/notifications?limit=2&beforeId=2`).then((response) => response.json())
    assert.deepEqual(second.notifications.map((item) => item.notificationId), [1])
    assert.equal(second.page.hasMore, false)

    const filtered = await fetch(`${context.baseUrl}/notifications?severity=紧急&readState=unread`).then((response) => response.json())
    assert.deepEqual(filtered.notifications.map((item) => item.notificationId), [3])
    assert.equal(filtered.counts.filteredTotal, 1)
    assert.equal(filtered.counts.filteredUnread, 1)

    assert.equal((await fetch(`${context.baseUrl}/notifications?severity=一般`)).status, 400)
    assert.equal((await fetch(`${context.baseUrl}/notifications?readState=read`)).status, 400)
    assert.equal((await fetch(`${context.baseUrl}/notifications?beforeId=2x`)).status, 400)
  } finally { context.server.close(); db.close() }
})

test('single and filtered read or clear operations remain account-scoped and never delete shared events', async () => {
  const db = new Database(':memory:')
  const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
    db,
    userId: 'account-one',
  })
  seedNotification(db, { eventId: 1, userId: 'account-one', severity: '轻微' })
  seedNotification(db, { eventId: 2, userId: 'account-one', severity: '轻微' })
  seedNotification(db, { eventId: 3, userId: 'account-one', severity: '重大', readAt: 30 })
  seedNotification(db, { eventId: 4, userId: 'account-one', severity: '重大' })
  seedNotification(db, { eventId: 5, userId: 'account-two', severity: '紧急' })
  try {
    const single = await fetch(`${context.baseUrl}/notifications/1/read`, { method: 'PUT' }).then((response) => response.json())
    assert.equal(single.changed, true)
    const repeated = await fetch(`${context.baseUrl}/notifications/1/read`, { method: 'PUT' }).then((response) => response.json())
    assert.equal(repeated.changed, false)
    assert.equal((await fetch(`${context.baseUrl}/notifications/5/read`, { method: 'PUT' })).status, 404)

    const batchRead = await fetch(`${context.baseUrl}/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: '轻微', readState: 'unread' }),
    }).then((response) => response.json())
    assert.equal(batchRead.changed, 1)

    const batchClear = await fetch(`${context.baseUrl}/notifications/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity: '重大', readState: 'unread' }),
    }).then((response) => response.json())
    assert.equal(batchClear.changed, 1)
    assert.equal(db.prepare('SELECT cleared_at FROM account_alert_notifications WHERE user_id = ? AND event_id = 3').get('account-one').cleared_at, null)
    assert.notEqual(db.prepare('SELECT cleared_at FROM account_alert_notifications WHERE user_id = ? AND event_id = 4').get('account-one').cleared_at, null)

    assert.equal((await fetch(`${context.baseUrl}/notifications/3`, { method: 'DELETE' })).status, 200)
    assert.equal((await fetch(`${context.baseUrl}/notifications/3`, { method: 'DELETE' })).status, 404)
    assert.equal((await fetch(`${context.baseUrl}/notifications/5`, { method: 'DELETE' })).status, 404)

    const remaining = await fetch(`${context.baseUrl}/notifications`).then((response) => response.json())
    assert.deepEqual(remaining.notifications.map((item) => item.notificationId), [2, 1])
    assert.equal(remaining.counts.total, 2)
    assert.equal(remaining.counts.unread, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM alert_notification_events').get().count, 5)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_alert_notifications WHERE user_id = 'account-two'").get().count, 1)
    assert.deepEqual(context.notificationChanges, [
      { userId: 'account-one', action: 'read' },
      { userId: 'account-one', action: 'read' },
      { userId: 'account-one', action: 'clear' },
      { userId: 'account-one', action: 'clear' },
    ])

    assert.equal((await fetch(`${context.baseUrl}/notifications/0/read`, { method: 'PUT' })).status, 400)
    assert.equal((await fetch(`${context.baseUrl}/notifications/clear`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readState: 'read' }),
    })).status, 400)
  } finally { context.server.close(); db.close() }
})

test('offline summary REST lease is single-claim, confirm is idempotence-safe, and range filters are enforced', async () => {
  const db = new Database(':memory:')
  const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), {
    db,
    userId: 'account-one',
  })
  seedNotification(db, { eventId: 1, userId: 'account-one', severity: '轻微', createdOffline: true })
  seedNotification(db, { eventId: 2, userId: 'account-one', severity: '重大', createdOffline: false })
  seedNotification(db, { eventId: 3, userId: 'account-one', severity: '紧急', createdOffline: true })
  try {
    const claim = await fetch(`${context.baseUrl}/notifications/offline-summary/claim`, { method: 'POST' }).then((response) => response.json())
    assert.equal(claim.summary.total, 2)
    assert.deepEqual(claim.summary.bySeverity, { 轻微: 1, 重大: 0, 紧急: 1 })
    const concurrent = await fetch(`${context.baseUrl}/notifications/offline-summary/claim`, { method: 'POST' }).then((response) => response.json())
    assert.equal(concurrent.summary, null)
    assert.equal(concurrent.claimInProgress, true)

    const ranged = await fetch(`${context.baseUrl}/notifications?offlineAfterId=0&throughId=3`).then((response) => response.json())
    assert.deepEqual(ranged.notifications.map((item) => item.notificationId), [3, 1])
    assert.equal(ranged.counts.filteredTotal, 2)
    assert.equal((await fetch(`${context.baseUrl}/notifications?offlineAfterId=0`)).status, 400)

    const confirm = await fetch(`${context.baseUrl}/notifications/offline-summary/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimToken: claim.summary.claimToken }),
    })
    assert.equal(confirm.status, 200)
    const repeated = await fetch(`${context.baseUrl}/notifications/offline-summary/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimToken: claim.summary.claimToken }),
    })
    assert.equal(repeated.status, 409)
    const afterRefresh = await fetch(`${context.baseUrl}/notifications/offline-summary/claim`, { method: 'POST' }).then((response) => response.json())
    assert.equal(afterRefresh.summary, null)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_alert_notifications WHERE read_at IS NULL").get().count, 3)
  } finally { context.server.close(); db.close() }
})

test('all four roles retain bounded, sanitized current-page exports and empty input remains rejected', async () => {
  const rows = Array.from({ length: 101 }, (_value, index) => ({
    occurredAt: `2026-08-30 ${index}`, severity: '轻微', name: `safe\u0000-row-${index}`,
    category: 'appAlerts', sourceHost: '10.0.0.8', status: '触发中', extra: 'not-exported',
  }))
  for (const role of ['basic', 'standard', 'auditor', 'admin']) {
    const context = await startTestServer(async () => ({ alerts: [], availableCount: 0, hasMore: false }), { role })
    try {
      const empty = await fetch(`${context.baseUrl}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [] }),
      })
      assert.equal(empty.status, 400, `${role} empty export`)
      const exported = await fetch(`${context.baseUrl}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }),
      })
      assert.equal(exported.status, 200, `${role} export`)
      const sheet = new AdmZip(Buffer.from(await exported.arrayBuffer())).readAsText('xl/worksheets/sheet1.xml')
      assert.equal((sheet.match(/<row /g) || []).length, 101, `${role} header plus 100 rows`)
      assert.match(sheet, /safe-row-0/)
      assert.doesNotMatch(sheet, /extra/)
    } finally { context.server.close(); context.db.close() }
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
