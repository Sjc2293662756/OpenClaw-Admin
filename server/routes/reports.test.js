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
    if (req.get('x-test-role') === 'auditor-deny') {
      return { id: 'auditor-1', role: 'auditor', effectiveModules: { 'data.allUsers': false } }
    }
    if (req.get('x-test-scope') === 'all-users') {
      return { id: 'user-b', role: 'basic', effectiveModules: { 'data.allUsers': true } }
    }
    if (req.get('x-test-scope') === 'all-without-reports') {
      return { id: 'user-b', role: 'basic', effectiveModules: { 'data.allUsers': true, reports: false } }
    }
    const role = req.get('x-test-role') || 'basic'
    const id = req.get('x-test-user') || (role === 'admin' || role === 'auditor' ? `${role}-1` : 'user a')
    return { id, role }
  })).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reports`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.reports.length, 3)
    const reportOne = payload.reports.find((report) => report.id === 'report-1')
    assert.deepEqual(reportOne, {
      id: 'report-1', name: '正式归档测试报告.docx', reportType: 'quick report', sourceSessionId: 'session-a', sourceSessionTitle: null, sourceUserId: 'user a', sourceChannel: 'web', sourceChannelUserId: 'user a', sourceChannelUserName: '用户A', sourceMessageId: 'message-a', sourceMessagePreview: '请生成今天的系统运行综述报告', dataSourceId: 'data-source-a', dataSourceName: '101.254.114.238NAPM', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 6, status: 'ready', longTermKeep: false, retentionState: 'active', delivery: { attemptId: 'delivery-1', channel: 'wecom', status: 'handed_off', preparedAt: Date.parse(preparedAt), handedOffAt: Date.parse(handedOffAt), confirmedAt: null, failedAt: null, errorCode: null, updatedAt: Date.parse(handedOffAt) }, createdAt: reportOne.createdAt, updatedAt: reportOne.updatedAt,
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

    for (const role of ['basic', 'standard', 'admin', 'auditor']) {
      const roleResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
        headers: { 'x-test-role': role },
      })
      const rolePayload = await roleResponse.json()
      assert.equal(roleResponse.status, 200, `${role} report list`)
      assert.equal(rolePayload.reports.length, 3, `${role} can read its permitted reports`)

      const roleDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
        headers: { 'x-test-role': role },
      })
      assert.equal(roleDownload.status, 200, `${role} permitted report download`)
      assert.equal(await roleDownload.text(), 'report')
    }

    for (const role of ['basic', 'standard']) {
      const deniedList = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
        headers: { 'x-test-role': role, 'x-test-user': 'user-b' },
      })
      assert.deepEqual((await deniedList.json()).reports, [], `${role} cannot list another user's reports`)

      const deniedRoleDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
        headers: { 'x-test-role': role, 'x-test-user': 'user-b' },
      })
      assert.equal(deniedRoleDownload.status, 404, `${role} cannot download another user's report`)
    }

    const auditorResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
      headers: { 'x-test-role': 'auditor' },
    })
    const auditorPayload = await auditorResponse.json()
    assert.equal(auditorResponse.status, 200)
    assert.equal(auditorPayload.reports.length, 3)
    assert.equal(auditorPayload.reports.find((report) => report.id === 'legacy-unattributed')?.sourceUserId, 'user a')

    const allUserResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
      headers: { 'x-test-scope': 'all-users' },
    })
    const allUserPayload = await allUserResponse.json()
    assert.equal(allUserResponse.status, 200)
    assert.equal(allUserPayload.reports.length, 3)

    const scopeWithoutModuleResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
      headers: { 'x-test-scope': 'all-without-reports' },
    })
    const scopeWithoutModulePayload = await scopeWithoutModuleResponse.json()
    assert.equal(scopeWithoutModuleResponse.status, 200)
    assert.deepEqual(scopeWithoutModulePayload.reports, [])

    const reducedAuditorResponse = await fetch(`http://127.0.0.1:${server.address().port}/reports`, {
      headers: { 'x-test-role': 'auditor-deny' },
    })
    const reducedAuditorPayload = await reducedAuditorResponse.json()
    assert.equal(reducedAuditorResponse.status, 200)
    assert.deepEqual(reducedAuditorPayload.reports, [])

    const deniedDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
      headers: { 'x-test-user': 'user-b' },
    })
    assert.equal(deniedDownload.status, 404)

    const deniedPreview = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/preview`, {
      headers: { 'x-test-user': 'user-b' },
    })
    assert.equal(deniedPreview.status, 404)

    const allUserDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
      headers: { 'x-test-scope': 'all-users' },
    })
    assert.equal(allUserDownload.status, 200)
    assert.equal(await allUserDownload.text(), 'report')

    const reducedAuditorDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
      headers: { 'x-test-role': 'auditor-deny' },
    })
    assert.equal(reducedAuditorDownload.status, 404)

    const ownUnsupportedPreview = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/preview`)
    assert.equal(ownUnsupportedPreview.status, 415)

    const auditorDownload = await fetch(`http://127.0.0.1:${server.address().port}/reports/report-1/download`, {
      headers: { 'x-test-role': 'auditor' },
    })
    assert.equal(auditorDownload.status, 200)
    assert.match(String(auditorDownload.headers.get('content-disposition')), /%E6%AD%A3%E5%BC%8F%E5%BD%92%E6%A1%A3%E6%B5%8B%E8%AF%95%E6%8A%A5%E5%91%8A\.docx/)
    assert.equal(await auditorDownload.text(), 'report')
  } finally {
    server.close()
    if (previousRoot === undefined) delete process.env.GAIOP_REPORTS_DIR
    else process.env.GAIOP_REPORTS_DIR = previousRoot
    if (previousAttributionIndex === undefined) delete process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH
    else process.env.GAIOP_REPORT_ATTRIBUTION_INDEX_PATH = previousAttributionIndex
  }
})

