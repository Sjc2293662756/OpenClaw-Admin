import { randomUUID } from 'crypto'

const WEB_SESSION_PREFIX = 'agent:main:main:dm:webchat-'
const SESSION_LIST_KEYS = ['sessions', 'items', 'list', 'data']
const WEB_CHANNELS = new Set(['web', 'webchat', 'workspace'])

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

function normalizeSourceChannel(value) {
  const channel = normalizeSessionKey(value).toLowerCase()
  if (['web', 'webchat', 'workspace'].includes(channel)) return 'web'
  if (['feishu', 'lark', 'openclaw-lark', 'feishu-china'].includes(channel)) return 'feishu'
  if (['dingtalk', 'dingtalk-connector'].includes(channel)) return 'dingtalk'
  if (['wecom', 'wecom-app', 'wecom-openclaw-plugin'].includes(channel)) return 'wecom'
  return channel || 'main'
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value)
  }
  const normalized = normalizeSessionKey(value)
  if (!normalized) return null
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const numeric = Number(normalized)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric)
    }
  }
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Conversation ordering must use user/assistant activity, not Gateway record
 * maintenance. updatedAt can change because of delivery retries, compaction,
 * cache accounting, or other background work.
 */
function resolveConversationLastActivity(value) {
  const row = asRecord(value)
  for (const key of [
    'lastInteractionAt',
    'lastMessageAt',
    'lastUserMessageAt',
    'lastAssistantMessageAt',
    'lastActivity',
    'sessionStartedAt',
    'createdAt',
  ]) {
    const timestamp = normalizeTimestamp(row[key])
    if (timestamp) return new Date(timestamp).toISOString()
  }
  // Current Gateway session lists expose updatedAt as the only activity field
  // for regular WebChat and channel conversations. Its protected default
  // runtime session is excluded because retries/maintenance can touch that
  // record without a real conversation.
  if (!isLegacySharedWebSessionKey(extractRowSessionKey(row))) {
    const updatedAt = normalizeTimestamp(row.updatedAt)
    if (updatedAt) return new Date(updatedAt).toISOString()
  }
  return null
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

/**
 * The original GAIOP Web Chat used Gateway's default `main` key before the
 * BFF issued user-owned WebChat keys. Gateway protects that key from physical
 * deletion, so it is treated as a legacy shared WebChat record.
 */
export function isLegacySharedWebSessionKey(value) {
  const key = normalizeSessionKey(value).toLowerCase()
  return key === 'main' || key === 'agent:main:main'
}

export function hideLegacySharedSession(db, user, sessionKey, now = Date.now()) {
  const key = normalizeSessionKey(sessionKey)
  const userId = getOwnerPrincipal(user)
  if (!isLegacySharedWebSessionKey(key) || !userId) return false
  db.prepare(`
    INSERT INTO hidden_legacy_sessions (session_key, hidden_by_user_id, hidden_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      hidden_by_user_id = excluded.hidden_by_user_id,
      hidden_at = excluded.hidden_at
  `).run(key, userId, now)
  return true
}

export function isLegacySessionHidden(db, sessionKey) {
  const key = normalizeSessionKey(sessionKey)
  if (!isLegacySharedWebSessionKey(key)) return false
  return Boolean(db.prepare('SELECT 1 FROM hidden_legacy_sessions WHERE session_key = ?').get(key))
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

/**
 * A WebChat title is a stable preview of the first user request, not an AI
 * summary. This deliberately avoids an extra model call, latency, and token
 * cost while keeping the title understandable in both the workspace and
 * management views.
 */
export function deriveWorkspaceSessionTitle(value, maxLength = 24) {
  const normalized = String(value || '')
    .replace(/^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:\s+[A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?)?\]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) return ''
  // Transport/control commands are not conversation subjects. Leaving the
  // title empty lets the first real user request become the stable title.
  if (/^\/[a-z][\w-]*(?:\s|$)/iu.test(normalized)) return ''
  const characters = Array.from(normalized)
  const safeLength = Math.max(1, Math.floor(Number(maxLength) || 24))
  return characters.length > safeLength
    ? `${characters.slice(0, safeLength).join('')}…`
    : normalized
}

/**
 * Writes a title only once. Later turns must not silently rename a user’s
 * conversation, and non-Web/Gateway sessions never get a local title.
 */
export function setWorkspaceSessionTitleIfEmpty(db, sessionKey, title, now = Date.now()) {
  const key = normalizeSessionKey(sessionKey)
  const normalizedTitle = deriveWorkspaceSessionTitle(title)
  if (!key || !normalizedTitle) return null
  const result = db.prepare(`
    UPDATE workspace_sessions
    SET session_title = ?, updated_at = ?
    WHERE session_key = ? AND status = 'active'
      AND (session_title IS NULL OR TRIM(session_title) = '')
  `).run(normalizedTitle, now, key)
  if (result.changes !== 1) return null
  return normalizedTitle
}

function findHistoricalWebChatTitle(db, sessionKey) {
  const key = normalizeSessionKey(sessionKey)
  if (!key) return ''
  const row = db.prepare('SELECT session_title FROM historical_webchat_titles WHERE session_key = ?').get(key)
  return normalizeSessionKey(row?.session_title)
}

export function findDisplaySessionTitle(db, sessionKey) {
  const workspace = findWorkspaceSession(db, sessionKey)
  const workspaceTitle = normalizeSessionKey(workspace?.session_title)
  if (!isReplaceableWebChatTitle(workspaceTitle)) return workspaceTitle
  const historicalTitle = findHistoricalWebChatTitle(db, sessionKey)
  return isReplaceableWebChatTitle(historicalTitle) ? '' : historicalTitle
}

export function setHistoricalWebChatTitleIfEmpty(db, sessionKey, title, now = Date.now()) {
  const key = normalizeSessionKey(sessionKey)
  const normalizedTitle = deriveWorkspaceSessionTitle(title)
  if (!key || !normalizedTitle || findDisplaySessionTitle(db, key)) return null
  db.prepare(`
    INSERT INTO historical_webchat_titles (session_key, session_title, title_source, created_at, updated_at)
    VALUES (?, ?, 'first_user_message', ?, ?)
    ON CONFLICT(session_key) DO NOTHING
  `).run(key, normalizedTitle, now, now)
  return findHistoricalWebChatTitle(db, key) || null
}

function isReplaceableWebChatTitle(value) {
  const normalized = normalizeSessionKey(value)
  return !normalized || /^\/[a-z][\w-]*(?:\s|$)/iu.test(normalized)
}

/**
 * Restore a title from verified local history without overwriting a meaningful
 * existing title. Owned WebChat sessions use workspace_sessions; older
 * unregistered WebChat sessions use the historical side table.
 */
export function setRecoveredWebChatTitle(db, sessionKey, title, now = Date.now()) {
  const key = normalizeSessionKey(sessionKey)
  const normalizedTitle = deriveWorkspaceSessionTitle(title)
  if (!key || !normalizedTitle) return null
  const workspace = findWorkspaceSession(db, key)
  if (workspace) {
    if (!isReplaceableWebChatTitle(workspace.session_title)) return null
    const result = db.prepare(`
      UPDATE workspace_sessions
      SET session_title = ?, updated_at = ?
      WHERE session_key = ? AND status = 'active'
    `).run(normalizedTitle, now, key)
    return result.changes === 1 ? normalizedTitle : null
  }
  const existing = findHistoricalWebChatTitle(db, key)
  if (!isReplaceableWebChatTitle(existing)) return null
  db.prepare(`
    INSERT INTO historical_webchat_titles (session_key, session_title, title_source, created_at, updated_at)
    VALUES (?, ?, 'first_user_message', ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      session_title = excluded.session_title,
      title_source = excluded.title_source,
      updated_at = excluded.updated_at
  `).run(key, normalizedTitle, now, now)
  return findHistoricalWebChatTitle(db, key) || null
}

export function isConversationSessionSend(method, params) {
  const normalizedMethod = normalizeSessionKey(method)
  if (normalizedMethod === 'chat.send') return true
  return normalizedMethod === 'agent' && Boolean(getSessionKeyFromParams(params))
}

export function getConversationTitleCandidate(method, params) {
  if (!isConversationSessionSend(method, params)) return ''
  const row = asRecord(params)
  return deriveWorkspaceSessionTitle(row.message || row.input || row.text || row.content)
}

export function findWorkspaceSession(db, sessionKey) {
  const key = normalizeSessionKey(sessionKey)
  if (!key) return null
  return db.prepare('SELECT session_key, owner_user_id, session_title, status FROM workspace_sessions WHERE session_key = ?').get(key) || null
}

export function canAccessWorkspaceSession(db, user, sessionKey) {
  if (user?.role === 'admin' || user?.role === 'auditor') return true
  const ownerUserId = getOwnerPrincipal(user)
  if (!ownerUserId) return false
  const row = findWorkspaceSession(db, sessionKey)
  return !!row && row.status === 'active' && row.owner_user_id === ownerUserId
}

export function ensureWorkspaceSessionAccess(db, user, sessionKey, { allowCreate = false } = {}) {
  const key = normalizeSessionKey(sessionKey)
  if (!key) return { ok: false, code: 'SESSION_KEY_REQUIRED', message: '缺少会话标识' }
  if (user?.role === 'admin' || user?.role === 'auditor') return { ok: true, key, created: false }

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
  if (user?.role === 'admin' || user?.role === 'auditor') return null
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

const USAGE_TOTAL_FIELDS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'totalTokens',
  'totalCost',
  'inputCost',
  'outputCost',
  'cacheReadCost',
  'cacheWriteCost',
  'missingCostEntries',
]

function usageNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function emptyUsageTotals() {
  return Object.fromEntries(USAGE_TOTAL_FIELDS.map((field) => [field, 0]))
}

function addUsageTotals(target, source) {
  const usage = asRecord(source)
  for (const field of USAGE_TOTAL_FIELDS) {
    target[field] += usageNumber(usage[field])
  }
  if (!usage.totalTokens) {
    target.totalTokens += usageNumber(usage.tokens || usage.total)
  }
}

function aggregateUsageRows(rows) {
  const totals = emptyUsageTotals()
  const messages = {
    total: 0,
    user: 0,
    assistant: 0,
    toolCalls: 0,
    toolResults: 0,
    errors: 0,
  }
  const tools = new Map()
  const byModel = new Map()
  const byProvider = new Map()
  const byAgent = new Map()
  const byChannel = new Map()
  const daily = new Map()
  let totalToolCalls = 0

  const addGroupedTotals = (map, key, usage) => {
    if (!key) return
    let item = map.get(key)
    if (!item) {
      item = { count: 0, totals: emptyUsageTotals() }
      map.set(key, item)
    }
    item.count += 1
    addUsageTotals(item.totals, usage)
  }

  for (const item of rows) {
    const session = asRecord(item)
    const usage = asRecord(session.usage)
    if (Object.keys(usage).length === 0) continue

    addUsageTotals(totals, usage)

    const messageCounts = asRecord(usage.messageCounts)
    for (const field of Object.keys(messages)) {
      messages[field] += usageNumber(messageCounts[field])
    }
    if (messageCounts.total === undefined) {
      messages.total += usageNumber(messageCounts.user) + usageNumber(messageCounts.assistant)
    }

    const toolUsage = asRecord(usage.toolUsage)
    const sessionTools = Array.isArray(toolUsage.tools) ? toolUsage.tools : []
    totalToolCalls += toolUsage.totalCalls === undefined
      ? sessionTools.reduce((sum, tool) => sum + usageNumber(asRecord(tool).count), 0)
      : usageNumber(toolUsage.totalCalls)
    for (const tool of sessionTools) {
      const row = asRecord(tool)
      const name = normalizeSessionKey(row.name)
      if (name) tools.set(name, (tools.get(name) || 0) + usageNumber(row.count))
    }

    const provider = normalizeSessionKey(
      session.modelProvider || session.provider || session.providerOverride
    )
    const model = normalizeSessionKey(session.model || session.modelOverride)
    addGroupedTotals(byProvider, provider, usage)
    if (provider || model) addGroupedTotals(byModel, `${provider}\u0000${model}`, usage)
    addGroupedTotals(byAgent, normalizeSessionKey(session.agentId || session.agent), usage)
    addGroupedTotals(
      byChannel,
      normalizeSourceChannel(session.channel || session.lastChannel || session.platform),
      usage
    )

    for (const item of Array.isArray(usage.dailyBreakdown) ? usage.dailyBreakdown : []) {
      const row = asRecord(item)
      const date = normalizeSessionKey(row.date)
      if (!date) continue
      let entry = daily.get(date)
      if (!entry) {
        entry = { date, tokens: 0, cost: 0, messages: 0, toolCalls: 0, errors: 0 }
        daily.set(date, entry)
      }
      entry.tokens += usageNumber(row.tokens || row.totalTokens)
      entry.cost += usageNumber(row.cost || row.totalCost)
      entry.messages += usageNumber(row.messages)
      entry.toolCalls += usageNumber(row.toolCalls)
      entry.errors += usageNumber(row.errors)
    }
  }

  const grouped = (map, field) => Array.from(map.entries())
    .map(([key, value]) => ({ [field]: key, count: value.count, totals: value.totals }))
    .sort((left, right) => (
      right.totals.totalTokens - left.totals.totalTokens ||
      String(left[field]).localeCompare(String(right[field]))
    ))

  return {
    totals,
    aggregates: {
      messages,
      tools: {
        totalCalls: totalToolCalls,
        uniqueTools: tools.size,
        tools: Array.from(tools.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
      },
      byModel: Array.from(byModel.entries())
        .map(([key, value]) => {
          const [provider, model] = key.split('\u0000')
          return { provider: provider || undefined, model: model || undefined, ...value }
        })
        .sort((left, right) => (
          right.totals.totalTokens - left.totals.totalTokens ||
          String(left.model || '').localeCompare(String(right.model || ''))
        )),
      byProvider: grouped(byProvider, 'provider'),
      byAgent: grouped(byAgent, 'agentId').map(({ count: _count, ...item }) => item),
      byChannel: grouped(byChannel, 'channel').map(({ count: _count, ...item }) => item),
      daily: Array.from(daily.values()).sort((left, right) => left.date.localeCompare(right.date)),
    },
  }
}

export function filterSessionUsagePayload(payload, allowedKeys) {
  if (allowedKeys === null) return payload
  const filtered = filterSessionListPayload(payload, allowedKeys)
  if (Array.isArray(filtered)) return filtered

  const rows = extractSessionRows(filtered)
  const ownedUsage = aggregateUsageRows(rows)
  return {
    ...filtered,
    ...ownedUsage,
  }
}

/** Remove locally retired legacy shared sessions from every BFF list response. */
export function filterHiddenLegacySessions(db, payload) {
  const isVisible = (value) => !isLegacySessionHidden(db, extractRowSessionKey(value))
  if (Array.isArray(payload)) return payload.filter(isVisible)
  const row = asRecord(payload)
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(row[key])) return { ...row, [key]: row[key].filter(isVisible) }
  }
  return payload
}

