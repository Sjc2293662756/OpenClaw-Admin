import assert from 'node:assert/strict'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import { createRoleMiddleware } from '../lib/permissions.js'
import {
  createLoginFailureTracker,
  isPasswordChangeRequest,
  migrateUserSecurityColumns,
} from '../lib/account-security.js'
import { sendError } from '../lib/api-response.js'
import { createAuthRouter } from './auth.js'
import { createUsersRouter } from './users.js'

const PASSWORDS = {
  initial: 'InitialA1!',
  admin: 'AdminUser2!',
  basic: 'BasicUser3!',
  temporary: 'Temp Pass4!',
  replacement: 'New Pass5!',
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('base64')
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('base64')}`
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, encodedHash] = String(storedHash || '').split('$')
  if (algorithm !== 'scrypt' || !salt || !encodedHash) return false
  const expected = Buffer.from(encodedHash, 'base64')
  const actual = scryptSync(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    description: user.description || '',
    status: user.status,
    isInitialAdmin: Boolean(user.is_initial_admin),
    mustChangePassword: Boolean(user.must_change_password),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  }
}

async function createFixture() {
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
  migrateUserSecurityColumns(db)
  const insert = db.prepare(`
    INSERT INTO users (
      id, username, password_hash, role, description, status,
      is_initial_admin, must_change_password, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'active', ?, 0, ?, ?)
  `)
  insert.run('initial-id', 'initial-admin', hashPassword(PASSWORDS.initial), 'admin', 1, 1, 1)
  insert.run('admin-id', 'ordinary-admin', hashPassword(PASSWORDS.admin), 'admin', 0, 2, 2)
  insert.run('basic-id', 'basic-user', hashPassword(PASSWORDS.basic), 'basic', 0, 3, 3)

  const sessions = new Map()
  const audits = []
  let currentTime = 10_000
  const loginFailures = createLoginFailureTracker({ now: () => currentTime })
  const app = express()
  app.use(express.json())

  function checkAuth(req) {
    const token = req.headers.authorization?.replace('Bearer ', '')
    return token ? sessions.get(token) : null
  }
  function authMiddleware(req, res, next) {
    const session = checkAuth(req)
    if (!session) return sendError(res, { status: 401, code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录' })
    req.user = session
    const path = String(req.originalUrl || '').split('?')[0]
    if (session.mustChangePassword && path !== '/api/auth/check' && !isPasswordChangeRequest(req, session)) {
      return sendError(res, { status: 403, code: 'PASSWORD_CHANGE_REQUIRED', message: '必须先修改临时密码' })
    }
    next()
  }
  const adminMiddleware = createRoleMiddleware(authMiddleware, ['admin'], '仅管理员可以执行此操作')
  const recordAudit = (user, action, target = '', detail = '') => {
    audits.push({ user, action, target, detail })
  }

  app.use('/api/auth', createAuthRouter({
    db,
    sessions,
    authMiddleware,
    isAuthEnabled: () => true,
    verifyPassword,
    recordAudit,
    createId: randomUUID,
    getSessionSettings: () => ({ loginSessionHours: 24 }),
    loginFailures,
  }))
  app.use('/api/users', createUsersRouter({
    db,
    sessions,
    authMiddleware,
    adminMiddleware,
    recordAudit,
    hashPassword,
    verifyPassword,
    publicUser,
    userRoles: new Set(['basic', 'auditor', 'standard', 'admin']),
    userStatuses: new Set(['active', 'inactive']),
    createId: randomUUID,
  }))
  app.get('/api/protected', authMiddleware, (_req, res) => res.json({ ok: true }))
  app.post('/api/rpc', authMiddleware, (_req, res) => res.json({ ok: true }))

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  async function request(path, { token, ...options } = {}) {
    const headers = { ...(options.headers || {}) }
    if (token) headers.Authorization = `Bearer ${token}`
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
    const body = await response.json()
    return { response, body }
  }
  async function login(username, password) {
    const result = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    return { ...result, token: result.body.token }
  }

  return {
    db,
    sessions,
    audits,
    loginFailures,
    request,
    login,
    advanceTime: milliseconds => { currentTime += milliseconds },
    async close() {
      server.close()
      await once(server, 'close')
      db.close()
    },
  }
}

test('login lockout is case-insensitive, uses the same external error, and clears after success', async () => {
  const fixture = await createFixture()
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await fixture.login(attempt % 2 ? 'BASIC-USER' : 'basic-user', 'WrongPass9!')
      assert.equal(failed.response.status, 401)
      assert.equal(failed.body.code, 'INVALID_CREDENTIALS')
      assert.equal(failed.body.error, '用户名或密码错误')
    }
    assert.equal((await fixture.login('basic-user', PASSWORDS.basic)).response.status, 401)
    const missing = await fixture.login('missing-user', 'WrongPass9!')
    assert.equal(missing.body.error, '用户名或密码错误')

    fixture.advanceTime(5 * 60 * 1000)
    const successful = await fixture.login('basic-user', PASSWORDS.basic)
    assert.equal(successful.response.status, 200)
    assert.equal(fixture.loginFailures.getState('BASIC-USER').failures, 0)
    assert.equal(fixture.audits.some(entry => entry.action === '登录锁定'), true)
  } finally {
    await fixture.close()
  }
})

test('password policy, administrator hierarchy, and direct REST protections are enforced', async () => {
  const fixture = await createFixture()
  try {
    const initial = await fixture.login('initial-admin', PASSWORDS.initial)
    const ordinary = await fixture.login('ordinary-admin', PASSWORDS.admin)

    for (const password of ['Abc1234', 'abcdefgh', '12345678']) {
      const rejected = await fixture.request('/api/users', {
        token: initial.token,
        method: 'POST',
        body: JSON.stringify({ username: `user-${password.length}-${password[0]}`, password, role: 'basic', status: 'active' }),
      })
      assert.equal(rejected.body.code, 'PASSWORD_POLICY_VIOLATION')
    }

    const created = await fixture.request('/api/users', {
      token: ordinary.token,
      method: 'POST',
      body: JSON.stringify({ username: 'managed-user', password: 'Valid User6!', role: 'standard', status: 'active' }),
    })
    assert.equal(created.response.status, 201)
    const ordinaryEditsUser = await fixture.request(`/api/users/${created.body.user.id}`, {
      token: ordinary.token,
      method: 'PUT',
      body: JSON.stringify({ role: 'auditor', description: 'managed', status: 'active' }),
    })
    assert.equal(ordinaryEditsUser.response.status, 200)

    const ordinaryCreatesAdmin = await fixture.request('/api/users', {
      token: ordinary.token,
      method: 'POST',
      body: JSON.stringify({ username: 'blocked-admin', password: 'Valid Admin7!', role: 'admin', status: 'active' }),
    })
    assert.equal(ordinaryCreatesAdmin.body.code, 'ADMIN_MANAGEMENT_FORBIDDEN')

    const ordinaryPromotesUser = await fixture.request(`/api/users/${created.body.user.id}`, {
      token: ordinary.token,
      method: 'PUT',
      body: JSON.stringify({ role: 'admin', description: '', status: 'active' }),
    })
    assert.equal(ordinaryPromotesUser.body.code, 'ADMIN_MANAGEMENT_FORBIDDEN')

    const ordinaryEditsAdmin = await fixture.request('/api/users/admin-id', {
      token: ordinary.token,
      method: 'PUT',
      body: JSON.stringify({ role: 'standard', description: '', status: 'active' }),
    })
    assert.equal(ordinaryEditsAdmin.response.status, 403)

    const initialProtections = [
      fixture.request('/api/users/initial-id', {
        token: ordinary.token,
        method: 'PUT',
        body: JSON.stringify({ role: 'basic', description: '', status: 'inactive' }),
      }),
      fixture.request('/api/users/initial-id/reset-password', {
        token: ordinary.token,
        method: 'POST',
        body: JSON.stringify({ temporaryPassword: PASSWORDS.temporary, confirmPassword: PASSWORDS.temporary }),
      }),
      fixture.request('/api/users/initial-id', { token: ordinary.token, method: 'DELETE' }),
    ]
    for (const resultPromise of initialProtections) {
      const result = await resultPromise
      assert.equal(result.response.status >= 400, true)
    }

    const initialCreatesAdmin = await fixture.request('/api/users', {
      token: initial.token,
      method: 'POST',
      body: JSON.stringify({ username: 'created-admin', password: 'Valid Admin8!', role: 'admin', status: 'active' }),
    })
    assert.equal(initialCreatesAdmin.response.status, 201)

    const initialEditsAdmin = await fixture.request('/api/users/admin-id', {
      token: initial.token,
      method: 'PUT',
      body: JSON.stringify({ role: 'standard', description: 'managed', status: 'active' }),
    })
    assert.equal(initialEditsAdmin.response.status, 200)

    assert.equal(fixture.db.prepare('SELECT role, status FROM users WHERE id = ?').get('initial-id').role, 'admin')
    assert.equal(fixture.db.prepare('SELECT status FROM users WHERE id = ?').get('initial-id').status, 'active')
  } finally {
    await fixture.close()
  }
})

test('reset user must change password, cannot access protected REST or RPC, then must reauthenticate', async () => {
  const fixture = await createFixture()
  try {
    const initial = await fixture.login('initial-admin', PASSWORDS.initial)
    const reset = await fixture.request('/api/users/basic-id/reset-password', {
      token: initial.token,
      method: 'POST',
      body: JSON.stringify({
        temporaryPassword: PASSWORDS.temporary,
        confirmPassword: PASSWORDS.temporary,
      }),
    })
    assert.equal(reset.response.status, 200)
    assert.equal(fixture.db.prepare('SELECT must_change_password FROM users WHERE id = ?').get('basic-id').must_change_password, 1)

    const temporaryLogin = await fixture.login('basic-user', PASSWORDS.temporary)
    assert.equal(temporaryLogin.body.user.mustChangePassword, true)
    assert.equal((await fixture.request('/api/protected', { token: temporaryLogin.token })).body.code, 'PASSWORD_CHANGE_REQUIRED')
    assert.equal((await fixture.request('/api/rpc', { token: temporaryLogin.token, method: 'POST' })).body.code, 'PASSWORD_CHANGE_REQUIRED')

    const changed = await fixture.request('/api/users/basic-id/password', {
      token: temporaryLogin.token,
      method: 'PUT',
      body: JSON.stringify({
        currentPassword: PASSWORDS.temporary,
        newPassword: PASSWORDS.replacement,
      }),
    })
    assert.equal(changed.response.status, 200)
    assert.equal(changed.body.reauthenticate, true)
    assert.equal(fixture.db.prepare('SELECT must_change_password FROM users WHERE id = ?').get('basic-id').must_change_password, 0)
    assert.equal((await fixture.request('/api/protected', { token: temporaryLogin.token })).response.status, 401)

    const normalLogin = await fixture.login('basic-user', PASSWORDS.replacement)
    assert.equal(normalLogin.body.user.mustChangePassword, false)
    assert.equal((await fixture.request('/api/protected', { token: normalLogin.token })).response.status, 200)

    const auditText = JSON.stringify(fixture.audits)
    for (const password of Object.values(PASSWORDS)) assert.equal(auditText.includes(password), false)
  } finally {
    await fixture.close()
  }
})
