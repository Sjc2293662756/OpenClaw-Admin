export const USER_ROLES = new Set(['basic', 'auditor', 'standard', 'admin'])
export const USER_STATUSES = new Set(['active', 'inactive'])

export function createRoleMiddleware(authMiddleware, roles, message) {
  const allowedRoles = new Set(roles)
  return (req, res, next) => {
    authMiddleware(req, res, () => {
      if (!allowedRoles.has(req.user?.role)) {
        return res.status(403).json({ ok: false, error: message, code: 'PERMISSION_DENIED' })
      }
      next()
    })
  }
}

export function createInitialAdminMiddleware(authMiddleware) {
  return (req, res, next) => {
    authMiddleware(req, res, () => {
      if (req.user?.role !== 'admin' || req.user?.isInitialAdmin !== true) {
        return res.status(403).json({
          ok: false,
          error: '仅初始管理员可以修改平台品牌名称',
          code: 'INITIAL_ADMIN_REQUIRED',
        })
      }
      next()
    })
  }
}

const SESSION_READ_RPC_METHODS = new Set([
  'sessions.list', 'session.list', 'sessions.get', 'session.get',
  'sessions.history', 'session.history', 'chat.history',
  'sessions.usage', 'usage.sessions',
])

const SESSION_WRITE_RPC_METHODS = new Set([
  'agent', 'chat.send', 'chat.abort', 'agent.abort',
  'sessions.delete', 'session.delete', 'sessions.reset', 'session.reset',
  'sessions.spawn', 'session.spawn', 'sessions.send', 'session.send',
  'sessions.patch', 'session.patch',
])
const OWNED_SESSION_DELETE_RPC_METHODS = new Set(['sessions.delete', 'session.delete'])
const BASIC_WORKSPACE_WRITE_RPC_METHODS = new Set([
  'agent', 'chat.send', 'chat.abort', 'agent.abort',
  ...OWNED_SESSION_DELETE_RPC_METHODS,
])

const GLOBAL_USAGE_RPC_METHODS = new Set(['usage.cost', 'cost.usage'])

const CHANNEL_STATUS_RPC_METHODS = new Set([
  'channels.status', 'channels.list', 'channel.list', 'channel.status',
  'plugins.list', 'plugin.list', 'plugins.status', 'plugin.status',
])

const SKILL_READ_RPC_METHODS = new Set(['skills.status', 'skills.list'])

const CRON_READ_RPC_METHODS = new Set([
  'cron.list', 'crons.list', 'schedule.list', 'schedules.list',
  'cron.status', 'crons.status', 'schedule.status', 'schedules.status',
  'cron.runs', 'crons.runs', 'cron.history', 'crons.history',
])

const SYSTEM_STATUS_RPC_METHODS = new Set(['status', 'health'])
const SYSTEM_MONITOR_RPC_METHODS = new Set(['system-presence', 'node.list'])

const EXPLICIT_READ_RPC_METHODS = new Set([
  ...SESSION_READ_RPC_METHODS,
  ...GLOBAL_USAGE_RPC_METHODS,
  ...CHANNEL_STATUS_RPC_METHODS,
  ...SKILL_READ_RPC_METHODS,
  ...CRON_READ_RPC_METHODS,
  ...SYSTEM_STATUS_RPC_METHODS,
  ...SYSTEM_MONITOR_RPC_METHODS,
  'config.get', 'tools.list', 'models.list', 'model.list',
  'agents.list', 'agent.list', 'agents.files.list', 'agent.files.list',
  'agents.files.get', 'agent.files.get',
])

export const ADMIN_DIAGNOSTIC_RPC_METHODS = new Set([
  'logs.tail',
  'exec.approvals.get', 'exec.approvals.node.get',
  'exec.approvals.set', 'exec.approvals.node.set',
  'node.invoke', 'node.pair.request', 'node.pair.approve',
])

export const FORMAL_RPC_METHODS = new Set([
  ...EXPLICIT_READ_RPC_METHODS,
  ...SESSION_WRITE_RPC_METHODS,
  'agent.model.set',
  'sessions.export', 'session.export',
  'config.patch', 'config.apply', 'config.set',
  'channel.auth', 'channels.auth', 'web.login.start', 'channel.pair', 'channels.pair',
  'skills.install', 'skills.update',
  'agents.create', 'agents.update', 'agents.delete',
  'agents.files.set', 'agent.files.set',
  'cron.add', 'cron.create', 'crons.add', 'crons.create',
  'cron.update', 'crons.update', 'schedule.update', 'schedules.update',
  'cron.remove', 'cron.delete', 'crons.remove', 'crons.delete', 'schedule.delete', 'schedules.delete',
  'cron.run', 'crons.run', 'cron.trigger', 'crons.trigger',
  'update.run',
  ...ADMIN_DIAGNOSTIC_RPC_METHODS,
])

export function isReadOnlyRpcMethod(method) {
  if (typeof method !== 'string') return false
  const normalized = method.trim()
  return EXPLICIT_READ_RPC_METHODS.has(normalized)
}

