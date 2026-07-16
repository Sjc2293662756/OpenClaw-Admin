import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'

export function createUsersRouter({
  db,
  sessions,
  authMiddleware,
  adminMiddleware,
  recordAudit,
  hashPassword,
  verifyPassword,
  publicUser,
  userRoles,
  userStatuses,
  resetPassword,
  createId,
}) {
  const router = Router()

  router.get('/', authMiddleware, (_req, res) => {
    const users = db.prepare('SELECT id, username, role, description, status, created_at, updated_at FROM users ORDER BY updated_at DESC').all()
    sendOk(res, { users: users.map(publicUser) })
  })

  router.post('/', adminMiddleware, (req, res) => {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    const role = String(req.body?.role || '')
    const description = String(req.body?.description || '').trim()
    const status = String(req.body?.status || 'active')

    if (!username || username.length > 64 || !password || password.length < 6 || !userRoles.has(role) || !userStatuses.has(status) || description.length > 500) {
      return sendError(res, { status: 400, code: 'INVALID_USER_INPUT', message: '用户信息不完整或格式不正确' })
    }

    try {
      const now = Date.now()
      const user = {
        id: createId(), username, password_hash: hashPassword(password), role, description, status,
        created_at: now, updated_at: now,
      }
      db.prepare(`INSERT INTO users (id, username, password_hash, role, description, status, created_at, updated_at)
        VALUES (@id, @username, @password_hash, @role, @description, @status, @created_at, @updated_at)`).run(user)
      recordAudit(req.user, '创建用户', username, `角色：${role}；状态：${status}`)
      sendOk(res, { user: publicUser(user) }, 201)
    } catch (error) {
      const duplicate = String(error.message).includes('UNIQUE')
      sendError(res, {
        status: duplicate ? 409 : 500,
        code: duplicate ? 'USERNAME_EXISTS' : 'USER_CREATE_FAILED',
        message: duplicate ? '用户名已存在' : '创建用户失败',
      })
    }
  })

  router.put('/:id', adminMiddleware, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return sendError(res, { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' })

    const role = String(req.body?.role || '')
    const description = String(req.body?.description || '').trim()
    const status = String(req.body?.status || '')
    if (!userRoles.has(role) || !userStatuses.has(status) || description.length > 500) {
      return sendError(res, { status: 400, code: 'INVALID_USER_INPUT', message: '用户信息不完整或格式不正确' })
    }

    const roleChanged = role !== user.role
    const statusChanged = status !== user.status
    if (req.user.id === user.id && (roleChanged || status === 'inactive')) {
      return sendError(res, {
        status: 400,
        code: 'CURRENT_USER_SECURITY_UPDATE_FORBIDDEN',
        message: '不能修改当前登录账户的角色或将其停用',
      })
    }

    if (user.role === 'admin' && user.status === 'active' && (role !== 'admin' || status !== 'active')) {
      const activeAdminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count
      if (activeAdminCount <= 1) {
        return sendError(res, {
          status: 400,
          code: 'LAST_ADMIN_UPDATE_FORBIDDEN',
          message: '至少需要保留一个已激活的管理员账户',
        })
      }
    }

    const updatedAt = Date.now()
    db.prepare('UPDATE users SET role = ?, description = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(role, description, status, updatedAt, user.id)
    if (roleChanged || statusChanged) {
      for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
    }
    recordAudit(req.user, '编辑用户', user.username, `角色：${user.role} → ${role}；状态：${user.status} → ${status}`)
    const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
    sendOk(res, { user: publicUser(updatedUser) })
  })

  router.post('/:id/reset-password', adminMiddleware, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return sendError(res, { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' })
    const updatedAt = Date.now()
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(resetPassword), updatedAt, user.id)
    for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
    recordAudit(req.user, '重置用户密码', user.username, '已重置为默认密码')
    sendOk(res, { updatedAt })
  })

  router.put('/:id/password', authMiddleware, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return sendError(res, { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' })
    const newPassword = String(req.body?.newPassword || '')
    const isSelf = req.user.id === user.id
    if (!isSelf && req.user.role !== 'admin') {
      return sendError(res, { status: 403, code: 'PERMISSION_DENIED', message: '无权修改该用户密码' })
    }
    if (newPassword.length < 6) {
      return sendError(res, { status: 400, code: 'PASSWORD_TOO_SHORT', message: '密码至少 6 位' })
    }
    if (isSelf && !verifyPassword(String(req.body?.currentPassword || ''), user.password_hash)) {
      return sendError(res, { status: 400, code: 'CURRENT_PASSWORD_INCORRECT', message: '当前密码不正确' })
    }
    const updatedAt = Date.now()
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(newPassword), updatedAt, user.id)
    const currentToken = req.headers.authorization?.replace('Bearer ', '')
    for (const [token, session] of sessions) if (session.id === user.id && token !== currentToken) sessions.delete(token)
    recordAudit(req.user, isSelf ? '修改本人密码' : '修改用户密码', user.username)
    sendOk(res, { updatedAt })
  })

  router.delete('/:id', adminMiddleware, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return sendError(res, { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' })
    if (req.user.id === user.id) {
      return sendError(res, { status: 400, code: 'CURRENT_USER_DELETE_FORBIDDEN', message: '不能删除当前登录账户' })
    }
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count
      if (adminCount <= 1) {
        return sendError(res, { status: 400, code: 'LAST_ADMIN_DELETE_FORBIDDEN', message: '至少需要保留一个已激活的管理员账户' })
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
    recordAudit(req.user, '删除用户', user.username, `角色：${user.role}`)
    sendOk(res)
  })

  return router
}
