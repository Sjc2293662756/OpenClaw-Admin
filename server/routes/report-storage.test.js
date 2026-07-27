import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { resolve } from 'node:path'
import { createReportStorageRouter } from './report-storage.js'

test('report storage status exposes the deployment-controlled directory to administrators', async () => {
  const previousRoot = process.env.GAIOP_REPORTS_DIR
  const configuredRoot = 'controlled-report-root'
  process.env.GAIOP_REPORTS_DIR = configuredRoot
  const app = express()
  app.use('/report-storage', createReportStorageRouter({
    adminMiddleware: (req, _res, next) => { req.user = { id: 'admin-1', role: 'admin' }; next() },
    recordAudit: () => {},
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/report-storage`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.reportStorageConfigured, true)
    assert.equal(payload.reportStorageRoot, resolve(configuredRoot))
  } finally {
    server.close()
    if (previousRoot === undefined) delete process.env.GAIOP_REPORTS_DIR
    else process.env.GAIOP_REPORTS_DIR = previousRoot
  }
})
