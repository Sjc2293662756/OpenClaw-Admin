const HISTORY_ARRAY_KEYS = Object.freeze([
  'messages',
  'history',
  'transcript',
  'items',
  'list',
  'data',
  'events',
  'turns',
])

const PROCESS_KIND = 'user_visible_process'

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function finiteInteger(value) {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function messageMetadata(message) {
  return asRecord(asRecord(message).__openclaw)
}

export function gatewayMessageSequence(message) {
  const row = asRecord(message)
  const metadata = messageMetadata(row)
  return finiteInteger(row.seq ?? metadata.seq)
}

export function gatewayMessageId(message) {
  const row = asRecord(message)
  const metadata = messageMetadata(row)
  return cleanString(row.id || row.messageId || row.message_id || metadata.id, 500)
}

export function findChatHistoryMessages(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []

  const queue = [payload]
  const visited = new Set()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    if (Array.isArray(current)) return current

    for (const key of HISTORY_ARRAY_KEYS) {
      if (Array.isArray(current[key])) return current[key]
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return []
}

function messageRole(message) {
  const row = asRecord(message)
  return cleanString(row.role || row.type, 40).toLowerCase()
}

function contentParts(message) {
  const content = asRecord(message).content
  return Array.isArray(content) ? content.map(asRecord) : []
}

function toolCalls(message) {
  return contentParts(message)
    .filter((part) => ['toolcall', 'tool_call'].includes(cleanString(part.type, 40).toLowerCase()))
}

function toolCallIds(message) {
  return toolCalls(message)
    .map((part) => cleanString(part.id || part.toolCallId || part.tool_call_id || part.callId || part.call_id, 500))
    .filter(Boolean)
}

function toolResultId(message) {
  const row = asRecord(message)
  return cleanString(
    row.toolCallId || row.tool_call_id || row.callId || row.call_id || row.id,
    500,
  )
}

function extractProcessText(message) {
  const row = asRecord(message)
  if (Array.isArray(row.content)) {
    return row.content
      .map(asRecord)
      .filter((part) => cleanString(part.type, 40).toLowerCase() === 'text')
      .map((part) => cleanString(part.text, 1_000))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return cleanString(row.content || row.text || row.message, 1_000)
}

export function safeUserVisibleProcessText(value) {
  const text = cleanString(value, 1_000)
  if (!text || text.length > 400 || text.split(/\r?\n/u).length > 4) return ''

  const forbidden = [
    /```/u,
    /(?:^|\s)[A-Za-z]:\\[^\s]+/u,
    /(?:^|\s)\\\\[^\s\\]+\\[^\s]+/u,
    /(?:^|\s)\/(?:etc|home|opt|root|srv|tmp|usr|var)\/[^\s]+/iu,
    /(?:^|\s)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]+)?/u,
    /https?:\/\//iu,
    /\b(?:access[_ -]?token|api[_ -]?key|authorization|bearer|password|private[_ -]?key|secret|token)\b\s*[:=]/iu,
    /\b(?:select|insert|update|delete|drop|alter|create)\b[\s\S]*\b(?:from|into|set|table|values)\b/iu,
    /(?:^|\n)\s*(?:pragma|vacuum|truncate|grant|revoke|merge|call|exec(?:ute)?)\b/iu,
    /(?:^|\n)\s*(?:\$|>|PS\s+[^>]*>)\s*\S+/u,
    /\b(?:bash|cmd\.exe|curl|powershell|wget)\b\s+[-/]/iu,
    /(?:^|\n)\s*(?:sudo\s+)?(?:rm|cp|mv|chmod|chown|systemctl|journalctl|ssh|scp|rsync|node|npm|pnpm|yarn|python3?|bash|sh|cmd(?:\.exe)?|powershell|pwsh|curl|wget|git|docker|kubectl|tar|unzip)\b\s+[-./\\\w]/iu,
    /\b(?:Error|Exception):/u,
    /\{\s*"[^"\r\n]+"\s*:/u,
  ]
  if (forbidden.some((pattern) => pattern.test(text))) return ''
  return text
}

export function migrateChatProcessProjection(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_process_runs (
      user_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      client_run_id TEXT NOT NULL,
      gateway_run_id TEXT,
      show_process INTEGER NOT NULL CHECK (show_process IN (0, 1)),
      start_after_seq INTEGER NOT NULL,
      user_message_id TEXT,
      user_message_seq INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, session_key, client_run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_process_runs_projection
      ON chat_process_runs(user_id, session_key, start_after_seq, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_process_runs_user_message
      ON chat_process_runs(user_id, session_key, user_message_seq)
      WHERE user_message_seq IS NOT NULL;
  `)
}

function readRuns(db, userId, sessionKey) {
  return db.prepare(`
    SELECT * FROM chat_process_runs
    WHERE user_id = ? AND session_key = ?
    ORDER BY start_after_seq ASC, created_at ASC, client_run_id ASC
  `).all(userId, sessionKey)
}

function bindPendingRuns(db, userId, sessionKey, messages) {
  const orderedMessages = messages
    .map((message, index) => ({ message, index, seq: gatewayMessageSequence(message) }))
    .filter((entry) => entry.seq !== null)
    .sort((left, right) => left.seq - right.seq || left.index - right.index)
  const runs = readRuns(db, userId, sessionKey)
  const claimed = new Set(runs.map((run) => finiteInteger(run.user_message_seq)).filter((seq) => seq !== null))
  const update = db.prepare(`
    UPDATE chat_process_runs
    SET user_message_id = ?, user_message_seq = ?, updated_at = ?
    WHERE user_id = ? AND session_key = ? AND client_run_id = ? AND user_message_seq IS NULL
  `)

  for (const run of runs) {
    if (finiteInteger(run.user_message_seq) !== null) continue
    const nextRunBoundary = runs
      .filter((candidate) => candidate !== run && candidate.start_after_seq > run.start_after_seq)
      .map((candidate) => candidate.start_after_seq)
      .sort((left, right) => left - right)[0]
    const candidates = orderedMessages.filter((entry) => (
      entry.seq > run.start_after_seq
      && (nextRunBoundary === undefined || entry.seq <= nextRunBoundary)
      && !claimed.has(entry.seq)
      && messageRole(entry.message) === 'user'
    ))
    if (candidates.length === 0) continue

    const first = candidates[0]
    update.run(
      gatewayMessageId(first.message) || `seq:${first.seq}`,
      first.seq,
      Date.now(),
      userId,
      sessionKey,
      run.client_run_id,
    )
    claimed.add(first.seq)
  }
}

export function beginChatProcessRun({ db, userId, sessionKey, clientRunId, showProcess, historyPayload, now = Date.now() }) {
  const cleanUserId = cleanString(userId, 160)
  const cleanSessionKey = cleanString(sessionKey, 500)
  const cleanRunId = cleanString(clientRunId, 160)
  if (!cleanUserId || !cleanSessionKey || !cleanRunId || typeof showProcess !== 'boolean') {
    throw new Error('Chat process snapshot fields are incomplete')
  }

  const messages = findChatHistoryMessages(historyPayload)
  bindPendingRuns(db, cleanUserId, cleanSessionKey, messages)
  const existing = db.prepare(`
    SELECT * FROM chat_process_runs
    WHERE user_id = ? AND session_key = ? AND client_run_id = ?
  `).get(cleanUserId, cleanSessionKey, cleanRunId)
  if (existing) return existing

  const sequences = messages.map(gatewayMessageSequence).filter((seq) => seq !== null)
  if (messages.length > 0 && sequences.length !== messages.length) {
    throw new Error('Gateway history does not provide a stable sequence for every message')
  }
  const pending = db.prepare(`
    SELECT 1 FROM chat_process_runs
    WHERE user_id = ? AND session_key = ? AND user_message_seq IS NULL
    LIMIT 1
  `).get(cleanUserId, cleanSessionKey)
  if (pending) throw new Error('A prior chat process snapshot is not yet bound to Gateway history')

  const startAfterSeq = sequences.length > 0 ? Math.max(...sequences) : -1
  db.prepare(`
    INSERT INTO chat_process_runs (
      user_id, session_key, client_run_id, show_process, start_after_seq, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cleanUserId, cleanSessionKey, cleanRunId, showProcess ? 1 : 0, startAfterSeq, now, now)
  return db.prepare(`
    SELECT * FROM chat_process_runs
    WHERE user_id = ? AND session_key = ? AND client_run_id = ?
  `).get(cleanUserId, cleanSessionKey, cleanRunId)
}

export function setChatProcessGatewayRunId(db, userId, sessionKey, clientRunId, gatewayRunId, now = Date.now()) {
  const cleanGatewayRunId = cleanString(gatewayRunId, 160)
  if (!cleanGatewayRunId) return 0
  return db.prepare(`
    UPDATE chat_process_runs
    SET gateway_run_id = ?, updated_at = ?
    WHERE user_id = ? AND session_key = ? AND client_run_id = ?
  `).run(cleanGatewayRunId, now, userId, sessionKey, clientRunId).changes
}

function processStatus(messages, messageIndex, callIds) {
  if (callIds.length === 0) return 'in_progress'
  const completed = new Set()
  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]
    if (messageRole(candidate) === 'user') break
    const resultId = toolResultId(candidate)
    if (resultId && callIds.includes(resultId)) completed.add(resultId)
  }
  return callIds.every((id) => completed.has(id)) ? 'completed' : 'in_progress'
}

export function projectChatHistoryProcessMetadata(db, userId, sessionKey, payload) {
  const messages = findChatHistoryMessages(payload)
  if (messages.length === 0) return payload
  bindPendingRuns(db, userId, sessionKey, messages)
  const runs = readRuns(db, userId, sessionKey).filter((run) => finiteInteger(run.user_message_seq) !== null)
  if (runs.length === 0) return payload

  const messageSeqs = messages.map(gatewayMessageSequence)
  for (const run of runs) {
    const userSeq = finiteInteger(run.user_message_seq)
    if (userSeq === null) continue
    let sequence = 0
    for (let index = 0; index < messages.length; index += 1) {
      const message = asRecord(messages[index])
      const seq = messageSeqs[index]
      if (seq === null || seq <= userSeq) continue
      if (messageRole(message) === 'user') break
      if (messageRole(message) !== 'assistant') continue
      const calls = toolCalls(message)
      if (calls.length === 0) continue
      const callIds = toolCallIds(message)

      sequence += 1
      const rawText = extractProcessText(message)
      const publicText = safeUserVisibleProcessText(rawText)
      const messageId = gatewayMessageId(message)
      const stepId = messageId || callIds[0] || `seq:${seq}`
      message.gaiopProcess = {
        kind: PROCESS_KIND,
        sessionKey,
        runId: cleanString(run.gateway_run_id || run.client_run_id, 160),
        stepId,
        sequence,
        publicText,
        status: processStatus(messages, index, callIds),
        visible: Boolean(run.show_process) && Boolean(publicText),
        safe: Boolean(publicText),
      }
    }
  }
  return payload
}
