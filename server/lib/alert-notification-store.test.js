import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateAlertNotificationPreferences, saveAlertNotificationPreferences } from './alert-notification-preferences.js'
import {
  claimOfflineAlertSummary,
  confirmOfflineAlertSummary,
  deleteAlertNotificationsForUser,
  migrateAlertNotificationStore,
  persistAlertNotificationEvent,
} from './alert-notification-store.js'
import { migrateAlertStreamState, persistAlertStreamBaseline, persistAlertStreamRebaseline, readAlertStreamState } from './alert-stream-state.js'
import { migrateModulePermissions } from './module-permissions.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      is_initial_admin INTEGER NOT NULL DEFAULT 0,
      must_change_password INTEGER NOT NULL DEFAULT 0
    )
  `)
  migrateAlertStreamState(db)
  migrateAlertNotificationPreferences(db)
  migrateModulePermissions(db)
  migrateAlertNotificationStore(db)
  persistAlertStreamBaseline(db, 0, { now: 1 })
  return db
}

function addUser(db, id, { role = 'standard', status = 'active', initial = false } = {}) {
  db.prepare(`
    INSERT INTO users (
      id, username, role, status, is_initial_admin, must_change_password, permission_version
    ) VALUES (?, ?, ?, ?, ?, 0, 0)
  `).run(id, id, role, status, initial ? 1 : 0)
}

function payload(id = 'alert-1', severity = '重大') {
  return {
    id,
    occurredAt: '2026-09-02T01:02:03.000Z',
    sourceHost: '198.51.100.10',
    category: 'appAlerts',
    categoryLabel: '应用告警',
    severity,
    name: '连接超时',
    ruleId: 7,
    metrics: [{ name: '时延', value: '300', unit: 'ms' }],
    description: '安全展示字段',
    triggerCondition: '时延大于阈值',
    groupPath: '业务/应用',
    restored: false,
  }
}

test('creates the three durable notification tables and query indexes idempotently', () => {
  const db = createDb()
  migrateAlertNotificationStore(db)
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'alert_notification_events',
      'account_alert_notifications',
      'account_alert_notification_state'
    ) ORDER BY name
  `).all().map((row) => row.name)
  assert.deepEqual(tables, [
    'account_alert_notification_state',
    'account_alert_notifications',
    'alert_notification_events',
  ])
  const indexes = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN (
      'alert_notification_events', 'account_alert_notifications'
    )
  `).all().map((row) => row.name))
  for (const name of [
    'idx_alert_notification_events_occurred',
    'idx_alert_notification_events_severity',
    'idx_alert_notification_events_alert_id',
    'idx_account_alert_notifications_visible',
    'idx_account_alert_notifications_unread',
    'idx_account_alert_notifications_offline',
  ]) assert.equal(indexes.has(name), true, name)
  db.close()
})

test('uses effective module permission and account settings to select recipients', () => {
  const db = createDb()
  addUser(db, 'online')
  addUser(db, 'offline')
  addUser(db, 'denied')
  addUser(db, 'disabled')
  addUser(db, 'inactive', { status: 'inactive' })
  db.prepare(`
    INSERT INTO user_module_permission_overrides (
      user_id, module_key, effect, updated_by, created_at, updated_at
    ) VALUES ('denied', 'alerts.notifications', 'deny', 'admin', 1, 1)
  `).run()
  saveAlertNotificationPreferences(db, 'disabled', {
    realtimeEnabled: true,
    soundEnabled: true,
    minorPopupEnabled: true,
    minorNotificationEnabled: true,
    majorPopupEnabled: true,
    majorNotificationEnabled: false,
    criticalPopupEnabled: true,
    criticalNotificationEnabled: true,
  }, 1)

  const result = persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload(),
    receiverReceivedAt: '2026-09-02T01:02:04.000Z',
    isUserOnline: (userId) => userId === 'online',
    now: 2,
  })

  assert.deepEqual(result.recipients, [
    { userId: 'offline', createdOffline: true },
    { userId: 'online', createdOffline: false },
  ])
  assert.deepEqual(db.prepare(`
    SELECT user_id, created_offline FROM account_alert_notifications ORDER BY user_id
  `).all(), [
    { user_id: 'offline', created_offline: 1 },
    { user_id: 'online', created_offline: 0 },
  ])
  assert.equal(readAlertStreamState(db).lastProcessedCursor, 1)
  db.close()
})

test('deduplicates a Receiver sequence but keeps separate actions sharing one alert id', () => {
  const db = createDb()
  addUser(db, 'account')
  const first = persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload('same-alert'),
    now: 2,
  })
  const duplicate = persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload('same-alert'),
    now: 3,
  })
  const recoveredPayload = { ...payload('same-alert'), restored: true }
  const recovered = persistAlertNotificationEvent(db, {
    streamSequence: 2,
    action: 'recovered',
    payload: recoveredPayload,
    now: 4,
  })
  assert.equal(first.inserted, true)
  assert.equal(duplicate.inserted, false)
  assert.equal(duplicate.eventId, first.eventId)
  assert.equal(recovered.inserted, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM alert_notification_events').get().count, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_alert_notifications').get().count, 2)
  assert.equal(readAlertStreamState(db).lastProcessedCursor, 2)
  db.close()
})

test('rolls back event, recipients and cursor together when an account row cannot be written', () => {
  const db = createDb()
  addUser(db, 'account')
  db.exec(`
    CREATE TRIGGER reject_alert_notification_recipient
    BEFORE INSERT ON account_alert_notifications
    BEGIN
      SELECT RAISE(ABORT, 'test recipient failure');
    END;
  `)
  assert.throws(() => persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload(),
    now: 2,
  }), /test recipient failure/)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM alert_notification_events').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_alert_notifications').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_alert_notification_state').get().count, 0)
  assert.equal(readAlertStreamState(db).resumeCursor, 0)
  assert.equal(readAlertStreamState(db).lastProcessedCursor, null)
  db.close()
})

test('uses a new Receiver generation after reset so sequence numbers may restart safely', () => {
  const db = createDb()
  addUser(db, 'account')
  persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload('before-reset'),
    now: 2,
  })
  persistAlertStreamRebaseline(db, {
    state: 'receiver_reset',
    latestSequence: 0,
    oldestAvailableSequence: 0,
    errorCode: 'ALERT_CURSOR_AHEAD',
    now: 3,
  })
  persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload('after-reset'),
    now: 4,
  })
  assert.deepEqual(db.prepare(`
    SELECT receiver_generation, stream_sequence, alert_id
    FROM alert_notification_events ORDER BY event_id
  `).all(), [
    { receiver_generation: 1, stream_sequence: 1, alert_id: 'before-reset' },
    { receiver_generation: 2, stream_sequence: 1, alert_id: 'after-reset' },
  ])
  assert.equal(readAlertStreamState(db).receiverGeneration, 2)
  db.close()
})

test('deleting an account removes only its notification rows and summary state', () => {
  const db = createDb()
  addUser(db, 'one')
  addUser(db, 'two')
  persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload(),
    now: 2,
  })
  assert.equal(deleteAlertNotificationsForUser(db, 'one'), 2)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_alert_notifications WHERE user_id = 'one'").get().count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_alert_notification_state WHERE user_id = 'one'").get().count, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_alert_notifications WHERE user_id = 'two'").get().count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM alert_notification_events').get().count, 1)
  db.close()
})

test('claims one offline summary across tabs, confirms its own waterline, and never marks notifications read', () => {
  const db = createDb()
  addUser(db, 'account')
  for (const [sequence, severity] of [[1, '轻微'], [2, '重大'], [3, '紧急']]) {
    persistAlertNotificationEvent(db, {
      streamSequence: sequence,
      action: 'triggered',
      payload: payload(`alert-${sequence}`, severity),
      isUserOnline: () => false,
      now: sequence + 1,
    })
  }
  const first = claimOfflineAlertSummary(db, 'account', { claimToken: 'tab-one', now: 10, leaseMs: 5_000 })
  assert.deepEqual(first.summary, {
    claimToken: 'tab-one',
    afterId: 0,
    throughId: 3,
    total: 3,
    bySeverity: { 轻微: 1, 重大: 1, 紧急: 1 },
    expiresAt: 5_010,
  })
  const secondTab = claimOfflineAlertSummary(db, 'account', { claimToken: 'tab-two', now: 11, leaseMs: 5_000 })
  assert.equal(secondTab.summary, null)
  assert.equal(secondTab.claimInProgress, true)
  assert.equal(confirmOfflineAlertSummary(db, 'account', 'tab-two', { now: 12 }), null)
  assert.deepEqual(confirmOfflineAlertSummary(db, 'account', 'tab-one', { now: 13 }), { confirmedThrough: 3 })
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM account_alert_notifications
    WHERE user_id = 'account' AND read_at IS NULL
  `).get().count, 3)
  assert.equal(claimOfflineAlertSummary(db, 'account', { claimToken: 'refresh', now: 14 }).summary, null)
  db.close()
})

