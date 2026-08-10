import { randomUUID } from 'crypto'

export const SESSION_RETENTION_POLICY_VERSION = 'gaiop_session_retention.v1'
export const SESSION_RETENTION_DAYS = 180
export const SESSION_RETENTION_GRACE_DAYS = 7
export const TEMP_ATTACHMENT_RETENTION_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000
const SESSION_LIST_KEYS = ['sessions', 'items', 'list', 'data']
const BLOCKING_RUN_STATUSES = new Set(['pending', 'queued', 'running', 'processing', 'streaming', 'in_progress'])
const RELIABLE_ACTIVITY_SOURCES = new Set([
  'conversationLastActivity',
  'lastInteractionAt',
  'lastMessageAt',
  'lastUserMessageAt',
  'lastAssistantMessageAt',
  'lastActivity',
])

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeText(value, limit = 1024) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value)
  }
  const text = normalizeText(value, 80)
  if (!text) return null
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text)
    if (Number.isFinite(number) && number > 0) return number < 10_000_000_000 ? Math.floor(number * 1000) : Math.floor(number)
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function positiveInteger(value, fallback, maximum = 10_000) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback
}

function extractSessionKey(value) {
  const row = asRecord(value)
  return normalizeText(row.key || row.sessionKey || row.id, 512)
}

function extractSessionRows(payload) {
  if (Array.isArray(payload)) return payload.filter((row) => extractSessionKey(row))
  const row = asRecord(payload)
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(row[key])) return row[key].filter((item) => extractSessionKey(item))
  }
  return extractSessionKey(row) ? [row] : []
}

function resolveLastActivity(value) {
  const row = asRecord(value)
  for (const key of [
    'lastInteractionAt',
    'lastMessageAt',
    'lastUserMessageAt',
    'lastAssistantMessageAt',
    'lastActivity',
  ]) {
    const timestamp = normalizeTimestamp(row[key])
    if (timestamp) return timestamp
  }
  const source = normalizeText(row.conversationLastActivitySource, 80)
  if (RELIABLE_ACTIVITY_SOURCES.has(source)) {
    return normalizeTimestamp(row.conversationLastActivity)
  }
  return null
}

function hasTruthySignal(row, keys) {
  return keys.some((key) => {
    const value = row[key]
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === 'object') return Object.keys(value).length > 0
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      return Boolean(normalized && normalized !== 'false' && normalized !== '0')
    }
    return value === true || (typeof value === 'number' && value > 0)
  })
}

function hasActiveOrPendingWork(value) {
  const row = asRecord(value)
  const status = normalizeText(row.runStatus || row.executionStatus || row.taskStatus, 40).toLowerCase()
  if (BLOCKING_RUN_STATUSES.has(status)) return true
  return hasTruthySignal(row, [
    'isRunning', 'isStreaming', 'inFlight', 'activeRun', 'activeRunId', 'activeRuns',
    'pendingTask', 'pendingTasks', 'hasPendingTask', 'hasPendingTasks',
    'pendingFinalDelivery', 'queuedMessages', 'pendingMessages',
  ])
}

function isMultiChannelShared(value) {
  const row = asRecord(value)
  if (row.shared === true || row.isShared === true || row.multiChannel === true) return true
  for (const key of ['channels', 'sourceChannels', 'deliveryContexts']) {
    if (Array.isArray(row[key]) && new Set(row[key].map((item) => JSON.stringify(item))).size > 1) return true
  }
  const sessionKey = extractSessionKey(row)
  return sessionKey === 'main' || sessionKey === 'agent:main:main'
}

