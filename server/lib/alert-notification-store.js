import { readAlertNotificationPreferences } from './alert-notification-preferences.js'
import { resolveEffectiveModulePermissions } from './module-permissions.js'
import { persistProcessedAlertCursor, readAlertStreamState } from './alert-stream-state.js'

const ACTIONS = new Set(['triggered', 'recovered'])
const SEVERITIES = new Set(['轻微', '重大', '紧急'])
const NOTIFICATION_SETTING = Object.freeze({
  轻微: 'minorNotificationEnabled',
  重大: 'majorNotificationEnabled',
  紧急: 'criticalNotificationEnabled',
})
const NOTIFICATION_SEVERITIES = Object.freeze(['轻微', '重大', '紧急'])

function safeText(value, maxLength, fallback = '') {
  const normalized = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return (normalized || fallback).slice(0, maxLength)
}

function nullableText(value, maxLength) {
  const normalized = safeText(value, maxLength)
  return normalized || null
}

function safeTimestamp(value, fallback) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName))
}

export function projectSafeAlertNotificationPayload(payload) {
  const severity = safeText(payload?.severity, 20)
  if (!SEVERITIES.has(severity)) throw new TypeError('alert_notification_severity_invalid')
  const occurredAtMs = safeTimestamp(payload?.occurredAt, Date.now())
  const metrics = Array.isArray(payload?.metrics)
    ? payload.metrics.slice(0, 50).map((metric) => ({
      name: safeText(metric?.name, 200),
      value: safeText(metric?.value, 200),
      unit: safeText(metric?.unit, 80),
    }))
    : []
  return {
    id: safeText(payload?.id, 240),
    occurredAt: new Date(occurredAtMs).toISOString(),
    sourceHost: safeText(payload?.sourceHost, 160, '未记录'),
    category: safeText(payload?.category, 100, 'unknown'),
    categoryLabel: safeText(payload?.categoryLabel, 160, '未知类型'),
    severity,
    name: safeText(payload?.name, 500, '未命名告警'),
    ruleId: Number.isSafeInteger(Number(payload?.ruleId)) ? Number(payload.ruleId) : 0,
    metrics,
    description: nullableText(payload?.description, 2_000),
    triggerCondition: nullableText(payload?.triggerCondition, 2_000),
    groupPath: nullableText(payload?.groupPath, 1_000),
    ...(nullableText(payload?.alertNumber, 120) ? { alertNumber: nullableText(payload.alertNumber, 120) } : {}),
    startTime: nullableText(payload?.startTime, 120),
    endTime: nullableText(payload?.endTime, 120),
    eventId: nullableText(payload?.eventId, 240),
    restored: Boolean(payload?.restored),
  }
}

