import assert from 'node:assert/strict'
import test from 'node:test'
import { createHmac } from 'node:crypto'
import { attachReportProvenance, __test__ } from './report-provenance-service.js'

test('report provenance v2 signs server-owned user, session, and active data source', () => {
  const key = '0123456789abcdef0123456789abcdef'
  const result = attachReportProvenance({ sessionKey: 'session-1', metadata: { browser: 'value' } }, { id: 'user-1' }, {
    enabled: true,
    signingKey: key,
    dataSourceId: 'source-1',
    now: 123456789,
  })
  const envelope = result.params.metadata.gaiopReportProvenance
  const expected = createHmac('sha256', key)
    .update(__test__.canonicalPayload({ userId: 'user-1', sessionId: 'session-1', dataSourceId: 'source-1', issuedAt: 123456789 }), 'utf8')
    .digest('base64url')
  assert.equal(result.attached, true)
  assert.equal(envelope.version, 'gaiop_report_provenance.v2')
  assert.equal(envelope.dataSourceId, 'source-1')
  assert.equal(envelope.signature, expected)
  assert.equal(result.params.metadata.browser, 'value')
})

test('report provenance does not attach without the server signing preconditions', () => {
  const params = { sessionKey: 'session-1' }
  const result = attachReportProvenance(params, { id: 'user-1' }, { enabled: true, signingKey: 'short' })
  assert.equal(result.attached, false)
  assert.equal(result.params, params)
})
