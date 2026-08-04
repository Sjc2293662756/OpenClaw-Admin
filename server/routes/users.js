import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { PASSWORD_POLICY_MESSAGE, canManageUser, validatePassword } from '../lib/account-security.js'

export function createUsersRouter({
  db,
  sessions,
  authMiddleware,
  adminMiddleware,
  accountViewerMiddleware,
  recordAudit,
  hashPassword,
  verifyPassword,
  publicUser,
  userRoles,
  userStatuses,
  createId,
  loginFailures,
}) {
  const router = Router()

  router.get('/', accountViewerMiddleware, (req, res) => {
    const users = db.prepare(`
      SELECT id, username, role, description, status, is_initial_admin, must_change_password, created_at, updated_at
      FROM users
      ORDER BY updated_at DESC
    `).all()
    sendOk(res, {
      users: users.map((user) => {
        const projected = publicUser(user)
        if (req.user?.role !== 'auditor') return projected
        const { mustChangePassword: _mustChangePassword, ...auditorView } = projected
        return auditorView
      }),
    })
  })

  router.post('/', adminMiddleware, (req, res) => {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    const role = String(req.body?.role || '')
    const description = String(req.body?.description || '').trim()
    const status = String(req.body?.status || 'active')

    if (!validatePassword(password).ok) {
      return sendError(res, { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: PASSWORD_POLICY_MESSAGE })
    }
    if (!username || username.length > 64 || !userRoles.has(role) || !userStatuses.has(status) || description.length > 500) {
      return sendError(res, { status: 400, code: 'INVALID_USER_INPUT', message: '用户信息不完整或格式不正确' })
    }
    if ((role === 'admin' || role === 'auditor') && !req.user.isInitialAdmin) {
      return sendError(res, { status: 403, code: 'ADMIN_MANAGEMENT_FORBIDDEN', message: '只有初始管理员可以创建审计和管理员账户' })
    }

    try {
      const now = Date.now()
      const user = {
        id: createId(), username, password_hash: hashPassword(password), role, description, status,
        is_initial_admin: 0, must_change_password: 0, created_at: now, updated_at: now,
      }
      db.prepare(`INSERT INTO users (
          id, username, password_hash, role, description, status,
          is_initial_admin, must_change_password, created_at, updated_at
        ) VALUES (
          @id, @username, @password_hash, @role, @description, @status,
          @is_initial_admin, @must_change_password, @created_at, @updated_at
        )`).run(user)
      loginFailures?.clear(username)
      recordAudit(req.user, '创建用户', username, `角色：${role}；状态：${status}；已清除登录失败锁定`)
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
    if (!canManageUser(req.user, user, role)) {
      return sendError(res, {
        status: 403,
        code: 'ADMIN_MANAGEMENT_FORBIDDEN',
        message: user.is_initial_admin ? '初始管理员账户仅可由本人修改描述和密码' : '只有初始管理员可以管理审计和管理员账户',
      })
    }
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
    if (!canManageUser(req.user, user) || user.is_initial_admin) {
      return sendError(res, {
        status: 403,
        code: 'ADMIN_MANAGEMENT_FORBIDDEN',
        message: user.is_initial_admin ? '初始管理员只能修改自己的密码' : '只有初始管理员可以重置审计和管理员密码',
      })
    }
    const temporaryPassword = String(req.body?.temporaryPassword || '')
    const confirmPassword = String(req.body?.confirmPassword || '')
    if (temporaryPassword !== confirmPassword) {
      return sendError(res, { status: 400, code: 'PASSWORD_CONFIRMATION_MISMATCH', message: '两次输入的密码不一致' })
    }
    if (!validatePassword(temporaryPassword).ok) {
      return sendError(res, { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: PASSWORD_POLICY_MESSAGE })
    }
    const updatedAt = Date.now()
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?')
      .run(hashPassword(temporaryPassword), updatedAt, user.id)
    for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
    loginFailures?.clear(user.username)
    recordAudit(req.user, '重置用户密码', user.username, '已设置临时密码并要求首次登录修改；已清除登录失败锁定')
    sendOk(res, { updatedAt })
  })

  router.put('/:id/password', authMiddleware, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return sendError(res, { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' })
    const newPassword = String(req.body?.newPassword || '')
    const isSelf = req.user.id === user.id
    if (!isSelf) {
      return sendError(res, { status: 403, code: 'PERMISSION_DENIED', message: '只能通过重置流程修改其他用户密码' })
    }
    if (!validatePassword(newPassword).ok) {
      recordAudit(req.user, '修改本人密码失败', user.username, '新密码不符合密码规则')
      return sendError(res, { status: 400, code: 'PASSWORD_POLICY_VIOLATION', message: PASSWORD_POLICY_MESSAGE })
    }
    if (!verifyPassword(String(req.body?.currentPassword || ''), user.password_hash)) {
      recordAudit(req.user, '修改本人密码失败', user.username, '当前密码校验失败')
      return sendError(res, { status: 400, code: 'CURRENT_PASSWORD_INCORRECT', message: '当前密码不正确' })
    }
    const updatedAt = Date.now()
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(hashPassword(newPassword), updatedAt, user.id)
    for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
    recordAudit(req.user, '修改本人密码', user.username, '修改成功，已撤销原登录Token')
    sendOk(res, { updatedAt, reauthenticate: true })
  })

  router.delete('/:id', adminMiddleware, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
    if (!user) return sendError(res, { status: 404, code: 'USER_NOT_FOUND', message: '用户不存在' })
    if (req.user.id === user.id) {
      return sendError(res, { status: 400, code: 'CURRENT_USER_DELETE_FORBIDDEN', message: '不能删除当前登录账户' })
    }
    if (!canManageUser(req.user, user)) {
      return sendError(res, {
        status: 403,
        code: 'ADMIN_MANAGEMENT_FORBIDDEN',
        message: user.is_initial_admin ? '初始管理员账户不能删除' : '只有初始管理员可以删除审计和管理员账户',
      })
    }
    if (user.role === 'admin' && user.status === 'active') {
      const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count
      if (adminCount <= 1) {
        return sendError(res, { status: 400, code: 'LAST_ADMIN_DELETE_FORBIDDEN', message: '至少需要保留一个已激活的管理员账户' })
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
    for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
    loginFailures?.clear(user.username)
    recordAudit(req.user, '删除用户', user.username, `角色：${user.role}；已清除登录失败锁定`)
    sendOk(res)
  })

  return router
}
