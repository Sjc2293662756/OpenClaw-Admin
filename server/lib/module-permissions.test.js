import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  MODULE_PERMISSION_CATALOG,
  ModulePermissionError,
  getUserModulePermissionProjection,
  migrateModulePermissions,
  replaceUserModulePermissionOverrides,
  resolveEffectiveModulePermissions,
  validateModulePermissionOverrides,
} from './module-permissions.js'

function createDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_initial_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE audit_logs (id TEXT);
  `)
  migrateModulePermissions(db)
  const insert = db.prepare(`INSERT INTO users (
    id, username, role, status, is_initial_admin, created_at, updated_at
  ) VALUES (?, ?, ?, 'active', ?, 1, 1)`)
  insert.run('initial', 'root', 'admin', 1)
  insert.run('admin', 'admin', 'admin', 0)
  insert.run('auditor', 'auditor', 'auditor', 0)
  insert.run('standard-a', 'standard-a', 'standard', 0)
  insert.run('standard-b', 'standard-b', 'standard', 0)
  insert.run('basic', 'basic', 'basic', 0)
  return db
}

function row(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id)
}

function byKey(projection, key) {
  return projection.modules.find((entry) => entry.moduleKey === key)
}

test('no overrides match the approved four-role matrix for every catalog key', () => {
  const db = createDb()
  for (const id of ['basic', 'standard-a', 'auditor', 'admin']) {
    const user = row(db, id)
    const projection = resolveEffectiveModulePermissions(db, user)
    for (const entry of MODULE_PERMISSION_CATALOG) {
      const expected = entry.moduleKey === 'platformBranding'
        ? false
        : entry.defaultRoles.includes(user.role)
      assert.equal(byKey(projection, entry.moduleKey).effectiveAllowed, expected, `${id}:${entry.moduleKey}`)
      assert.equal(byKey(projection, entry.moduleKey).defaultAllowed, entry.defaultRoles.includes(user.role))
    }
  }
  const initial = resolveEffectiveModulePermissions(db, row(db, 'initial'))
  assert.equal(byKey(initial, 'platformBranding').effectiveAllowed, true)
})

test('allow, deny, delete and same-role isolation use optimistic versions', () => {
  const db = createDb()
  const audits = []
  const recordAudit = (...args) => { audits.push(args); return true }
  let result = replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial', username: 'root', role: 'admin', isInitialAdmin: true },
    userId: 'standard-a', expectedVersion: 0,
    overrides: [
      { moduleKey: 'cron', effect: 'allow' },
      { moduleKey: 'channels', effect: 'deny' },
    ],
    recordAudit,
  })
  assert.equal(result.permissionVersion, 1)
  assert.equal(byKey(result, 'cron').effectiveAllowed, true)
  assert.equal(byKey(result, 'channels').effectiveAllowed, false)
  assert.equal(getUserModulePermissionProjection(db, 'standard-b').permissionVersion, 0)
  assert.equal(byKey(getUserModulePermissionProjection(db, 'standard-b'), 'channels').effectiveAllowed, true)

  result = replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial', username: 'root', role: 'admin', isInitialAdmin: true },
    userId: 'standard-a', expectedVersion: 1, overrides: [], recordAudit, action: '恢复用户模块默认权限',
  })
  assert.equal(result.permissionVersion, 2)
  assert.equal(byKey(result, 'cron').effectiveAllowed, false)
  assert.equal(byKey(result, 'channels').effectiveAllowed, true)
  assert.equal(audits.filter((entry) => entry[1] === '更新用户模块权限').length, 1)
  assert.equal(audits.filter((entry) => entry[1] === '恢复用户模块默认权限').length, 1)
  assert.equal(audits.filter((entry) => entry[1] === '用户模块权限前后差异').length, 2)
  assert.equal(audits.every((entry) => String(entry[3]).length <= 500), true)
})

test('role changes recompute defaults while retaining personal overrides', () => {
  const db = createDb()
  replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial' }, userId: 'standard-a', expectedVersion: 0,
    overrides: [{ moduleKey: 'cron', effect: 'allow' }], recordAudit: () => true,
  })
  db.prepare("UPDATE users SET role = 'basic' WHERE id = 'standard-a'").run()
  const projection = getUserModulePermissionProjection(db, 'standard-a')
  assert.equal(byKey(projection, 'dashboard').defaultAllowed, false)
  assert.equal(byKey(projection, 'cron').defaultAllowed, false)
  assert.equal(byKey(projection, 'cron').effectiveAllowed, true)
})

test('rejects unknown keys, invalid effects, duplicates, locked items and dependency conflicts', () => {
  const db = createDb()
  const standard = row(db, 'standard-a')
  const cases = [
    [[{ moduleKey: 'free.text', effect: 'allow' }], 'UNKNOWN_MODULE_PERMISSION_KEY'],
    [[{ moduleKey: 'cron', effect: 'inherit' }], 'INVALID_MODULE_PERMISSION_EFFECT'],
    [[{ moduleKey: 'cron', effect: 'allow' }, { moduleKey: 'cron', effect: 'deny' }], 'DUPLICATE_MODULE_PERMISSION_KEY'],
    [[{ moduleKey: 'platformBranding', effect: 'allow' }], 'MODULE_PERMISSION_LOCKED'],
  ]
  for (const [input, code] of cases) {
    assert.throws(() => validateModulePermissionOverrides(standard, input), (error) => error instanceof ModulePermissionError && error.code === code)
  }
  assert.throws(() => replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial' }, userId: 'standard-a', expectedVersion: 0,
    overrides: [{ moduleKey: 'alerts.records', effect: 'deny' }], recordAudit: () => true,
  }), (error) => error.code === 'MODULE_PERMISSION_DEPENDENCY_CONFLICT')
})

test('initial administrator core permissions are locked and version conflicts are stable', () => {
  const db = createDb()
  assert.throws(() => validateModulePermissionOverrides(row(db, 'initial'), [
    { moduleKey: 'users', effect: 'deny' },
  ]), (error) => error.code === 'MODULE_PERMISSION_LOCKED')
  assert.throws(() => replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial' }, userId: 'basic', expectedVersion: 9,
    overrides: [], recordAudit: () => true,
  }), (error) => error.code === 'PERMISSION_VERSION_CONFLICT' && error.extra.currentVersion === 0)
})
