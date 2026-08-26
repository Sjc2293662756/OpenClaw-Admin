const STREAM_STATES = new Set([
  'idle',
  'connecting',
  'connected',
  'unavailable',
  'authentication_error',
  'gap',
  'receiver_reset',
  'protocol_error',
])

function safeCursor(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError('alert_stream_cursor_invalid')
  return cursor
}

function safeState(value) {
  const state = String(value || '')
  if (!STREAM_STATES.has(state)) throw new TypeError('alert_stream_state_invalid')
  return state
}

export function migrateAlertStreamState(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_stream_runtime (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      resume_cursor INTEGER CHECK (resume_cursor IS NULL OR resume_cursor >= 0),
      last_processed_cursor INTEGER CHECK (last_processed_cursor IS NULL OR last_processed_cursor >= 0),
      connection_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (connection_state IN ('idle', 'connecting', 'connected', 'unavailable',
          'authentication_error', 'gap', 'receiver_reset', 'protocol_error')),
      gap_state TEXT CHECK (gap_state IS NULL OR gap_state IN ('unresolved', 'receiver_reset')),
      oldest_available_sequence INTEGER,
      latest_sequence INTEGER,
      last_error_code TEXT,
      gap_detected_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO alert_stream_runtime (
      singleton_id, connection_state, updated_at
    ) VALUES (1, 'idle', 0);
  `)
}

export function readAlertStreamState(db) {
  const row = db.prepare('SELECT * FROM alert_stream_runtime WHERE singleton_id = 1').get()
  if (!row) throw new Error('alert_stream_state_missing')
  return {
    resumeCursor: row.resume_cursor === null ? null : Number(row.resume_cursor),
    lastProcessedCursor: row.last_processed_cursor === null ? null : Number(row.last_processed_cursor),
    connectionState: row.connection_state,
    gapState: row.gap_state,
    oldestAvailableSequence: row.oldest_available_sequence === null ? null : Number(row.oldest_available_sequence),
    latestSequence: row.latest_sequence === null ? null : Number(row.latest_sequence),
    lastErrorCode: row.last_error_code,
    gapDetectedAt: row.gap_detected_at === null ? null : Number(row.gap_detected_at),
    updatedAt: Number(row.updated_at),
  }
}

export function persistAlertStreamBaseline(db, cursor, { now = Date.now() } = {}) {
  const normalized = safeCursor(cursor)
  db.prepare(`
    UPDATE alert_stream_runtime
    SET resume_cursor = ?, connection_state = 'connected', last_error_code = NULL, updated_at = ?
    WHERE singleton_id = 1
  `).run(normalized, now)
  return readAlertStreamState(db)
}

export function persistProcessedAlertCursor(db, cursor, { now = Date.now() } = {}) {
  const normalized = safeCursor(cursor)
  const current = readAlertStreamState(db)
  if (current.resumeCursor !== null && normalized <= current.resumeCursor) return false
  const result = db.prepare(`
    UPDATE alert_stream_runtime
    SET resume_cursor = ?, last_processed_cursor = ?, connection_state = 'connected',
        last_error_code = NULL, updated_at = ?
    WHERE singleton_id = 1
      AND (resume_cursor IS NULL OR resume_cursor < ?)
  `).run(normalized, normalized, now, normalized)
  return result.changes === 1
}

export function persistAlertStreamStatus(db, {
  state,
  errorCode = null,
  now = Date.now(),
} = {}) {
  const normalizedState = safeState(state)
  db.prepare(`
    UPDATE alert_stream_runtime
    SET connection_state = ?, last_error_code = ?, updated_at = ?
    WHERE singleton_id = 1
  `).run(normalizedState, errorCode ? String(errorCode).slice(0, 80) : null, now)
  return readAlertStreamState(db)
}

export function persistAlertStreamRebaseline(db, {
  state,
  latestSequence,
  oldestAvailableSequence = null,
  errorCode,
  now = Date.now(),
} = {}) {
  const normalizedState = safeState(state)
  if (normalizedState !== 'gap' && normalizedState !== 'receiver_reset') {
    throw new TypeError('alert_stream_rebaseline_state_invalid')
  }
  const latest = safeCursor(latestSequence)
  const oldest = safeCursor(oldestAvailableSequence, { nullable: true })
  db.prepare(`
    UPDATE alert_stream_runtime
    SET resume_cursor = ?, connection_state = ?, gap_state = ?,
        oldest_available_sequence = ?, latest_sequence = ?, last_error_code = ?,
        gap_detected_at = ?, updated_at = ?
    WHERE singleton_id = 1
  `).run(
    latest,
    normalizedState,
    normalizedState === 'gap' ? 'unresolved' : 'receiver_reset',
    oldest,
    latest,
    String(errorCode || '').slice(0, 80) || null,
    now,
    now,
  )
  return readAlertStreamState(db)
}

export const __test__ = { safeCursor, safeState, STREAM_STATES }
