import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import express from 'express'

function createMemoryDb() {
  const rows = new Map()
  const deliveryRows = new Map()
  return {
    prepare(sql) {
      if (sql.includes('INSERT INTO report_files')) {
        return {
          run(...values) {
            const [id, storedName, auditName, originalName, reportType, sourceSessionId, sourceUserId, sourceChannel, sourceChannelUserId, sourceChannelUserName, sourceMessageId, sourceMessagePreview, dataSourceId, mimeType, size, status, createdAt, updatedAt] = values
            rows.set(storedName, { id, stored_name: storedName, audit_name: auditName, original_name: originalName, report_type: reportType, source_session_id: sourceSessionId, source_user_id: sourceUserId, source_channel: sourceChannel, source_channel_user_id: sourceChannelUserId, source_channel_user_name: sourceChannelUserName, source_message_id: sourceMessageId, source_message_preview: sourceMessagePreview, data_source_id: dataSourceId, mime_type: mimeType, size, status, created_at: createdAt, updated_at: updatedAt })
          },
        }
      }
      if (sql.includes('SELECT id FROM report_files WHERE id = ?')) {
        return {
          get(id) {
            return [...rows.values()].find((row) => row.id === id) || null
          },
        }
      }
      if (sql.includes('SELECT stored_name FROM report_files WHERE id = ?')) {
        return {
          get(id) {
            const row = [...rows.values()].find((value) => value.id === id)
            return row ? { stored_name: row.stored_name } : null
          },
        }
      }
      if (sql.includes('UPDATE report_files SET') && sql.includes('source_session_id = COALESCE')) {
        return {
          run(sourceSessionId, sourceUserId, sourceChannel, sourceChannelUserId, sourceChannelUserName, dataSourceId, updatedAt, id) {
            const row = [...rows.values()].find((value) => value.id === id)
            if (!row) return
            row.source_session_id ||= sourceSessionId
            row.source_user_id ||= sourceUserId
            row.source_channel ||= sourceChannel
            row.source_channel_user_id ||= sourceChannelUserId
            row.source_channel_user_name ||= sourceChannelUserName
            row.data_source_id ||= dataSourceId
            row.updated_at = Math.max(row.updated_at, updatedAt)
          },
        }
      }
      if (sql.includes('SELECT * FROM report_files WHERE id = ?')) {
        return {
          get(id) {
            return [...rows.values()].find((row) => row.id === id) || null
          },
        }
      }
      if (sql.includes('SELECT id FROM data_sources WHERE is_active = 1')) {
        return { all: () => [{ id: 'data-source-a' }] }
      }
      if (sql.includes('INSERT INTO report_deliveries')) {
        return {
          run(...values) {
            const [id, reportId, eventName, channel, status, preparedAt, handedOffAt, confirmedAt, failedAt, errorCode, createdAt, updatedAt] = values
            deliveryRows.set(id, { id, report_id: reportId, event_name: eventName, channel, status, prepared_at: preparedAt, handed_off_at: handedOffAt, confirmed_at: confirmedAt, failed_at: failedAt, error_code: errorCode, created_at: createdAt, updated_at: updatedAt })
          },
        }
      }
      if (sql.includes('FROM report_deliveries') && sql.includes('ORDER BY')) {
        return {
          all() {
            return [...deliveryRows.values()].sort((left, right) => right.updated_at - left.updated_at)
          },
        }
      }
      if (sql.includes('FROM report_files') && sql.includes('ORDER BY')) {
        return {
          all(...values) {
            const sourceUserId = sql.includes('source_user_id = ?') ? values[0] : null
            return [...rows.values()]
              .filter((row) => !sourceUserId || row.source_user_id === sourceUserId)
              .map((row) => ({
                ...row,
                data_source_name: row.data_source_id === 'data-source-a' ? '101.254.114.238NAPM' : null,
              }))
          },
        }
      }
      throw new Error(`Unexpected test query: ${sql}`)
    },
  }
}

async function createReportsApp(resolveUser) {
  const { createReportsRouter } = await import(`./reports.js?report-root-test=${Date.now()}-${Math.random()}`)
  const app = express()
  app.use('/reports', createReportsRouter({
    db: createMemoryDb(),
    authMiddleware: (req, _res, next) => { req.user = resolveUser(req); next() },
    adminMiddleware: (req, _res, next) => { req.user = resolveUser(req); next() },
    recordAudit: () => {},
  }))
  return app
}

