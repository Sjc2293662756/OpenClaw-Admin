import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import Database from 'better-sqlite3'
import express from 'express'
import {
  migrateStorageWatermarkTables,
  persistStorageWatermarkResults,
} from '../lib/storage-watermark-service.js'
import { createStorageWatermarkRouter } from './storage-watermark.js'

test('storage watermark API keeps the system monitor role boundary and redacts managed paths', async () => {
  const db = new Database(':memory:')
  migrateStorageWatermarkTables(db)
  const now = Date.UTC(2026, 7, 17, 0, 0, 0)
  persistStorageWatermarkResults(db, [{
    filesystemId: 'fs-0123456789abcdefabcd',
    state: 'warning',
    detectionSuccess: true,
    usagePercent: 75,
    thresholdPercent: 75,
    checkedAt: now,
    reasonCode: 'warning_threshold_reached',
    roots: [{ targetId: 'target-0123456789abcdefabcd', label: 'admin_state' }],
  }])

  const auth = (req, res, next) => {
    const role = req.get('x-test-role')
    if (!role) return res.status(401).json({ code: 'UNAUTHORIZED' })
    req.user = { id: `${role}-id`, username: role, role }
    next()
  }
  const monitor = (req, res, next) => auth(req, res, () => (
    ['standard', 'auditor', 'admin'].includes(req.user.role)
      ? next()
      : res.status(403).json({ code: 'PERMISSION_DENIED' })
  ))
  const app = express()
  app.use('/api/system/storage-watermarks', createStorageWatermarkRouter({ db, systemMonitorMiddleware: monitor }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/api/system/storage-watermarks`
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { 'x-test-role': 'basic' } })).status, 403)
    for (const role of ['standard', 'auditor', 'admin']) {
      const response = await fetch(url, { headers: { 'x-test-role': role } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      const body = await response.json()
      assert.equal(body.ok, true)
      assert.equal(body.statuses[0].managedRootLabels[0], 'admin_state')
      assert.deepEqual(Object.keys(body.recentAlerts[0]).sort(), [
        'detectionSuccess',
        'filesystemId',
        'policyVersion',
        'reasonCode',
        'state',
        'thresholdPercent',
        'usagePercent',
        'utcTime',
      ])
      const serialized = JSON.stringify(body)
      assert.equal(serialized.includes('/var/'), false)
      assert.equal(serialized.includes('/home/'), false)
      assert.equal(serialized.toLowerCase().includes('token'), false)
      assert.equal(serialized.toLowerCase().includes('password'), false)
    }
  } finally {
    server.close()
    await once(server, 'close')
    db.close()
  }
})
