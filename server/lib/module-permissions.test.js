import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  MODULE_PERMISSION_CATALOG,
  ModulePermissionError,
  canViewAllUserData,
  getUserModulePermissionProjection,
  migrateModulePermissions,
  replaceUserModulePermissionOverrides,
  restModuleKeyFor,
  resolveEffectiveModulePermissions,
  validateModulePermissionOverrides,
} from './module-permissions.js'

test('alert exports follow the alert-record module boundary', () => {
  assert.equal(restModuleKeyFor('POST', '/api/alerts/export'), 'alerts.records')
})

test('module-permission administration is identity-gated rather than delegable', () => {
  assert.equal(restModuleKeyFor('GET', '/api/users/target/module-permissions'), null)
  assert.equal(restModuleKeyFor('PUT', '/api/users/target/module-permissions'), null)
})

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
  for (const entry of initial.modules) {
    assert.equal(entry.effectiveAllowed, true, entry.moduleKey)
    assert.equal(entry.locked, true, entry.moduleKey)
  }
  assert.equal(resolveEffectiveModulePermissions(db, row(db, 'basic')).effectiveModules.users, false)
  assert.equal(resolveEffectiveModulePermissions(db, row(db, 'standard-a')).effectiveModules.userAdministration, false)
  assert.equal(resolveEffectiveModulePermissions(db, row(db, 'auditor')).effectiveModules.users, true)
  assert.equal(resolveEffectiveModulePermissions(db, row(db, 'auditor')).effectiveModules.userAdministration, false)
  assert.equal(resolveEffectiveModulePermissions(db, row(db, 'admin')).effectiveModules.users, true)
  assert.equal(resolveEffectiveModulePermissions(db, row(db, 'admin')).effectiveModules.userAdministration, true)
})

test('account governance is role-fixed and ignores projected or legacy personal values', () => {
  const db = createDb()
  db.prepare(`INSERT INTO user_module_permission_overrides (
    user_id, module_key, effect, updated_by, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('basic', 'users', 'allow', 'initial', 1, 1)
  const basic = resolveEffectiveModulePermissions(db, row(db, 'basic'))
  assert.equal(basic.modules.some((entry) => entry.moduleKey === 'users' || entry.moduleKey === 'userAdministration'), false)
  assert.equal(basic.effectiveModules.users, false)
  assert.equal(basic.effectiveModules.userAdministration, false)
})

test('all-user data scope follows role defaults and personal overrides', () => {
  const db = createDb()
  assert.equal(canViewAllUserData(row(db, 'basic')), false)
  assert.equal(canViewAllUserData(row(db, 'standard-a')), false)
  assert.equal(canViewAllUserData(row(db, 'auditor')), true)
  assert.equal(canViewAllUserData(row(db, 'admin')), true)

  const allowed = replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial' }, userId: 'standard-a', expectedVersion: 0,
    overrides: [{ moduleKey: 'data.allUsers', effect: 'allow' }], recordAudit: () => true,
  })
  assert.equal(allowed.effectiveModules['data.allUsers'], true)
  assert.equal(canViewAllUserData(allowed), true)

  const denied = replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial' }, userId: 'auditor', expectedVersion: 0,
    overrides: [{ moduleKey: 'data.allUsers', effect: 'deny' }], recordAudit: () => true,
  })
  assert.equal(denied.effectiveModules['data.allUsers'], false)
  assert.equal(canViewAllUserData(denied), false)
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

test('rejects unknown keys, fixed account governance keys, invalid effects, duplicates and locked items', () => {
  const db = createDb()
  const standard = row(db, 'standard-a')
  const cases = [
    [[{ moduleKey: 'free.text', effect: 'allow' }], 'UNKNOWN_MODULE_PERMISSION_KEY'],
    [[{ moduleKey: 'cron', effect: 'inherit' }], 'INVALID_MODULE_PERMISSION_EFFECT'],
    [[{ moduleKey: 'cron', effect: 'allow' }, { moduleKey: 'cron', effect: 'deny' }], 'DUPLICATE_MODULE_PERMISSION_KEY'],
    [[{ moduleKey: 'platformBranding', effect: 'allow' }], 'MODULE_PERMISSION_LOCKED'],
    [[{ moduleKey: 'users', effect: 'allow' }], 'UNKNOWN_MODULE_PERMISSION_KEY'],
    [[{ moduleKey: 'userAdministration', effect: 'allow' }], 'UNKNOWN_MODULE_PERMISSION_KEY'],
  ]
  for (const [input, code] of cases) {
    assert.throws(() => validateModulePermissionOverrides(standard, input), (error) => error instanceof ModulePermissionError && error.code === code)
  }
})

test('all initial-administrator permissions are locked and version conflicts are stable', () => {
  const db = createDb()
  db.prepare(`INSERT INTO user_module_permission_overrides (
    user_id, module_key, effect, updated_by, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('initial', 'dashboard', 'deny', 'initial', 1, 1)
  const projection = resolveEffectiveModulePermissions(db, row(db, 'initial'))
  assert.equal(byKey(projection, 'dashboard').override, null)
  assert.equal(byKey(projection, 'dashboard').effectiveAllowed, true)
  for (const entry of MODULE_PERMISSION_CATALOG) {
    assert.throws(() => validateModulePermissionOverrides(row(db, 'initial'), [
      { moduleKey: entry.moduleKey, effect: 'deny' },
    ]), (error) => error.code === 'MODULE_PERMISSION_LOCKED')
  }
  assert.throws(() => replaceUserModulePermissionOverrides(db, {
    actor: { id: 'initial' }, userId: 'basic', expectedVersion: 9,
    overrides: [], recordAudit: () => true,
  }), (error) => error.code === 'PERMISSION_VERSION_CONFLICT' && error.extra.currentVersion === 0)
})
