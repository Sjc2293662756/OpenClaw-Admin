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

const STANDARD_WRITE_RPC_METHODS = new Set([
  'agent',
  'chat.send',
  'chat.abort',
  'agent.abort',
  'agent.model.set',
  'sessions.reset',
  'session.reset',
  'sessions.delete',
  'session.delete',
  'sessions.spawn',
  'session.spawn',
  'sessions.send',
  'session.send',
  'sessions.patch',
  'session.patch',
  'skills.install',
  'skills.update',
  'cron.add',
  'cron.create',
  'crons.add',
  'crons.create',
  'cron.update',
  'crons.update',
  'schedule.update',
  'schedules.update',
  'cron.remove',
  'cron.delete',
  'crons.remove',
  'crons.delete',
  'schedule.delete',
  'schedules.delete',
  'cron.run',
  'crons.run',
  'cron.trigger',
  'crons.trigger',
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

  if (isReadOnlyRpcMethod(normalized)) return { allowed: true }

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
