export const PASSWORD_POLICY_MESSAGE = '密码至少8位，必须同时包含英文字母和数字'
export const LOGIN_FAILURE_LIMIT = 5
export const LOGIN_LOCK_MS = 5 * 60 * 1000

export function validatePassword(password) {
  const value = String(password || '')
  return {
    ok: value.length >= 8 && /[A-Za-z]/.test(value) && /\d/.test(value),
    message: PASSWORD_POLICY_MESSAGE,
  }
}

export function normalizeLoginUsername(username) {
  return String(username || '').trim().toLowerCase()
}

export function createLoginFailureTracker({
  limit = LOGIN_FAILURE_LIMIT,
  lockMs = LOGIN_LOCK_MS,
  now = () => Date.now(),
} = {}) {
  const entries = new Map()

  function getState(username) {
    const key = normalizeLoginUsername(username)
    const entry = entries.get(key)
    if (!entry) return { failures: 0, locked: false, lockedUntil: 0 }
    if (entry.lockedUntil && entry.lockedUntil <= now()) {
      entries.delete(key)
      return { failures: 0, locked: false, lockedUntil: 0 }
    }
    return {
      failures: entry.failures,
      locked: entry.lockedUntil > now(),
      lockedUntil: entry.lockedUntil,
    }
  }

  function recordFailure(username) {
    const key = normalizeLoginUsername(username)
    const current = getState(key)
    const failures = current.failures + 1
    const lockedUntil = failures >= limit ? now() + lockMs : 0
    const next = { failures, lockedUntil }
    entries.set(key, next)
    return {
      failures,
      locked: lockedUntil > 0,
      lockedUntil,
      justLocked: failures === limit,
    }
  }

  function clear(username) {
    entries.delete(normalizeLoginUsername(username))
  }

  return { getState, recordFailure, clear }
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)
}

export function migrateUserSecurityColumns(db) {
  db.transaction(() => {
    if (!hasColumn(db, 'users', 'is_initial_admin')) {
      db.exec('ALTER TABLE users ADD COLUMN is_initial_admin INTEGER NOT NULL DEFAULT 0')
    }
    if (!hasColumn(db, 'users', 'must_change_password')) {
      db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0')
    }

    db.exec(`
      UPDATE users SET is_initial_admin = 0 WHERE is_initial_admin IS NULL OR is_initial_admin NOT IN (0, 1);
      UPDATE users SET must_change_password = 0 WHERE must_change_password IS NULL OR must_change_password NOT IN (0, 1);
    `)

    const flagged = db.prepare(`
      SELECT id, role, status
      FROM users
      WHERE is_initial_admin = 1
      ORDER BY created_at ASC, id ASC
    `).all()
    const validFlag = flagged.length === 1 && flagged[0].role === 'admin' && flagged[0].status === 'active'
    if (!validFlag) {
      db.prepare('UPDATE users SET is_initial_admin = 0 WHERE is_initial_admin <> 0').run()
      const earliestActiveAdmin = db.prepare(`
        SELECT id
        FROM users
        WHERE role = 'admin' AND status = 'active'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get()
      if (earliestActiveAdmin) {
        db.prepare('UPDATE users SET is_initial_admin = 1 WHERE id = ?').run(earliestActiveAdmin.id)
      }
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_initial_admin
      ON users(is_initial_admin)
      WHERE is_initial_admin = 1;
    `)
  })()
}

export function isPasswordChangeRequest(req, user) {
  if (!user?.mustChangePassword || !user?.id) return true
  const path = String(req.originalUrl || req.url || '').split('?')[0]
  return req.method === 'PUT' && path === `/api/users/${user.id}/password`
}

export function canManageUser(actor, target, nextRole = target?.role) {
  if (actor?.role !== 'admin' || !target) return false
  if (target.is_initial_admin) return actor.id === target.id && nextRole === target.role
  if (target.role === 'admin' || target.role === 'auditor' || nextRole === 'admin' || nextRole === 'auditor') {
    return Boolean(actor.isInitialAdmin)
  }
  return true
}
