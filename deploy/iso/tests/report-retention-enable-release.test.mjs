import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const read = (name) => readFileSync(join(root, name), 'utf8')
const powershell = read('scripts/Invoke-237RetentionClosedRelease.ps1')
const runner = read('scripts/gateway237-retention-closed-release.cjs')
const release = read('scripts/gateway237-report-retention-enable.sh')
const policy = read('deploy/iso/env/report-retention.policy.example')

test('controlled entry requires a verified Admin report retention source', () => {
  assert.match(powershell, /'enable-report-retention'/)
  assert.match(powershell, /AdminSourceRootPath/)
  for (const required of [
    'server\\report-retention-cleanup.js',
    'server\\report-retention-service.js',
    'server\\lib\\report-retention-schema.js',
    'server\\lib\\report-storage-path.js',
    'deploy\\systemd\\gaiop-report-retention-cleanup.service',
    'deploy\\systemd\\gaiop-report-retention-cleanup.timer',
    'deploy\\iso\\env\\report-retention.policy.example',
  ]) assert.ok(powershell.includes(required), required)
  assert.match(runner, /if \(mode === 'enable-report-retention'\)/)
  assert.match(runner, /runValidatedSudoScript\(client, reportRetentionReleaseScript\('enable', expected\)\)/)
})

test('independent policy contains only the six approved report settings', () => {
  const keys = policy.trim().split(/\r?\n/).map((line) => line.slice(0, line.indexOf('=')))
  assert.deepEqual(keys, [
    'GAIOP_ADMIN_DATA_DIR',
    'GAIOP_REPORTS_DIR',
    'GAIOP_REPORT_RECOVERY_DIR',
    'GAIOP_REPORT_RETENTION_LOCK_PATH',
    'GAIOP_REPORT_RETENTION_MAX_ITEMS',
    'GAIOP_REPORT_RETENTION_AUTO_PROCESS',
  ])
  assert.match(release, /EnvironmentFile=\nEnvironmentFile=\/etc\/gaiop\/report-retention\.policy/)
  assert.match(release, /InaccessiblePaths=-\/etc\/gaiop\/admin\.env/)
  assert.doesNotMatch(release, /(?:cat|sed)[^\n]*\/etc\/gaiop\/admin\.env/)
})

test('enablement gates candidates before writes and pauses on permanent deletion or anomalies', () => {
  const inspection = release.indexOf('initial_inspection_b64=$(inspect_report_state')
  const capture = release.indexOf('phase=capture')
  assert.ok(inspection >= 0 && capture > inspection)
  assert.match(release, /if \[ "\$permanent_count" -ne 0 \]; then phase=permanent_delete_confirmation_required; exit 81; fi/)
  assert.match(release, /if \[ "\$anomaly_count" -ne 0 \]; then phase=report_retention_anomaly_gate; exit 82; fi/)
  assert.match(release, /protectedUnknownReports/)
  assert.match(release, /candidateAnomalies/)
  assert.match(release, /unknownRecoveryFiles/)
  assert.match(release, /registered_path_symlink/)
  assert.match(release, /report_size_mismatch/)
  assert.match(release, /audit_pair_mismatch/)
  assert.match(release, /delivery_pair_mismatch/)
  assert.match(release, /file_not_expired/)
  assert.match(release, /artifact_owner_invalid/)
  assert.match(release, /phase=preflight_paths/)
  assert.match(release, /FAILED_STATUS/)
  assert.match(release, /FAILED_DETAIL_B64/)
  assert.match(release, /SOURCE_PERMISSIONS_B64/)
  assert.match(release, /capture_source_modes "\$\{trusted_sources\[@\]\}"/)
  assert.match(release, /phase=harden_source_permissions[\s\S]+chmod go-w -- "\$\{trusted_sources\[@\]\}"/)
  assert.match(runner, /remoteExitCode: remote\.exitCode/)
  assert.match(runner, /remoteStatus: values\.FAILED_STATUS/)
  assert.match(runner, /failureDetail: parseBase64Json\(values\.FAILED_DETAIL_B64/)
  assert.match(runner, /before: parseBase64Json\(values\.SOURCE_PERMISSIONS_B64/)
  assert.match(runner, /after: parseBase64Json\(values\.SOURCE_PERMISSIONS_AFTER_B64/)
  assert.match(runner, /key\.endsWith\('_SHA256'\)/)
  assert.match(powershell, /if \(\$Mode -eq 'enable-report-retention'\)[\s\S]+ConvertTo-Json -Depth 12/)
})

test('release uses an online safety backup, a disabled one-shot, batch one and formal limit fifty', () => {
  assert.match(release, /phase=database_safety_backup/)
  assert.match(release, /await live\.backup\(destination\)/)
  assert.match(release, /pragma\('integrity_check'\)/)
  assert.match(release, /write_policy 1 false[\s\S]+run_report_service auto_process_disabled/)
  assert.match(release, /test "\$disabled_before_b64" = "\$disabled_after_b64"/)
  assert.match(release, /write_policy 1 true[\s\S]+validate_transition [^\n]+ 1 /)
  assert.match(release, /write_policy 50 true[\s\S]+systemctl enable --now "\$report_timer"/)
  assert.match(release, /run_report_service completed "\$work_root\/manual\.json"/)
  assert.match(release, /systemd-analyze verify "\$service_file" "\$timer_file"/)
})

test('directory, service and existing timer boundaries are verified without restarting protected services', () => {
  assert.match(release, /stat -c '%d' "\$report_root"/)
  assert.match(release, /realpath -e "\$recovery_root"/)
  assert.match(release, /runuser -u gaiop -- test -w "\$report_root"/)
  assert.match(release, /gaiop-admin-retention-cleanup\.timer[^\n]+ = 'active\|enabled'/)
  assert.match(release, /gaiop-admin-session-retention\.timer[^\n]+ = 'inactive\|disabled'/)
  assert.match(release, /GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false/)
  assert.match(release, /GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED=false/)
  assert.doesNotMatch(release, /systemctl restart (?:gaiop-admin|gaiop-upgrade|caddy)/)
  assert.doesNotMatch(release, /systemctl --user restart openclaw-gateway/)
})

test('failure rollback restores controlled configuration but never restores the database or deletes reports', () => {
  assert.match(release, /restore_file "\$service_file" report\.service/)
  assert.match(release, /restore_file "\$timer_file" report\.timer/)
  assert.match(release, /restore_file "\$dropin_file" report\.dropin/)
  assert.match(release, /restore_file "\$policy_file" report\.policy/)
  assert.match(release, /restore_source_modes/)
  assert.match(release, /BACKUP_EVIDENCE_PRESERVED/)
  assert.doesNotMatch(release, /(?:cp|mv|install)[^\n]*wizard\.db\.before-enable[^\n]*\$admin_db/)
  assert.doesNotMatch(release, /rm -rf -- "\$(?:report_root|recovery_root)"/)
  assert.doesNotMatch(release, /unlinkSync|\.unlink\(/)
  assert.match(runner, /reportRetentionPostcheckRollbackScript/)
  assert.match(runner, /REPORT_RETENTION_PERMANENT_DELETE_CONFIRMATION_REQUIRED/)
})
