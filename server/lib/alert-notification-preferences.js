export const ALERT_NOTIFICATION_DEFAULTS = Object.freeze({
  realtimeEnabled: true,
  soundEnabled: true,
  minorSound: 'minor-soft',
  majorSound: 'major-chime',
  criticalSound: 'critical-pulse',
  minorPopupEnabled: true,
  minorNotificationEnabled: true,
  majorPopupEnabled: true,
  majorNotificationEnabled: true,
  criticalPopupEnabled: true,
  criticalNotificationEnabled: true,
})

const FIELD_TO_COLUMN = Object.freeze({
  realtimeEnabled: 'realtime_enabled',
  soundEnabled: 'sound_enabled',
  minorSound: 'minor_sound',
  majorSound: 'major_sound',
  criticalSound: 'critical_sound',
  minorPopupEnabled: 'minor_popup_enabled',
  minorNotificationEnabled: 'minor_notification_enabled',
  majorPopupEnabled: 'major_popup_enabled',
  majorNotificationEnabled: 'major_notification_enabled',
  criticalPopupEnabled: 'critical_popup_enabled',
  criticalNotificationEnabled: 'critical_notification_enabled',
})

const FIELDS = Object.freeze(Object.keys(FIELD_TO_COLUMN))

export function migrateAlertNotificationPreferences(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_notification_preferences (
      user_id TEXT PRIMARY KEY,
      realtime_enabled INTEGER NOT NULL DEFAULT 1 CHECK (realtime_enabled IN (0, 1)),
      sound_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sound_enabled IN (0, 1)),
      minor_sound TEXT NOT NULL DEFAULT 'minor-soft',
      major_sound TEXT NOT NULL DEFAULT 'major-chime',
      critical_sound TEXT NOT NULL DEFAULT 'critical-pulse',
      minor_popup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (minor_popup_enabled IN (0, 1)),
      minor_notification_enabled INTEGER NOT NULL DEFAULT 1 CHECK (minor_notification_enabled IN (0, 1)),
      major_popup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (major_popup_enabled IN (0, 1)),
      major_notification_enabled INTEGER NOT NULL DEFAULT 1 CHECK (major_notification_enabled IN (0, 1)),
      critical_popup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (critical_popup_enabled IN (0, 1)),
      critical_notification_enabled INTEGER NOT NULL DEFAULT 1 CHECK (critical_notification_enabled IN (0, 1)),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_notification_preferences_updated_at
      ON alert_notification_preferences(updated_at DESC);
  `)
  for (const column of [
    "minor_sound TEXT NOT NULL DEFAULT 'minor-soft'",
    "major_sound TEXT NOT NULL DEFAULT 'major-chime'",
    "critical_sound TEXT NOT NULL DEFAULT 'critical-pulse'",
  ]) {
    try { db.exec(`ALTER TABLE alert_notification_preferences ADD COLUMN ${column}`) } catch (error) {
      if (!String(error?.message || '').includes('duplicate column name')) throw error
    }
  }
}

export function toAlertNotificationPreferences(row) {
  if (!row) return { ...ALERT_NOTIFICATION_DEFAULTS, updatedAt: null }
  const value = { updatedAt: Number(row.updated_at) || null }
  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    value[field] = field.endsWith('Sound') ? String(row[column] || ALERT_NOTIFICATION_DEFAULTS[field]) : Boolean(row[column])
  }
  return value
}

export function validateAlertNotificationPreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '告警通知设置必须是对象' }
  }
  const keys = Object.keys(input)
  if (keys.length !== FIELDS.length || keys.some((key) => !Object.hasOwn(FIELD_TO_COLUMN, key))) {
    return { ok: false, error: '告警通知设置字段无效' }
  }
  for (const field of FIELDS) {
    if (field.endsWith('Sound')) {
      if (!['minor-soft', 'major-chime', 'critical-pulse', 'rising-bell', 'falling-bell', 'digital-ping', 'woodblock', 'rapid-signal', 'none'].includes(input[field])) return { ok: false, error: '告警提示音无效' }
    } else if (typeof input[field] !== 'boolean') return { ok: false, error: '告警通知设置必须使用布尔值' }
  }
  return { ok: true, value: Object.fromEntries(FIELDS.map((field) => [field, input[field]])) }
}

export function readAlertNotificationPreferences(db, userId) {
  const row = db.prepare(`SELECT * FROM alert_notification_preferences WHERE user_id = ?`).get(userId)
  return toAlertNotificationPreferences(row)
}

export function saveAlertNotificationPreferences(db, userId, settings, now = Date.now()) {
  const values = FIELDS.map((field) => field.endsWith('Sound') ? settings[field] : settings[field] ? 1 : 0)
  db.prepare(`
    INSERT INTO alert_notification_preferences (
      user_id, realtime_enabled, sound_enabled, minor_sound, major_sound, critical_sound, minor_popup_enabled, minor_notification_enabled,
      major_popup_enabled, major_notification_enabled, critical_popup_enabled, critical_notification_enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      realtime_enabled = excluded.realtime_enabled,
      sound_enabled = excluded.sound_enabled,
      minor_sound = excluded.minor_sound,
      major_sound = excluded.major_sound,
      critical_sound = excluded.critical_sound,
      minor_popup_enabled = excluded.minor_popup_enabled,
      minor_notification_enabled = excluded.minor_notification_enabled,
      major_popup_enabled = excluded.major_popup_enabled,
      major_notification_enabled = excluded.major_notification_enabled,
      critical_popup_enabled = excluded.critical_popup_enabled,
      critical_notification_enabled = excluded.critical_notification_enabled,
      updated_at = excluded.updated_at
  `).run(userId, ...values, now)
  return readAlertNotificationPreferences(db, userId)
}

export function deleteAlertNotificationPreferencesForUser(db, userId) {
  return db.prepare('DELETE FROM alert_notification_preferences WHERE user_id = ?').run(userId).changes
}

export const __test__ = { FIELD_TO_COLUMN, FIELDS }