test('public report name appends the stored extension after dotted data-source text', async () => {
  const { __test__ } = await import(`./reports.js?public-report-name-test=${Date.now()}-${Math.random()}`)
  assert.equal(__test__.publicReportName({
    original_name: '101.254.114.238NAPM_业务综述报告',
    stored_name: 'user/summary/report.docx',
  }), '101.254.114.238NAPM_业务综述报告.docx')
  assert.equal(__test__.publicReportName({
    original_name: '已有扩展名.docx',
    stored_name: 'user/summary/report.docx',
  }), '已有扩展名.docx')
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

test('administrator retention endpoints expose keep, recovery, restore and expiry-only quarantine operations', async () => {
  const { createReportsRouter } = await import(`./reports.js?report-retention-api-test=${Date.now()}-${Math.random()}`)
  const calls = []
  const retentionService = {
    listRecovery: () => [{ id: 'report-1', name: '报告.docx', retentionState: 'quarantined' }],
    setLongTermKeep: (id, enabled) => { calls.push(['keep', id, enabled]); return { ok: true, longTermKeep: enabled } },
    restoreReport: (id) => { calls.push(['restore', id]); return { ok: true } },
    quarantineReport: (id, options) => { calls.push(['quarantine', id, options]); return { ok: true, recoverableUntil: 123 } },
  }
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT * FROM report_files WHERE id = ?')) {
        return { get: () => ({ id: 'report-1', original_name: '报告.docx' }) }
      }
      throw new Error(`Unexpected test query: ${sql}`)
    },
  }
  const app = express()
  app.use(express.json())
  app.use('/reports', createReportsRouter({
    db,
    retentionService,
    authMiddleware: (_req, _res, next) => next(),
    adminMiddleware: (req, _res, next) => { req.user = { id: 'admin', role: 'admin' }; next() },
    recordAudit: () => {},
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/reports`
  try {
    const recovery = await fetch(`${url}/retention/recovery`).then((response) => response.json())
    assert.equal(recovery.reports[0].retentionState, 'quarantined')
    const keep = await fetch(`${url}/report-1/retention`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ longTermKeep: true }),
    }).then((response) => response.json())
    assert.equal(keep.longTermKeep, true)
    assert.equal((await fetch(`${url}/report-1/restore`, { method: 'POST' })).status, 200)
    const quarantine = await fetch(`${url}/report-1`, { method: 'DELETE' }).then((response) => response.json())
    assert.equal(quarantine.recoverableUntil, 123)
    assert.deepEqual(calls, [
      ['keep', 'report-1', true],
      ['restore', 'report-1'],
      ['quarantine', 'report-1', undefined],
    ])
  } finally {
    server.close()
  }
})

test('personal WeChat report names are resolved from the logged-in account segment, not the peer id', async () => {
  const { __test__ } = await import(`./reports.js?personal-wechat-name-test=${Date.now()}-${Math.random()}`)
  const rows = [{
    source_channel: 'openclaw-weixin',
    source_session_id: 'agent:main:openclaw-weixin:account-a:direct:peer-contact',
    source_channel_user_id: 'peer-contact',
    source_channel_user_name: null,
  }]
  const db = {
    prepare(sql) {
      assert.match(sql, /account_id/)
      return {
        all: () => [{ account_id: 'account-a', display_name: '售后微信', wechat_user_id: 'logged-in-wechat-id' }],
      }
    },
  }

  __test__.enrichPersonalWechatAccountNames(db, rows)

  assert.equal(__test__.personalWechatAccountIdFromSessionKey(rows[0].source_session_id), 'account-a')
  assert.equal(rows[0].source_channel_user_name, '售后微信')
  assert.notEqual(rows[0].source_channel_user_id, 'logged-in-wechat-id')
})
