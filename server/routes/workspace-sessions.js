import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import {
  createWorkspaceSession,
  markWorkspaceSessionDeleted,
  setWorkspaceSessionTitleIfEmpty,
} from '../lib/session-ownership-service.js'
import { attachReportProvenance } from '../report-provenance-service.js'

function cleanText(value, maxLength = 200_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function safeRecordAudit(recordAudit, ...args) {
  try {
    recordAudit?.(...args)
  } catch {
    // Audit failures must not turn a completed Gateway operation into an HTTP
    // failure or hide the real session-creation result from the caller.
  }
}

function safelyRun(operation) {
  try {
    return operation()
  } catch {
    return undefined
  }
}

export function createWorkspaceSessionsRouter({
  db,
  authMiddleware,
  operatorMiddleware,
  recordAudit,
  gateway,
  reportProvenanceOptions = {},
  attachProvenance = attachReportProvenance,
}) {
  const router = Router()

  router.post('/', operatorMiddleware || authMiddleware, async (req, res) => {
    let sessionKey = ''
    try {
      sessionKey = createWorkspaceSession(db, req.user)
      const message = cleanText(req.body?.message)
      if (!message) {
        safeRecordAudit(recordAudit, req.user, '创建工作台会话', '对话工作台', '已登记用户专属空会话')
        return sendOk(res, { sessionKey, initialized: false }, 201)
      }
      if (!gateway?.isConnected) {
        throw new Error('Gateway unavailable')
      }

      const idempotencyKey = cleanText(req.body?.idempotencyKey, 160)
      const activeDataSource = db.prepare('SELECT id FROM data_sources WHERE is_active = 1 LIMIT 1').get()
      const provenance = attachProvenance({ sessionKey, message, idempotencyKey }, req.user, {
        ...reportProvenanceOptions,
        dataSourceId: activeDataSource?.id,
        transportMetadata: false,
      })
      if (reportProvenanceOptions.enabled === true && provenance?.stored !== true) {
        throw new Error('Web report provenance was not persisted')
      }
      const result = await gateway.call('sessions.create', {
        key: sessionKey,
        message,
      }, 120_000)
      const createdKey = cleanText(result?.key || result?.sessionKey, 500)
      if (createdKey !== sessionKey || result?.ok === false || result?.runStarted !== true || result?.runError) {
        throw new Error('Gateway did not atomically create the requested conversation')
      }

      // The Gateway conversation is already authoritative at this point. A
      // best-effort title update must not hide a successfully created session.
      safelyRun(() => setWorkspaceSessionTitleIfEmpty(db, sessionKey, message))
      safeRecordAudit(recordAudit, req.user, '创建工作台会话', '对话工作台', 'Gateway 已原子创建会话并接收首条消息')
      return sendOk(res, {
        sessionKey,
        initialized: true,
        runStarted: true,
        runId: cleanText(result?.runId, 160) || undefined,
        idempotencyKey: idempotencyKey || undefined,
        provenanceStored: provenance?.stored === true,
      }, 201)
    } catch {
      if (sessionKey) safelyRun(() => markWorkspaceSessionDeleted(db, sessionKey))
      safeRecordAudit(recordAudit, req.user, '创建工作台会话失败', '对话工作台', 'Gateway 原子创建或首条消息接收未完成')
      return sendError(res, { status: 502, code: 'WORKSPACE_SESSION_CREATE_FAILED', message: '创建工作台会话失败，首条消息未发送' })
    }
  })

  return router
}