function resolveOwnership(db, value) {
  const row = asRecord(value)
  const sessionKey = extractSessionKey(row)
  const workspace = sessionKey
    ? db.prepare('SELECT owner_user_id, status FROM workspace_sessions WHERE session_key = ?').get(sessionKey)
    : null
  if (workspace?.status === 'active' && normalizeText(workspace.owner_user_id, 200)) {
    return { reliable: true, ownerKind: 'workspace_user', ownerRef: normalizeText(workspace.owner_user_id, 200), sourceChannel: 'web' }
  }

  const originKind = normalizeText(row.originKind, 40).toLowerCase()
  const sourceChannel = normalizeText(row.sourceChannel || row.channel, 80).toLowerCase()
  const channelPeer = normalizeText(row.channelUserId || row.peer || row.channelUserName, 240)
  if (originKind === 'channel' && sourceChannel && sourceChannel !== 'main' && channelPeer) {
    return { reliable: true, ownerKind: 'channel_peer', ownerRef: channelPeer, sourceChannel }
  }
  return { reliable: false, ownerKind: null, ownerRef: null, sourceChannel: sourceChannel || null }
}

export function migrateSessionRetentionTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_retention_records (
      session_key TEXT PRIMARY KEY,
      retention_mode TEXT NOT NULL DEFAULT 'standard' CHECK (retention_mode IN ('standard', 'long_term')),
      lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'pending_delete', 'deleted')),
      owner_kind TEXT CHECK (owner_kind IS NULL OR owner_kind IN ('workspace_user', 'channel_peer')),
      owner_ref TEXT,
      source_channel TEXT,
      last_activity_at INTEGER,
      marked_at INTEGER,
      delete_after INTEGER,
      cancelled_activity_at INTEGER,
      deleted_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_retention_pending
      ON session_retention_records(lifecycle_state, delete_after, session_key);
    CREATE INDEX IF NOT EXISTS idx_session_retention_mode
      ON session_retention_records(retention_mode, updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_retention_attachments (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      attachment_ref TEXT NOT NULL,
      retention_class TEXT NOT NULL CHECK (retention_class IN ('follow_session', 'temporary')),
      ownership_state TEXT NOT NULL CHECK (ownership_state IN ('verified', 'unverified')),
      lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'pending_delete', 'gateway_cleanup_required', 'deleted')),
      registered_at INTEGER NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_key, attachment_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_session_retention_attachments_session
      ON session_retention_attachments(session_key, lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_session_retention_attachments_expiry
      ON session_retention_attachments(retention_class, expires_at, lifecycle_state);
  `)
}

export function getSessionRetention(db, sessionKey) {
  const key = normalizeText(sessionKey, 512)
  if (!key) return null
  return db.prepare('SELECT * FROM session_retention_records WHERE session_key = ?').get(key) || null
}

function retentionProjection(db, sessionKey) {
  const key = normalizeText(sessionKey, 512)
  const row = getSessionRetention(db, key)
  const attachments = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN lifecycle_state != 'deleted' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN ownership_state != 'verified' THEN 1 ELSE 0 END) AS unverified,
      SUM(CASE WHEN retention_class = 'temporary' AND lifecycle_state != 'deleted' THEN 1 ELSE 0 END) AS temporary
    FROM session_retention_attachments WHERE session_key = ?
  `).get(key)
  return {
    mode: row?.retention_mode || 'standard',
    status: row?.lifecycle_state || 'active',
    lastActivityAt: row?.last_activity_at || null,
    markedAt: row?.marked_at || null,
    deleteAfter: row?.delete_after || null,
    deletedAt: row?.deleted_at || null,
    attachmentCount: Number(attachments?.active || 0),
    unverifiedAttachmentCount: Number(attachments?.unverified || 0),
    temporaryAttachmentCount: Number(attachments?.temporary || 0),
    attachmentCleanupSupported: false,
  }
}

export function enrichSessionRetentionPayload(db, payload) {
  if (Array.isArray(payload)) {
    return payload.map((item) => ({ ...asRecord(item), retention: retentionProjection(db, extractSessionKey(item)) }))
  }
  const row = asRecord(payload)
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(row[key])) {
      return {
        ...row,
        [key]: row[key].map((item) => ({ ...asRecord(item), retention: retentionProjection(db, extractSessionKey(item)) })),
      }
    }
  }
  return extractSessionKey(row) ? { ...row, retention: retentionProjection(db, extractSessionKey(row)) } : payload
}

