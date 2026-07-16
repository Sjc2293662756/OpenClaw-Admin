import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { createReportStorageRouter } from './report-storage.js'

test('report storage status never exposes a server directory', async () => {
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
    assert.equal(Object.hasOwn(payload, 'reportStorageRoot'), false)
  } finally {
    server.close()
  }
})
