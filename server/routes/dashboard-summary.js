import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import {
  filterSessionListPayload,
  listOwnedWorkspaceSessionKeys,
} from '../lib/session-ownership-service.js'

function rowsFrom(payload, keys = []) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  return []
}

function installedSkillCount(payload) {
  return rowsFrom(payload, ['skills', 'items'])
    .filter((row) => row?.installed !== false).length
}

export function createDashboardSummaryRouter({ authMiddleware, getGateway, db }) {
  const router = Router()

  router.get('/', authMiddleware, async (req, res) => {
    const gateway = getGateway()
    if (!gateway?.isConnected) {
      return sendError(res, {
        status: 503,
        code: 'GATEWAY_UNAVAILABLE',
        message: 'GAIOP 智能体服务暂未连接',
      })
    }

    try {
      const [sessionsResult, cronsResult, modelsResult, skillsResult] = await Promise.allSettled([
        gateway.call('sessions.list', {}),
        gateway.call('cron.list', {}),
        gateway.call('models.list', {}),
        gateway.call('skills.status', {}),
      ])
      const sessionsPayload = sessionsResult.status === 'fulfilled'
        ? filterSessionListPayload(
            sessionsResult.value,
            listOwnedWorkspaceSessionKeys(db, req.user)
          )
        : []
      const sessions = rowsFrom(sessionsPayload, ['sessions', 'items', 'data'])
      const crons = cronsResult.status === 'fulfilled'
        ? rowsFrom(cronsResult.value, ['jobs', 'crons', 'items'])
        : []
      const models = modelsResult.status === 'fulfilled'
        ? rowsFrom(modelsResult.value, ['models', 'items'])
        : []
      const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : []

      res.setHeader('Cache-Control', 'private, no-store')
      return sendOk(res, {
        summary: {
          sessionCount: sessions.length,
          cronCount: crons.filter((job) => job?.enabled !== false).length,
          modelCount: models.length,
          installedSkills: installedSkillCount(skills),
        },
      })
    } catch {
      return sendError(res, {
        status: 502,
        code: 'DASHBOARD_SUMMARY_FAILED',
        message: '仪表盘摘要暂时不可用，请稍后重试',
      })
    }
  })

  return router
}
