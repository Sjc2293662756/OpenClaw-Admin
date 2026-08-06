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

test('sidecar attributes personal WeChat reports for per-account and per-channel session keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-report-attribution-weixin-'))
  const sessionsRoot = join(root, 'sessions')
  const legacyRoot = join(root, 'legacy')
  const reportRoot = join(root, 'formal')
  const provenanceRoot = join(root, 'provenance')
  const attributionRoot = join(root, 'attribution')
  for (const directory of [sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot]) mkdirSync(directory, { recursive: true })

  const peer = 'o9cq809tqf_xx4jktqcs8859ks5e@im.wechat'
  const accountKey = `agent:main:openclaw-weixin:f513e99d1851-im-bot:direct:${peer}`
  const peerKey = `agent:main:openclaw-weixin:direct:${peer}`
  const accountFile = join(legacyRoot, 'wx-account.docx')
  const accountAudit = join(legacyRoot, 'wx-account.json')
  const peerFile = join(legacyRoot, 'wx-peer.docx')
  const peerAudit = join(legacyRoot, 'wx-peer.json')
  writeFileSync(accountFile, 'wx account report')
  writeFileSync(accountAudit, JSON.stringify({ reportId: 'wx-account' }))
  writeFileSync(peerFile, 'wx peer report')
  writeFileSync(peerAudit, JSON.stringify({ reportId: 'wx-peer' }))
  const accountSession = join(sessionsRoot, 'wx-account.jsonl')
  const peerSession = join(sessionsRoot, 'wx-peer.jsonl')
  writeSession(accountSession, { ok: true, reportId: 'wx-account', filePath: accountFile, auditPath: accountAudit })
  writeSession(peerSession, { ok: true, reportId: 'wx-peer', filePath: peerFile, auditPath: peerAudit })
  writeFileSync(join(sessionsRoot, 'sessions.json'), JSON.stringify({
    [accountKey]: { sessionFile: accountSession },
    [peerKey]: { sessionFile: peerSession },
  }))

  const result = scanReportAttributions({ sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot })
  assert.equal(result.entries, 2)
  const index = JSON.parse(readFileSync(result.indexPath, 'utf8'))
  for (const reportId of ['wx-account', 'wx-peer']) {
    const entry = index.entries.find((item) => item.reportId === reportId)
    assert.equal(entry.sourceChannel, 'openclaw-weixin')
    assert.equal(entry.sourceUserId, `channel:openclaw-weixin:${peer}`)
    assert.equal(entry.sourceChannelUserId, peer)
    assert.ok(entry.storedName.startsWith('_sidecar/'))
    assert.ok(existsSync(join(reportRoot, entry.storedName)))
  }
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

test('sidecar accepts an exec result only when it names one exact controlled report and audit pair', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-report-attribution-exec-'))
  const sessionsRoot = join(root, 'sessions')
  const legacyRoot = join(root, 'legacy')
  const reportRoot = join(root, 'formal')
  const provenanceRoot = join(root, 'provenance')
  const attributionRoot = join(root, 'attribution')
  for (const directory of [sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot]) mkdirSync(directory, { recursive: true })
  const migratedDirectory = join(reportRoot, 'migrated')
  mkdirSync(migratedDirectory)
  const reportFile = join(migratedDirectory, 'exec-report.docx')
  const auditFile = join(migratedDirectory, 'exec-report.json')
  writeFileSync(reportFile, 'exec report')
  writeFileSync(auditFile, JSON.stringify({ reportId: 'exec-report', fileName: 'exec-report.docx' }))
  const sessionFile = join(sessionsRoot, 'wecom.jsonl')
  writeFileSync(sessionFile, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    message: {
      role: 'toolResult', toolName: 'exec',
      content: [{ type: 'text', text: 'completed\nexec-report.docx' }],
    },
  })}\n`)
  const sessionKey = 'agent:main:wecom:direct:yangs'
  writeFileSync(join(sessionsRoot, 'sessions.json'), JSON.stringify({ [sessionKey]: { sessionFile, channel: 'wecom' } }))

  const result = scanReportAttributions({ sessionsRoot, legacyRoot, reportRoot, provenanceRoot, attributionRoot })
  assert.equal(result.entries, 1)
  const [entry] = JSON.parse(readFileSync(result.indexPath, 'utf8')).entries
  assert.equal(entry.evidence, 'exec_tool_result')
  assert.equal(entry.sourceSessionId, sessionKey)
  assert.equal(entry.sourceChannel, 'wecom')
})
