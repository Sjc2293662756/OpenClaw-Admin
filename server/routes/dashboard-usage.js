import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { createDashboardUsageRuntime } from '../lib/dashboard-usage-runtime.js'
import { listOwnedWorkspaceSessionKeys } from '../lib/session-ownership-service.js'

function readDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
  const parsed = Date.parse(`${text}T00:00:00Z`)
  return Number.isFinite(parsed) ? text : ''
}

function principalFor(user) {
  const identity = String(user?.id || user?.username || 'anonymous').trim()
  const role = String(user?.role || 'unknown').trim()
  return `${role}:${identity}`
}

export function createDashboardUsageRouter({
  authMiddleware,
  getGateway,
  ttlMs,
  maxEntries,
  runtime,
  db,
}) {
  const router = Router()
  const usageRuntime = runtime || createDashboardUsageRuntime({
    ttlMs,
    maxEntries,
    loadUsage: async (params) => {
      const gateway = getGateway()
      if (!gateway?.isConnected) {
        const error = new Error('GAIOP 智能体服务暂未连接')
        error.code = 'GATEWAY_UNAVAILABLE'
        throw error
      }
      return gateway.call('sessions.usage', params)
    },
  })

  router.get('/', authMiddleware, async (req, res) => {
    const startDate = readDate(req.query.startDate)
    const endDate = readDate(req.query.endDate)
    if (!startDate || !endDate || startDate > endDate) {
      return sendError(res, {
        status: 400,
        code: 'DASHBOARD_USAGE_RANGE_INVALID',
        message: '仪表盘统计时间范围无效',
      })
    }

    try {
      const result = await usageRuntime.read({
        principal: principalFor(req.user),
        startDate,
        endDate,
        force: req.query.force === '1',
        allowedKeys: db ? listOwnedWorkspaceSessionKeys(db, req.user, { scopeModuleKey: 'dashboard' }) : null,
      })
      res.setHeader('Cache-Control', 'private, no-store')
      return sendOk(res, result)
    } catch (error) {
      const unavailable = error?.code === 'GATEWAY_UNAVAILABLE'
      return sendError(res, {
        status: unavailable ? 503 : 502,
        code: unavailable ? 'GATEWAY_UNAVAILABLE' : 'DASHBOARD_USAGE_FAILED',
        message: unavailable ? error.message : '仪表盘统计暂时不可用，请稍后重试',
      })
    }
  })

  return router
}
