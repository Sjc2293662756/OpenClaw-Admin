import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import {
  SESSION_RETENTION_DAYS,
  SESSION_RETENTION_GRACE_DAYS,
  TEMP_ATTACHMENT_RETENTION_DAYS,
  cancelPendingDeletion,
  listSessionRetentionOverview,
  registerSessionAttachment,
  setLongTermRetention,
} from '../lib/session-retention-service.js'

function normalizeSessionKey(value) {
  return typeof value === 'string' ? value.trim().slice(0, 512) : ''
}

export function createSessionRetentionRouter({
  db,
  viewerMiddleware,
  adminMiddleware,
  recordAudit,
  policy = {},
}) {
  const router = Router()

  router.get('/', viewerMiddleware, (_req, res) => {
    sendOk(res, {
      policy: {
        retentionDays: policy.retentionDays || SESSION_RETENTION_DAYS,
        graceDays: policy.graceDays || SESSION_RETENTION_GRACE_DAYS,
        temporaryAttachmentDays: TEMP_ATTACHMENT_RETENTION_DAYS,
        automaticMarkingEnabled: policy.automaticMarkingEnabled === true,
        automaticDeletionEnabled: policy.automaticDeletionEnabled === true,
        attachmentDeletionSupported: false,
        deletionAuditRetentionDays: 1095,
      },
      records: listSessionRetentionOverview(db),
    })
  })

  router.post('/cancel', adminMiddleware, (req, res) => {
    const sessionKey = normalizeSessionKey(req.body?.sessionKey)
    if (!sessionKey) {
      return sendError(res, { status: 400, code: 'SESSION_KEY_REQUIRED', message: '缺少会话标识' })
    }
    const retention = cancelPendingDeletion(db, sessionKey)
    if (!retention) {
      return sendError(res, { status: 409, code: 'SESSION_NOT_PENDING_DELETE', message: '会话当前不在待删除状态' })
    }
    recordAudit(req.user, '取消会话待删除', sessionKey, '', { category: 'session_retention' })
    sendOk(res, { sessionKey, retention })
  })

  router.put('/long-term', adminMiddleware, (req, res) => {
    const sessionKey = normalizeSessionKey(req.body?.sessionKey)
    if (!sessionKey || typeof req.body?.enabled !== 'boolean') {
      return sendError(res, { status: 400, code: 'SESSION_RETENTION_INPUT_INVALID', message: '会话标识或长期保留状态无效' })
    }
    const retention = setLongTermRetention(db, sessionKey, req.body.enabled)
    recordAudit(
      req.user,
      req.body.enabled ? '设置会话长期保留' : '取消会话长期保留',
      sessionKey,
      '',
      { category: 'session_retention' },
    )
    sendOk(res, { sessionKey, retention })
  })

  router.post('/attachments', adminMiddleware, (req, res) => {
    try {
      const attachment = registerSessionAttachment(db, {
        sessionKey: req.body?.sessionKey,
        attachmentRef: req.body?.attachmentRef,
        retentionClass: req.body?.retentionClass,
        createdAt: req.body?.createdAt,
      })
      recordAudit(req.user, '登记会话附件留存', attachment.session_key, `类型：${attachment.retention_class}`, {
        category: 'session_retention',
      })
      sendOk(res, {
        attachment: {
          id: attachment.id,
          sessionKey: attachment.session_key,
          retentionClass: attachment.retention_class,
          ownershipState: attachment.ownership_state,
          lifecycleState: attachment.lifecycle_state,
          registeredAt: attachment.registered_at,
          expiresAt: attachment.expires_at,
          deletionSupported: false,
        },
      }, 201)
    } catch (error) {
      const code = String(error?.message || '')
      const invalidInput = ['session_key_required', 'attachment_ref_invalid', 'attachment_retention_class_invalid'].includes(code)
      sendError(res, {
        status: invalidInput ? 400 : 500,
        code: invalidInput ? code.toUpperCase() : 'SESSION_ATTACHMENT_REGISTER_FAILED',
        message: invalidInput ? '附件登记信息无效' : '会话附件登记失败',
      })
    }
  })

  return router
}
