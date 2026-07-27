import { Router } from 'express'
import { sendOk } from '../lib/api-response.js'
import { getReportStorageRoot } from '../lib/report-storage-path.js'

/**
 * Administrators may read the deployment-controlled report root. The route
 * remains read-only and never accepts a browser-provided path.
 */
export function createReportStorageRouter({ adminMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', adminMiddleware, (req, res) => {
    const reportStorageRoot = getReportStorageRoot()
    recordAudit(req.user, '查看报告存储路径', '系统设置', '只读查看部署配置的报告根目录')
    sendOk(res, {
      reportStorageConfigured: true,
      reportStorageRoot,
    })
  })

  return router
}
