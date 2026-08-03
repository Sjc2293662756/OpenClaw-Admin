import assert from 'node:assert/strict'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { createAuditExportWorkbook, normalizeAuditExportRows } from './audit-export.js'

test('creates a safe audit export workbook with the complete approved projection', () => {
  const rows = normalizeAuditExportRows([{
    createdAt: new Date('2026-08-03T10:05:06.000Z').getTime(), result: 'denied', username: '=formula-user', actorUserId: 'user-42',
    role: 'auditor', category: 'authorization', action: '=SUM(1,1)', detail: '安全说明', target: '报告', source: 'rpc',
    restMethod: 'POST', restPath: '/api/rpc', rpcMethod: 'config.set', errorCode: 'RPC_METHOD_FORBIDDEN', requestId: 'request-42', sourceAddress: '127.0.0.1',
  }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0][1], '拒绝')
  assert.equal(rows[0][2], "'=formula-user")
  assert.equal(rows[0][6], "'=SUM(1,1)")

  const zip = new AdmZip(createAuditExportWorkbook([{
    createdAt: new Date('2026-08-03T10:05:06.000Z').getTime(), result: 'denied', username: '=formula-user', actorUserId: 'user-42',
    role: 'auditor', category: 'authorization', action: '=SUM(1,1)', detail: '安全说明', target: '报告', source: 'rpc',
    restMethod: 'POST', restPath: '/api/rpc', rpcMethod: 'config.set', errorCode: 'RPC_METHOD_FORBIDDEN', requestId: 'request-42', sourceAddress: '127.0.0.1',
  }]))
  assert.ok(zip.getEntry('xl/workbook.xml'))
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml')
  assert.match(sheet, /操作用户/)
  assert.match(sheet, /来源地址/)
  assert.match(sheet, /&apos;=formula-user/)
  assert.match(sheet, /&apos;=SUM\(1,1\)/)
})

test('uses historical-missing markers and caps the workbook rows at the TOP ceiling', () => {
  const rows = normalizeAuditExportRows(Array.from({ length: 3005 }, (_, index) => ({ action: `row-${index}` })))
  assert.equal(rows.length, 3000)
  assert.equal(rows[0][0], '历史未记录')
  assert.equal(rows[0][15], '历史未记录')
})
