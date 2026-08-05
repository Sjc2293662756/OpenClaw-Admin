import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scanReportAttributions } from './report-attribution-worker.js'

function writeSession(filePath, result) {
  writeFileSync(filePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: {
      role: 'toolResult',
      toolName: 'napm-report-export',
      toolCallId: 'call-report',
      details: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    },
  })}\n`)
}

test('sidecar attributes official web and channel exports without changing generated artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-report-attribution-'))
  const sessionsRoot = join(root, 'sessions')
  const legacyRoot = join(root, 'legacy')
  const reportRoot = join(root, 'formal')
  const provenanceRoot = join(root, 'provenance')
  const attributionRoot = join(root, 'attribution')
  for (const directory of [sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot]) mkdirSync(directory, { recursive: true })

  const webKey = 'agent:main:main:dm:webchat-test'
  const channelKey = 'agent:main:wecom:direct:yangs'
  const webFile = join(reportRoot, 'web.docx')
  const webAudit = join(reportRoot, 'web.json')
  const channelFile = join(legacyRoot, 'channel.docx')
  const channelAudit = join(legacyRoot, 'channel.json')
  writeFileSync(webFile, 'web report')
  writeFileSync(webAudit, JSON.stringify({ reportId: 'web-report', dataSourceId: 'source-a' }))
  writeFileSync(channelFile, 'channel report')
  writeFileSync(channelAudit, JSON.stringify({ reportId: 'channel-report', dataSource: { id: 'source-b' } }))
  writeSession(join(sessionsRoot, 'web.jsonl'), { ok: true, reportId: 'web-report', filePath: webFile, auditPath: webAudit })
  // The coworker-maintained plugin intentionally exposes reportId but omits
  // host file paths from public tool details. The sidecar resolves the unique
  // audit/report pair inside the two controlled report roots.
  writeSession(join(sessionsRoot, 'channel.jsonl'), { ok: true, reportId: 'channel-report' })
  writeFileSync(join(sessionsRoot, 'sessions.json'), JSON.stringify({
    [webKey]: { sessionFile: join(sessionsRoot, 'web.jsonl') },
    [channelKey]: { sessionFile: join(sessionsRoot, 'channel.jsonl'), channel: 'wecom', senderName: '杨硕' },
  }))
  const webEnvelope = {
    sourceUserId: 'user-web', sourceSessionId: webKey, sourceChannel: 'web',
    sourceChannelUserId: 'user-web', sourceChannelUserName: 'ys', dataSourceId: 'source-a',
  }
  writeFileSync(join(provenanceRoot, `${createHash('sha256').update(webKey).digest('hex')}.json`), JSON.stringify(webEnvelope))

  const result = scanReportAttributions({ sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot })
  assert.equal(result.entries, 2)
  const index = JSON.parse(readFileSync(result.indexPath, 'utf8'))
  const web = index.entries.find((entry) => entry.reportId === 'web-report')
  const channel = index.entries.find((entry) => entry.reportId === 'channel-report')
  assert.deepEqual({ channel: web.sourceChannel, user: web.sourceUserId, session: web.sourceSessionId }, { channel: 'web', user: 'user-web', session: webKey })
  assert.deepEqual({ channel: channel.sourceChannel, user: channel.sourceUserId, name: channel.sourceChannelUserName, session: channel.sourceSessionId }, { channel: 'wecom', user: 'channel:wecom:yangs', name: '杨硕', session: channelKey })
  assert.equal(channel.evidence, 'official_tool_result')
  assert.ok(channel.storedName.startsWith('_sidecar/'))
  assert.ok(existsSync(join(reportRoot, channel.storedName)))
  assert.equal(readFileSync(channelFile, 'utf8'), 'channel report')
  assert.equal(JSON.parse(readFileSync(channelAudit, 'utf8')).reportId, 'channel-report')
  assert.equal(scanReportAttributions({ sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot }).discovered, 0)
})

test('sidecar ignores exec fallbacks and failed report exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-report-attribution-ignore-'))
  const sessionsRoot = join(root, 'sessions')
  const directories = {
    sessionsRoot,
    legacyRoot: join(root, 'legacy'),
    reportRoot: join(root, 'formal'),
    provenanceRoot: join(root, 'provenance'),
    attributionRoot: join(root, 'attribution'),
  }
  for (const directory of Object.values(directories)) mkdirSync(directory, { recursive: true })
  const sessionFile = join(sessionsRoot, 'channel.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ message: { role: 'toolResult', toolName: 'napm-report-export', details: { ok: false, errorCode: 'REPORT_DATA_NOT_FOUND' } } }),
    JSON.stringify({ message: { role: 'toolResult', toolName: 'exec', details: { status: 'completed' } } }),
  ].join('\n'))
  writeFileSync(join(sessionsRoot, 'sessions.json'), JSON.stringify({
    'agent:main:wecom:direct:yangs': { sessionFile, channel: 'wecom' },
  }))
  const result = scanReportAttributions(directories)
  assert.equal(result.entries, 0)
})
