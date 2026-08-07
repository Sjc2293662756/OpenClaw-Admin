import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import {
  DEFAULT_PLATFORM_BRANDING,
  readBrandingSettings,
  saveBrandingSettings,
} from '../lib/branding-settings.js'

export function createBrandingSettingsRouter({ db, initialAdminMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', (_req, res) => {
    sendOk(res, readBrandingSettings(db))
  })

  router.put('/', initialAdminMiddleware, (req, res) => {
    const saved = saveBrandingSettings(db, req.body, req.user.id)
    if (!saved.ok) {
      return sendError(res, { status: 400, code: 'BRANDING_SETTINGS_INVALID', message: saved.error })
    }
    recordAudit(req.user, '修改平台品牌名称', '平台品牌配置', '已更新八项公司与产品名称')
    sendOk(res, saved.value)
  })

  router.post('/reset', initialAdminMiddleware, (req, res) => {
    const saved = saveBrandingSettings(db, DEFAULT_PLATFORM_BRANDING, req.user.id)
    if (!saved.ok) {
      return sendError(res, { status: 500, code: 'BRANDING_RESET_FAILED', message: '恢复默认品牌名称失败' })
    }
    recordAudit(req.user, '恢复默认品牌名称', '平台品牌配置', '已恢复八项默认公司与产品名称')
    sendOk(res, saved.value)
  })

  return router
}
