import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  createLoginFailureTracker,
  migrateUserSecurityColumns,
  validatePassword,
} from './account-security.js'

test('password policy requires length, an English letter, and a number', () => {
  assert.equal(validatePassword('Abc1234').ok, false)
  assert.equal(validatePassword('abcdefgh').ok, false)
  assert.equal(validatePassword('12345678').ok, false)
  assert.equal(validatePassword('合法的 密码A1').ok, true)
  assert.equal(validatePassword('Special!9').ok, true)
})

test('login failures are case-insensitive, lock on the fifth failure, expire, and clear on success', () => {
  let currentTime = 1_000
  const tracker = createLoginFailureTracker({ now: () => currentTime })
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(tracker.recordFailure(attempt % 2 ? 'ExampleUser' : 'exampleuser').locked, false)
  }
  const fifth = tracker.recordFailure('EXAMPLEUSER')
  assert.equal(fifth.failures, 5)
  assert.equal(fifth.justLocked, true)
  assert.equal(tracker.getState('exampleuser').locked, true)

  currentTime += 5 * 60 * 1000
  assert.deepEqual(tracker.getState('ExampleUser'), { failures: 0, locked: false, lockedUntil: 0 })

  tracker.recordFailure('ExampleUser')
  tracker.clear('exampleuser')
  assert.equal(tracker.getState('EXAMPLEUSER').failures, 0)
})

test('user security migration is idempotent and preserves existing account data', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  const insert = db.prepare(`
    INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run('inactive-admin', 'inactive-admin', 'hash-1', 'admin', 'inactive', 10, 10)
  insert.run('first-active-admin', 'first-admin', 'hash-2', 'admin', 'active', 20, 20)
  insert.run('second-active-admin', 'second-admin', 'hash-3', 'admin', 'active', 30, 30)
  insert.run('standard-user', 'standard-user', 'hash-4', 'standard', 'active', 5, 5)

  migrateUserSecurityColumns(db)
  migrateUserSecurityColumns(db)

  const users = db.prepare(`
    SELECT id, password_hash, role, status, is_initial_admin, must_change_password
    FROM users
    ORDER BY id
  `).all()
  assert.deepEqual(
    users.map(({ id, password_hash, role, status }) => ({ id, password_hash, role, status })),
    [
      { id: 'first-active-admin', password_hash: 'hash-2', role: 'admin', status: 'active' },
      { id: 'inactive-admin', password_hash: 'hash-1', role: 'admin', status: 'inactive' },
      { id: 'second-active-admin', password_hash: 'hash-3', role: 'admin', status: 'active' },
      { id: 'standard-user', password_hash: 'hash-4', role: 'standard', status: 'active' },
    ],
  )
  assert.equal(users.filter(user => user.is_initial_admin === 1).length, 1)
  assert.equal(users.find(user => user.id === 'first-active-admin').is_initial_admin, 1)
  assert.equal(users.every(user => user.must_change_password === 0), true)
  db.close()
})