export function setLongTermRetention(db, sessionKey, enabled, now = Date.now()) {
  const key = normalizeText(sessionKey, 512)
  if (!key) throw new Error('session_key_required')
  const existing = getSessionRetention(db, key)
  const mode = enabled ? 'long_term' : 'standard'
  if (existing) {
    db.prepare(`
      UPDATE session_retention_records
      SET retention_mode = ?, lifecycle_state = 'active', marked_at = NULL, delete_after = NULL,
          deleted_at = NULL, updated_at = ?
      WHERE session_key = ?
    `).run(mode, now, key)
  } else {
    db.prepare(`
      INSERT INTO session_retention_records (session_key, retention_mode, lifecycle_state, updated_at)
      VALUES (?, ?, 'active', ?)
    `).run(key, mode, now)
  }
  db.prepare(`
    UPDATE session_retention_attachments SET lifecycle_state = 'active', updated_at = ?
    WHERE session_key = ? AND lifecycle_state = 'pending_delete'
  `).run(now, key)
  return retentionProjection(db, key)
}

export function cancelPendingDeletion(db, sessionKey, now = Date.now()) {
  const key = normalizeText(sessionKey, 512)
  if (!key) throw new Error('session_key_required')
  const result = db.prepare(`
    UPDATE session_retention_records
    SET lifecycle_state = 'active', cancelled_activity_at = last_activity_at,
        marked_at = NULL, delete_after = NULL, updated_at = ?
    WHERE session_key = ? AND lifecycle_state = 'pending_delete'
  `).run(now, key)
  if (result.changes !== 1) return null
  db.prepare(`
    UPDATE session_retention_attachments SET lifecycle_state = 'active', updated_at = ?
    WHERE session_key = ? AND lifecycle_state = 'pending_delete'
  `).run(now, key)
  return retentionProjection(db, key)
}

