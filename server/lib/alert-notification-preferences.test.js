import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  ALERT_NOTIFICATION_DEFAULTS,
  deleteAlertNotificationPreferencesForUser,
  migrateAlertNotificationPreferences,
  readAlertNotificationPreferences,
  saveAlertNotificationPreferences,
  validateAlertNotificationPreferences,
} from './alert-notification-preferences.js'

test('alert notification preference storage defaults, updates, and deletes account-owned rows', () => {
  const db = new Database(':memory:')
  try {
    migrateAlertNotificationPreferences(db)
    assert.deepEqual(readAlertNotificationPreferences(db, 'one'), { ...ALERT_NOTIFICATION_DEFAULTS, updatedAt: null })
    const saved = saveAlertNotificationPreferences(db, 'one', { ...ALERT_NOTIFICATION_DEFAULTS, criticalPopupEnabled: false }, 123)
    assert.equal(saved.criticalPopupEnabled, false)
    assert.equal(saved.minorSound, 'minor-soft')
    assert.equal(validateAlertNotificationPreferences({ ...ALERT_NOTIFICATION_DEFAULTS, majorSound: 'woodblock' }).ok, true)
    assert.equal(validateAlertNotificationPreferences({ ...ALERT_NOTIFICATION_DEFAULTS, majorSound: 'not-a-sound' }).ok, false)
    assert.equal(saved.updatedAt, 123)
    assert.equal(deleteAlertNotificationPreferencesForUser(db, 'one'), 1)
    assert.deepEqual(readAlertNotificationPreferences(db, 'one'), { ...ALERT_NOTIFICATION_DEFAULTS, updatedAt: null })
  } finally { db.close() }
})

test('preference migration assigns the three default sounds to an existing table', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`CREATE TABLE alert_notification_preferences (
      user_id TEXT PRIMARY KEY,
      realtime_enabled INTEGER NOT NULL DEFAULT 1,
      sound_enabled INTEGER NOT NULL DEFAULT 1,
      minor_popup_enabled INTEGER NOT NULL DEFAULT 1,
      minor_notification_enabled INTEGER NOT NULL DEFAULT 1,
      major_popup_enabled INTEGER NOT NULL DEFAULT 1,
      major_notification_enabled INTEGER NOT NULL DEFAULT 1,
      critical_popup_enabled INTEGER NOT NULL DEFAULT 1,
      critical_notification_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`)
    migrateAlertNotificationPreferences(db)
    assert.deepEqual(readAlertNotificationPreferences(db, 'existing'), { ...ALERT_NOTIFICATION_DEFAULTS, updatedAt: null })
  } finally { db.close() }
})
