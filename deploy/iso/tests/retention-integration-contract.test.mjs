import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8')

function parseEnvironmentExample(source) {
  const values = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    assert.notEqual(separator, -1, `invalid environment line: ${line}`)
    const key = line.slice(0, separator)
    assert.equal(values.has(key), false, `duplicate environment key: ${key}`)
    values.set(key, line.slice(separator + 1))
  }
  return values
}

test('all Admin retention mutation switches remain explicitly disabled', () => {
  const environment = parseEnvironmentExample(read('deploy/iso/env/admin.env.example'))
  const disabled = [
    'GAIOP_ADMIN_RETENTION_AUTO_DELETE',
    'GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED',
    'GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED',
    'GAIOP_REPORT_RETENTION_AUTO_PROCESS',
    'GAIOP_SESSION_RETENTION_AUTO_MARK',
    'GAIOP_SESSION_RETENTION_AUTO_DELETE',
  ]
  for (const key of disabled) assert.equal(environment.get(key), 'false', key)
})

test('retention routes and migrations each have one non-overlapping registration', () => {
  const indexSource = read('server/index.js')
  const databaseSource = read('server/database.js')
  const routes = [
    "app.use('/api/reports'",
    "app.use('/api/session-retention'",
    "app.use('/api/system/storage-watermarks'",
  ]
  for (const route of routes) assert.equal(indexSource.split(route).length - 1, 1, route)

  const migrations = [
    'migrateReportRetention(db)',
    'migrateSessionRetentionTables(db)',
    'migrateStorageWatermarkTables(db)',
  ]
  for (const migration of migrations) assert.equal(databaseSource.split(migration).length - 1, 1, migration)
})

