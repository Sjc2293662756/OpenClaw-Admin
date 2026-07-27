import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachReportProvenance, __test__ } from './report-provenance-service.js'

test('report provenance v3 signs server-owned Web user, session, and source message', () => {
  const key = '0123456789abcdef0123456789abcdef'
  const result = attachReportProvenance({ sessionKey: 'session-1', message: '生成今日综述报告', idempotencyKey: 'message-1', metadata: { browser: 'value' } }, { id: 'user-1', username: 'alice' }, {
    enabled: true,
    signingKey: key,
    dataSourceId: 'source-1',
    now: 123456789,
  })
  const envelope = result.params.metadata.gaiopReportProvenance
  const expected = createHmac('sha256', key)
    .update(__test__.canonicalPayload({ userId: 'user-1', username: 'alice', sessionId: 'session-1', dataSourceId: 'source-1', sourceChannel: 'web', sourceChannelUserId: 'user-1', sourceChannelUserName: 'alice', messageId: 'message-1', messagePreview: '生成今日综述报告', issuedAt: 123456789 }), 'utf8')
    .digest('base64url')
  assert.equal(result.attached, true)
  assert.equal(envelope.version, 'gaiop_report_provenance.v3')
  assert.equal(envelope.dataSourceId, 'source-1')
  assert.equal(envelope.sourceChannel, 'web')
  assert.equal(envelope.sourceChannelUserName, 'alice')
  assert.equal(envelope.sourceMessageId, 'message-1')
  assert.equal(envelope.signature, expected)
  assert.equal(result.params.metadata.browser, 'value')
})

test('report provenance does not attach without the server signing preconditions', () => {
  const params = { sessionKey: 'session-1' }
  const result = attachReportProvenance(params, { id: 'user-1' }, { enabled: true, signingKey: 'short' })
  assert.equal(result.attached, false)
  assert.equal(result.params, params)
})

test('report provenance accepts the Gateway input alias for the source preview', () => {
  const result = attachReportProvenance(
    { sessionKey: 'session-input', input: '生成运行综述报告' },
    { id: 'user-input', username: 'alice' },
    { enabled: true, signingKey: '0123456789abcdef0123456789abcdef' },
  )
  assert.equal(result.params.metadata.gaiopReportProvenance.sourceMessagePreview, '生成运行综述报告')
})

test('report provenance persists one signed snapshot without exposing the session id in its file name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-report-provenance-'))
  try {
    const result = attachReportProvenance({ sessionKey: 'agent:main:main:dm:webchat-user-1', message: '生成报告' }, { id: 'user-1', username: 'alice' }, {
      enabled: true,
      signingKey: '0123456789abcdef0123456789abcdef',
      storeDirectory: directory,
      dataSourceId: 'source-1',
      now: 123456789,
    })
    const files = readdirSync(directory)
    assert.equal(result.stored, true)
    assert.equal(files.length, 1)
    assert.match(files[0], /^[a-f0-9]{64}\.json$/)
    const stored = JSON.parse(readFileSync(join(directory, files[0]), 'utf8'))
    assert.equal(stored.sessionId, 'agent:main:main:dm:webchat-user-1')
    assert.equal(stored.sourceChannel, 'web')
    assert.equal(stored.dataSourceId, 'source-1')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('report provenance store-only mode leaves Gateway and model transport parameters unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-report-provenance-store-only-'))
  try {
    const params = {
      sessionKey: 'agent:main:main:dm:webchat-store-only',
      message: '分析最近三小时告警情况',
      idempotencyKey: 'message-store-only',
    }
    const result = attachReportProvenance(params, { id: 'user-store-only', username: 'alice' }, {
      enabled: true,
      signingKey: '0123456789abcdef0123456789abcdef',
      storeDirectory: directory,
      dataSourceId: 'source-store-only',
      transportMetadata: false,
      now: 123456789,
    })
    assert.equal(result.attached, false)
    assert.equal(result.stored, true)
    assert.equal(result.params, params)
    assert.equal('metadata' in result.params, false)
    const stored = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'))
    assert.equal(stored.sourceUserId, undefined)
    assert.equal(stored.userId, 'user-store-only')
    assert.equal(stored.sessionId, params.sessionKey)
    assert.equal(stored.dataSourceId, 'source-store-only')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
