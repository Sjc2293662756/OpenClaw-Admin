export const CHAT_DISPLAY_PREFERENCES_DEFAULTS = Object.freeze({
  showThinkingProcess: true,
})

export function migrateChatDisplayPreferences(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_display_preferences (
      user_id TEXT PRIMARY KEY,
      show_thinking_process INTEGER NOT NULL DEFAULT 1 CHECK (show_thinking_process IN (0, 1)),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_display_preferences_updated_at
      ON chat_display_preferences(updated_at DESC);
  `)
}

export function toChatDisplayPreferences(row) {
  if (!row) return { ...CHAT_DISPLAY_PREFERENCES_DEFAULTS, updatedAt: null }
  return {
    showThinkingProcess: Boolean(row.show_thinking_process),
    updatedAt: Number(row.updated_at) || null,
  }
}

export function validateChatDisplayPreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '对话显示设置必须是对象' }
  }
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'showThinkingProcess') {
    return { ok: false, error: '对话显示设置字段无效' }
  }
  if (typeof input.showThinkingProcess !== 'boolean') {
    return { ok: false, error: '显示思考过程设置必须使用布尔值' }
  }
  return { ok: true, value: { showThinkingProcess: input.showThinkingProcess } }
}

export function readChatDisplayPreferences(db, userId) {
  const row = db.prepare('SELECT * FROM chat_display_preferences WHERE user_id = ?').get(userId)
  return toChatDisplayPreferences(row)
}

export function saveChatDisplayPreferences(db, userId, settings, now = Date.now()) {
  db.prepare(`
    INSERT INTO chat_display_preferences (user_id, show_thinking_process, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      show_thinking_process = excluded.show_thinking_process,
      updated_at = excluded.updated_at
  `).run(userId, settings.showThinkingProcess ? 1 : 0, now)
  return readChatDisplayPreferences(db, userId)
}

export function deleteChatDisplayPreferencesForUser(db, userId) {
  return db.prepare('DELETE FROM chat_display_preferences WHERE user_id = ?').run(userId).changes
}
