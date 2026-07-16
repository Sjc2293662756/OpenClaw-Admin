import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'

export function createAuthRouter({
  db,
  sessions,
  authMiddleware,
  isAuthEnabled,
  getLegacyCredentials,
  verifyPassword,
  recordAudit,
  createId,
  getSessionSettings,
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

    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username)
    const legacyCredentials = getLegacyCredentials()
    const validUser = user && user.status === 'active' && verifyPassword(password, user.password_hash)
    const validLegacyUser = !user && username === legacyCredentials.username && password === legacyCredentials.password
    if (!validUser && !validLegacyUser) {
      return sendError(res, { status: 401, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    const sessionUser = validUser
      ? { id: user.id, username: user.username, role: user.role }
      : { username: legacyCredentials.username, role: 'admin' }
    const now = Date.now()
    const policy = getSessionSettings()
    const token = createId()
    sessions.set(token, {
      ...sessionUser,
      createdAt: now,
      lastActiveAt: now,
      expires: now + policy.loginSessionHours * 60 * 60 * 1000,
    })
    recordAudit(sessionUser, '登录', '管理平台', '登录成功')
    sendOk(res, { token, user: sessionUser })
  })

  router.post('/logout', (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (token) {
      recordAudit(sessions.get(token), '退出登录', '管理平台', '用户主动退出')
      sessions.delete(token)
    }
    sendOk(res)
  })

  router.get('/check', authMiddleware, (req, res) => {
    sendOk(res, {
      authenticated: true,
      user: { id: req.user.id, username: req.user.username, role: req.user.role },
    })
  })

  return router
}
