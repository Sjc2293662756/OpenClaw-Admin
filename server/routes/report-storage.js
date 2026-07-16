import { Router } from 'express'
import { sendOk } from '../lib/api-response.js'
import { getReportStorageRoot } from '../lib/report-storage-path.js'

/**
 * Deployment paths are visible only to administrators. The endpoint has no
 * write method so the browser can never use it to select a host directory.
 */
export function createReportStorageRouter({ adminMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', adminMiddleware, (req, res) => {
    recordAudit(req.user, '查看报告存储目录', '系统设置', '只读查看部署配置的报告存储根目录')
    sendOk(res, { reportStorageRoot: getReportStorageRoot() })
  })

  return router
}
