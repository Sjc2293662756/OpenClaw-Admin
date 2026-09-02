import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  CHAT_DISPLAY_PREFERENCES_DEFAULTS,
  deleteChatDisplayPreferencesForUser,
  migrateChatDisplayPreferences,
  readChatDisplayPreferences,
  saveChatDisplayPreferences,
  validateChatDisplayPreferences,
} from './chat-display-preferences.js'

test('chat display preference storage defaults on, persists per account, migrates idempotently, and deletes owned rows', () => {
  const db = new Database(':memory:')
  try {
    migrateChatDisplayPreferences(db)
    migrateChatDisplayPreferences(db)
    assert.deepEqual(readChatDisplayPreferences(db, 'user-one'), {
      ...CHAT_DISPLAY_PREFERENCES_DEFAULTS,
      updatedAt: null,
    })
    assert.deepEqual(saveChatDisplayPreferences(db, 'user-one', { showThinkingProcess: false }, 123), {
      showThinkingProcess: false,
      updatedAt: 123,
    })
    assert.equal(readChatDisplayPreferences(db, 'user-two').showThinkingProcess, true)
    assert.equal(deleteChatDisplayPreferencesForUser(db, 'user-one'), 1)
    assert.equal(deleteChatDisplayPreferencesForUser(db, 'user-one'), 0)
    assert.equal(readChatDisplayPreferences(db, 'user-one').showThinkingProcess, true)
  } finally {
    db.close()
  }
})

test('chat display preference validation accepts exactly one boolean field', () => {
  assert.deepEqual(validateChatDisplayPreferences({ showThinkingProcess: false }), {
    ok: true,
    value: { showThinkingProcess: false },
  })
  for (const value of [null, [], {}, { showThinkingProcess: 'false' }, { showThinkingProcess: true, userId: 'other' }]) {
    assert.equal(validateChatDisplayPreferences(value).ok, false)
  }
})
