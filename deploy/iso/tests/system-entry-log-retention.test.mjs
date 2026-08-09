import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  isStrictlyPastRetention,
  validateRetentionTemplates,
} from '../scripts/validate-system-entry-log-retention.mjs'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '../../..')

test('ISO templates register only the intended logs and retention mechanisms', async () => {
  const result = await validateRetentionTemplates(repositoryRoot)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test('expiry boundary requires timestamps to be strictly older than retention', () => {
  const now = new Date('2026-08-09T12:00:00.000Z')
  assert.equal(isStrictlyPastRetention('2025-08-09T12:00:00.001Z', now, 365), false)
  assert.equal(isStrictlyPastRetention('2025-08-09T12:00:00.000Z', now, 365), false)
  assert.equal(isStrictlyPastRetention('2025-08-09T11:59:59.999Z', now, 365), true)
  assert.equal(isStrictlyPastRetention('2026-02-10T12:00:00.000Z', now, 180), false)
  assert.equal(isStrictlyPastRetention('2026-02-10T11:59:59.999Z', now, 180), true)
  assert.equal(isStrictlyPastRetention('invalid', now, 365), false)
})

test('Caddy fragment strips every query string and deletes credential/body fields', async () => {
  const result = await validateRetentionTemplates(repositoryRoot)
  const fragment = await import('node:fs/promises').then(({ readFile }) => readFile(result.paths.caddy, 'utf8'))
  for (const forbidden of [
    'request>headers>Authorization delete',
    'request>headers>Proxy-Authorization delete',
    'request>headers>Cookie delete',
    'resp_headers>Set-Cookie delete',
    'request>body delete',
    'response>body delete',
  ]) assert.match(fragment, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(fragment, /request>uri\s+regexp\s+"\\\\\?\.\*\$"\s+"\?\[QUERY_REDACTED\]"/)
  assert.doesNotMatch(fragment, /log_credentials/)
})

test('validator reports only reason codes when a template is unsafe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gaiop-log-retention-test-'))
  const caddyDirectory = path.join(root, 'deploy/iso/caddy')
  const logrotateDirectory = path.join(root, 'deploy/iso/logrotate')
  const journalDirectory = path.join(root, 'deploy/iso/journald')
  await Promise.all([mkdir(caddyDirectory, { recursive: true }), mkdir(logrotateDirectory, { recursive: true }), mkdir(journalDirectory, { recursive: true })])
  await Promise.all([
    writeFile(path.join(caddyDirectory, 'gaiop-access-log.caddy'), 'secret-value-from-fixture', 'utf8'),
    writeFile(path.join(logrotateDirectory, 'gaiop-netinside-syslog'), 'secret-value-from-fixture', 'utf8'),
    writeFile(path.join(journalDirectory, '60-gaiop-retention.conf'), 'secret-value-from-fixture', 'utf8'),
  ])
  const result = await validateRetentionTemplates(root)
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
  assert.doesNotMatch(result.errors.join(','), /secret-value-from-fixture/)
})

test('Linux validation protects current files and requires approved continuity checks', async () => {
  const script = await import('node:fs/promises').then(({ readFile }) => readFile(
    path.join(repositoryRoot, 'deploy/iso/scripts/validate-system-entry-log-retention-linux.sh'),
    'utf8',
  ))
  assert.match(script, /GAIOP_LOG_RETENTION_LIVE_ROTATION_APPROVED/)
  assert.match(script, /test ! -L \/var\/log\/gaiop\/caddy\/access\.log/)
  assert.match(script, /test ! -L \/var\/log\/netinside\/syslog\.log/)
  assert.match(script, /systemctl is-active --quiet rsyslog\.service/)
  assert.match(script, /GAIOP_SYSLOG_RECEIVER_USER/)
  assert.match(script, /logger --tag gaiop-retention-validation/)
  assert.doesNotMatch(script, /(?:cat|head|tail)\s+\/var\/log\//)
})
