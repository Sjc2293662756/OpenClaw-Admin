import { randomUUID } from 'crypto'

const WEB_SESSION_PREFIX = 'agent:main:main:dm:webchat-'
const SESSION_LIST_KEYS = ['sessions', 'items', 'list', 'data']

export const SESSION_SCOPED_READ_METHODS = new Set([
  'sessions.history', 'session.history', 'chat.history',
  'sessions.get', 'session.get', 'sessions.export', 'session.export',
])

export const SESSION_SCOPED_WRITE_METHODS = new Set([
  'chat.send', 'chat.abort', 'agent.abort',
  'sessions.delete', 'session.delete', 'sessions.reset', 'session.reset',
  'sessions.patch', 'session.patch', 'agent.model.set',
])

export const SESSION_LIST_METHODS = new Set([
  'sessions.list', 'session.list', 'sessions.usage', 'usage.sessions',
])

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeSessionKey(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function getSessionKeyFromParams(params) {
  const row = asRecord(params)
  return normalizeSessionKey(row.sessionKey || row.key || row.session)
}

export function getOwnerPrincipal(user) {
  const id = normalizeSessionKey(user?.id)
  if (id) return id
  const username = normalizeSessionKey(user?.username)
  return username ? `legacy:${username}` : ''
}

export function isManagedWebSessionKey(value) {
  const key = normalizeSessionKey(value)
  return key.startsWith(WEB_SESSION_PREFIX) && /^[a-zA-Z0-9_-]{12,128}$/.test(key.slice(WEB_SESSION_PREFIX.length))
}

export function createWorkspaceSession(db, user, now = Date.now()) {
  const ownerUserId = getOwnerPrincipal(user)
  if (!ownerUserId) throw new Error('当前登录用户缺少稳定身份标识')
  const sessionKey = `${WEB_SESSION_PREFIX}${randomUUID().replace(/-/g, '')}`
  db.prepare(`
    INSERT INTO workspace_sessions (session_key, owner_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(sessionKey, ownerUserId, now, now)
  return sessionKey
}

export function findWorkspaceSession(db, sessionKey) {
  const key = normalizeSessionKey(sessionKey)
  if (!key) return null
  return db.prepare('SELECT session_key, owner_user_id, status FROM workspace_sessions WHERE session_key = ?').get(key) || null
}

export function canAccessWorkspaceSession(db, user, sessionKey) {
  if (user?.role === 'admin') return true
  const ownerUserId = getOwnerPrincipal(user)
  if (!ownerUserId) return false
  const row = findWorkspaceSession(db, sessionKey)
  return !!row && row.status === 'active' && row.owner_user_id === ownerUserId
}

export function ensureWorkspaceSessionAccess(db, user, sessionKey, { allowCreate = false } = {}) {
  const key = normalizeSessionKey(sessionKey)
  if (!key) return { ok: false, code: 'SESSION_KEY_REQUIRED', message: '缺少会话标识' }
  if (user?.role === 'admin') return { ok: true, key, created: false }

  const ownerUserId = getOwnerPrincipal(user)
  if (!ownerUserId) return { ok: false, code: 'SESSION_NOT_FOUND', message: '会话不存在或无权访问' }
  const row = findWorkspaceSession(db, key)
  if (row?.status === 'active' && row.owner_user_id === ownerUserId) return { ok: true, key, created: false }
  if (row) return { ok: false, code: 'SESSION_NOT_FOUND', message: '会话不存在或无权访问' }
  if (!allowCreate || !isManagedWebSessionKey(key)) return { ok: false, code: 'SESSION_NOT_FOUND', message: '会话不存在或无权访问' }

  const now = Date.now()
  db.prepare(`
    INSERT INTO workspace_sessions (session_key, owner_user_id, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
  `).run(key, ownerUserId, now, now)
  return { ok: true, key, created: true }
}

export function markWorkspaceSessionDeleted(db, sessionKey, now = Date.now()) {
  db.prepare(`
    UPDATE workspace_sessions
    SET status = 'deleted', updated_at = ?, deleted_at = ?
    WHERE session_key = ? AND status = 'active'
  `).run(now, now, normalizeSessionKey(sessionKey))
}

export function listOwnedWorkspaceSessionKeys(db, user) {
  if (user?.role === 'admin') return null
  const ownerUserId = getOwnerPrincipal(user)
  if (!ownerUserId) return new Set()
  const rows = db.prepare(`
    SELECT session_key FROM workspace_sessions
    WHERE owner_user_id = ? AND status = 'active'
  `).all(ownerUserId)
  return new Set(rows.map((row) => row.session_key))
}

function extractRowSessionKey(value) {
  const row = asRecord(value)
  return normalizeSessionKey(row.key || row.sessionKey || row.id)
}

export function filterSessionListPayload(payload, allowedKeys) {
  if (allowedKeys === null) return payload
  if (Array.isArray(payload)) return payload.filter((row) => allowedKeys.has(extractRowSessionKey(row)))
  const row = asRecord(payload)
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(row[key])) {
      return { ...row, [key]: row[key].filter((item) => allowedKeys.has(extractRowSessionKey(item))) }
    }
  }
  return { ...row, sessions: [] }
}

export function extractSessionKeyFromEvent(payload, depth = 0) {
  if (depth > 4 || !payload || typeof payload !== 'object') return ''
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const key = extractSessionKeyFromEvent(item, depth + 1)
      if (key) return key
    }
    return ''
  }
  const row = asRecord(payload)
  const direct = getSessionKeyFromParams(row)
  if (direct) return direct
  for (const key of ['payload', 'data', 'event', 'session', 'message', 'result']) {
    const nested = extractSessionKeyFromEvent(row[key], depth + 1)
    if (nested) return nested
  }
  return ''
}

export const __test__ = {
  getOwnerPrincipal,
  isManagedWebSessionKey,
  filterSessionListPayload,
  extractSessionKeyFromEvent,
}