test('formal report archive imports only a matched audit pair and isolates the owner', async () => {
  const previousRoot = process.env.GAIOP_REPORTS_DIR
  const previousAttributionIndex = process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH
  const reportRoot = mkdtempSync(join(tmpdir(), 'gaiop-report-root-'))
  const reportDirectory = join(reportRoot, 'user_a', 'quick_report')
  mkdirSync(reportDirectory, { recursive: true })
  writeFileSync(join(reportDirectory, 'report-1.docx'), 'report')
  writeFileSync(join(reportDirectory, 'report-1.json'), JSON.stringify({
    reportId: 'report-1',
    title: '正式归档测试报告',
    reportType: 'quick report',
    sourceUserId: 'user a',
    sourceSessionId: 'session-a',
    sourceChannel: 'web',
    sourceChannelUserId: 'user a',
    sourceChannelUserName: '用户A',
    sourceMessageId: 'message-a',
    sourceMessagePreview: '请生成今天的系统运行综述报告',
    generatedAt: new Date().toISOString(),
    relativeFilePath: 'user_a/quick_report/report-1.docx',
    relativeAuditPath: 'user_a/quick_report/report-1.json',
  }))
  // A nested audit which does not point to itself must never be registered.
  writeFileSync(join(reportDirectory, 'spoofed.json'), JSON.stringify({
    reportId: 'spoofed', relativeFilePath: 'user_a/quick_report/report-1.docx', relativeAuditPath: 'user_a/quick_report/other.json', sourceUserId: 'user a',
  }))
  writeFileSync(join(reportDirectory, 'wrong-type.docx'), 'report')
  writeFileSync(join(reportDirectory, 'wrong-type.json'), JSON.stringify({
    reportId: 'wrong-type', reportType: 'diagnostic report', sourceUserId: 'user a',
    relativeFilePath: 'user_a/quick_report/wrong-type.docx', relativeAuditPath: 'user_a/quick_report/wrong-type.json',
  }))
  // Legacy deployed generators wrote the report ID audit name but omitted the
  // relative path fields. It remains safe only when it is the sibling pair.
  writeFileSync(join(reportDirectory, 'legacy-report.docx'), 'legacy report')
  writeFileSync(join(reportDirectory, 'legacy-metadata.json'), JSON.stringify({
    reportId: 'legacy-report-id',
    filePath: '/legacy-generator/output/legacy-report.docx',
    title: '旧契约正式归档报告',
    reportType: 'quick report',
    sourceUserId: 'user a',
    sourceSessionId: 'session-a',
    sourceChannel: 'web',
    generatedAt: new Date().toISOString(),
  }))
  writeFileSync(join(reportDirectory, 'legacy-missing.json'), JSON.stringify({
    reportId: 'legacy-missing',
    fileName: 'missing.docx',
    reportType: 'quick report',
    sourceUserId: 'user a',
  }))
  const unattributedDirectory = join(reportRoot, '_sidecar', 'artifact-hash')
  mkdirSync(unattributedDirectory, { recursive: true })
  writeFileSync(join(unattributedDirectory, 'legacy-unattributed.docx'), 'legacy unattributed report')
  writeFileSync(join(unattributedDirectory, 'legacy-unattributed.json'), JSON.stringify({
    reportId: 'legacy-unattributed',
    filePath: '/legacy-generator/output/legacy-unattributed.docx',
    relativeFilePath: 'original-user/summary_report/legacy-unattributed.docx',
    relativeAuditPath: 'original-user/summary_report/legacy-unattributed.json',
    reportType: 'summary report',
    title: '未归属旧归档报告',
  }))
  const attributionDirectory = join(reportRoot, '.attribution-test')
  mkdirSync(attributionDirectory)
  const attributionIndex = join(attributionDirectory, 'index.json')
  writeFileSync(attributionIndex, JSON.stringify({
    schemaVersion: 'gaiop.report-attribution.v1',
    entries: [{
      storedName: '_sidecar/artifact-hash/legacy-unattributed.docx',
      auditName: '_sidecar/artifact-hash/legacy-unattributed.json',
      reportId: 'legacy-unattributed',
      sourceUserId: 'user a',
      sourceSessionId: 'session-sidecar',
      sourceChannel: 'web',
      sourceChannelUserId: 'user a',
      sourceChannelUserName: '用户A',
      dataSourceId: 'data-source-a',
      evidence: 'official_tool_result',
    }],
  }))
  const deliveryDirectory = join(reportRoot, '.delivery-events')
  mkdirSync(deliveryDirectory)
  const preparedAt = new Date(Date.now() - 1000).toISOString()
  const handedOffAt = new Date().toISOString()
  writeFileSync(join(deliveryDirectory, 'delivery-1.json'), JSON.stringify({
    schemaVersion: 'gaiop.report-delivery.v1',
    eventType: 'report_delivery',
    attemptId: 'delivery-1',
    reportId: 'report-1',
    channel: 'wecom',
    status: 'handed_off',
    preparedAt,
    handedOffAt,
    createdAt: preparedAt,
    updatedAt: handedOffAt,
  }))
  writeFileSync(join(deliveryDirectory, 'orphan.json'), JSON.stringify({
    schemaVersion: 'gaiop.report-delivery.v1',
    eventType: 'report_delivery',
    attemptId: 'orphan',
    reportId: 'missing-report',
    channel: 'wecom',
    status: 'handed_off',
    createdAt: handedOffAt,
    updatedAt: handedOffAt,
  }))
  process.env.GAIOP_REPORTS_DIR = reportRoot
  process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH = attributionIndex

  const server = (await createReportsApp((req) => {
    if (req.get('x-test-role') === 'auditor') return { id: 'auditor-1', role: 'auditor' }
    return req.get('x-test-user') === 'user-b'
      ? { id: 'user-b', role: 'basic' }
      : { id: 'user a', role: 'basic' }
  })).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reports`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.reports.length, 3)
    const reportOne = payload.reports.find((report) => report.id === 'report-1')
    assert.deepEqual(reportOne, {
      id: 'report-1', name: '正式归档测试报告', reportType: 'quick report', sourceSessionId: 'session-a', sourceSessionTitle: null, sourceUserId: 'user a', sourceChannel: 'web', sourceChannelUserId: 'user a', sourceChannelUserName: '用户A', sourceMessageId: 'message-a', sourceMessagePreview: '请生成今天的系统运行综述报告', dataSourceId: 'data-source-a', dataSourceName: '101.254.114.238NAPM', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 6, status: 'ready', delivery: { attemptId: 'delivery-1', channel: 'wecom', status: 'handed_off', preparedAt: Date.parse(preparedAt), handedOffAt: Date.parse(handedOffAt), confirmedAt: null, failedAt: null, errorCode: null, updatedAt: Date.parse(handedOffAt) }, createdAt: reportOne.createdAt, updatedAt: reportOne.updatedAt,
    })
    assert.equal(payload.reports.find((report) => report.id === 'legacy-report-id')?.status, 'ready')
    assert.deepEqual(
      {
        user: payload.reports.find((report) => report.id === 'legacy-unattributed')?.sourceUserId,
        session: payload.reports.find((report) => report.id === 'legacy-unattributed')?.sourceSessionId,
        channel: payload.reports.find((report) => report.id === 'legacy-unattributed')?.sourceChannel,
      },
      { user: 'user a', session: 'session-sidecar', channel: 'web' },
    )
    assert.equal(payload.reports.find((report) => report.id === 'legacy-missing'), undefined)
    const otherUserResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, { headers: { 'x-test-user': 'user-b' } })
    const otherUserPayload = await otherUserResponse.json()
    assert.equal(otherUserResponse.status, 200)
    assert.deepEqual(otherUserPayload.reports, [])

    const auditorResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
      headers: { 'x-test-role': 'auditor' },
    })
    const auditorPayload = await auditorResponse.json()
    assert.equal(auditorResponse.status, 200)
    assert.equal(auditorPayload.reports.length, 3)
    assert.equal(auditorPayload.reports.find((report) => report.id === 'legacy-unattributed')?.sourceUserId, 'user a')

    const deniedDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
      headers: { 'x-test-user': 'user-b' },
    })
    assert.equal(deniedDownload.status, 404)

    const auditorDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
      headers: { 'x-test-role': 'auditor' },
    })
    assert.equal(auditorDownload.status, 200)
    assert.equal(await auditorDownload.text(), 'report')
  } finally {
    server.close()
    if (previousRoot === undefined) delete process.env.GAIOP_REPORTS_DIR
    else process.env.GAIOP_REPORTS_DIR = previousRoot
    if (previousAttributionIndex === undefined) delete process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH
    else process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH = previousAttributionIndex
  }
})

test('report list failures remain JSON responses', async () => {
  const previousRoot = process.env.GAIOP_REPORTS_DIR
  process.env.GAIOP_REPORTS_DIR = mkdtempSync(join(tmpdir(), 'gaiop-report-root-failure-'))
  const { createReportsRouter } = await import(`./reports.js?report-list-failure-test=${Date.now()}-${Math.random()}`)
  const app = express()
  app.use('/reports', createReportsRouter({
    db: { prepare: () => { throw new Error('simulated database failure') } },
    authMiddleware: (req, _res, next) => { req.user = { id: 'admin', role: 'admin' }; next() },
    adminMiddleware: (_req, _res, next) => next(),
    recordAudit: () => {},
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reports`)
    assert.match(String(response.headers.get('content-type')), /application\/json/)
    const payload = await response.json()
    assert.equal(response.status, 500)
    assert.equal(payload.code, 'REPORT_LIST_FAILED')
  } finally {
    server.close()
    if (previousRoot === undefined) delete process.env.GAIOP_REPORTS_DIR
    else process.env.GAIOP_REPORTS_DIR = previousRoot
  }
})
