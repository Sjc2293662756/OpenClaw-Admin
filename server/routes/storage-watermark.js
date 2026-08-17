import { Router } from 'express'
import { sendOk } from '../lib/api-response.js'
import { listStorageWatermarkOverview } from '../lib/storage-watermark-service.js'

export function createStorageWatermarkRouter({ db, systemMonitorMiddleware }) {
  const router = Router()

  router.get('/', systemMonitorMiddleware, (_req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    sendOk(res, listStorageWatermarkOverview(db))
  })

  return router
}