export function migrateAlertNotificationStore(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_notification_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        receiver_generation INTEGER NOT NULL CHECK (receiver_generation >= 1),
        stream_sequence INTEGER NOT NULL CHECK (stream_sequence >= 1),
        alert_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('triggered', 'recovered')),
        severity TEXT NOT NULL CHECK (severity IN ('轻微', '重大', '紧急')),
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        safe_payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(receiver_generation, stream_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_alert_notification_events_occurred
        ON alert_notification_events(occurred_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_notification_events_severity
        ON alert_notification_events(severity, event_id DESC);
      CREATE INDEX IF NOT EXISTS idx_alert_notification_events_alert_id
        ON alert_notification_events(alert_id, event_id DESC);

      CREATE TABLE IF NOT EXISTS account_alert_notifications (
        user_id TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        read_at INTEGER,
        cleared_at INTEGER,
        created_offline INTEGER NOT NULL DEFAULT 1 CHECK (created_offline IN (0, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_account_alert_notifications_visible
        ON account_alert_notifications(user_id, event_id DESC)
        WHERE cleared_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_account_alert_notifications_unread
        ON account_alert_notifications(user_id, event_id DESC)
        WHERE cleared_at IS NULL AND read_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_account_alert_notifications_offline
        ON account_alert_notifications(user_id, event_id)
        WHERE created_offline = 1;

      CREATE TABLE IF NOT EXISTS account_alert_notification_state (
        user_id TEXT PRIMARY KEY,
        summary_confirmed_through INTEGER NOT NULL DEFAULT 0 CHECK (summary_confirmed_through >= 0),
        summary_claimed_through INTEGER CHECK (summary_claimed_through IS NULL OR summary_claimed_through >= 0),
        claim_token TEXT,
        claim_expires_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `)
  })()
}

function activeNotificationRecipients(db, severity) {
  const setting = NOTIFICATION_SETTING[severity]
  if (!setting) return []
  const users = db.prepare(`
    SELECT id, username, role, status, is_initial_admin, must_change_password, permission_version
    FROM users
    WHERE status = 'active'
    ORDER BY id
  `).all()
  return users.filter((user) => {
    const permissions = resolveEffectiveModulePermissions(db, user)
    if (permissions.effectiveModules['alerts.notifications'] !== true) return false
    const preferences = readAlertNotificationPreferences(db, user.id)
    return preferences.realtimeEnabled === true && preferences[setting] === true
  })
}

export function persistAlertNotificationEvent(db, {
  streamSequence,
  action,
  payload,
  receiverReceivedAt,
  isUserOnline = () => false,
  now = Date.now(),
} = {}) {
  const sequence = Number(streamSequence)
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('alert_notification_stream_sequence_invalid')
  if (!ACTIONS.has(action)) throw new TypeError('alert_notification_action_invalid')
  const safePayload = projectSafeAlertNotificationPayload(payload)
  if (!safePayload.id) throw new TypeError('alert_notification_alert_id_invalid')
  const timestamp = Number.isSafeInteger(Number(now)) ? Number(now) : Date.now()
  const occurredAt = safeTimestamp(safePayload.occurredAt, timestamp)
  const receivedAt = safeTimestamp(receiverReceivedAt, timestamp)

  return db.transaction(() => {
    const streamState = readAlertStreamState(db)
    const generation = streamState.receiverGeneration
    const existing = db.prepare(`
      SELECT event_id FROM alert_notification_events
      WHERE receiver_generation = ? AND stream_sequence = ?
    `).get(generation, sequence)
    if (existing) {
      if ((streamState.resumeCursor === null || streamState.resumeCursor < sequence)
        && !persistProcessedAlertCursor(db, sequence, { now: timestamp })) {
        throw new Error('alert_notification_cursor_not_advanced')
      }
      return { inserted: false, eventId: Number(existing.event_id), receiverGeneration: generation, payload: safePayload, recipients: [] }
    }

    const inserted = db.prepare(`
      INSERT INTO alert_notification_events (
        receiver_generation, stream_sequence, alert_id, action, severity,
        occurred_at, received_at, safe_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generation,
      sequence,
      safePayload.id,
      action,
      safePayload.severity,
      occurredAt,
      receivedAt,
      JSON.stringify(safePayload),
      timestamp,
    )
    const eventId = Number(inserted.lastInsertRowid)
    const recipients = []
    const insertAccountNotification = db.prepare(`
      INSERT INTO account_alert_notifications (
        user_id, event_id, created_offline, created_at
      ) VALUES (?, ?, ?, ?)
    `)
    const ensureState = db.prepare(`
      INSERT OR IGNORE INTO account_alert_notification_state (
        user_id, summary_confirmed_through, updated_at
      ) VALUES (?, 0, ?)
    `)
    for (const user of activeNotificationRecipients(db, safePayload.severity)) {
      let online = false
      try {
        online = isUserOnline(user.id, receivedAt) === true
      } catch {
        online = false
      }
      insertAccountNotification.run(user.id, eventId, online ? 0 : 1, timestamp)
      ensureState.run(user.id, timestamp)
      recipients.push({ userId: user.id, createdOffline: !online })
    }
    if (!persistProcessedAlertCursor(db, sequence, { now: timestamp })) {
      throw new Error('alert_notification_cursor_not_advanced')
    }
    return { inserted: true, eventId, receiverGeneration: generation, payload: safePayload, recipients }
  })()
}

function buildAccountNotificationWhere(userId, {
  severity = null,
  unreadOnly = false,
  beforeEventId = null,
  offlineAfterEventId = null,
  throughEventId = null,
} = {}) {
  const clauses = ['n.user_id = ?', 'n.cleared_at IS NULL']
  const params = [String(userId)]
  if (severity !== null) {
    if (!SEVERITIES.has(severity)) throw new TypeError('alert_notification_severity_invalid')
    clauses.push('e.severity = ?')
    params.push(severity)
  }
  if (unreadOnly) clauses.push('n.read_at IS NULL')
  if (beforeEventId !== null) {
    const before = Number(beforeEventId)
    if (!Number.isSafeInteger(before) || before < 1) throw new TypeError('alert_notification_before_id_invalid')
    clauses.push('n.event_id < ?')
    params.push(before)
  }
  if (offlineAfterEventId !== null || throughEventId !== null) {
    const after = Number(offlineAfterEventId)
    const through = Number(throughEventId)
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < 1 || through <= after) {
      throw new TypeError('alert_notification_offline_range_invalid')
    }
    clauses.push('n.created_offline = 1', 'n.event_id > ?', 'n.event_id <= ?')
    params.push(after, through)
  }
  return { sql: clauses.join(' AND '), params }
}

function parseNotificationRow(row) {
  let payload
  try {
    payload = JSON.parse(row.safe_payload_json)
  } catch {
    throw new Error('alert_notification_payload_invalid')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('alert_notification_payload_invalid')
  }
  return {
    type: 'alert',
    notificationId: Number(row.event_id),
    action: row.action,
    cursor: Number(row.stream_sequence),
    receiverGeneration: Number(row.receiver_generation),
    payload,
    read: row.read_at !== null,
    readAt: row.read_at === null ? null : Number(row.read_at),
    createdOffline: Boolean(row.created_offline),
    createdAt: Number(row.account_created_at),
    receivedAt: Number(row.received_at),
  }
}

function emptySeverityCounts() {
  return Object.fromEntries(NOTIFICATION_SEVERITIES.map((severity) => [severity, { total: 0, unread: 0 }]))
}

export function listAlertNotifications(db, {
  userId,
  severity = null,
  unreadOnly = false,
  beforeEventId = null,
  offlineAfterEventId = null,
  throughEventId = null,
  limit = 30,
} = {}) {
  const normalizedLimit = Number(limit)
  if (!String(userId || '').trim()) throw new TypeError('alert_notification_user_id_invalid')
  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 100) {
    throw new TypeError('alert_notification_limit_invalid')
  }
  return db.transaction(() => {
    const pageWhere = buildAccountNotificationWhere(userId, {
      severity,
      unreadOnly,
      beforeEventId,
      offlineAfterEventId,
      throughEventId,
    })
    const rows = db.prepare(`
      SELECT
        n.event_id, n.read_at, n.created_offline, n.created_at AS account_created_at,
        e.receiver_generation, e.stream_sequence, e.action, e.received_at, e.safe_payload_json
      FROM account_alert_notifications n
      JOIN alert_notification_events e ON e.event_id = n.event_id
      WHERE ${pageWhere.sql}
      ORDER BY n.event_id DESC
      LIMIT ?
    `).all(...pageWhere.params, normalizedLimit + 1)
    const hasMore = rows.length > normalizedLimit
    const notifications = rows.slice(0, normalizedLimit).map(parseNotificationRow)

    const severityCounts = emptySeverityCounts()
    for (const row of db.prepare(`
      SELECT e.severity, COUNT(*) AS total,
        SUM(CASE WHEN n.read_at IS NULL THEN 1 ELSE 0 END) AS unread
      FROM account_alert_notifications n
      JOIN alert_notification_events e ON e.event_id = n.event_id
      WHERE n.user_id = ? AND n.cleared_at IS NULL
      GROUP BY e.severity
    `).all(String(userId))) {
      if (!SEVERITIES.has(row.severity)) continue
      severityCounts[row.severity] = { total: Number(row.total), unread: Number(row.unread || 0) }
    }
    const total = Object.values(severityCounts).reduce((sum, count) => sum + count.total, 0)
    const unread = Object.values(severityCounts).reduce((sum, count) => sum + count.unread, 0)
    const countWhere = buildAccountNotificationWhere(userId, {
      severity,
      unreadOnly,
      offlineAfterEventId,
      throughEventId,
    })
    const filtered = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN n.read_at IS NULL THEN 1 ELSE 0 END) AS unread
      FROM account_alert_notifications n
      JOIN alert_notification_events e ON e.event_id = n.event_id
      WHERE ${countWhere.sql}
    `).get(...countWhere.params)
    const snapshot = db.prepare(`
      SELECT COALESCE(MAX(event_id), 0) AS through_id
      FROM account_alert_notifications
      WHERE user_id = ? AND cleared_at IS NULL
    `).get(String(userId))
    return {
      notifications,
      counts: {
        total,
        unread,
        filteredTotal: Number(filtered.total || 0),
        filteredUnread: Number(filtered.unread || 0),
        bySeverity: severityCounts,
      },
      page: {
        limit: normalizedLimit,
        hasMore,
        nextBeforeId: hasMore && notifications.length
          ? notifications[notifications.length - 1].notificationId
          : null,
        snapshotThroughId: Number(snapshot.through_id || 0),
      },
    }
  })()
}

function existingVisibleNotification(db, userId, eventId) {
  return db.prepare(`
    SELECT event_id, read_at FROM account_alert_notifications
    WHERE user_id = ? AND event_id = ? AND cleared_at IS NULL
  `).get(String(userId), eventId)
}

export function markAlertNotificationRead(db, userId, eventId, { now = Date.now() } = {}) {
  const normalizedId = Number(eventId)
  if (!Number.isSafeInteger(normalizedId) || normalizedId < 1) throw new TypeError('alert_notification_event_id_invalid')
  return db.transaction(() => {
    const existing = existingVisibleNotification(db, userId, normalizedId)
    if (!existing) return null
    const result = db.prepare(`
      UPDATE account_alert_notifications
      SET read_at = ?
      WHERE user_id = ? AND event_id = ? AND cleared_at IS NULL AND read_at IS NULL
    `).run(now, String(userId), normalizedId)
    return {
      notificationId: normalizedId,
      changed: result.changes === 1,
      readAt: result.changes === 1 ? Number(now) : Number(existing.read_at),
    }
  })()
}

function buildBatchMutationWhere(userId, {
  severity = null,
  unreadOnly = false,
  offlineAfterEventId = null,
  throughEventId = null,
} = {}) {
  const clauses = ['user_id = ?', 'cleared_at IS NULL']
  const params = [String(userId)]
  if (unreadOnly) clauses.push('read_at IS NULL')
  if (severity !== null) {
    if (!SEVERITIES.has(severity)) throw new TypeError('alert_notification_severity_invalid')
    clauses.push('event_id IN (SELECT event_id FROM alert_notification_events WHERE severity = ?)')
    params.push(severity)
  }
  if (offlineAfterEventId !== null || throughEventId !== null) {
    const after = Number(offlineAfterEventId)
    const through = Number(throughEventId)
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(through) || through < 1 || through <= after) {
      throw new TypeError('alert_notification_offline_range_invalid')
    }
    clauses.push('created_offline = 1', 'event_id > ?', 'event_id <= ?')
    params.push(after, through)
  }
  return { sql: clauses.join(' AND '), params }
}

export function markAlertNotificationsRead(db, userId, filters = {}, { now = Date.now() } = {}) {
  const where = buildBatchMutationWhere(userId, filters)
  return db.prepare(`
    UPDATE account_alert_notifications
    SET read_at = ?
    WHERE ${where.sql} AND read_at IS NULL
  `).run(now, ...where.params).changes
}

export function clearAlertNotification(db, userId, eventId, { now = Date.now() } = {}) {
  const normalizedId = Number(eventId)
  if (!Number.isSafeInteger(normalizedId) || normalizedId < 1) throw new TypeError('alert_notification_event_id_invalid')
  return db.prepare(`
    UPDATE account_alert_notifications
    SET cleared_at = ?
    WHERE user_id = ? AND event_id = ? AND cleared_at IS NULL
  `).run(now, String(userId), normalizedId).changes === 1
}

export function clearAlertNotifications(db, userId, filters = {}, { now = Date.now() } = {}) {
  const where = buildBatchMutationWhere(userId, filters)
  return db.prepare(`
    UPDATE account_alert_notifications
    SET cleared_at = ?
    WHERE ${where.sql}
  `).run(now, ...where.params).changes
}

export function claimOfflineAlertSummary(db, userId, {
  claimToken,
  now = Date.now(),
  leaseMs = 30_000,
} = {}) {
  const token = safeText(claimToken, 200)
  if (!token) throw new TypeError('alert_notification_claim_token_invalid')
  const timestamp = Number(now)
  const lease = Number(leaseMs)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isSafeInteger(lease) || lease < 1_000 || lease > 300_000) {
    throw new TypeError('alert_notification_claim_time_invalid')
  }
  return db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO account_alert_notification_state (
        user_id, summary_confirmed_through, updated_at
      ) VALUES (?, 0, ?)
    `).run(String(userId), timestamp)
    const state = db.prepare(`
      SELECT summary_confirmed_through, summary_claimed_through, claim_token, claim_expires_at
      FROM account_alert_notification_state WHERE user_id = ?
    `).get(String(userId))
    if (state.claim_token && Number(state.claim_expires_at || 0) > timestamp) {
      return { summary: null, claimInProgress: true, retryAfter: Number(state.claim_expires_at) }
    }
    const afterId = Number(state.summary_confirmed_through || 0)
    const latest = db.prepare(`
      SELECT COALESCE(MAX(event_id), 0) AS through_id
      FROM account_alert_notifications
      WHERE user_id = ? AND created_offline = 1 AND event_id > ?
    `).get(String(userId), afterId)
    const throughId = Number(latest.through_id || 0)
    if (throughId <= afterId) {
      db.prepare(`
        UPDATE account_alert_notification_state
        SET summary_claimed_through = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE user_id = ?
      `).run(timestamp, String(userId))
      return { summary: null, claimInProgress: false, retryAfter: null }
    }
    const counts = emptySeverityCounts()
    for (const row of db.prepare(`
      SELECT e.severity, COUNT(*) AS total
      FROM account_alert_notifications n
      JOIN alert_notification_events e ON e.event_id = n.event_id
      WHERE n.user_id = ? AND n.created_offline = 1 AND n.cleared_at IS NULL
        AND n.event_id > ? AND n.event_id <= ?
      GROUP BY e.severity
    `).all(String(userId), afterId, throughId)) {
      if (SEVERITIES.has(row.severity)) counts[row.severity].total = Number(row.total || 0)
    }
    const total = Object.values(counts).reduce((sum, count) => sum + count.total, 0)
    if (total === 0) {
      db.prepare(`
        UPDATE account_alert_notification_state
        SET summary_confirmed_through = ?, summary_claimed_through = NULL,
            claim_token = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE user_id = ?
      `).run(throughId, timestamp, String(userId))
      return { summary: null, claimInProgress: false, retryAfter: null }
    }
    const expiresAt = timestamp + lease
    db.prepare(`
      UPDATE account_alert_notification_state
      SET summary_claimed_through = ?, claim_token = ?, claim_expires_at = ?, updated_at = ?
      WHERE user_id = ?
    `).run(throughId, token, expiresAt, timestamp, String(userId))
    return {
      summary: {
        claimToken: token,
        afterId,
        throughId,
        total,
        bySeverity: Object.fromEntries(NOTIFICATION_SEVERITIES.map((severity) => [severity, counts[severity].total])),
        expiresAt,
      },
      claimInProgress: false,
      retryAfter: null,
    }
  })()
}

