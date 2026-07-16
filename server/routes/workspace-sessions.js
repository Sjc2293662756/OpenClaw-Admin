import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { createWorkspaceSession } from '../lib/session-ownership-service.js'

export function createWorkspaceSessionsRouter({ db, authMiddleware, operatorMiddleware, recordAudit }) {
  const router = Router()

  router.post('/', operatorMiddleware || authMiddleware, (req, res) => {
    try {
      const sessionKey = createWorkspaceSession(db, req.user)
      recordAudit(req.user, '创建工作台会话', '对话工作台', '已登记用户专属会话')
      sendOk(res, { sessionKey }, 201)
    } catch {
      sendError(res, { status: 500, code: 'WORKSPACE_SESSION_CREATE_FAILED', message: '创建工作台会话失败' })
    }
  })

  return router
}