test('reclaims an expired summary lease and includes only new offline notifications after confirmation', () => {
  const db = createDb()
  addUser(db, 'account')
  persistAlertNotificationEvent(db, {
    streamSequence: 1,
    action: 'triggered',
    payload: payload('first', '重大'),
    isUserOnline: () => false,
    now: 2,
  })
  const expired = claimOfflineAlertSummary(db, 'account', { claimToken: 'expired', now: 10, leaseMs: 1_000 })
  assert.equal(expired.summary.total, 1)
  const reclaimed = claimOfflineAlertSummary(db, 'account', { claimToken: 'replacement', now: 1_011, leaseMs: 1_000 })
  assert.equal(reclaimed.summary.claimToken, 'replacement')
  assert.equal(confirmOfflineAlertSummary(db, 'account', 'expired', { now: 1_012 }), null)
  assert.deepEqual(confirmOfflineAlertSummary(db, 'account', 'replacement', { now: 1_013 }), { confirmedThrough: 1 })

  persistAlertNotificationEvent(db, {
    streamSequence: 2,
    action: 'triggered',
    payload: payload('online', '轻微'),
    isUserOnline: () => true,
    now: 2_000,
  })
  persistAlertNotificationEvent(db, {
    streamSequence: 3,
    action: 'triggered',
    payload: payload('new-offline', '紧急'),
    isUserOnline: () => false,
    now: 2_001,
  })
  const next = claimOfflineAlertSummary(db, 'account', { claimToken: 'next', now: 2_002 })
  assert.deepEqual(next.summary.bySeverity, { 轻微: 0, 重大: 0, 紧急: 1 })
  assert.equal(next.summary.afterId, 1)
  assert.equal(next.summary.throughId, 3)
  db.close()
})