test('every Admin retention service, timer and runtime script is uniquely packaged', () => {
  const releaseManifest = read('deploy/iso/release-manifest.example.yaml')
  assert.match(releaseManifest, /^      - server\/report-registry-sync\.js$/m)
  const units = [
    ['gaiop-admin-retention-cleanup', 'server/admin-retention-cleanup.js'],
    ['gaiop-report-retention-cleanup', 'server/report-retention-cleanup.js'],
    ['gaiop-admin-session-retention', 'server/session-retention-cleanup.js'],
    ['gaiop-admin-sqlite-backup', 'server/sqlite-backup.js'],
    ['gaiop-storage-watermark-monitor', 'server/storage-watermark-monitor.js'],
  ]
  const execTargets = new Set()
  for (const [name, script] of units) {
    const servicePath = `deploy/systemd/${name}.service`
    const timerPath = `deploy/systemd/${name}.timer`
    assert.equal(existsSync(path.join(repositoryRoot, servicePath)), true, servicePath)
    assert.equal(existsSync(path.join(repositoryRoot, timerPath)), true, timerPath)
    assert.equal(existsSync(path.join(repositoryRoot, script)), true, script)

    const service = read(servicePath)
    const timer = read(timerPath)
    const execMatch = service.match(/^ExecStart=\/usr\/local\/bin\/node \/opt\/gaiop\/admin\/(.+)$/m)
    assert.ok(execMatch, `${servicePath} must have a fixed Node entry point`)
    assert.equal(execMatch[1], script)
    assert.equal(execTargets.has(execMatch[1]), false, `duplicate ExecStart: ${execMatch[1]}`)
    execTargets.add(execMatch[1])
    assert.match(timer, new RegExp(`^Unit=${name}\\.service$`, 'm'))
    assert.match(timer, /^Persistent=true$/m)
    assert.match(releaseManifest, new RegExp(`- ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(releaseManifest, new RegExp(`source: GAIOP-Admin/deploy/systemd/${name}\\.service$`, 'm'))
    assert.match(releaseManifest, new RegExp(`source: GAIOP-Admin/deploy/systemd/${name}\\.timer$`, 'm'))
  }

  assert.match(releaseManifest, /^      - server\/sqlite-restore-test\.js$/m)
  assert.match(releaseManifest, /^      - deploy\/iso\/storage-watermark\/managed-roots\.json$/m)
})

test('Upgrade retention production enablement repairs the live unit before starting its timer', () => {
  const wrapper = read('scripts/Invoke-237RetentionClosedRelease.ps1')
  const runner = read('scripts/gateway237-retention-closed-release.cjs')

  assert.match(wrapper, /repair-enable-upgrade-retention/)
  assert.match(wrapper, /UpgradeSourceRootPath/)
  assert.match(runner, /function upgradeRetentionRepairEnableScript\(expectedHashes\)/)
  assert.match(runner, /function runValidatedSudoScript\(client, script\)[\s\S]+bash -n "\$script_path"/)
  assert.match(runner, /runValidatedSudoScript\(client, upgradeRetentionRepairEnableScript\(expectedHashes\)\)/)
  assert.match(runner, /if \(mode === 'repair-enable-upgrade-retention'\)/)
  assert.match(runner, /EnvironmentFile=\nEnvironmentFile=\$main_env\nEnvironmentFile=\$policy_env/)
  assert.match(runner, /ExecStart=\nExecStart=\/usr\/local\/bin\/node \$current_root\/src\/retention-cleanup\.js/)
  assert.match(runner, /ReadWritePaths=\nReadWritePaths=\/var\/lib\/gaiop-upgrade\nReadWritePaths=\/var\/lib\/gaiop-upgrade-retention\nReadWritePaths=\/var\/backups\/gaiop\/upgrade\nReadWritePaths=\/run\/gaiop-upgrade-retention/)
  assert.match(runner, /write_policy false[\s\S]+run_and_validate closed[\s\S]+write_policy true[\s\S]+run_and_validate enabled[\s\S]+systemctl enable --now "\$timer"/)
  assert.match(runner, /_SYSTEMD_INVOCATION_ID="\$invocation"/)
  assert.match(runner, /records\.length !== 3/)
  assert.match(runner, /records\.length !== 6/)
  assert.match(runner, /candidateCount !== 0/)
  assert.match(runner, /systemctl disable --now "\$timer"[\s\S]+original-dropin\.conf[\s\S]+original-policy\.policy/)

  const enablement = runner.slice(
    runner.indexOf('function upgradeRetentionRepairEnableScript(expectedHashes)'),
    runner.indexOf('async function repairEnableUpgradeRetention'),
  )
  assert.match(enablement, /seq 1 960/)
  assert.match(enablement, /effective_environment_files=\$\(systemctl show "\$service" -p EnvironmentFiles --value\)/)
  assert.match(enablement, /if printf '%s\\n' "\$effective_environment_files" \| grep -F -- '\/etc\/gaiop\/upgrade\.env'[\s\S]+return 1/)
  assert.match(enablement, /cmp -s "\$work_root\/99-gaiop-retention-production\.conf" "\$dropin_file"/)
  assert.match(enablement, /assert_managed_snapshot_unchanged\(\)[\s\S]+selected: value\.database\.selected[\s\S]+roots: value\.roots/)
  assert.match(enablement, /journal_cursor\(\)[\s\S]+--show-cursor/)
  assert.match(enablement, /--after-cursor="\$cursor" --unit="\$service"/)
  assert.match(enablement, /journal_policy_record_count\(\)[\s\S]+value\.phase === "completed"/)
  assert.match(enablement, /timer_cursor=\$\(journal_cursor\)[\s\S]+journal_policy_record_count "\$timer_cursor"/)
  assert.doesNotMatch(enablement, /manual_invocation=/)
  assert.doesNotMatch(enablement, /test "\$before_snapshot" =/)
  assert.match(enablement, /test "\$\(systemctl show "\$service" -p ReadWritePaths --value\)" = '\/var\/lib\/gaiop-upgrade \/var\/lib\/gaiop-upgrade-retention \/var\/backups\/gaiop\/upgrade \/run\/gaiop-upgrade-retention'/)
  assert.match(enablement, /test "\$\(systemctl is-active "\$service"[^\n]+" = inactive/)
  assert.match(enablement, /expected_retention_runner[\s\S]+sha256sum "\$current_root\/src\/services\/RetentionRunner\.js"/)
  assert.match(enablement, /expected_retention_qualification[\s\S]+sha256sum "\$current_root\/src\/services\/RetentionQualification\.js"/)
  assert.match(enablement, /expected_database_connection[\s\S]+sha256sum "\$current_root\/src\/database\/connection\.js"/)
  assert.match(enablement, /expected_config[\s\S]+sha256sum "\$current_root\/src\/config\.js"/)
  assert.match(enablement, /expected_timer_unit[\s\S]+sed 's\/\\r\$\/\/' "\$timer_file"/)
  assert.match(enablement, /service_template_b64[\s\S]+cmp -s "\$work_root\/expected-cleanup\.service"/)
  assert.match(enablement, /test ! -L "\$audit_log"/)
  assert.match(enablement, /audit_root=\/var\/lib\/gaiop-upgrade-retention/)
  assert.match(enablement, /verify_trusted_tree "\$trusted_tree"/)
  assert.match(enablement, /code-permissions-before[\s\S]+chmod go-w/)
  assert.match(enablement, /rollback_ok=1[\s\S]+systemctl stop "\$service"[\s\S]+unit_shape/)
  assert.match(enablement, /ROLLBACK_COMPLETE=0/)
  assert.match(runner, /function upgradeRetentionPostcheckRollbackScript\(\)/)
  assert.match(runner, /POSTCHECK_ROLLBACK_COMPLETE=1/)

  const upgradeDeployment = runner.slice(
    runner.indexOf('function upgradeDeploymentScript'),
    runner.indexOf('async function deployUpgrade'),
  )
  assert.match(upgradeDeployment, /systemctl disable --now "\$retention_timer"/)
  assert.match(upgradeDeployment, /restore_retention_timer/)
  assert.match(upgradeDeployment, /verify_retention_unit/)
  assert.doesNotMatch(upgradeDeployment, /systemctl start gaiop-upgrade-retention-cleanup\.service/)
  assert.doesNotMatch(enablement, /(?:cat|sed)\s+[^\n]*\$main_env/)
  assert.doesNotMatch(enablement, /grep\s+-E\s+[^\n]*\$main_env/)
  assert.doesNotMatch(enablement, /\.env[^\n]*base64/)
})
