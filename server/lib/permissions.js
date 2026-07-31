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

const SENSITIVE_READ_RPC_METHODS = new Set([
  'exec.approvals.get',
  'exec.approvals.node.get',
  'logs.tail',
  'agents.files.get',
  'agent.files.get',
  'sessions.export',
  'session.export',
])

const EXPLICIT_READ_RPC_METHODS = new Set([
  'system-presence',
  'sessions.history',
  'session.history',
  'chat.history',
  'sessions.usage',
  'usage.sessions',
  'usage.cost',
  'cost.usage',
  'cron.runs',
  'crons.runs',
  'cron.history',
  'crons.history',
])

const OWNED_SESSION_DELETE_RPC_METHODS = new Set([
  'sessions.delete',
  'session.delete',
])

const SESSION_READ_RPC_METHODS = new Set([
  'sessions.list',
  'session.list',
  'sessions.get',
  'session.get',
  'sessions.history',
  'session.history',
  'chat.history',
  'sessions.usage',
  'usage.sessions',
])

const GLOBAL_USAGE_RPC_METHODS = new Set([
  'usage.cost',
  'cost.usage',
])

const CHANNEL_STATUS_RPC_METHODS = new Set([
  'channels.status',
  'channels.list',
  'channel.list',
  'channel.status',
  'plugins.list',
  'plugin.list',
  'plugins.status',
  'plugin.status',
])

const SKILL_READ_RPC_METHODS = new Set([
  'skills.status',
  'skills.list',
])

const CRON_READ_RPC_METHODS = new Set([
  'cron.list',
  'crons.list',
  'schedule.list',
  'schedules.list',
  'cron.status',
  'crons.status',
  'schedule.status',
  'schedules.status',
  'cron.runs',
  'crons.runs',
  'cron.history',
  'crons.history',
])

const SYSTEM_STATUS_RPC_METHODS = new Set([
  'status',
  'health',
])

const SYSTEM_MONITOR_RPC_METHODS = new Set([
  'system-presence',
  'node.list',
])

const STANDARD_WRITE_RPC_METHODS = new Set([
  'agent',
  'chat.send',
  'chat.abort',
  'agent.abort',
  'sessions.reset',
  'session.reset',
  'sessions.spawn',
  'session.spawn',
  'sessions.send',
  'session.send',
  'sessions.patch',
  'session.patch',
])

export function isReadOnlyRpcMethod(method) {
  if (typeof method !== 'string') return false
  const normalized = method.trim()
  if (!normalized || SENSITIVE_READ_RPC_METHODS.has(normalized)) return false
  return normalized === 'status' || normalized === 'health' ||
    normalized === 'config.get' ||
    EXPLICIT_READ_RPC_METHODS.has(normalized) ||
    normalized.endsWith('.list') || normalized.endsWith('.get') || normalized.includes('.status')
}

export function getRpcPermissionDecision(user, method) {
  const normalized = typeof method === 'string' ? method.trim() : ''
  if (!normalized || normalized.length > 160) {
    return { allowed: false, code: 'INVALID_RPC_METHOD', message: 'RPC 方法无效' }
  }

  if (user?.role === 'admin') return { allowed: true }

  if (
    OWNED_SESSION_DELETE_RPC_METHODS.has(normalized) &&
    (user?.role === 'basic' || user?.role === 'standard')
  ) {
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
      (CHANNEL_STATUS_RPC_METHODS.has(normalized) || SKILL_READ_RPC_METHODS.has(normalized)) &&
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

  if (user?.role === 'standard' && STANDARD_WRITE_RPC_METHODS.has(normalized)) {
    return { allowed: true }
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
