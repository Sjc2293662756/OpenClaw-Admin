import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const runner = fs.readFileSync(path.join(root, 'gateway237-report-reply-dispatch-channel-fix.cjs'), 'utf8')
const wrapper = fs.readFileSync(path.join(root, 'Invoke-237ReportReplyDispatchChannelFix.ps1'), 'utf8')

test('patches both production plugin copies behind exact runtime hash gates', () => {
  assert.match(runner, /expected_workspace_sha='905099f1f5922f5b04dcda246c3b1f0b0af844ca18385a4f304b4507316e6983'/u)
  assert.match(runner, /expected_extension_sha='760c8d02c71a90e2744a82e62e43effeaa21cba3aecf3a6fd2bcf0193a58ae21'/u)
  assert.match(runner, /workspace_target='\/home\/netinside\/\.openclaw\/workspace\/napm-openclaw-plugin\.remote\.js'/u)
  assert.match(runner, /extension_target='\/home\/netinside\/\.openclaw\/extensions\/napm-openclaw-plugin\/napm-openclaw-plugin\.remote\.js'/u)
})

test('rejects WebChat sessions even when the event channel is mislabeled as WeCom', () => {
  assert.match(runner, /sessionKey\.startsWith\('agent:main:main:dm:webchat-'\)/u)
  assert.match(runner, /fn\(\{ channelId: 'wecom', sessionKey: webchat \}\) !== false/u)
  assert.match(runner, /fn\(\{ channelId: 'wecom', sessionKey: 'agent:main:main:dm:wecom-user' \}\) !== true/u)
})

test('backs up both plugins and SQLite and restores both plugins on a failed switch', () => {
  assert.match(runner, /backup_root\/workspace-plugin\.js/u)
  assert.match(runner, /backup_root\/extension-plugin\.js/u)
  assert.match(runner, /source\.backup\(process\.argv\[3\]\)/u)
  assert.match(runner, /gateway_control restart/u)
})

test('uses only the encrypted user-scoped controlled connection record', () => {
  assert.match(wrapper, /alert-syslog-connection\.clixml/u)
  assert.match(wrapper, /Import-Clixml -LiteralPath \$credentialPath/u)
  assert.doesNotMatch(wrapper, /ConvertTo-SecureString\s+-AsPlainText/u)
})
