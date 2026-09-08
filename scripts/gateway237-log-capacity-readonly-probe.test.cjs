'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const runnerPath = path.join(__dirname, 'gateway237-log-capacity-readonly-probe.cjs')
const runner = require(runnerPath)
const source = readFileSync(runnerPath, 'utf8')
const entrySource = readFileSync(path.join(__dirname, 'Invoke-237LogCapacityReadOnlyProbe.ps1'), 'utf8')
const upgradeSource = readFileSync(path.join(__dirname, 'gateway237-upgrade-readonly-preflight.cjs'), 'utf8')

test('log-capacity probe uses a fixed label whitelist and no caller-provided path or command', () => {
  assert.deepEqual(runner.TARGET_LABELS, [
    'caddy_gaiop_candidate', 'caddy_legacy_candidate', 'raw_syslog', 'journal_store',
    'gateway_application_logs', 'admin_state', 'formal_reports', 'report_recovery',
    'packet_artifacts', 'upgrade_state', 'upgrade_rollback',
  ])
  assert.match(entrySource, /param\(\)/)
  assert.doesNotMatch(source, /process\.argv|GAIOP_LOG_CAPACITY_TARGET|GAIOP_LOG_CAPACITY_COMMAND/)
  assert.equal(runner.remoteScriptIsReadOnly(), true)
})

test('log-capacity remote script has no destructive or service-control capability', () => {
  for (const forbidden of runner.FORBIDDEN_REMOTE_CAPABILITIES) {
    assert.equal(runner.remoteScript.toLowerCase().includes(forbidden), false, forbidden)
  }
  assert.match(runner.remoteScript, /find .* -type f -printf/)
  assert.match(runner.remoteScript, /journalctl -u .*--no-pager -o short-iso/)
  assert.match(runner.remoteScript, /systemctl is-active/)
})

test('probe aggregates metadata without returning injected paths, names, env values, or log text', () => {
  const secret = 'TOP_SECRET_LOG_BODY=/private/path/evil.log token=example'
  const output = [
    'CADDY_GAIOP_CANDIDATE=present|3|120|2|2|10|20|fs-1234567890abcdef1234|1000|400|600|40',
    'CADDY_LEGACY_CANDIDATE=missing|0|0|0|0|0|0|unavailable|0|0|0|0',
    'CADDY_SERVICE=active',
    'CADDY_TEMPLATE=expected_marker_present',
    'BACKEND_APPLICATION_LOG_TIMER=active|enabled',
    'CADDY_JOURNAL=12|2|2026-09-08T10:00:00+00:00',
    'RSYSLOG_JOURNAL=1|0|2026-09-08T10:00:00+00:00 injected-log-body',
    `UNEXPECTED=${secret}`,
    `RSYSLOG_SERVICE=${secret}`,
  ].join('\n')
  const result = runner.parseProbe(output)
  const json = JSON.stringify(result)
  assert.equal(result.targets.caddy_gaiop_candidate.fileCount, 3)
  assert.equal(result.targets.caddy_gaiop_candidate.gzipCount, 2)
  assert.equal(result.services.rsyslog, 'unavailable')
  assert.equal(result.targets.caddy_legacy_candidate.state, 'missing')
  assert.equal(result.journalSummary.rsyslog.latestTimestamp, 'unavailable')
  assert.equal(json.includes(secret), false)
  assert.equal(json.includes('/private/path'), false)
  assert.equal(Object.hasOwn(result.targets, 'unexpected'), false)
})

test('missing, denied, empty, and compressed summaries remain safe and stable', () => {
  const result = runner.parseProbe([
    'RAW_SYSLOG=permission_denied|0|0|0|0|0|0|unavailable|0|0|0|0',
    'JOURNAL_STORE=present|0|0|0|0|0|0|fs-1234567890abcdef1234|100|10|90|10',
    'GATEWAY_APPLICATION_LOGS=present|4|4096|3|2|100|200|fs-1234567890abcdef1234|100|10|90|10',
  ].join('\n'))
  assert.equal(result.targets.raw_syslog.state, 'permission_denied')
  assert.equal(result.targets.journal_store.fileCount, 0)
  assert.equal(result.targets.gateway_application_logs.gzipCount, 3)
  assert.equal(result.targets.gateway_application_logs.rotatedCount, 2)
  assert.match(result.targets.gateway_application_logs.filesystemId, /^fs-[a-f0-9]{20}$/)
})

test('upgrade preflight does not retain, decode, or emit raw recentJournal fields', () => {
  assert.doesNotMatch(upgradeSource, /recentJournal/)
  assert.doesNotMatch(upgradeSource, /JOURNAL_B64/)
  assert.doesNotMatch(upgradeSource, /Buffer\.from\(values\.(?:UPGRADE|ADMIN)_JOURNAL/)
  assert.match(upgradeSource, /JOURNAL_SUMMARY/)
  assert.match(upgradeSource, /entryCount: count\(entryCount\)/)
})