function normalizeAttachmentRef(value) {
  const ref = normalizeText(value, 1024).replaceAll('\\', '/')
  if (!ref || ref.includes('\0') || ref.startsWith('/') || /^[a-zA-Z]:/.test(ref)) return ''
  if (ref.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return ''
  return ref
}

export function registerSessionAttachment(db, {
  id = randomUUID(),
  sessionKey,
  attachmentRef,
  retentionClass = 'follow_session',
  createdAt = Date.now(),
  now = Date.now(),
} = {}) {
  const key = normalizeText(sessionKey, 512)
  const ref = normalizeAttachmentRef(attachmentRef)
  if (!key) throw new Error('session_key_required')
  if (!ref) throw new Error('attachment_ref_invalid')
  if (!['follow_session', 'temporary'].includes(retentionClass)) throw new Error('attachment_retention_class_invalid')
  const ownership = resolveOwnership(db, { key })
  const registeredAt = normalizeTimestamp(createdAt) || now
  const expiresAt = retentionClass === 'temporary'
    ? Math.min(registeredAt + TEMP_ATTACHMENT_RETENTION_DAYS * DAY_MS, now + TEMP_ATTACHMENT_RETENTION_DAYS * DAY_MS)
    : null
  db.prepare(`
    INSERT INTO session_retention_attachments (
      id, session_key, attachment_ref, retention_class, ownership_state,
      lifecycle_state, registered_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(session_key, attachment_ref) DO UPDATE SET
      retention_class = excluded.retention_class,
      ownership_state = excluded.ownership_state,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(
    normalizeText(id, 200) || randomUUID(), key, ref, retentionClass,
    ownership.reliable ? 'verified' : 'unverified', registeredAt, expiresAt, now,
  )
  return db.prepare(`
    SELECT id, session_key, attachment_ref, retention_class, ownership_state,
           lifecycle_state, registered_at, expires_at, updated_at
    FROM session_retention_attachments WHERE session_key = ? AND attachment_ref = ?
  `).get(key, ref)
}

export function getSessionAttachmentDeletionBlock(db, sessionKey) {
  const key = normalizeText(sessionKey, 512)
  const row = db.prepare(`
    SELECT COUNT(*) AS count,
      SUM(CASE WHEN ownership_state != 'verified' THEN 1 ELSE 0 END) AS unverified
    FROM session_retention_attachments
    WHERE session_key = ? AND lifecycle_state != 'deleted'
  `).get(key)
  const count = Number(row?.count || 0)
  if (count === 0) return { blocked: false, count: 0, reason: null }
  return {
    blocked: true,
    count,
    reason: Number(row?.unverified || 0) > 0 ? 'attachment_ownership_unverified' : 'attachment_delete_api_unavailable',
  }
}

function evaluateProtection(db, session, { now, retentionDays, existing } = {}) {
  const key = extractSessionKey(session)
  const reasons = []
  const lastActivityAt = resolveLastActivity(session)
  const ownership = resolveOwnership(db, session)
  if (!key) reasons.push('session_key_missing')
  if (!lastActivityAt) reasons.push('last_activity_missing')
  if (!ownership.reliable) reasons.push('ownership_unknown')
  if (isMultiChannelShared(session)) reasons.push('multi_channel_shared')
  if (hasActiveOrPendingWork(session)) reasons.push('active_or_pending_work')
  if (existing?.retention_mode === 'long_term') reasons.push('long_term')
  if (existing?.cancelled_activity_at && lastActivityAt && existing.cancelled_activity_at >= lastActivityAt) {
    reasons.push('manual_cancellation_holds_snapshot')
  }
  const cutoff = now - positiveInteger(retentionDays, SESSION_RETENTION_DAYS, 3650) * DAY_MS
  if (lastActivityAt && lastActivityAt >= cutoff) reasons.push('within_retention')
  return { key, reasons, lastActivityAt, ownership, cutoff }
}

function addReason(summary, reason) {
  summary.reasons[reason] = (summary.reasons[reason] || 0) + 1
  summary.skipped += 1
}

function addReasons(summary, reasons) {
  summary.skipped += 1
  for (const reason of new Set(reasons)) {
    summary.reasons[reason] = (summary.reasons[reason] || 0) + 1
  }
}

function markSessionPending(db, evaluated, { now, graceDays }) {
  const deleteAfter = now + positiveInteger(graceDays, SESSION_RETENTION_GRACE_DAYS, 365) * DAY_MS
  const existing = getSessionRetention(db, evaluated.key)
  if (existing) {
    db.prepare(`
      UPDATE session_retention_records
      SET lifecycle_state = 'pending_delete', owner_kind = ?, owner_ref = ?, source_channel = ?,
          last_activity_at = ?, marked_at = ?, delete_after = ?, deleted_at = NULL, updated_at = ?
      WHERE session_key = ? AND retention_mode = 'standard'
    `).run(
      evaluated.ownership.ownerKind, evaluated.ownership.ownerRef, evaluated.ownership.sourceChannel,
      evaluated.lastActivityAt, now, deleteAfter, now, evaluated.key,
    )
  } else {
    db.prepare(`
      INSERT INTO session_retention_records (
        session_key, retention_mode, lifecycle_state, owner_kind, owner_ref, source_channel,
        last_activity_at, marked_at, delete_after, updated_at
      ) VALUES (?, 'standard', 'pending_delete', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evaluated.key, evaluated.ownership.ownerKind, evaluated.ownership.ownerRef,
      evaluated.ownership.sourceChannel, evaluated.lastActivityAt, now, deleteAfter, now,
    )
  }
  db.prepare(`
    UPDATE session_retention_attachments SET lifecycle_state = 'pending_delete', updated_at = ?
    WHERE session_key = ? AND lifecycle_state = 'active'
  `).run(now, evaluated.key)
}

function markSessionDeleted(db, sessionKey, now, { pendingOnly = true } = {}) {
  const transaction = db.transaction(() => {
    const lifecycleFilter = pendingOnly ? " AND lifecycle_state = 'pending_delete'" : ''
    db.prepare(`
      UPDATE session_retention_records
      SET lifecycle_state = 'deleted', marked_at = NULL, delete_after = NULL, deleted_at = ?, updated_at = ?
      WHERE session_key = ?${lifecycleFilter}
    `).run(now, now, sessionKey)
    db.prepare(`
      UPDATE workspace_sessions
      SET status = 'deleted', deleted_at = ?, updated_at = ?
      WHERE session_key = ? AND status = 'active'
    `).run(now, now, sessionKey)
  })
  transaction()
}

export function markManualGatewaySessionDeleted(db, sessionKey, now = Date.now()) {
  const key = normalizeText(sessionKey, 512)
  if (!key) return null
  const existing = getSessionRetention(db, key)
  markSessionDeleted(db, key, now, { pendingOnly: false })
  return existing ? retentionProjection(db, key) : null
}

function audit(recordAuditEvent, event) {
  if (typeof recordAuditEvent !== 'function') return
  recordAuditEvent({
    user: { id: null, username: 'system', role: 'system' },
    category: 'session_retention', source: 'system',
    ...event,
  })
}

function safeGatewayErrorCode(error) {
  const code = normalizeText(error?.code, 80).toUpperCase()
  return /^[A-Z0-9_]+$/.test(code) ? code : 'GATEWAY_DELETE_FAILED'
}

export async function runSessionRetentionCycle({
  db,
  autoMark = false,
  autoDelete = false,
  now = Date.now(),
  retentionDays = SESSION_RETENTION_DAYS,
  graceDays = SESSION_RETENTION_GRACE_DAYS,
  maxItems = 50,
  listGatewaySessions,
  deleteGatewaySession,
  recordAuditEvent,
} = {}) {
  if (!db) throw new Error('database_required')
  const limit = positiveInteger(maxItems, 50, 500)
  const result = {
    policyVersion: SESSION_RETENTION_POLICY_VERSION,
    marking: { enabled: Boolean(autoMark), success: 0, skipped: 0, failed: 0, reasons: {} },
    deletion: { enabled: Boolean(autoDelete), success: 0, skipped: 0, failed: 0, reasons: {} },
    attachments: { dueTemporary: 0, protected: 0, reasons: {} },
  }

  if (!autoMark) addReason(result.marking, 'auto_mark_disabled')
  if (!autoDelete) addReason(result.deletion, 'auto_delete_disabled')

  let rows = null
  const readRows = async () => {
    if (rows) return rows
    if (typeof listGatewaySessions !== 'function') throw Object.assign(new Error('gateway_session_list_unavailable'), { code: 'GATEWAY_SESSION_LIST_UNAVAILABLE' })
    rows = extractSessionRows(await listGatewaySessions())
    return rows
  }

  if (autoMark) {
    try {
      const sessions = await readRows()
      for (const session of sessions) {
        if (result.marking.success >= limit) break
        const key = extractSessionKey(session)
        const existing = key ? getSessionRetention(db, key) : null
        if (existing?.lifecycle_state === 'pending_delete') {
          addReason(result.marking, 'already_pending')
          continue
        }
        const evaluated = evaluateProtection(db, session, { now, retentionDays, existing })
        if (evaluated.reasons.length > 0) {
          addReasons(result.marking, evaluated.reasons)
          continue
        }
        markSessionPending(db, evaluated, { now, graceDays })
        result.marking.success += 1
        audit(recordAuditEvent, {
          action: '会话进入待删除状态', target: evaluated.key, detail: '', result: 'success',
        })
      }
    } catch (error) {
      result.marking.failed += 1
      result.marking.reasons.gateway_list_failed = 1
      audit(recordAuditEvent, {
        action: '会话留存自动标记失败', target: 'gateway_sessions', detail: '', result: 'failed', errorCode: safeGatewayErrorCode(error),
      })
    }
  }

  if (autoDelete) {
    const pending = db.prepare(`
      SELECT * FROM session_retention_records
      WHERE lifecycle_state = 'pending_delete' AND delete_after IS NOT NULL AND delete_after <= ?
      ORDER BY delete_after ASC, session_key ASC LIMIT ?
    `).all(now, limit)
    if (pending.length > 0) try {
      const sessionMap = new Map((await readRows()).map((row) => [extractSessionKey(row), row]))
      for (const record of pending) {
        const session = sessionMap.get(record.session_key)
        if (!session) {
          addReason(result.deletion, 'gateway_session_missing')
          continue
        }
        const evaluated = evaluateProtection(db, session, { now, retentionDays, existing: record })
        const resumableReasons = [...evaluated.reasons]
        if (evaluated.lastActivityAt !== record.last_activity_at) resumableReasons.push('activity_changed_after_mark')
        const attachmentBlock = getSessionAttachmentDeletionBlock(db, record.session_key)
        if (attachmentBlock.blocked) resumableReasons.push(attachmentBlock.reason)
        if (resumableReasons.length > 0) {
          addReasons(result.deletion, resumableReasons)
          continue
        }
        if (typeof deleteGatewaySession !== 'function') {
          addReason(result.deletion, 'gateway_delete_unavailable')
          continue
        }
        try {
          await deleteGatewaySession(record.session_key)
          markSessionDeleted(db, record.session_key, now)
          result.deletion.success += 1
          audit(recordAuditEvent, {
            action: '到期会话删除完成', target: record.session_key, detail: '', result: 'success',
          })
        } catch (error) {
          result.deletion.failed += 1
          const code = safeGatewayErrorCode(error)
          result.deletion.reasons[code.toLowerCase()] = (result.deletion.reasons[code.toLowerCase()] || 0) + 1
          audit(recordAuditEvent, {
            action: '到期会话删除失败', target: record.session_key, detail: '', result: 'failed', errorCode: code,
          })
        }
      }
    } catch (error) {
      result.deletion.failed += 1
      result.deletion.reasons.gateway_list_failed = 1
      audit(recordAuditEvent, {
        action: '会话留存最终删除失败', target: 'gateway_sessions', detail: '', result: 'failed', errorCode: safeGatewayErrorCode(error),
      })
    }
  }

  const dueTemporary = db.prepare(`
    SELECT ownership_state, COUNT(*) AS count
    FROM session_retention_attachments
    WHERE retention_class = 'temporary' AND lifecycle_state != 'deleted'
      AND expires_at IS NOT NULL AND expires_at <= ?
    GROUP BY ownership_state
  `).all(now)
  for (const row of dueTemporary) {
    const count = Number(row.count || 0)
    result.attachments.dueTemporary += count
    result.attachments.protected += count
    const reason = row.ownership_state === 'verified' ? 'attachment_delete_api_unavailable' : 'attachment_ownership_unverified'
    result.attachments.reasons[reason] = (result.attachments.reasons[reason] || 0) + count
  }

  return result
}

export function listSessionRetentionOverview(db, { limit = 200 } = {}) {
  const safeLimit = positiveInteger(limit, 200, 500)
  const records = db.prepare(`
    SELECT session_key, retention_mode, lifecycle_state, owner_kind, source_channel,
           last_activity_at, marked_at, delete_after, deleted_at, updated_at
    FROM session_retention_records
    WHERE lifecycle_state = 'pending_delete' OR retention_mode = 'long_term'
    ORDER BY CASE lifecycle_state WHEN 'pending_delete' THEN 0 ELSE 1 END,
             COALESCE(delete_after, updated_at) ASC, session_key ASC
    LIMIT ?
  `).all(safeLimit)
  return records.map((row) => ({
    sessionKey: row.session_key,
    mode: row.retention_mode,
    status: row.lifecycle_state,
    ownerKind: row.owner_kind,
    sourceChannel: row.source_channel,
    lastActivityAt: row.last_activity_at,
    markedAt: row.marked_at,
    deleteAfter: row.delete_after,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at,
    ...retentionProjection(db, row.session_key),
  }))
}

export const __test__ = {
  DAY_MS,
  extractSessionRows,
  resolveLastActivity,
  hasActiveOrPendingWork,
  isMultiChannelShared,
  resolveOwnership,
  evaluateProtection,
  normalizeAttachmentRef,
}
