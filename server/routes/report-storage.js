import { Router } from 'express'
import { sendOk } from '../lib/api-response.js'

/**
 * The browser may learn only whether deployment configured report storage.
 * It must never receive a host path or a way to select one.
 */
export function createReportStorageRouter({ adminMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', adminMiddleware, (req, res) => {
    recordAudit(req.user, '查看报告存储状态', '系统设置', '只读查看部署配置状态')
    sendOk(res, { reportStorageConfigured: true })
  })

  return router
}
