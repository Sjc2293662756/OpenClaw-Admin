import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const runner = readFileSync(new URL('./gateway237-report-runtime-contract-restore.cjs', import.meta.url), 'utf8')
const wrapper = readFileSync(new URL('./Invoke-237ReportRuntimeContractRestore.ps1', import.meta.url), 'utf8')

process.env.GAIOP_REPORT_RUNTIME_ARCHIVE = 'fixture.tgz'
process.env.GAIOP_REPORT_RUNTIME_ARCHIVE_SHA256 = 'a'.repeat(64)
process.env.GAIOP_REPORT_RUNTIME_RELEASE_ID = '20260902T000000Z'
process.env.GAIOP_REPORT_RUNTIME_MODE = 'inspect'
process.env.GAIOP_REPORT_RUNTIME_SSH_HOST = 'fixture'
process.env.GAIOP_REPORT_RUNTIME_SSH_USERNAME = 'fixture'
process.env.GAIOP_REPORT_RUNTIME_SSH_PASSWORD = 'fixture'
const require = createRequire(import.meta.url)
const { deploymentScript } = require('./gateway237-report-runtime-contract-restore.cjs')

test('report runtime restoration is patch-based and rejects an unexpected archive', () => {
  assert.match(runner, /patch --dry-run/)
  const makePatch = runner.slice(runner.indexOf('make_patch()'), runner.indexOf('apply_patch_file()'))
  assert.match(makePatch, /if diff -u/)
  assert.doesNotMatch(makePatch, /set \+e/)
  assert.match(runner, /expected_entries=/)
  assert.match(runner, /test "\$archive_entries" = "\$expected_entries"/)
  assert.doesNotMatch(runner, /rm -rf -- \/home\/netinside\/\.openclaw/)
})

test('inspect mode reports patch compatibility without switching production files', () => {
  const inspect = runner.slice(runner.indexOf('if [ "$deployment_mode" = inspect ]'), runner.indexOf('plugin_contract_present='))
  assert.match(inspect, /status: 'inspected'/)
  assert.match(inspect, /runtimeHashes/)
  assert.doesNotMatch(inspect, /phase=switch/)
  assert.doesNotMatch(inspect, /install -o netinside/)
  assert.match(runner, /incompatible:hunks=/)
  assert.match(runner, /patch --dry-run --verbose/)
})

test('release retains the two inspected single-hunk repair guards', () => {
  assert.match(runner, /test "\$\(grep -c '\^@@' "\$reject_file"\)" -eq 1/)
  assert.match(runner, /source\.split\(turnAnchor\)\.length !== 2/)
  assert.match(runner, /source\.split\(anchor\)\.length !== 2/)
  assert.doesNotMatch(runner, /--merge/)
})

test('deployment script renders both guarded semantic repairs inside Bash', () => {
  const script = deploymentScript('/tmp/fixture.tgz')
  assert.match(script, /const channelReportProvenance = extractTrustedChannelReportProvenance/)
  assert.match(script, /const sourceOwnership = \{/)
  assert.match(script, /fs\.writeFileSync\(file, source\)/)
  assert.doesNotMatch(script, /\$\{payload\./)
})

test('stage mode validates temporary files and exits before backup or switch', () => {
  const script = deploymentScript('/tmp/fixture.tgz')
  const stage = script.slice(script.indexOf('if [ "$deployment_mode" = stage ]'), script.indexOf('report_files_before='))
  assert.match(stage, /status: 'staged'/)
  assert.match(stage, /stagedHashes/)
  assert.doesNotMatch(stage, /phase=backup/)
  assert.doesNotMatch(stage, /phase=switch/)
  assert.ok(script.indexOf('if [ "$deployment_mode" = stage ]') < script.indexOf('phase=backup'))
})

test('report runtime restoration backs up code and SQLite before switching', () => {
  assert.match(runner, /admin-code-config\.tgz/)
  assert.match(runner, /source\.backup\(process\.argv\[3\]\)/)
  assert.ok(runner.indexOf('phase=backup') < runner.indexOf('phase=switch'))
  assert.match(runner, /install -o netinside -g netinside -m 0644/)
})

test('report runtime restoration rolls back code without restoring the live database', () => {
  const rollback = runner.slice(runner.indexOf('rollback()'), runner.indexOf('trap rollback ERR'))
  assert.match(rollback, /install -o netinside/)
  assert.doesNotMatch(rollback, /wizard\.db/)
  assert.match(rollback, /gateway_control restart/)
})

test('Gateway daemon reload is not passed a service unit', () => {
  const helper = runner.slice(runner.indexOf('gateway_control()'), runner.indexOf('rollback()'))
  assert.match(helper, /systemctl --user daemon-reload/)
  assert.match(helper, /systemctl --user "\$action" openclaw-gateway\.service/)
  assert.doesNotMatch(helper, /systemctl --user "\$action" openclaw-gateway\.service[\s\S]*daemon-reload/)
})

test('report runtime restoration verifies contracts, counts, services, and boundaries', () => {
  assert.match(runner, /shouldOwnAutomaticReportReplyDispatch/)
  assert.match(runner, /GAIOP_REPORTS_DIR=\/var\/lib\/gaiop\/reports/)
  assert.match(runner, /test "\$db_before" = "\$db_after"/)
  assert.match(runner, /127\.0\.0\.1:3000/)
  assert.match(runner, /gaiop-session-retention-cleanup\.timer/)
})

test('PowerShell wrapper loads only the user-scoped encrypted connection record', () => {
  assert.match(wrapper, /alert-syslog-connection\.clixml/)
  assert.match(wrapper, /Import-Clixml/)
  assert.match(wrapper, /SecureStringToBSTR/)
  assert.match(wrapper, /ZeroFreeBSTR/)
  assert.match(wrapper, /ValidateSet\('Inspect', 'Stage', 'Release'\)/)
})