export function confirmOfflineAlertSummary(db, userId, claimToken, { now = Date.now() } = {}) {
  const token = safeText(claimToken, 200)
  if (!token) throw new TypeError('alert_notification_claim_token_invalid')
  return db.transaction(() => {
    const state = db.prepare(`
      SELECT summary_confirmed_through, summary_claimed_through, claim_token
      FROM account_alert_notification_state WHERE user_id = ?
    `).get(String(userId))
    if (!state || state.claim_token !== token || state.summary_claimed_through === null) return null
    const confirmedThrough = Math.max(
      Number(state.summary_confirmed_through || 0),
      Number(state.summary_claimed_through || 0),
    )
    db.prepare(`
      UPDATE account_alert_notification_state
      SET summary_confirmed_through = ?, summary_claimed_through = NULL,
          claim_token = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE user_id = ? AND claim_token = ?
    `).run(confirmedThrough, now, String(userId), token)
    return { confirmedThrough }
  })()
}

export function deleteAlertNotificationsForUser(db, userId) {
  let deleted = 0
  if (tableExists(db, 'account_alert_notifications')) {
    deleted += db.prepare('DELETE FROM account_alert_notifications WHERE user_id = ?').run(userId).changes
  }
  if (tableExists(db, 'account_alert_notification_state')) {
    deleted += db.prepare('DELETE FROM account_alert_notification_state WHERE user_id = ?').run(userId).changes
  }
  return deleted
}

export const __test__ = { ACTIONS, SEVERITIES, NOTIFICATION_SETTING, safeTimestamp, buildAccountNotificationWhere }
