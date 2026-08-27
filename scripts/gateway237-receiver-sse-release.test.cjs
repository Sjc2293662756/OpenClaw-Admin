'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = __dirname
const releaseSource = fs.readFileSync(path.join(root, 'gateway237-receiver-sse-release.cjs'), 'utf8')
const inspectSource = fs.readFileSync(path.join(root, 'gateway237-receiver-sse-inspect.cjs'), 'utf8')

test('Receiver SSE release runner is scoped to the receiver and has rollback safeguards', () => {
  assert.match(releaseSource, /service='gaiop-syslog-receiver\.service'/)
  assert.match(releaseSource, /trap rollback ERR/)
  assert.match(releaseSource, /cp -a -- "\$target_root" "\$backup_root\/receiver-snapshot"/)
  assert.match(releaseSource, /events_check\(\)/)
  assert.match(releaseSource, /HISTORY_PRESERVED/)
  assert.doesNotMatch(releaseSource, /napm-syslog-watcher\.service/)
})

test('Receiver SSE inspection emits only a sanitized operational summary', () => {
  assert.match(inspectSource, /releaseArtifacts/)
  assert.match(inspectSource, /managedBackupMarker/)
  assert.match(inspectSource, /JSON\.stringify\(summary\)/)
  assert.doesNotMatch(inspectSource, /process\.stdout\.write\(.*env_file/)
  assert.doesNotMatch(inspectSource, /process\.stdout\.write\(.*GAIOP_ALERT_RECEIVER_TOKEN/)
})