function parseSessionChannelAndPeer(row) {
  const source = asRecord(row)
  const key = extractRowSessionKey(source)
  const parts = key.split(':')
  const keyChannel = parts.length >= 3 ? normalizeSessionKey(parts[2]).toLowerCase() : ''
  const keyPeer = parts.length >= 5 ? normalizeSessionKey(parts.slice(4).join(':')) : ''
  const channel = normalizeSourceChannel(
    source.channel || source.lastChannel || source.platform || source.deliveryContext?.channel || keyChannel
  )
  const peer = normalizeSessionKey(source.peer || source.user || source.recipient || source.subject || keyPeer)
  return { key, channel, peer }
}

function extractSessionRows(payload) {
  if (Array.isArray(payload)) return payload
  const row = asRecord(payload)
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(row[key])) return row[key]
  }
  return []
}

export function isWebChatSessionRecord(value) {
  const { key, channel } = parseSessionChannelAndPeer(value)
  return isLegacySharedWebSessionKey(key)
    || isManagedWebSessionKey(key)
    || ['web', 'webchat', 'workspace'].includes(channel)
}

function extractMessageRows(payload) {
  if (Array.isArray(payload)) return payload
  const row = asRecord(payload)
  for (const key of ['messages', 'items', 'history', 'transcript', 'data']) {
    if (Array.isArray(row[key])) return row[key]
  }
  return []
}

