import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { createLoginFailureTracker } from '../lib/account-security.js'

export function createAuthRouter({
  db,
  sessions,
  authMiddleware,
  isAuthEnabled,
  verifyPassword,
  recordAudit,
  createId,
  getSessionSettings,
  loginFailures = createLoginFailureTracker(),
}) {
  const router = Router()

  router.get('/config', (_req, res) => {
    sendOk(res, { enabled: isAuthEnabled() })
  })

  router.post('/login', (req, res) => {
    if (!isAuthEnabled()) return sendOk(res, { message: '认证未启用' })

    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!username || !password) {
      return sendError(res, { status: 400, code: 'LOGIN_INPUT_REQUIRED', message: '请输入用户名和密码' })
    }
    if (username.length > 64) {
      return sendError(res, { status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    const failureState = loginFailures.getState(username)
    if (failureState.locked) {
      recordAudit({ username, role: 'unknown' }, '登录失败', '管理平台', '账户处于临时锁定期', {
        req, category: 'authentication', result: 'failed', source: 'auth', errorCode: 'INVALID_CREDENTIALS',
      })
      res.locals.auditRejectionRecorded = true
      return sendError(res, { status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username)
    const validUser = user && user.status === 'active' && verifyPassword(password, user.password_hash)
    if (!validUser) {
      const result = loginFailures.recordFailure(username)
      recordAudit(
        { id: user?.id, username, role: user?.role || 'unknown' },
        result.justLocked ? '登录锁定' : '登录失败',
        '管理平台',
        result.justLocked ? '连续登录失败达到限制，临时锁定5分钟' : `连续失败次数：${result.failures}`,
        { req, category: 'authentication', result: 'failed', source: 'auth', errorCode: 'INVALID_CREDENTIALS' },
      )
      res.locals.auditRejectionRecorded = true
      return sendError(res, { status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    loginFailures.clear(username)
    const sessionUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      isInitialAdmin: Boolean(user.is_initial_admin),
      mustChangePassword: Boolean(user.must_change_password),
    }
    const now = Date.now()
    const policy = getSessionSettings()
    const token = createId()
    sessions.set(token, {
      ...sessionUser,
      createdAt: now,
      lastActiveAt: now,
      expires: now + policy.loginSessionHours * 60 * 60 * 1000,
    })
    recordAudit(sessionUser, '登录', '管理平台', '登录成功', { req, category: 'authentication', result: 'success', source: 'auth' })
    sendOk(res, { token, user: sessionUser })
  })

  router.post('/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (token) {
      const session = sessions.get(token)
      if (session) recordAudit(session, '退出登录', '管理平台', '用户主动退出', { req, category: 'authentication', result: 'success', source: 'auth' })
      sessions.delete(token)
    }
    sendOk(res)
  })

  router.get('/check', authMiddleware, (req, res) => {
    sendOk(res, {
      authenticated: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        isInitialAdmin: Boolean(req.user.isInitialAdmin),
        mustChangePassword: Boolean(req.user.mustChangePassword),
      },
    })
  })

  return router
}