export function getRpcPermissionDecision(user, method) {
  const normalized = typeof method === 'string' ? method.trim() : ''
  if (!normalized || normalized.length > 160) {
    return { allowed: false, code: 'INVALID_RPC_METHOD', message: 'RPC 方法无效' }
  }

  if (!FORMAL_RPC_METHODS.has(normalized)) {
    return { allowed: false, code: 'RPC_METHOD_NOT_SUPPORTED', message: 'RPC 方法未登记或不受 GAIOP 支持' }
  }

  if (user?.role === 'admin') return { allowed: true }

  if (user?.role === 'basic') {
    if (
      SESSION_READ_RPC_METHODS.has(normalized)
      || SYSTEM_STATUS_RPC_METHODS.has(normalized)
      || BASIC_WORKSPACE_WRITE_RPC_METHODS.has(normalized)
    ) {
      return { allowed: true }
    }
    return {
      allowed: false,
      code: 'BASIC_WORKSPACE_ONLY',
      message: '基础用户仅可使用对话工作台和修改本人密码',
    }
  }

  if (SESSION_WRITE_RPC_METHODS.has(normalized) && user?.role === 'standard') {
    return { allowed: true }
  }

  if (isReadOnlyRpcMethod(normalized)) {
    const role = user?.role
    if (SESSION_READ_RPC_METHODS.has(normalized) || SYSTEM_STATUS_RPC_METHODS.has(normalized)) {
      return { allowed: true }
    }
    if (GLOBAL_USAGE_RPC_METHODS.has(normalized) && role === 'auditor') {
      return { allowed: true }
    }
    if (
      SYSTEM_MONITOR_RPC_METHODS.has(normalized) &&
      (role === 'auditor' || role === 'standard')
    ) {
      return { allowed: true }
    }
    if (
      CHANNEL_STATUS_RPC_METHODS.has(normalized) &&
      (role === 'basic' || role === 'auditor' || role === 'standard')
    ) {
      return { allowed: true }
    }
    if (
      SKILL_READ_RPC_METHODS.has(normalized) &&
      (role === 'auditor' || role === 'standard')
    ) {
      return { allowed: true }
    }
    if (CRON_READ_RPC_METHODS.has(normalized) && role === 'auditor') {
      return { allowed: true }
    }
    if (normalized === 'config.get' && role === 'standard') {
      return { allowed: true }
    }
    if (role === 'standard') {
      return {
        allowed: false,
        code: 'STANDARD_ROLE_RESTRICTED',
        message: '标准用户无权读取此管理模块',
      }
    }
    if (role === 'auditor') {
      return {
        allowed: false,
        code: 'AUDITOR_SCOPE_RESTRICTED',
        message: '审计用户无权读取此管理模块',
      }
    }
    return {
      allowed: false,
      code: 'BASIC_SCOPE_RESTRICTED',
      message: '基础用户无权读取此管理模块',
    }
  }

  if (user?.role === 'standard') {
    return {
      allowed: false,
      code: 'STANDARD_ROLE_RESTRICTED',
      message: '标准用户不能修改底层连接、凭证、智能体或安全配置',
    }
  }

  if (user?.role === 'auditor') {
    return { allowed: false, code: 'AUDITOR_READ_ONLY', message: '审计用户仅可查看信息，不能执行此操作' }
  }

  return { allowed: false, code: 'BASIC_READ_ONLY', message: '基础用户仅可查看信息，不能执行此操作' }
}

export function canCallRpc(user, method) {
  return getRpcPermissionDecision(user, method).allowed
}

function basicPasswordChangeTarget(path) {
  const match = path.match(/^\/api\/users\/([^/]+)\/password$/u)
  if (!match) return ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}

export function isBasicWorkspaceApiRequest(user, method, originalUrl) {
  if (user?.role !== 'basic') return true
  const normalizedMethod = String(method || 'GET').toUpperCase()
  const path = String(originalUrl || '').split('?')[0]
  if (normalizedMethod === 'POST' && (path === '/api/rpc' || path === '/api/workspace/sessions')) return true
  if (normalizedMethod === 'GET' && (path === '/api/events' || path === '/api/media')) return true
  if (normalizedMethod === 'PUT' && basicPasswordChangeTarget(path) === String(user.id || '')) return true
  return false
}

export function createBasicWorkspaceOnlyMiddleware(authMiddleware, recordAudit) {
  return (req, res, next) => {
    const path = String(req.originalUrl || '').split('?')[0]
    if (path === '/api/health') return next()
    authMiddleware(req, res, () => {
      if (isBasicWorkspaceApiRequest(req.user, req.method, req.originalUrl)) return next()
      try {
        recordAudit?.(req.user, '拒绝受保护请求', path, '', {
          req,
          category: 'authorization',
          result: 'denied',
          source: 'rest',
          errorCode: 'BASIC_WORKSPACE_ONLY',
        })
      } catch {
        // Permission denial must not depend on audit persistence.
      }
      res.locals.auditRejectionRecorded = true
      return res.status(403).json({
        ok: false,
        code: 'BASIC_WORKSPACE_ONLY',
        error: { message: '基础用户仅可使用对话工作台和修改本人密码' },
      })
    })
  }
}

export function rpcPermissionMiddleware(req, res, next) {
  const method = typeof req.body?.method === 'string' ? req.body.method.trim() : ''
  if (!method) {
    return res.status(400).json({ ok: false, code: 'RPC_METHOD_REQUIRED', error: { message: '必须提供 RPC 方法' } })
  }
  const permission = getRpcPermissionDecision(req.user, method)
  if (!permission.allowed) {
    return res.status(403).json({ ok: false, code: permission.code, error: { message: permission.message } })
  }
  req.rpcMethod = method
  next()
}
