import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import {
  readChatDisplayPreferences,
  saveChatDisplayPreferences,
  validateChatDisplayPreferences,
} from '../lib/chat-display-preferences.js'

const CHAT_PREFERENCE_ROLES = new Set(['basic', 'standard', 'auditor', 'admin'])

export function createChatPreferencesRouter({ db, authMiddleware, recordAudit }) {
  const router = Router()

  const assertCurrentAccountAccess = (req, res) => {
    if (CHAT_PREFERENCE_ROLES.has(req.user?.role) && req.user?.id) return true
    sendError(res, { status: 403, code: 'CHAT_PREFERENCES_ACCESS_DENIED', message: '当前账号无权读取对话显示设置' })
    return false
  }

  router.get('/', authMiddleware, (req, res) => {
    if (!assertCurrentAccountAccess(req, res)) return
    return sendOk(res, { preferences: readChatDisplayPreferences(db, req.user.id) })
  })

  router.put('/', authMiddleware, (req, res) => {
    if (!assertCurrentAccountAccess(req, res)) return
    const validated = validateChatDisplayPreferences(req.body)
    if (!validated.ok) {
      return sendError(res, { status: 400, code: 'CHAT_PREFERENCES_INVALID', message: validated.error })
    }
    const preferences = saveChatDisplayPreferences(db, req.user.id, validated.value)
    recordAudit(
      req.user,
      '保存对话显示设置',
      '当前账户',
      `显示思考过程：${preferences.showThinkingProcess ? '开启' : '关闭'}`,
    )
    return sendOk(res, { preferences })
  })

  return router
}
