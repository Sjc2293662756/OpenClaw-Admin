import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (name) => readFileSync(resolve(repositoryRoot, name), 'utf8')

test('formal report retention templates remain daily, persistent, bounded and default off', () => {
  const env = read('deploy/iso/env/admin.env.example')
  const policy = read('deploy/iso/env/report-retention.policy.example')
  const service = read('deploy/systemd/gaiop-report-retention-cleanup.service')
  const timer = read('deploy/systemd/gaiop-report-retention-cleanup.timer')

  assert.match(env, /^GAIOP_REPORT_RETENTION_AUTO_PROCESS=false$/m)
  assert.match(env, /^GAIOP_REPORT_RETENTION_MAX_ITEMS=50$/m)
  assert.match(env, /^GAIOP_REPORT_RECOVERY_DIR=\/var\/lib\/gaiop\/report-recovery$/m)
  assert.deepEqual(policy.trim().split(/\r?\n/).map((line) => line.split('=', 1)[0]), [
    'GAIOP_ADMIN_DATA_DIR',
    'GAIOP_REPORTS_DIR',
    'GAIOP_REPORT_RECOVERY_DIR',
    'GAIOP_REPORT_RETENTION_LOCK_PATH',
    'GAIOP_REPORT_RETENTION_MAX_ITEMS',
    'GAIOP_REPORT_RETENTION_AUTO_PROCESS',
  ])
  assert.match(policy, /^GAIOP_REPORT_RETENTION_AUTO_PROCESS=false$/m)
  assert.match(policy, /^GAIOP_REPORT_RETENTION_MAX_ITEMS=50$/m)
  assert.match(timer, /^OnCalendar=\*-\*-\* 02:45:00 UTC$/m)
  assert.match(timer, /^Persistent=true$/m)
  assert.match(service, /^Type=oneshot$/m)
  assert.match(service, /^NoNewPrivileges=true$/m)
  assert.match(service, /^ProtectSystem=strict$/m)
  assert.match(service, /^EnvironmentFile=\/etc\/gaiop\/report-retention\.policy$/m)
  assert.match(service, /^InaccessiblePaths=-\/etc\/gaiop\/admin\.env$/m)
  assert.doesNotMatch(service, /ReadWritePaths=\/$/m)
  assert.doesNotMatch(service, /GAIOP_REPORT_RETENTION_AUTO_PROCESS=true/)
})
