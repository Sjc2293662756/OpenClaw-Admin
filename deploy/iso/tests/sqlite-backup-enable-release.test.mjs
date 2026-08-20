import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const powershell = readFileSync(join(root, 'scripts', 'Invoke-237RetentionClosedRelease.ps1'), 'utf8')
const runner = readFileSync(join(root, 'scripts', 'gateway237-retention-closed-release.cjs'), 'utf8')

test('controlled entry validates both verified SQLite backup source trees', () => {
  assert.match(powershell, /'enable-sqlite-backups'/)
  assert.match(powershell, /\[string\]\$AdminSourceRootPath/)
  assert.match(powershell, /\[string\]\$UpgradeSourceRootPath/)
  for (const required of [
    'server\\sqlite-backup.js',
    'server\\sqlite-restore-test.js',
    'server\\lib\\sqlite-backup-service.js',
    'src\\sqlite-backup.js',
    'src\\sqlite-restore-test.js',
    'src\\services\\SqliteBackupService.js',
  ]) assert.ok(powershell.includes(required), required)
})

test('production policies enable creation but keep expiration cleanup closed', () => {
  const adminDisabled = runner.indexOf('GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=false')
  const adminEnabled = runner.indexOf("sed 's/GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=false/GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=true/'")
  const upgradeDisabled = runner.indexOf('GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=false')
  const upgradeEnabled = runner.indexOf("sed 's/GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=false/GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=true/'")
  assert.ok(adminDisabled >= 0 && adminEnabled > adminDisabled)
  assert.ok(upgradeDisabled >= 0 && upgradeEnabled > upgradeDisabled)
  assert.match(runner, /GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false/)
  assert.match(runner, /GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED=false/)
  assert.doesNotMatch(runner, /GAIOP_(?:ADMIN|UPGRADE)_SQLITE_BACKUP_CLEANUP_ENABLED=true/)
})

test('effective units use isolated runtime directories and do not load main environments', () => {
  for (const value of [
    'WorkingDirectory=/run/gaiop-admin-sqlite-backup',
    'WorkingDirectory=/run/gaiop-upgrade-sqlite-backup',
    'RuntimeDirectoryPreserve=no',
    'TimeoutStartSec=15min',
    'InaccessiblePaths=-/etc/gaiop/admin.env',
    'InaccessiblePaths=-/etc/gaiop/upgrade.env',
    'InaccessiblePaths=-/var/lib/gaiop-upgrade',
    'InaccessiblePaths=-/var/backups/gaiop/upgrade',
    'InaccessiblePaths=-/var/lib/gaiop/admin',
  ]) assert.ok(runner.includes(value), value)
  assert.match(runner, /EnvironmentFile=\nEnvironmentFile=\$admin_policy/)
  assert.match(runner, /EnvironmentFile=\nEnvironmentFile=\$upgrade_policy/)
})

test('release requires safety snapshots, three tiers, restore tests and an idempotent enabled run', () => {
  assert.match(runner, /phase=database_safety_backups/)
  assert.match(runner, /online_backup .*wizard\.db\.before-enable/)
  assert.match(runner, /online_backup .*upgrade\.db\.before-enable/)
  assert.match(runner, /validate_disabled_one_shot "\$admin_service"/)
  assert.match(runner, /validate_disabled_one_shot "\$upgrade_service"/)
  assert.match(runner, /admin_expected_created=3/)
  assert.match(runner, /upgrade_expected_created=3/)
  assert.match(runner, /validate_one_shot "\$admin_service" admin "\$admin_expected_created"/)
  assert.match(runner, /validate_one_shot "\$upgrade_service" upgrade "\$upgrade_expected_created"/)
  assert.match(runner, /verify_restore_tiers admin/)
  assert.match(runner, /verify_restore_tiers upgrade/)
  assert.match(runner, /validate_one_shot "\$admin_service" admin 0/)
  assert.match(runner, /validate_one_shot "\$upgrade_service" upgrade 0/)
  assert.match(runner, /selected\.cleanup\?\.status !== 'disabled'/)
  assert.match(runner, /source_bytes \* 60 \+ 104857600/)
  assert.match(runner, /systemd-run --quiet --wait --pipe --collect/)
  assert.match(runner, /journalMode: 'delete'/)
  assert.match(runner, /identicalSnapshots: true/)
})

test('failure rollback preserves evidence and restores only controlled state', () => {
  assert.match(runner, /restore_file "\$admin_dropin_file" admin\.dropin/)
  assert.match(runner, /restore_file "\$upgrade_dropin_file" upgrade\.dropin/)
  assert.match(runner, /restore_mode "\$upgrade_db" upgrade-database/)
  assert.match(runner, /BACKUP_EVIDENCE_PRESERVED=1/)
  assert.match(runner, /chmod 0640 "\$database_file"/)
  assert.match(runner, /sqliteBackupPostcheckRollbackScript/)
  assert.match(runner, /POSTCHECK_ROLLBACK_COMPLETE=1/)
  assert.doesNotMatch(runner, /systemctl restart gaiop-upgrade\.service/)
})
