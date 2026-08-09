import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachReportProvenance, cleanupExpiredReportProvenance, __test__ } from './report-provenance-service.js'

function writeEnvelope(directory, sessionId, issuedAt, mtimeMs = issuedAt) {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex')
  const target = join(directory, `${digest}.json`)
  writeFileSync(target, JSON.stringify({
    version: __test__.PROVENANCE_VERSION,
    userId: 'user-1',
    sessionId,
    issuedAt,
    signature: 'owned-signature',
  }))
  utimesSync(target, mtimeMs / 1000, mtimeMs / 1000)
  return target
}

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

test('report provenance cleanup requires both 48-hour age checks and deletes oldest owned envelopes first', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-report-provenance-cleanup-'))
  const directory = join(parent, 'report-provenance')
  mkdirSync(directory)
  const now = Date.UTC(2026, 7, 9, 12)
  try {
    const oldest = writeEnvelope(directory, 'session-oldest', now - 72 * 60 * 60 * 1000)
    const boundary = writeEnvelope(directory, 'session-boundary', now - 48 * 60 * 60 * 1000)
    const beforeBoundary = writeEnvelope(directory, 'session-before-boundary', now - 48 * 60 * 60 * 1000 + 1)

    const first = cleanupExpiredReportProvenance({ storeDirectory: directory, now, maxItems: 1 })
    assert.equal(first.success, 1)
    assert.equal(first.reasons.batch_limit, 1)
    assert.equal(first.reasons.not_expired, 1)
    assert.equal(readdirSync(directory).length, 2)
    assert.equal(lstatSync(oldest, { throwIfNoEntry: false }), undefined)

    const second = cleanupExpiredReportProvenance({ storeDirectory: directory, now, maxItems: 10 })
    assert.equal(second.success, 1)
    assert.equal(lstatSync(boundary, { throwIfNoEntry: false }), undefined)
    assert.equal(lstatSync(beforeBoundary).isFile(), true)

    const third = cleanupExpiredReportProvenance({ storeDirectory: directory, now, maxItems: 10 })
    assert.equal(third.success, 0)
    assert.equal(third.reasons.not_expired, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('report provenance cleanup skips unknown, malformed, symlinked and abnormal entries without widening scope', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-report-provenance-safety-'))
  const directory = join(parent, 'report-provenance')
  const outside = join(parent, 'outside')
  mkdirSync(directory)
  mkdirSync(outside)
  const now = Date.UTC(2026, 7, 9, 12)
  try {
    writeFileSync(join(directory, 'unknown.txt'), 'keep')
    mkdirSync(join(directory, 'unknown-directory'))
    const invalidDigest = 'a'.repeat(64)
    writeFileSync(join(directory, `${invalidDigest}.json`), '{"version":"wrong"}')
    const abnormal = writeEnvelope(directory, 'session-abnormal', now - 72 * 60 * 60 * 1000)
    const linkName = `${'b'.repeat(64)}.json`
    symlinkSync(outside, join(directory, linkName), 'junction')
    const oldTempName = `.${'c'.repeat(64)}.12.${now - 72 * 60 * 60 * 1000}.tmp`
    writeFileSync(join(directory, oldTempName), 'keep')

    const result = cleanupExpiredReportProvenance({
      storeDirectory: directory,
      now,
      fs: {
        lstatSync: (target) => target === abnormal
          ? new Proxy(lstatSync(target), { get: (stat, property) => property === 'mtimeMs' ? Number.NaN : Reflect.get(stat, property, stat) })
          : lstatSync(target),
      },
    })
    assert.equal(result.success, 0)
    assert.equal(result.reasons.unknown_filename, 2)
    assert.equal(result.reasons.unknown_directory, 1)
    assert.equal(result.reasons.invalid_envelope, 1)
    assert.equal(result.reasons.invalid_timestamp, 1)
    assert.equal(result.reasons.symbolic_link, 1)
    assert.equal(readdirSync(directory).length, 6)

    const refused = cleanupExpiredReportProvenance({ storeDirectory: parent, now })
    assert.equal(refused.failed, 1)
    assert.equal(refused.reasons.unexpected_root_name, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('owned provenance temp files follow a separate strict rule and deletion failures remain retryable', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-report-provenance-temp-'))
  const directory = join(parent, 'report-provenance')
  mkdirSync(directory)
  const now = Date.UTC(2026, 7, 9, 12)
  const createdAt = now - 72 * 60 * 60 * 1000
  const target = join(directory, `.gaiop-report-provenance-${'d'.repeat(64)}.123.${createdAt}.tmp`)
  try {
    writeFileSync(target, 'partial')
    utimesSync(target, createdAt / 1000, createdAt / 1000)
    const failed = cleanupExpiredReportProvenance({
      storeDirectory: directory,
      now,
      fs: { unlinkSync: () => { throw new Error('simulated') } },
    })
    assert.equal(failed.failed, 1)
    assert.equal(lstatSync(target).isFile(), true)

    const retried = cleanupExpiredReportProvenance({ storeDirectory: directory, now })
    assert.equal(retried.success, 1)
    assert.equal(lstatSync(target, { throwIfNoEntry: false }), undefined)
    const repeated = cleanupExpiredReportProvenance({ storeDirectory: directory, now })
    assert.equal(repeated.success, 0)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