function extractMessageText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => extractMessageText(item)).filter(Boolean).join(' ')
  }
  const row = asRecord(value)
  return normalizeSessionKey(row.text || row.content || row.message || row.value)
}

export function deriveFirstUserMessageTitle(historyPayload) {
  for (const item of extractMessageRows(historyPayload)) {
    const row = asRecord(item)
    const role = normalizeSessionKey(row.role || row.sender || row.author).toLowerCase()
    if (role !== 'user') continue
    const title = deriveWorkspaceSessionTitle(extractMessageText(row.content || row.text || row.message))
    if (title) return title
  }
  return ''
}

/**
 * One-shot, administrator-triggered migration. The reader receives only a
 * session key and must return that session's Gateway history. Conversation
 * text is transformed locally into a fixed title and is never logged or sent
 * to a model.
 */
export async function backfillHistoricalWebChatTitles(db, sessionListPayload, readHistory) {
  const result = { eligible: 0, updated: 0, alreadyTitled: 0, withoutUserMessage: 0, failed: 0 }
  for (const session of extractSessionRows(sessionListPayload)) {
    if (!isWebChatSessionRecord(session)) continue
    const key = extractRowSessionKey(session)
    if (!key) continue
    result.eligible += 1
    if (!isReplaceableWebChatTitle(findDisplaySessionTitle(db, key))) {
      result.alreadyTitled += 1
      continue
    }
    try {
      const title = deriveFirstUserMessageTitle(await readHistory(key))
      if (!title) {
        result.withoutUserMessage += 1
        continue
      }
      if (setRecoveredWebChatTitle(db, key, title)) result.updated += 1
      else result.alreadyTitled += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}

function readOwnerDisplayName(db, ownerUserId) {
  if (!db || !ownerUserId) return ''
  try {
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get(ownerUserId)
    return normalizeSessionKey(row?.username)
  } catch {
    return ''
  }
}

/**
 * Adds presentation-only origin fields to Gateway sessions. Web ownership is
 * resolved from the Admin registry; external channel identities remain the
 * peer provided by Gateway and are never guessed from a display name.
 */
export function enrichSessionPayload(db, payload) {
  const enrich = (value) => {
    const row = asRecord(value)
    const { key, channel, peer } = parseSessionChannelAndPeer(row)
    const workspace = key ? findWorkspaceSession(db, key) : null
    const legacySharedWeb = isLegacySharedWebSessionKey(key)
    const isWeb = Boolean(workspace) || legacySharedWeb || isManagedWebSessionKey(key) || WEB_CHANNELS.has(channel)
    const ownerUserId = normalizeSessionKey(workspace?.owner_user_id)
    const ownerUsername = readOwnerDisplayName(db, ownerUserId)
    const gatewayChannelUserId = normalizeSessionKey(row.channelUserId || row.senderId || row.userId || peer)
    // Some Gateway channel adapters place the platform display name in label.
    // It is a user display fallback for external channels, never a WebChat title.
    const gatewayChannelUserName = normalizeSessionKey(row.channelUserName || row.senderName || row.userName || row.displayName || row.label || gatewayChannelUserId)
    const channelUserId = isWeb ? ownerUserId : gatewayChannelUserId
    const channelUserName = isWeb ? (ownerUsername || ownerUserId) : gatewayChannelUserName
    return {
      ...row,
      channel,
      originKind: isWeb ? 'web' : 'channel',
      sourceChannel: isWeb ? 'web' : channel,
      ownerUserId: ownerUserId || null,
      ownerUsername: ownerUsername || null,
      sessionTitle: isWeb ? (findDisplaySessionTitle(db, key) || null) : null,
      conversationLastActivity: resolveConversationLastActivity(row),
      channelUserId: channelUserId || null,
      channelUserName: channelUserName || null,
    }
  }

  if (Array.isArray(payload)) return payload.map(enrich)
  const row = asRecord(payload)
  for (const key of SESSION_LIST_KEYS) {
    if (Array.isArray(row[key])) return { ...row, [key]: row[key].map(enrich) }
  }
  return enrich(row)
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
  deriveWorkspaceSessionTitle,
  setWorkspaceSessionTitleIfEmpty,
  findDisplaySessionTitle,
  setHistoricalWebChatTitleIfEmpty,
  setRecoveredWebChatTitle,
  isConversationSessionSend,
  getConversationTitleCandidate,
  isWebChatSessionRecord,
  deriveFirstUserMessageTitle,
  backfillHistoricalWebChatTitles,
  isLegacySharedWebSessionKey,
  hideLegacySharedSession,
  isLegacySessionHidden,
  filterSessionListPayload,
  filterHiddenLegacySessions,
  enrichSessionPayload,
  extractSessionKeyFromEvent,
  resolveConversationLastActivity,
}
