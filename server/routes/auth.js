import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { createLoginFailureTracker, createLoginIpRateLimiter } from '../lib/account-security.js'
import { getSafeSourceAddress } from '../lib/audit-service.js'

export function createAuthRouter({
  db,
  sessions,
  authMiddleware,
  isAuthEnabled,
  verifyPassword,
  recordAudit,
  createId,
  getSessionSettings,
  projectAuthUser = (user) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    isInitialAdmin: Boolean(user.is_initial_admin ?? user.isInitialAdmin),
    mustChangePassword: Boolean(user.must_change_password ?? user.mustChangePassword),
  }),
  loginFailures = createLoginFailureTracker(),
  loginRateLimiter = createLoginIpRateLimiter(),
}) {
  const router = Router()
  const publicAuthUser = (user) => {
    const { moduleOverrides: _moduleOverrides, ...projection } = user
    return projection
  }

  router.get('/config', (_req, res) => {
    sendOk(res, { enabled: isAuthEnabled() })
  })

  router.post('/login', (req, res) => {
    if (!isAuthEnabled()) return sendOk(res, { message: '认证未启用' })

    const sourceAddress = getSafeSourceAddress(req) || 'unknown'
    const rateDecision = loginRateLimiter.consume(sourceAddress)
    if (!rateDecision.allowed) {
      if (rateDecision.shouldAudit) {
        recordAudit({ username: 'anonymous', role: 'unknown' }, '登录频率限制', '管理平台', '同一来源登录请求超过服务端限制', {
          req, category: 'authentication', result: 'denied', source: 'auth', errorCode: 'LOGIN_RATE_LIMITED',
        })
      }
      res.locals.auditRejectionRecorded = true
      res.setHeader('Retry-After', String(rateDecision.retryAfterSeconds))
      return sendError(res, { status: 429, code: 'LOGIN_RATE_LIMITED', message: '登录请求过于频繁，请稍后再试' })
    }

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
        req, category: 'authentication', result: 'failed', source: 'auth', errorCode: 'LOGIN_TEMPORARILY_LOCKED',
      })
      res.locals.auditRejectionRecorded = true
      return sendError(res, { status: 401, code: 'LOGIN_TEMPORARILY_LOCKED', message: '当前账户用户名或密码连续错误，已锁定5分钟，请稍后再试' })
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
        { req, category: 'authentication', result: 'failed', source: 'auth', errorCode: result.locked ? 'LOGIN_TEMPORARILY_LOCKED' : 'INVALID_CREDENTIALS' },
      )
      res.locals.auditRejectionRecorded = true
      if (result.locked) {
        return sendError(res, { status: 401, code: 'LOGIN_TEMPORARILY_LOCKED', message: '当前账户用户名或密码连续错误，已锁定5分钟，请稍后再试' })
      }
      return sendError(res, { status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    loginFailures.clear(username)
    const sessionUser = projectAuthUser(user)
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
    sendOk(res, { token, user: publicAuthUser(sessionUser) })
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
      user: publicAuthUser(projectAuthUser(req.user)),
    })
  })

  return router
}
