import test from 'node:test'
import assert from 'node:assert/strict'
import AdmZip from 'adm-zip'
import { createAlertExportWorkbook, normalizeAlertExportRows } from './alert-export.js'

test('creates an xlsx workbook for the current alert page', () => {
  const rows = [{
    occurredAt: '2026-07-15 17:58', severity: '紧急', name: '接口超时', category: '应用性能告警', sourceHost: '10.0.0.1', status: '触发中',
  }]
  const zip = new AdmZip(createAlertExportWorkbook(rows))
  assert.ok(zip.getEntry('xl/workbook.xml'))
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml')
  assert.match(sheet, /告警时间/)
  assert.match(sheet, /接口超时/)
})

test('bounds and cleans alert export rows', () => {
  const rows = normalizeAlertExportRows([{ name: 'a\u0000b', sourceHost: '10.0.0.1' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0][2], 'ab')
})
