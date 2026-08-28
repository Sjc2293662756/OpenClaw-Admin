import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  ALERT_NOTIFICATION_DEFAULTS,
  deleteAlertNotificationPreferencesForUser,
  migrateAlertNotificationPreferences,
  readAlertNotificationPreferences,
  saveAlertNotificationPreferences,
} from './alert-notification-preferences.js'

test('alert notification preference storage defaults, updates, and deletes account-owned rows', () => {
  const db = new Database(':memory:')
  try {
    migrateAlertNotificationPreferences(db)
    assert.deepEqual(readAlertNotificationPreferences(db, 'one'), { ...ALERT_NOTIFICATION_DEFAULTS, updatedAt: null })
    const saved = saveAlertNotificationPreferences(db, 'one', { ...ALERT_NOTIFICATION_DEFAULTS, criticalPopupEnabled: false }, 123)
    assert.equal(saved.criticalPopupEnabled, false)
    assert.equal(saved.updatedAt, 123)
    assert.equal(deleteAlertNotificationPreferencesForUser(db, 'one'), 1)
    assert.deepEqual(readAlertNotificationPreferences(db, 'one'), { ...ALERT_NOTIFICATION_DEFAULTS, updatedAt: null })
  } finally { db.close() }
})
