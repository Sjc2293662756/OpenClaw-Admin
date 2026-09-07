'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const test = require('node:test')
const { join } = require('node:path')
const vm = require('node:vm')
const { __test__ } = require('./gateway237-sqlite-backup-recovery-verify.cjs')

test('parses success receipt in systemd property order without exposing raw output', () => {
  assert.deepEqual(__test__.receipt('success|start|finish|0'), {
    result: 'success',
    exitStatus: '0',
    startedAt: 'start',
    completedAt: 'finish',
  })
})

test('uses the component restore root alongside the isolated v1 backup set', () => {
  const runner = readFileSync(join(__dirname, 'gateway237-sqlite-backup-recovery-verify.cjs'), 'utf8')
  assert.match(runner, /sqlite-backups\/v1/)
  assert.match(runner, /upgrade_restore_root="\$\(dirname "\$\(dirname "\$upgrade_backup_root"\)"\)\/sqlite-restore-tests"/)
  assert.match(runner, /entryKinds = \{ sqlite3: 0, manifests: 0, other: 0 \}/)
  assert.match(runner, /entryNames = entries\.map\(\(entry\) => entry\.name\)\.sort\(\)/)
})

test('embedded verifier recognizes the controlled daily backup filename', () => {
  const source = readFileSync(join(__dirname, 'gateway237-sqlite-backup-recovery-verify.cjs'), 'utf8')
  const outer = { require, process, console }
  vm.runInNewContext(source.slice(0, source.indexOf('const remoteScript =')) + '\nglobalThis.value = verifier', outer)
  const verifierPrefix = outer.value.slice(0, outer.value.indexOf('const Database = require(moduleRoot)'))
  const context = { process: { argv: ['node', 'runner', 'backup-set', 'x', 'x', 'x', 'admin', 'x'] }, require }
  vm.runInNewContext(verifierPrefix + '\nglobalThis.value = parsedName("admin-daily-2026-09-07.sqlite3")', context)
  assert.deepEqual(context.value, { tier: 'daily', period: '2026-09-07' })
})

test('summarizes only the allowlisted backup metadata projection', () => {
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
  const result = __test__.summarize([
    'CHECKED_AT=2026-09-07T00:00:00Z',
    'ADMIN_TIMER=active|enabled|last',
    'ADMIN_SERVICE_RECEIPT=success|start|finish|0',
    `ADMIN_SWITCHES_B64=${encoded({ createEnabled: true, cleanupEnabled: false })}`,
    `ADMIN_LIVE_B64=${encoded({ ok: true, quickCheck: 'ok', integrityCheck: 'ok' })}`,
    `ADMIN_BACKUP_SET_B64=${encoded({ ok: true, tiers: {} })}`,
    'ADMIN_DISK=1024|20%',
  ].join('\n'), true)
  assert.equal(result.completed, true)
  assert.equal(result.errorCode, null)
  assert.deepEqual(result.admin.timer, { active: 'active', enabled: 'enabled', lastTriggerAt: 'last' })
  assert.deepEqual(result.admin.switches, { createEnabled: true, cleanupEnabled: false })
  assert.deepEqual(result.admin.disk, { availableKiB: 1024, usePercent: '20%' })
  assert.equal(result.admin.backupSet.ok, true)
  assert.equal(result.admin.rawOutput, undefined)
})
