'use strict'

const { createHash } = require('node:crypto')
const { createReadStream, readFileSync } = require('node:fs')
const https = require('node:https')
const { join } = require('node:path')
const { Client } = require('ssh2')

const mode = String(process.env.GAIOP_RETENTION_RELEASE_MODE || '').trim()
const releaseId = String(process.env.GAIOP_RETENTION_RELEASE_ID || '').trim()
const adminArchive = String(process.env.GAIOP_RETENTION_RELEASE_ADMIN_ARCHIVE || '').trim()
const upgradeArchive = String(process.env.GAIOP_RETENTION_RELEASE_UPGRADE_ARCHIVE || '').trim()
const watermarkArchive = String(process.env.GAIOP_RETENTION_RELEASE_WATERMARK_ARCHIVE || '').trim()
const adminSourceRoot = String(process.env.GAIOP_RETENTION_RELEASE_ADMIN_SOURCE_ROOT || '').trim()
const upgradeSourceRoot = String(process.env.GAIOP_RETENTION_RELEASE_UPGRADE_SOURCE_ROOT || '').trim()
const connection = {
  host: String(process.env.GAIOP_RETENTION_RELEASE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_RETENTION_RELEASE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_RETENTION_RELEASE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!['preflight', 'verify-units', 'deploy-upgrade', 'deploy-admin', 'diagnose-admin', 'close-disabled-timers', 'verify-watermark', 'inspect-watermark-filesystems', 'deploy-watermark-probes', 'verify-enable-watermark', 'observe-watermark', 'rollback-watermark', 'repair-enable-upgrade-retention', 'enable-sqlite-backups'].includes(mode)) {
  throw new Error('The controlled retention release mode is not available.')
}
if (mode === 'verify-units'
  && (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !adminArchive || !upgradeArchive)) {
  throw new Error('The controlled unit verification inputs are incomplete.')
}
if (mode === 'deploy-upgrade'
  && (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !upgradeArchive)) {
  throw new Error('The controlled Upgrade deployment inputs are incomplete.')
}
if (mode === 'deploy-admin'
  && (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !adminArchive)) {
  throw new Error('The controlled Admin deployment inputs are incomplete.')
}
if (mode === 'diagnose-admin' && !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The controlled Admin diagnosis inputs are incomplete.')
}
if (['deploy-watermark-probes', 'verify-enable-watermark', 'observe-watermark', 'rollback-watermark'].includes(mode)
  && !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The storage watermark filesystem release inputs are incomplete.')
}
if (mode === 'repair-enable-upgrade-retention' && !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The Upgrade retention enablement inputs are incomplete.')
}
if (mode === 'repair-enable-upgrade-retention' && !upgradeSourceRoot) {
  throw new Error('The verified Upgrade retention source is incomplete.')
}
if (mode === 'enable-sqlite-backups'
  && (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !adminSourceRoot || !upgradeSourceRoot)) {
  throw new Error('The SQLite backup enablement inputs are incomplete.')
}
if (mode === 'deploy-watermark-probes' && !watermarkArchive) {
  throw new Error('The storage watermark probe archive is incomplete.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled retention release connection is incomplete.')
}

const preflightScript = String.raw`set -eu
admin_root=/opt/gaiop/admin
admin_db=/var/lib/gaiop/admin/wizard.db
upgrade_root=$(systemctl show gaiop-upgrade.service -p WorkingDirectory --value 2>/dev/null || true)
case "$upgrade_root" in
  /opt/gaiop/*|/opt/gaiop-*) ;;
  *) upgrade_root=unknown ;;
esac

upgrade_db=unknown
for candidate in \
  /var/lib/gaiop-upgrade/napm-upgrade.db \
  /var/lib/gaiop-upgrade/upgrade.db \
  /var/lib/gaiop/upgrade/upgrade.db \
  /var/lib/gaiop/upgrade/napm-upgrade.db
do
  if [ -f "$candidate" ]; then
    upgrade_db="$candidate"
    break
  fi
done

service_state() {
  systemctl is-active "$1" 2>/dev/null || true
}

timer_state() {
  unit="$1"
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || printf '000'
}

directory_count() {
  target="$1"
  if [ ! -d "$target" ]; then
    printf 'missing'
    return
  fi
  find "$target" -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]'
}

tree_hash() {
  root="$1"
  shift
  if [ ! -d "$root" ]; then
    printf 'missing'
    return
  fi
  (
    cd "$root"
    find "$@" -type f -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}'
  )
}

database_summary() {
  module_root="$1"
  database="$2"
  selected="$3"
  if [ ! -f "$database" ] || [ ! -d "$module_root" ]; then
    printf 'eyJpbnRlZ3JpdHkiOiJ1bmF2YWlsYWJsZSIsInRvdGFsUm93cyI6bnVsbCwic2VsZWN0ZWQiOnt9fQ=='
    return
  fi
  /usr/local/bin/node - "$module_root" "$database" "$selected" <<'NODE' | base64 -w 0
const [moduleRoot, databasePath, selectedCsv] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const integrity = db.pragma('integrity_check', { simple: true })
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  let totalRows = 0
  const counts = new Map()
  for (const { name } of tables) {
    const quoted = '"' + String(name).replaceAll('"', '""') + '"'
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
    counts.set(name, count)
    totalRows += count
  }
  const selected = Object.fromEntries(selectedCsv.split(',').map((name) => [name, counts.get(name) ?? null]))
  process.stdout.write(JSON.stringify({ integrity, totalRows, selected }))
} finally {
  db.close()
}
NODE
}

managed_roots=$(runuser -u gaiop -- /usr/local/bin/node - <<'NODE' | base64 -w 0
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const roots = [
  ['admin_state', '/var/lib/gaiop/admin'],
  ['runtime_state', '/var/lib/gaiop/runtime'],
  ['formal_reports', '/var/lib/gaiop/reports'],
  ['upgrade_state', '/var/lib/gaiop-upgrade'],
  ['upgrade_rollback', '/var/backups/gaiop/upgrade'],
  ['admin_upgrade_staging', '/opt/gaiop/admin/data/upgrade-upload-staging'],
  ['gateway_state', '/home/netinside/.openclaw'],
  ['raw_syslog', '/var/log/netinside'],
  ['caddy_access_logs', '/var/log/caddy'],
]
const classify = (error, operation) => {
  if (error?.code === 'ENOENT') return 'managed_root_not_found'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'managed_root_permission_denied'
  return operation === 'statfs' ? 'managed_root_statfs_failed' : 'managed_root_stat_failed'
}
const classifyUsage = (used, available) => {
  const denominator = used + available
  if (denominator <= 0n) return 'unknown'
  if (used * 100n >= denominator * 90n) return 'emergency'
  if (used * 100n >= denominator * 80n) return 'cleanup_required'
  if (used * 100n >= denominator * 75n) return 'warning'
  return 'normal'
}
const result = []
for (const [label, path] of roots) {
  let stat
  try {
    stat = fs.statSync(path, { bigint: true })
    if (!stat.isDirectory()) throw Object.assign(new Error('not-directory'), { code: 'ENOTDIR' })
  } catch (error) {
    result.push({ label, status: 'unknown', reasonCode: classify(error, 'stat'), filesystemId: null })
    continue
  }
  try {
    const statfs = fs.statfsSync(path, { bigint: true })
    const used = statfs.blocks - statfs.bfree
    const denominator = used + statfs.bavail
    const basisPoints = denominator > 0n ? Number((used * 10000n) / denominator) : null
    const filesystemId = 'fs-' + createHash('sha256')
      .update('gaiop-storage:' + stat.dev.toString())
      .digest('hex')
      .slice(0, 20)
    result.push({
      label,
      status: classifyUsage(used, statfs.bavail),
      reasonCode: 'ok',
      filesystemId,
      usagePercent: basisPoints === null ? null : basisPoints / 100,
    })
  } catch (error) {
    result.push({ label, status: 'unknown', reasonCode: classify(error, 'statfs'), filesystemId: null })
  }
}
process.stdout.write(JSON.stringify(result))
NODE
)

admin_summary=$(database_summary "$admin_root/node_modules/better-sqlite3" "$admin_db" 'users,workspace_sessions,report_files,report_deliveries,audit_logs')
if [ "$upgrade_root" != unknown ]; then
  upgrade_module="$upgrade_root/node_modules/better-sqlite3"
else
  upgrade_module=unknown
fi
upgrade_summary=$(database_summary "$upgrade_module" "$upgrade_db" 'upgrade_tasks,backups,components')

gateway_uid=$(id -u netinside)
gateway_state=$(runuser -u netinside -- env XDG_RUNTIME_DIR="/run/user/$gateway_uid" systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)
admin_listener=$(ss -ltnH 'sport = :3000' 2>/dev/null | awk '{print $4}' | head -n 1)
upgrade_listener=$(ss -ltnH 'sport = :18900' 2>/dev/null | awk '{print $4}' | head -n 1)

printf 'UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'ADMIN_ROOT=%s\n' "$admin_root"
printf 'ADMIN_HASH=%s\n' "$(tree_hash "$admin_root" server dist package.json package-lock.json)"
printf 'ADMIN_DB=%s\n' "$admin_db"
printf 'ADMIN_DB_SUMMARY_B64=%s\n' "$admin_summary"
printf 'UPGRADE_ROOT=%s\n' "$upgrade_root"
if [ "$upgrade_root" != unknown ]; then
  printf 'UPGRADE_HASH=%s\n' "$(tree_hash "$upgrade_root" src package.json package-lock.json)"
else
  printf 'UPGRADE_HASH=unknown\n'
fi
printf 'UPGRADE_DB=%s\n' "$upgrade_db"
printf 'UPGRADE_DB_SUMMARY_B64=%s\n' "$upgrade_summary"
printf 'ADMIN_SERVICE=%s\n' "$(service_state gaiop-admin.service)"
printf 'UPGRADE_SERVICE=%s\n' "$(service_state gaiop-upgrade.service)"
printf 'GATEWAY_SERVICE=%s\n' "$gateway_state"
printf 'CADDY_SERVICE=%s\n' "$(service_state caddy.service)"
printf 'ADMIN_LISTENER=%s\n' "$admin_listener"
printf 'UPGRADE_LISTENER=%s\n' "$upgrade_listener"
printf 'ADMIN_HEALTH=%s\n' "$(http_status http://127.0.0.1:3000/api/health)"
printf 'ADMIN_ROOT_HTTP=%s\n' "$(http_status http://127.0.0.1:3000/)"
printf 'UPGRADE_HEALTH=%s\n' "$(http_status http://127.0.0.1:18900/health)"
printf 'UPGRADE_UNAUTH=%s\n' "$(http_status http://127.0.0.1:18900/api/v1/upgrade/status)"
printf 'GATEWAY_HEALTH=%s\n' "$(http_status http://127.0.0.1:18789/health)"
printf 'HTTPS_LOOPBACK=%s\n' "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/ 2>/dev/null || printf '000')"
printf 'ADMIN_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-retention-cleanup.timer)"
printf 'UPGRADE_RETENTION_TIMER=%s\n' "$(timer_state gaiop-upgrade-retention-cleanup.timer)"
printf 'REPORT_RETENTION_TIMER=%s\n' "$(timer_state gaiop-report-retention-cleanup.timer)"
printf 'SESSION_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-session-retention.timer)"
printf 'ADMIN_SQLITE_TIMER=%s\n' "$(timer_state gaiop-admin-sqlite-backup.timer)"
printf 'UPGRADE_SQLITE_TIMER=%s\n' "$(timer_state gaiop-upgrade-sqlite-backup.timer)"
printf 'WATERMARK_TIMER=%s\n' "$(timer_state gaiop-storage-watermark-monitor.timer)"
printf 'PROVENANCE_COUNT=%s\n' "$(directory_count /var/lib/gaiop/runtime/report-provenance)"
printf 'ADMIN_STAGING_COUNT=%s\n' "$(directory_count /opt/gaiop/admin/data/upgrade-upload-staging)"
printf 'UPGRADE_PACKAGES_COUNT=%s\n' "$(directory_count /var/lib/gaiop-upgrade/packages)"
printf 'UPGRADE_STAGING_COUNT=%s\n' "$(directory_count /var/lib/gaiop-upgrade/staging)"
printf 'UPGRADE_ROLLBACK_COUNT=%s\n' "$(directory_count /var/backups/gaiop/upgrade)"
printf 'FORMAL_REPORT_COUNT=%s\n' "$(directory_count /var/lib/gaiop/reports)"
printf 'MANAGED_ROOTS_B64=%s\n' "$managed_roots"
printf 'DISK_USE=%s\n' "$(df -P /var/lib/gaiop/admin | awk 'NR == 2 {print $5}')"
printf 'RECENT_RETENTION_BACKUP=%s\n' "$(find /var/backups/gaiop/deployments -mindepth 1 -maxdepth 1 -type d -name 'retention-*' -printf '%f\n' 2>/dev/null | LC_ALL=C sort | tail -n 1)"
printf 'SYSTEMD_VERSION=%s\n' "$(systemd-analyze --version | head -n 1)"
`

function runSudoScript(client, script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output, exitCode }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function runValidatedSudoScript(client, script) {
  const payload = Buffer.from(script, 'utf8').toString('base64')
  return runSudoScript(client, String.raw`set -euo pipefail
script_path=$(mktemp /run/gaiop-retention-release.XXXXXX)
cleanup() { rm -f -- "$script_path"; }
trap cleanup EXIT
base64 -d > "$script_path" <<'GAIOP_RETENTION_SCRIPT'
${payload}
GAIOP_RETENTION_SCRIPT
chmod 0700 "$script_path"
bash -n "$script_path"
bash "$script_path"
`)
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function sha256NormalizedText(filePath) {
  return createHash('sha256')
    .update(readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex')
}

function upload(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error)
      sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (putError) => {
        sftp.end()
        putError ? reject(putError) : resolve()
      })
    })
  })
}

function unitVerificationScript({ remoteAdmin, remoteUpgrade, adminSha, upgradeSha }) {
  return String.raw`set -euo pipefail
stage_root='/tmp/gaiop-retention-unit-verify-${releaseId}'
admin_archive='${remoteAdmin}'
upgrade_archive='${remoteUpgrade}'
admin_sha='${adminSha}'
upgrade_sha='${upgradeSha}'
cleanup() {
  rm -rf -- "$stage_root"
  rm -f -- "$admin_archive" "$upgrade_archive"
}
trap cleanup EXIT

test ! -e "$stage_root"
test "$(sha256sum -- "$admin_archive" | awk '{print $1}')" = "$admin_sha"
test "$(sha256sum -- "$upgrade_archive" | awk '{print $1}')" = "$upgrade_sha"
install -d -o root -g root -m 0700 "$stage_root/admin" "$stage_root/upgrade" "$stage_root/units"
tar -xzf "$admin_archive" -C "$stage_root/admin" --no-same-owner
tar -xzf "$upgrade_archive" -C "$stage_root/upgrade" --no-same-owner

test -f "$stage_root/admin/dist/index.html"
test -f "$stage_root/admin/server/index.js"
test -f "$stage_root/admin/package.json"
test -f "$stage_root/admin/package-lock.json"
test -f "$stage_root/admin/server/storage-watermark-monitor.js"
test -f "$stage_root/upgrade/src/index.js"
test -f "$stage_root/upgrade/src/sqlite-backup.js"
test -f "$stage_root/upgrade/package.json"
test -f "$stage_root/upgrade/package-lock.json"
/usr/local/bin/node --check "$stage_root/admin/server/index.js"
/usr/local/bin/node --check "$stage_root/admin/server/storage-watermark-monitor.js"
/usr/local/bin/node --check "$stage_root/upgrade/src/index.js"
/usr/local/bin/node --check "$stage_root/upgrade/src/sqlite-backup.js"

for name in \
  gaiop-report-retention-cleanup.service \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.service \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.service \
  gaiop-admin-sqlite-backup.timer \
  gaiop-storage-watermark-monitor.service \
  gaiop-storage-watermark-monitor.timer
do
  sed "s#/opt/gaiop/admin#$stage_root/admin#g" \
    "$stage_root/admin/deploy/systemd/$name" > "$stage_root/units/$name"
done

upgrade_root=$(systemctl show gaiop-upgrade.service -p WorkingDirectory --value)
case "$upgrade_root" in
  /opt/gaiop/*|/opt/gaiop-*) ;;
  *) exit 42 ;;
esac
upgrade_db_root=/var/lib/gaiop-upgrade
sed \
  -e "s#/opt/gaiop/upgrade#$stage_root/upgrade#g" \
  -e "s#/var/lib/gaiop/upgrade#$upgrade_db_root#g" \
  "$stage_root/upgrade/deploy/systemd/gaiop-upgrade-sqlite-backup.service" \
  > "$stage_root/units/gaiop-upgrade-sqlite-backup.service"
cp "$stage_root/upgrade/deploy/systemd/gaiop-upgrade-sqlite-backup.timer" \
  "$stage_root/units/gaiop-upgrade-sqlite-backup.timer"

verify_log="$stage_root/systemd-verify.log"
if ! systemd-analyze verify "$stage_root/units"/*.service "$stage_root/units"/*.timer >"$verify_log" 2>&1; then
  printf 'NATIVE_VERIFY=failed\n'
  exit 43
fi
printf 'NATIVE_VERIFY=ok\n'
printf 'ADMIN_ARCHIVE_SHA=%s\n' "$admin_sha"
printf 'UPGRADE_ARCHIVE_SHA=%s\n' "$upgrade_sha"
printf 'ADMIN_SERVER_FILES=%s\n' "$(find "$stage_root/admin/server" -type f -printf x | wc -c | tr -d '[:space:]')"
printf 'ADMIN_DIST_FILES=%s\n' "$(find "$stage_root/admin/dist" -type f -printf x | wc -c | tr -d '[:space:]')"
printf 'UPGRADE_SRC_FILES=%s\n' "$(find "$stage_root/upgrade/src" -type f -printf x | wc -c | tr -d '[:space:]')"
`
}

async function verifyUnits(client) {
  const remoteAdmin = `/tmp/gaiop-admin-retention-${releaseId}.tgz`
  const remoteUpgrade = `/tmp/gaiop-upgrade-retention-${releaseId}.tgz`
  const [adminSha, upgradeSha] = await Promise.all([
    sha256(adminArchive),
    sha256(upgradeArchive),
  ])
  await upload(client, adminArchive, remoteAdmin)
  await upload(client, upgradeArchive, remoteUpgrade)
  const remote = await runSudoScript(client, unitVerificationScript({
    remoteAdmin,
    remoteUpgrade,
    adminSha,
    upgradeSha,
  }))
  const values = parseKeyValues(remote.output)
  return {
    completed: remote.ok && values.NATIVE_VERIFY === 'ok',
    mode: 'verify-units',
    nativeSystemdVerify: values.NATIVE_VERIFY || 'failed',
    archiveHashes: {
      admin: values.ADMIN_ARCHIVE_SHA || adminSha,
      upgrade: values.UPGRADE_ARCHIVE_SHA || upgradeSha,
    },
    packageCounts: {
      adminServerFiles: Number(values.ADMIN_SERVER_FILES || 0),
      adminDistFiles: Number(values.ADMIN_DIST_FILES || 0),
      upgradeSrcFiles: Number(values.UPGRADE_SRC_FILES || 0),
    },
  }
}

function upgradeDeploymentScript({ remoteUpgrade, upgradeSha }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
archive='${remoteUpgrade}'
expected_sha='${upgradeSha}'
current_root=$(systemctl show gaiop-upgrade.service -p WorkingDirectory --value)
case "$current_root" in
  /opt/gaiop/*|/opt/gaiop-*) ;;
  *) printf 'FAILED_PHASE=invalid_working_directory\n'; exit 41 ;;
esac
stage_root="/opt/gaiop-upgrade-retention-stage-$release_id"
backup_root="/var/backups/gaiop/deployments/upgrade-retention-$release_id"
database=unknown
for candidate in \
  /var/lib/gaiop-upgrade/napm-upgrade.db \
  /var/lib/gaiop-upgrade/upgrade.db \
  /var/lib/gaiop/upgrade/upgrade.db \
  /var/lib/gaiop/upgrade/napm-upgrade.db
do
  if [ -f "$candidate" ]; then database="$candidate"; break; fi
done
test "$database" != unknown
database_root=$(dirname "$database")
database_backup="$backup_root/$(basename "$database").before-release"
sqlite_service=/etc/systemd/system/gaiop-upgrade-sqlite-backup.service
sqlite_timer=/etc/systemd/system/gaiop-upgrade-sqlite-backup.timer
retention_service=gaiop-upgrade-retention-cleanup.service
retention_timer=gaiop-upgrade-retention-cleanup.timer
retention_dropin=/etc/systemd/system/gaiop-upgrade-retention-cleanup.service.d/99-gaiop-retention-production.conf
retention_policy=/etc/gaiop/upgrade-retention.policy
phase=precheck
mutation_started=0
complete=0
retention_timer_captured=0
original_retention_timer_active=unknown
original_retention_timer_enabled=unknown

cleanup_transfer() {
  rm -f -- "$archive"
  rm -rf -- "$stage_root"
}

retention_timer_state() {
  active=$(systemctl is-active "$retention_timer" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$retention_timer" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

verify_retention_unit() {
  test "$(systemctl show "$retention_service" -p WorkingDirectory --value)" = "$current_root"
  test "$(systemctl show "$retention_service" -p DropInPaths --value)" = "$retention_dropin"
  retention_exec=$(systemctl show "$retention_service" -p ExecStart --value)
  test "$(printf '%s' "$retention_exec" | grep -o 'path=' | wc -l | tr -d '[:space:]')" = 1
  test "$(printf '%s' "$retention_exec" | grep -o 'argv\[\]=' | wc -l | tr -d '[:space:]')" = 1
  printf '%s' "$retention_exec" | grep -F -- 'path=/usr/local/bin/node' >/dev/null
  printf '%s' "$retention_exec" | grep -F -- "argv[]=/usr/local/bin/node $current_root/src/retention-cleanup.js ;" >/dev/null
  main_env=$(systemctl show gaiop-upgrade.service -p EnvironmentFiles --value | grep -oE '/etc/[A-Za-z0-9._/-]+\.env' | awk '/^\/etc\/gaiop-upgrade\// { print; exit }')
  test -n "$main_env"
  test "$(systemctl show "$retention_service" -p EnvironmentFiles --value)" = "$main_env (ignore_errors=no) $retention_policy (ignore_errors=no)"
  test "$(systemctl show "$retention_service" -p ReadWritePaths --value)" = '/var/lib/gaiop-upgrade /var/lib/gaiop-upgrade-retention /var/backups/gaiop/upgrade /run/gaiop-upgrade-retention'
  test -f "$retention_policy"
  test ! -L "$retention_policy"
  test "$(stat -c '%u:%a' "$retention_policy")" = '0:600'
}

restore_retention_timer() {
  if [ "$retention_timer_captured" != 1 ]; then return 0; fi
  systemctl disable --now "$retention_timer" >/dev/null 2>&1 || true
  if [ "$original_retention_timer_enabled" = enabled ]; then systemctl enable "$retention_timer" >/dev/null; fi
  if [ "$original_retention_timer_active" = active ]; then systemctl start "$retention_timer" >/dev/null; fi
  test "$(retention_timer_state)" = "$original_retention_timer_active|$original_retention_timer_enabled"
}

rollback() {
  status=$?
  if [ "$status" -eq 0 ] && [ "$complete" -eq 1 ]; then
    cleanup_transfer
    exit 0
  fi
  printf 'FAILED_PHASE=%s\n' "$phase"
  rollback_ok=1
  set +e
  if [ "$retention_timer_captured" = 1 ]; then
    systemctl disable --now "$retention_timer" >/dev/null 2>&1 || true
    systemctl stop "$retention_service" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      retention_rollback_state=$(systemctl is-active "$retention_service" 2>/dev/null || true)
      case "$retention_rollback_state" in
        active|activating|deactivating) sleep 1 ;;
        *) break ;;
      esac
    done
    [ "$(systemctl is-active "$retention_service" 2>/dev/null || true)" = inactive ] || rollback_ok=0
    [ "$(retention_timer_state)" = 'inactive|disabled' ] || rollback_ok=0
  fi
  if [ "$mutation_started" -eq 1 ] && [ "$rollback_ok" = 1 ]; then
    systemctl stop gaiop-upgrade.service
    [ "$(systemctl is-active gaiop-upgrade.service 2>/dev/null || true)" = inactive ] || rollback_ok=0
    if [ "$rollback_ok" = 1 ]; then
    rm -rf -- "$current_root"
    cp -a -- "$backup_root/service-tree" "$current_root"
    if [ -f "$backup_root/gaiop-upgrade-sqlite-backup.service" ]; then
      cp -a -- "$backup_root/gaiop-upgrade-sqlite-backup.service" "$sqlite_service"
    else
      rm -f -- "$sqlite_service"
    fi
    if [ -f "$backup_root/gaiop-upgrade-sqlite-backup.timer" ]; then
      cp -a -- "$backup_root/gaiop-upgrade-sqlite-backup.timer" "$sqlite_timer"
    else
      rm -f -- "$sqlite_timer"
    fi
    systemctl daemon-reload
    systemctl start gaiop-upgrade.service
    for _ in $(seq 1 30); do
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18900/health 2>/dev/null || true)
      [ "$code" = 200 ] && break
      sleep 1
    done
    if systemctl is-active --quiet gaiop-upgrade.service \
      && [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health 2>/dev/null || true)" = 200 ] \
      && verify_retention_unit; then
      :
    else
      rollback_ok=0
    fi
    fi
  fi
  if [ "$rollback_ok" = 1 ]; then restore_retention_timer || rollback_ok=0; fi
  if [ "$rollback_ok" = 1 ]; then
    printf 'ROLLBACK_COMPLETE=1\n'
  else
    printf 'ROLLBACK_COMPLETE=0\n'
  fi
  set -e
  cleanup_transfer
  exit "$status"
}
trap rollback EXIT

phase=precheck
test "$(systemctl is-active gaiop-upgrade.service)" = active
test ! -e "$stage_root"
test ! -e "$backup_root"
test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_sha"
test -d "$current_root/node_modules/better-sqlite3"
verify_retention_unit
original_retention_timer_active=$(systemctl is-active "$retention_timer" 2>/dev/null || true)
original_retention_timer_enabled=$(systemctl is-enabled "$retention_timer" 2>/dev/null || true)
case "$original_retention_timer_active" in active|inactive) ;; *) exit 44 ;; esac
case "$original_retention_timer_enabled" in enabled|disabled) ;; *) exit 45 ;; esac
retention_timer_captured=1
systemctl disable --now "$retention_timer" >/dev/null
test "$(retention_timer_state)" = 'inactive|disabled'
test "$(systemctl is-active "$retention_service" 2>/dev/null || true)" = inactive

phase=stage
install -d -o root -g root -m 0755 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/src/index.js"
test -f "$stage_root/src/runtime-safety.js"
test -f "$stage_root/src/retention-cleanup.js"
test -f "$stage_root/src/sqlite-backup.js"
test -f "$stage_root/package.json"
test -f "$stage_root/package-lock.json"
if [ -f "$current_root/.env" ]; then cp -a -- "$current_root/.env" "$stage_root/.env"; fi
chown -R root:root "$stage_root"
cd "$stage_root"
npm ci --omit=dev --no-audit --no-fund >/dev/null
npm ls --omit=dev --all >/dev/null
find src -type f -name '*.js' -print0 | xargs -0 -r -n 1 /usr/local/bin/node --check

tree_hash() {
  root="$1"
  (
    cd "$root"
    find src package.json package-lock.json -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
  )
}
staged_source_hash=$(tree_hash "$stage_root")

phase=backup
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$current_root" "$backup_root/service-tree"
cp -a -- /etc/systemd/system/gaiop-upgrade.service "$backup_root/gaiop-upgrade.service"
if [ -f /etc/gaiop/upgrade.env ]; then cp -a -- /etc/gaiop/upgrade.env "$backup_root/upgrade.env"; fi
if [ -f "$sqlite_service" ]; then cp -a -- "$sqlite_service" "$backup_root/gaiop-upgrade-sqlite-backup.service"; fi
if [ -f "$sqlite_timer" ]; then cp -a -- "$sqlite_timer" "$backup_root/gaiop-upgrade-sqlite-backup.timer"; fi

/usr/local/bin/node - "$current_root/node_modules/better-sqlite3" "$database" "$database_backup" <<'NODE'
const [moduleRoot, source, destination] = process.argv.slice(2)
const Database = require(moduleRoot)
;(async () => {
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('source-integrity')
    await db.backup(destination)
  } finally {
    db.close()
  }
  const backup = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup-integrity')
  } finally {
    backup.close()
  }
})().catch(() => process.exit(1))
NODE
test -s "$database_backup"
chmod 0600 "$database_backup"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'

phase=switch
systemctl stop "$retention_service" >/dev/null 2>&1 || true
test "$(systemctl is-active "$retention_service" 2>/dev/null || true)" = inactive
test "$(retention_timer_state)" = 'inactive|disabled'
mutation_started=1
systemctl stop gaiop-upgrade.service
rm -rf -- "$current_root"
mv -- "$stage_root" "$current_root"
chown -R root:root "$current_root"

phase=unit
install -d -o root -g root -m 0700 "$database_root/sqlite-backups" "$database_root/sqlite-restore-tests"
candidate_service=/run/gaiop-upgrade-sqlite-backup.service
sed \
  -e "s#/opt/gaiop/upgrade#$current_root#g" \
  -e "s#/var/lib/gaiop/upgrade#$database_root#g" \
  "$current_root/deploy/systemd/gaiop-upgrade-sqlite-backup.service" > "$candidate_service"
systemd-analyze verify \
  /etc/systemd/system/gaiop-upgrade.service \
  "$candidate_service" \
  "$current_root/deploy/systemd/gaiop-upgrade-sqlite-backup.timer"
install -o root -g root -m 0644 "$candidate_service" "$sqlite_service"
install -o root -g root -m 0644 "$current_root/deploy/systemd/gaiop-upgrade-sqlite-backup.timer" "$sqlite_timer"
rm -f -- "$candidate_service"
systemctl daemon-reload
systemctl disable --now gaiop-upgrade-sqlite-backup.timer >/dev/null 2>&1 || true

phase=start
systemctl start gaiop-upgrade.service
for _ in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18900/health 2>/dev/null || true)
  [ "$code" = 200 ] && break
  sleep 1
done
test "$(systemctl is-active gaiop-upgrade.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/api/v1/upgrade/status)" = 401
test "$(tree_hash "$current_root")" = "$staged_source_hash"

phase=retention_guard
before_packages=$(find /var/lib/gaiop-upgrade/packages -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
before_staging=$(find /var/lib/gaiop-upgrade/staging -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
before_rollback=$(find /var/backups/gaiop/upgrade -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
before_sqlite=$(find "$database_root/sqlite-backups" -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
systemctl start gaiop-upgrade-sqlite-backup.service
after_packages=$(find /var/lib/gaiop-upgrade/packages -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
after_staging=$(find /var/lib/gaiop-upgrade/staging -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
after_rollback=$(find /var/backups/gaiop/upgrade -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
after_sqlite=$(find "$database_root/sqlite-backups" -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
test "$before_packages" = "$after_packages"
test "$before_staging" = "$after_staging"
test "$before_rollback" = "$after_rollback"
test "$before_sqlite" = "$after_sqlite"
verify_retention_unit
test "$(systemctl show gaiop-upgrade-sqlite-backup.service -p Result --value)" = success
test "$(systemctl is-enabled gaiop-upgrade-sqlite-backup.timer 2>/dev/null || true)" != enabled

phase=database_verify
/usr/local/bin/node - "$current_root/node_modules/better-sqlite3" "$database" <<'NODE' | base64 -w 0 > "$backup_root/post-release-db-summary.b64"
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const integrity = db.pragma('integrity_check', { simple: true })
  const selected = {}
  let totalRows = 0
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const quoted = '"' + String(name).replaceAll('"', '""') + '"'
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
    totalRows += count
    if (['upgrade_tasks', 'backups', 'components'].includes(name)) selected[name] = count
  }
  process.stdout.write(JSON.stringify({ integrity, totalRows, selected }))
} finally {
  db.close()
}
NODE
post_summary=$(cat "$backup_root/post-release-db-summary.b64")
rm -f -- "$backup_root/post-release-db-summary.b64"

phase=restore_retention_timer
restore_retention_timer
verify_retention_unit

complete=1
printf 'UPGRADE_DEPLOY_COMPLETE=1\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'DATABASE_BACKUP=%s\n' "$database_backup"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'
printf 'SOURCE_HASH=%s\n' "$staged_source_hash"
printf 'HEALTH=200\n'
printf 'UNAUTHENTICATED_STATUS=401\n'
printf 'RETENTION_ONESHOT=not-run-enabled-policy\n'
printf 'RETENTION_TIMER=%s\n' "$(retention_timer_state)"
printf 'SQLITE_ONESHOT=success\n'
printf 'SQLITE_TIMER=disabled\n'
printf 'PACKAGES_COUNT=%s\n' "$after_packages"
printf 'STAGING_COUNT=%s\n' "$after_staging"
printf 'ROLLBACK_COUNT=%s\n' "$after_rollback"
printf 'SQLITE_BACKUP_COUNT=%s\n' "$after_sqlite"
printf 'DATABASE_SUMMARY_B64=%s\n' "$post_summary"
`
}

async function deployUpgrade(client) {
  const remoteUpgrade = `/tmp/gaiop-upgrade-retention-${releaseId}.tgz`
  const upgradeSha = await sha256(upgradeArchive)
  await upload(client, upgradeArchive, remoteUpgrade)
  const remote = await runSudoScript(client, upgradeDeploymentScript({ remoteUpgrade, upgradeSha }))
  const values = parseKeyValues(remote.output)
  return {
    completed: remote.ok && values.UPGRADE_DEPLOY_COMPLETE === '1',
    mode: 'deploy-upgrade',
    releaseId: values.RELEASE_ID || releaseId,
    failedPhase: values.FAILED_PHASE || null,
    rollbackComplete: values.ROLLBACK_COMPLETE === '1',
    archiveSha256: upgradeSha,
    sourceHash: values.SOURCE_HASH || null,
    rollbackPoint: values.BACKUP_PATH || null,
    databaseBackup: values.DATABASE_BACKUP || null,
    databaseBackupIntegrity: values.DATABASE_BACKUP_INTEGRITY || null,
    database: parseBase64Json(values.DATABASE_SUMMARY_B64, null),
    health: Number(values.HEALTH || 0),
    unauthenticatedStatus: Number(values.UNAUTHENTICATED_STATUS || 0),
    closedState: {
      retentionOneShot: values.RETENTION_ONESHOT || null,
      retentionTimer: parseTimer(values.RETENTION_TIMER),
      sqliteOneShot: values.SQLITE_ONESHOT || null,
      sqliteTimer: values.SQLITE_TIMER || null,
    },
    directoryCounts: {
      packages: Number(values.PACKAGES_COUNT || 0),
      staging: Number(values.STAGING_COUNT || 0),
      rollback: Number(values.ROLLBACK_COUNT || 0),
      sqliteBackups: Number(values.SQLITE_BACKUP_COUNT || 0),
    },
  }
}

function adminDeploymentScript({ remoteAdmin, adminSha }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
archive='${remoteAdmin}'
expected_sha='${adminSha}'
current_root=/opt/gaiop/admin
stage_root="/opt/gaiop/.admin-retention-stage-$release_id"
backup_root="/var/backups/gaiop/admin-prestage-$release_id"
database=/var/lib/gaiop/admin/wizard.db
database_backup="$backup_root/wizard.db.before-retention-release"
phase=precheck
mutation_started=0
complete=0
start_epoch=$(date +%s)

new_units='gaiop-report-retention-cleanup.service gaiop-report-retention-cleanup.timer gaiop-admin-session-retention.service gaiop-admin-session-retention.timer gaiop-admin-sqlite-backup.service gaiop-admin-sqlite-backup.timer gaiop-storage-watermark-monitor.service gaiop-storage-watermark-monitor.timer'

cleanup_transfer() {
  rm -f -- "$archive"
  rm -rf -- "$stage_root"
}

rollback() {
  status=$?
  if [ "$status" -eq 0 ] && [ "$complete" -eq 1 ]; then
    cleanup_transfer
    exit 0
  fi
  printf 'FAILED_PHASE=%s\n' "$phase"
  if [ "$mutation_started" -eq 1 ]; then
    set +e
    systemctl stop gaiop-admin.service
    for unit in $new_units; do
      if [ -f "$backup_root/units/$unit" ]; then
        cp -a -- "$backup_root/units/$unit" "/etc/systemd/system/$unit"
      else
        rm -f -- "/etc/systemd/system/$unit"
      fi
    done
    if [ -f "$backup_root/storage-watermark-roots.json" ]; then
      cp -a -- "$backup_root/storage-watermark-roots.json" /etc/gaiop/storage-watermark-roots.json
    else
      rm -f -- /etc/gaiop/storage-watermark-roots.json
    fi
    rm -rf -- "$current_root"
    cp -a -- "$backup_root/admin-tree" "$current_root"
    systemctl daemon-reload
    systemctl start gaiop-admin.service
    for _ in $(seq 1 120); do
      code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/health 2>/dev/null || true)
      [ "$code" = 200 ] && break
      sleep 1
    done
    if systemctl is-active --quiet gaiop-admin.service \
      && [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null || true)" = 200 ]; then
      printf 'ROLLBACK_COMPLETE=1\n'
    else
      printf 'ROLLBACK_COMPLETE=0\n'
    fi
    set -e
  fi
  cleanup_transfer
  exit "$status"
}
trap rollback EXIT

directory_count() {
  target="$1"
  if [ ! -d "$target" ]; then printf 'missing'; return; fi
  find "$target" -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]'
}

database_summary() {
  module_root="$1"
  database_path="$2"
  /usr/local/bin/node - "$module_root" "$database_path" <<'NODE' | base64 -w 0
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const integrity = db.pragma('integrity_check', { simple: true })
  const selectedNames = ['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']
  const selected = {}
  let totalRows = 0
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const quoted = '"' + String(name).replaceAll('"', '""') + '"'
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
    totalRows += count
    if (selectedNames.includes(name)) selected[name] = count
  }
  process.stdout.write(JSON.stringify({ integrity, totalRows, selected }))
} finally {
  db.close()
}
NODE
}

assert_business_counts_equal() {
  before_b64="$1"
  after_b64="$2"
  /usr/local/bin/node - "$before_b64" "$after_b64" <<'NODE'
const [beforeEncoded, afterEncoded] = process.argv.slice(2)
const before = JSON.parse(Buffer.from(beforeEncoded, 'base64').toString('utf8'))
const after = JSON.parse(Buffer.from(afterEncoded, 'base64').toString('utf8'))
if (before.integrity !== 'ok' || after.integrity !== 'ok') process.exit(1)
for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
  if (before.selected[name] !== after.selected[name]) process.exit(1)
}
NODE
}

server_hash() {
  root="$1"
  (
    cd "$root"
    find server package.json package-lock.json -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
  )
}

phase=precheck
test "$(systemctl is-active gaiop-admin.service)" = active
test -d "$current_root/node_modules/better-sqlite3"
test -f "$database"
test ! -e "$stage_root"
test ! -e "$backup_root"
test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_sha"
before_database=$(database_summary "$current_root/node_modules/better-sqlite3" "$database")
before_provenance=$(directory_count /var/lib/gaiop/runtime/report-provenance)
before_admin_staging=$(directory_count /opt/gaiop/admin/data/upgrade-upload-staging)
before_reports=$(directory_count /var/lib/gaiop/reports)

phase=stage
install -d -o gaiop -g gaiop -m 0750 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/dist/index.html"
test -d "$stage_root/dist/assets"
test -f "$stage_root/server/index.js"
test -f "$stage_root/server/report-retention-cleanup.js"
test -f "$stage_root/server/session-retention-cleanup.js"
test -f "$stage_root/server/sqlite-backup.js"
test -f "$stage_root/server/storage-watermark-monitor.js"
test -f "$stage_root/package.json"
test -f "$stage_root/package-lock.json"
find "$stage_root/dist/assets" -maxdepth 1 -type f -printf '%f\n' | LC_ALL=C sort > "$stage_root/dist/.release-assets"

if [ -d "$current_root/dist/assets" ]; then
  if [ -f "$current_root/dist/.release-assets" ]; then
    while IFS= read -r asset; do
      case "$asset" in ''|*/*|*'..'*) exit 47 ;; esac
      if [ -f "$current_root/dist/assets/$asset" ] && [ ! -e "$stage_root/dist/assets/$asset" ]; then
        cp -a -- "$current_root/dist/assets/$asset" "$stage_root/dist/assets/$asset"
      fi
    done < "$current_root/dist/.release-assets"
  else
    cp -an -- "$current_root/dist/assets/." "$stage_root/dist/assets/"
  fi
fi

if cmp -s "$stage_root/package-lock.json" "$current_root/package-lock.json"; then
  cp -a -- "$current_root/node_modules" "$stage_root/node_modules"
fi
cd "$stage_root"
if ! npm ls --omit=dev --all >/dev/null 2>&1; then
  rm -rf -- node_modules
  npm ci --omit=dev --no-audit --no-fund >/dev/null
fi
npm ls --omit=dev --all >/dev/null
find server -type f -name '*.js' -print0 | xargs -0 -r -n 1 /usr/local/bin/node --check
staged_server_hash=$(server_hash "$stage_root")
chown -R gaiop:gaiop "$stage_root"
if [ -d "$current_root/data" ]; then
  install -d -o gaiop -g gaiop -m 0750 "$stage_root/data"
  cp -a -- "$current_root/data/." "$stage_root/data/"
fi

phase=backup
install -d -o root -g root -m 0700 "$backup_root" "$backup_root/units"
cp -a -- "$current_root" "$backup_root/admin-tree"
cp -a -- /etc/systemd/system/gaiop-admin.service "$backup_root/gaiop-admin.service"
if [ -f /etc/gaiop/admin.env ]; then cp -a -- /etc/gaiop/admin.env "$backup_root/admin.env"; fi
for unit in $new_units; do
  if [ -f "/etc/systemd/system/$unit" ]; then cp -a -- "/etc/systemd/system/$unit" "$backup_root/units/$unit"; fi
done
if [ -f /etc/gaiop/storage-watermark-roots.json ]; then
  cp -a -- /etc/gaiop/storage-watermark-roots.json "$backup_root/storage-watermark-roots.json"
fi

/usr/local/bin/node - "$current_root/node_modules/better-sqlite3" "$database" "$database_backup" <<'NODE'
const [moduleRoot, source, destination] = process.argv.slice(2)
const Database = require(moduleRoot)
;(async () => {
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('source-integrity')
    await db.backup(destination)
  } finally {
    db.close()
  }
  const backup = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup-integrity')
  } finally {
    backup.close()
  }
})().catch(() => process.exit(1))
NODE
test -s "$database_backup"
chmod 0600 "$database_backup"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'

phase=switch
mutation_started=1
systemctl stop --no-block gaiop-admin.service
for _ in $(seq 1 30); do
  systemctl is-active --quiet gaiop-admin.service || break
  sleep 1
done
if systemctl is-active --quiet gaiop-admin.service; then
  systemctl kill --kill-who=all --signal=KILL gaiop-admin.service || true
  sleep 2
fi
test "$(systemctl is-active gaiop-admin.service 2>/dev/null || true)" != active
rm -rf -- "$current_root"
mv -- "$stage_root" "$current_root"
chown -R gaiop:gaiop "$current_root"

phase=unit
install -d -o gaiop -g gaiop -m 0700 \
  /var/lib/gaiop/admin/sqlite-backups \
  /var/lib/gaiop/admin/sqlite-restore-tests
install -d -o gaiop -g gaiop -m 0750 /var/lib/gaiop/report-recovery
install -o root -g root -m 0644 \
  "$current_root/deploy/iso/storage-watermark/managed-roots.json" \
  /etc/gaiop/storage-watermark-roots.json

candidate_root=/run/gaiop-retention-units-$release_id
install -d -o root -g root -m 0700 "$candidate_root"
for unit in $new_units; do
  cp "$current_root/deploy/systemd/$unit" "$candidate_root/$unit"
done
systemd-analyze verify \
  /etc/systemd/system/gaiop-admin.service \
  "$candidate_root"/*.service \
  "$candidate_root"/*.timer
for unit in $new_units; do
  install -o root -g root -m 0644 "$candidate_root/$unit" "/etc/systemd/system/$unit"
done
rm -rf -- "$candidate_root"
systemctl daemon-reload
for timer in \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-storage-watermark-monitor.timer
do
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
done

phase=start
systemctl start gaiop-admin.service
for _ in $(seq 1 120); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/health 2>/dev/null || true)
  [ "$code" = 200 ] && break
  sleep 1
done
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)" = 200
test "$(server_hash "$current_root")" = "$staged_server_hash"
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/system/storage-watermarks)" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/session-retention)" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/reports/retention/recovery)" = 401
/usr/local/bin/node - "$current_root/dist/index.html" "$current_root/dist" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [indexPath, distRoot] = process.argv.slice(2)
const html = fs.readFileSync(indexPath, 'utf8')
const refs = Array.from(html.matchAll(/(?:src|href)="(\/?assets\/[^"?]+)"/g), (match) => match[1].replace(/^\//, ''))
if (!refs.length || refs.some((entry) => !fs.existsSync(path.join(distRoot, entry)))) process.exit(1)
NODE

phase=closed_state
phase=closed_admin_retention
systemctl start gaiop-admin-retention-cleanup.service
phase=closed_report_retention
systemctl start gaiop-report-retention-cleanup.service
phase=closed_session_retention
systemctl start gaiop-admin-session-retention.service
phase=closed_admin_sqlite
systemctl start gaiop-admin-sqlite-backup.service
phase=closed_results
for service in \
  gaiop-admin-retention-cleanup.service \
  gaiop-report-retention-cleanup.service \
  gaiop-admin-session-retention.service \
  gaiop-admin-sqlite-backup.service
do
  test "$(systemctl show "$service" -p Result --value)" = success
done
phase=closed_timers
for timer in \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-storage-watermark-monitor.timer
do
  test "$(systemctl is-enabled "$timer" 2>/dev/null || true)" != enabled
done
phase=closed_database_counts
after_first_start=$(database_summary "$current_root/node_modules/better-sqlite3" "$database")
assert_business_counts_equal "$before_database" "$after_first_start"
phase=closed_directory_counts
test "$before_provenance" = "$(directory_count /var/lib/gaiop/runtime/report-provenance)"
test "$before_admin_staging" = "$(directory_count /opt/gaiop/admin/data/upgrade-upload-staging)"
test "$before_reports" = "$(directory_count /var/lib/gaiop/reports)"
test "$(directory_count /var/lib/gaiop/admin/sqlite-backups)" = 0

phase=idempotent_restart
systemctl stop --no-block gaiop-admin.service
for _ in $(seq 1 30); do
  systemctl is-active --quiet gaiop-admin.service || break
  sleep 1
done
if systemctl is-active --quiet gaiop-admin.service; then
  systemctl kill --kill-who=all --signal=KILL gaiop-admin.service || true
  sleep 2
fi
test "$(systemctl is-active gaiop-admin.service 2>/dev/null || true)" != active
systemctl start gaiop-admin.service
for _ in $(seq 1 120); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/health 2>/dev/null || true)
  [ "$code" = 200 ] && break
  sleep 1
done
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)" = 200
after_second_start=$(database_summary "$current_root/node_modules/better-sqlite3" "$database")
assert_business_counts_equal "$after_first_start" "$after_second_start"
test "$before_provenance" = "$(directory_count /var/lib/gaiop/runtime/report-provenance)"
test "$before_admin_staging" = "$(directory_count /opt/gaiop/admin/data/upgrade-upload-staging)"
test "$before_reports" = "$(directory_count /var/lib/gaiop/reports)"

phase=logs
if journalctl -u gaiop-admin.service --since "@$start_epoch" --no-pager -o cat \
  | grep -Eqi 'SyntaxError|SQLITE_(CORRUPT|ERROR)|migration failed|Cannot find module|UnhandledPromiseRejection'; then
  exit 55
fi

complete=1
printf 'ADMIN_DEPLOY_COMPLETE=1\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'DATABASE_BACKUP=%s\n' "$database_backup"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'
printf 'SERVER_HASH=%s\n' "$staged_server_hash"
printf 'HEALTH=200\n'
printf 'WATERMARK_UNAUTHENTICATED=401\n'
printf 'SESSION_UNAUTHENTICATED=401\n'
printf 'REPORT_RECOVERY_UNAUTHENTICATED=401\n'
printf 'ADMIN_RETENTION_ONESHOT=success\n'
printf 'REPORT_ONESHOT=success\n'
printf 'SESSION_ONESHOT=success\n'
printf 'SQLITE_ONESHOT=success\n'
printf 'NEW_TIMERS=disabled\n'
printf 'PROVENANCE_COUNT=%s\n' "$before_provenance"
printf 'ADMIN_STAGING_COUNT=%s\n' "$before_admin_staging"
printf 'FORMAL_REPORT_COUNT=%s\n' "$before_reports"
printf 'SQLITE_BACKUP_COUNT=0\n'
printf 'DATABASE_SUMMARY_B64=%s\n' "$after_second_start"
`
}

async function deployAdmin(client) {
  const remoteAdmin = `/tmp/gaiop-admin-retention-${releaseId}.tgz`
  const adminSha = await sha256(adminArchive)
  await upload(client, adminArchive, remoteAdmin)
  const remote = await runSudoScript(client, adminDeploymentScript({ remoteAdmin, adminSha }))
  const values = parseKeyValues(remote.output)
  return {
    completed: remote.ok && values.ADMIN_DEPLOY_COMPLETE === '1',
    mode: 'deploy-admin',
    releaseId: values.RELEASE_ID || releaseId,
    failedPhase: values.FAILED_PHASE || null,
    rollbackComplete: values.ROLLBACK_COMPLETE === '1',
    archiveSha256: adminSha,
    serverHash: values.SERVER_HASH || null,
    rollbackPoint: values.BACKUP_PATH || null,
    databaseBackup: values.DATABASE_BACKUP || null,
    databaseBackupIntegrity: values.DATABASE_BACKUP_INTEGRITY || null,
    database: parseBase64Json(values.DATABASE_SUMMARY_B64, null),
    health: Number(values.HEALTH || 0),
    unauthenticatedRoutes: {
      watermark: Number(values.WATERMARK_UNAUTHENTICATED || 0),
      session: Number(values.SESSION_UNAUTHENTICATED || 0),
      reportRecovery: Number(values.REPORT_RECOVERY_UNAUTHENTICATED || 0),
    },
    closedState: {
      adminRetentionOneShot: values.ADMIN_RETENTION_ONESHOT || null,
      reportOneShot: values.REPORT_ONESHOT || null,
      sessionOneShot: values.SESSION_ONESHOT || null,
      sqliteOneShot: values.SQLITE_ONESHOT || null,
      newTimers: values.NEW_TIMERS || null,
    },
    directoryCounts: {
      reportProvenance: Number(values.PROVENANCE_COUNT || 0),
      adminUpgradeStaging: Number(values.ADMIN_STAGING_COUNT || 0),
      formalReports: Number(values.FORMAL_REPORT_COUNT || 0),
      sqliteBackups: Number(values.SQLITE_BACKUP_COUNT || 0),
    },
  }
}

function adminDiagnosisScript() {
  return String.raw`set -eu
backup_root='/var/backups/gaiop/admin-prestage-${releaseId}'
database=/var/lib/gaiop/admin/wizard.db
admin_root=/opt/gaiop/admin

unit_summary() {
  unit="$1"
  load=$(systemctl show "$unit" -p LoadState --value 2>/dev/null || true)
  result=$(systemctl show "$unit" -p Result --value 2>/dev/null || true)
  status=$(systemctl show "$unit" -p ExecMainStatus --value 2>/dev/null || true)
  printf '%s|%s|%s' "$load" "$result" "$status"
}

stable_marker() {
  unit="$1"
  journalctl -u "$unit" --since '30 minutes ago' --no-pager -o cat 2>/dev/null \
    | grep -Eo 'auto_process_disabled|auto_mark_disabled|auto_delete_disabled|create_disabled|lock_held|failed' \
    | tail -n 1 || true
}

backup_integrity=unavailable
if [ -f "$backup_root/wizard.db.before-retention-release" ] \
  && [ -d "$admin_root/node_modules/better-sqlite3" ]; then
  backup_integrity=$(/usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$backup_root/wizard.db.before-retention-release" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try { process.stdout.write(String(db.pragma('integrity_check', { simple: true }))) } finally { db.close() }
NODE
)
fi

printf 'BACKUP_ROOT=%s\n' "$(test -d "$backup_root" && printf present || printf missing)"
printf 'DATABASE_BACKUP_INTEGRITY=%s\n' "$backup_integrity"
printf 'ADMIN_RETENTION=%s\n' "$(unit_summary gaiop-admin-retention-cleanup.service)"
printf 'ADMIN_RETENTION_MARKER=%s\n' "$(stable_marker gaiop-admin-retention-cleanup.service)"
printf 'REPORT_RETENTION=%s\n' "$(unit_summary gaiop-report-retention-cleanup.service)"
printf 'REPORT_RETENTION_MARKER=%s\n' "$(stable_marker gaiop-report-retention-cleanup.service)"
printf 'SESSION_RETENTION=%s\n' "$(unit_summary gaiop-admin-session-retention.service)"
printf 'SESSION_RETENTION_MARKER=%s\n' "$(stable_marker gaiop-admin-session-retention.service)"
printf 'ADMIN_SQLITE=%s\n' "$(unit_summary gaiop-admin-sqlite-backup.service)"
printf 'ADMIN_SQLITE_MARKER=%s\n' "$(stable_marker gaiop-admin-sqlite-backup.service)"
printf 'ADMIN_ERROR_COUNT=%s\n' "$(journalctl -u gaiop-admin.service --since '30 minutes ago' --no-pager -o cat 2>/dev/null | grep -Eic 'SyntaxError|SQLITE_(CORRUPT|ERROR)|migration failed|Cannot find module|UnhandledPromiseRejection' || true)"
printf 'SQLITE_BACKUP_COUNT=%s\n' "$(find /var/lib/gaiop/admin/sqlite-backups -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')"
printf 'MIGRATION_TABLE_COUNT=%s\n' "$(/usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const expected = ['report_retention_artifacts', 'session_retention_records', 'storage_watermark_status']
  const count = expected.filter((name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)).length
  process.stdout.write(String(count))
} finally { db.close() }
NODE
)"
`
}

async function diagnoseAdmin(client) {
  const remote = await runSudoScript(client, adminDiagnosisScript())
  const values = parseKeyValues(remote.output)
  const parseUnit = (value) => {
    const [loadState = '', result = '', execMainStatus = ''] = String(value || '').split('|')
    return { loadState, result, execMainStatus: Number(execMainStatus || 0) }
  }
  return {
    completed: remote.ok,
    mode: 'diagnose-admin',
    backupRoot: values.BACKUP_ROOT || null,
    databaseBackupIntegrity: values.DATABASE_BACKUP_INTEGRITY || null,
    units: {
      adminRetention: { ...parseUnit(values.ADMIN_RETENTION), marker: values.ADMIN_RETENTION_MARKER || null },
      reportRetention: { ...parseUnit(values.REPORT_RETENTION), marker: values.REPORT_RETENTION_MARKER || null },
      sessionRetention: { ...parseUnit(values.SESSION_RETENTION), marker: values.SESSION_RETENTION_MARKER || null },
      adminSqlite: { ...parseUnit(values.ADMIN_SQLITE), marker: values.ADMIN_SQLITE_MARKER || null },
    },
    adminErrorCount: Number(values.ADMIN_ERROR_COUNT || 0),
    sqliteBackupCount: Number(values.SQLITE_BACKUP_COUNT || 0),
    migrationTableCount: Number(values.MIGRATION_TABLE_COUNT || 0),
  }
}

const watermarkFilesystemInspectionScript = String.raw`set -euo pipefail
admin_root=/opt/gaiop/admin
database=/var/lib/gaiop/admin/wizard.db

timer_state() {
  unit="$1"
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || printf '000'
}

roots_file=$(mktemp)
trap 'rm -f -- "$roots_file"' EXIT
cat >"$roots_file" <<'ROOTS'
admin_state|/var/lib/gaiop/admin
runtime_state|/var/lib/gaiop/runtime
formal_reports|/var/lib/gaiop/reports
upgrade_state|/var/lib/gaiop-upgrade
upgrade_rollback|/var/backups/gaiop/upgrade
admin_upgrade_staging|/opt/gaiop/admin/data/upgrade-upload-staging
gateway_state|/home/netinside/.openclaw
raw_syslog|/var/log/netinside
caddy_access_logs|/var/log/caddy
ROOTS

inspection=$(
  while IFS='|' read -r label path; do
    root_device=$(stat -Lc '%d' -- "$path" 2>/dev/null || printf 'unavailable')
    mount_info=$(findmnt -n -T "$path" -o TARGET,SOURCE,FSTYPE,MAJ:MIN --raw 2>/dev/null || true)
    if [ -n "$mount_info" ]; then
      mount_point=$(printf '%s\n' "$mount_info" | awk '{print $1}')
      mount_source=$(printf '%s\n' "$mount_info" | awk '{print $2}')
      filesystem_type=$(printf '%s\n' "$mount_info" | awk '{print $3}')
      major_minor=$(printf '%s\n' "$mount_info" | awk '{print $4}')
    else
      mount_point=unavailable
      mount_source=unavailable
      filesystem_type=unavailable
      major_minor=unavailable
    fi
    df_info=$(df -P -- "$path" 2>/dev/null | awk 'NR == 2 { print $2 "|" $3 "|" $4 "|" $5 }' || true)
    if [ -n "$df_info" ]; then
      df_total=$(printf '%s' "$df_info" | cut -d '|' -f 1)
      df_used=$(printf '%s' "$df_info" | cut -d '|' -f 2)
      df_available=$(printf '%s' "$df_info" | cut -d '|' -f 3)
      df_percent=$(printf '%s' "$df_info" | cut -d '|' -f 4)
    else
      df_total=unavailable
      df_used=unavailable
      df_available=unavailable
      df_percent=unavailable
    fi
    gaiop_stat=$(runuser -u gaiop -- stat -Lc '%d' -- "$path" 2>/dev/null || printf 'unavailable')
    if runuser -u gaiop -- /usr/local/bin/node - "$path" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs')
const path = process.argv[2]
const stat = fs.statSync(path, { bigint: true })
if (!stat.isDirectory()) process.exit(2)
const statfs = fs.statfsSync(path, { bigint: true })
if (statfs.blocks <= 0n || statfs.bavail < 0n || statfs.bfree < 0n) process.exit(3)
NODE
    then
      gaiop_statfs=ok
    else
      gaiop_statfs=unavailable
    fi
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
      "$label" "$path" "$root_device" "$mount_point" "$mount_source" "$filesystem_type" \
      "$major_minor" "$df_total" "$df_used" "$df_available" "$df_percent" "$gaiop_stat" "$gaiop_statfs" \
      "$(test "$root_device" != unavailable -a "$mount_point" != unavailable -a "$df_total" != unavailable && printf ok || printf inspection_failed)"
  done <"$roots_file"
)

database_summary=$(/usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const selected = {}
  for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    selected[name] = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
  }
  const watermark = {
    statuses: Number(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_status WHERE is_current=1').get().count),
    events: Number(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_events').get().count),
  }
  process.stdout.write(JSON.stringify({
    integrity: db.pragma('integrity_check', { simple: true }),
    selected,
    watermark,
  }))
} finally { db.close() }
NODE
)

current_status=$(/usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const rows = db.prepare(
    'SELECT filesystem_id, state, detection_success, usage_percent, threshold_percent, reason_code, managed_root_labels, checked_at ' +
    'FROM storage_watermark_status WHERE is_current=1 ORDER BY filesystem_id'
  ).all().map((row) => ({
    filesystemId: row.filesystem_id,
    state: row.state,
    detectionSuccess: row.detection_success === 1,
    usagePercent: row.usage_percent,
    thresholdPercent: row.threshold_percent,
    reasonCode: row.reason_code,
    managedRootLabels: JSON.parse(row.managed_root_labels),
    checkedAt: row.checked_at,
  }))
  process.stdout.write(JSON.stringify(rows))
} finally { db.close() }
NODE
)

gateway_uid=$(id -u netinside)
gateway_state=$(runuser -u netinside -- env XDG_RUNTIME_DIR="/run/user/$gateway_uid" systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)
printf 'INSPECTION_COMPLETE=1\n'
printf 'UTC=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'FILESYSTEMS_B64=%s\n' "$(printf '%s' "$inspection" | base64 -w 0)"
printf 'DATABASE_B64=%s\n' "$(printf '%s' "$database_summary" | base64 -w 0)"
printf 'CURRENT_STATUS_B64=%s\n' "$(printf '%s' "$current_status" | base64 -w 0)"
printf 'CONFIG_SHA256=%s\n' "$(sha256sum /etc/gaiop/storage-watermark-roots.json | awk '{print $1}')"
printf 'SERVICE_SHA256=%s\n' "$(sha256sum /etc/systemd/system/gaiop-storage-watermark-monitor.service | awk '{print $1}')"
printf 'TIMER_SHA256=%s\n' "$(sha256sum /etc/systemd/system/gaiop-storage-watermark-monitor.timer | awk '{print $1}')"
printf 'ADMIN_SERVICE=%s\n' "$(systemctl is-active gaiop-admin.service 2>/dev/null || true)"
printf 'UPGRADE_SERVICE=%s\n' "$(systemctl is-active gaiop-upgrade.service 2>/dev/null || true)"
printf 'GATEWAY_SERVICE=%s\n' "$gateway_state"
printf 'CADDY_SERVICE=%s\n' "$(systemctl is-active caddy.service 2>/dev/null || true)"
printf 'ADMIN_HEALTH=%s\n' "$(http_status http://127.0.0.1:3000/api/health)"
printf 'UPGRADE_HEALTH=%s\n' "$(http_status http://127.0.0.1:18900/health)"
printf 'GATEWAY_HEALTH=%s\n' "$(http_status http://127.0.0.1:18789/health)"
printf 'HTTPS_LOOPBACK=%s\n' "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/ 2>/dev/null || printf '000')"
printf 'ADMIN_LISTENER=%s\n' "$(ss -ltnH 'sport = :3000' 2>/dev/null | awk '{print $4}' | head -n 1)"
printf 'UPGRADE_LISTENER=%s\n' "$(ss -ltnH 'sport = :18900' 2>/dev/null | awk '{print $4}' | head -n 1)"
printf 'ADMIN_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-retention-cleanup.timer)"
printf 'UPGRADE_RETENTION_TIMER=%s\n' "$(timer_state gaiop-upgrade-retention-cleanup.timer)"
printf 'REPORT_RETENTION_TIMER=%s\n' "$(timer_state gaiop-report-retention-cleanup.timer)"
printf 'SESSION_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-session-retention.timer)"
printf 'ADMIN_SQLITE_TIMER=%s\n' "$(timer_state gaiop-admin-sqlite-backup.timer)"
printf 'UPGRADE_SQLITE_TIMER=%s\n' "$(timer_state gaiop-upgrade-sqlite-backup.timer)"
printf 'WATERMARK_TIMER=%s\n' "$(timer_state gaiop-storage-watermark-monitor.timer)"
`

function parseFilesystemInspection(value) {
  const decoded = Buffer.from(String(value || ''), 'base64').toString('utf8')
  return decoded.split(/\r?\n/).filter(Boolean).map((line) => {
    const [label, path, device, mountPoint, mountSource, filesystemType, majorMinor,
      totalBlocks, usedBlocks, availableBlocks, usePercent, gaiopDevice, gaiopStatfs, reasonCode] = line.split('|')
    return {
      label,
      path,
      device,
      mountPoint,
      mountSource,
      filesystemType,
      majorMinor,
      df: { totalBlocks, usedBlocks, availableBlocks, usePercent },
      gaiop: { device: gaiopDevice, statfs: gaiopStatfs },
      reasonCode,
    }
  })
}

async function inspectWatermarkFilesystems(client) {
  const remote = await runSudoScript(client, watermarkFilesystemInspectionScript)
  const values = parseKeyValues(remote.output)
  return {
    completed: remote.ok && values.INSPECTION_COMPLETE === '1',
    mode: 'inspect-watermark-filesystems',
    checkedAt: values.UTC || null,
    filesystems: parseFilesystemInspection(values.FILESYSTEMS_B64),
    database: parseBase64Json(values.DATABASE_B64, null),
    currentStatus: parseBase64Json(values.CURRENT_STATUS_B64, []),
    hashes: {
      config: values.CONFIG_SHA256 || null,
      service: values.SERVICE_SHA256 || null,
      timer: values.TIMER_SHA256 || null,
    },
    services: {
      admin: values.ADMIN_SERVICE || null,
      upgrade: values.UPGRADE_SERVICE || null,
      gateway: values.GATEWAY_SERVICE || null,
      caddy: values.CADDY_SERVICE || null,
    },
    listeners: {
      admin: values.ADMIN_LISTENER || null,
      upgrade: values.UPGRADE_LISTENER || null,
    },
    health: {
      admin: Number(values.ADMIN_HEALTH || 0),
      upgrade: Number(values.UPGRADE_HEALTH || 0),
      gateway: Number(values.GATEWAY_HEALTH || 0),
      httpsLoopback: Number(values.HTTPS_LOOPBACK || 0),
    },
    timers: {
      adminRetention: parseTimer(values.ADMIN_RETENTION_TIMER),
      upgradeRetention: parseTimer(values.UPGRADE_RETENTION_TIMER),
      reportRetention: parseTimer(values.REPORT_RETENTION_TIMER),
      sessionRetention: parseTimer(values.SESSION_RETENTION_TIMER),
      adminSqlite: parseTimer(values.ADMIN_SQLITE_TIMER),
      upgradeSqlite: parseTimer(values.UPGRADE_SQLITE_TIMER),
      watermark: parseTimer(values.WATERMARK_TIMER),
    },
  }
}

function watermarkVerificationScript() {
  return String.raw`set -euo pipefail
verification_phase=initial_checks
before_events=unknown
first_events=unknown
second_events=unknown
trap 'status=$?; printf "WATERMARK_VERIFY_FAILURE_PHASE=%s\n" "$verification_phase"; printf "EVENTS_BEFORE=%s\n" "$before_events"; printf "EVENTS_AFTER_FIRST=%s\n" "$first_events"; printf "EVENTS_AFTER_SECOND=%s\n" "$second_events"; exit "$status"' ERR
admin_root=/opt/gaiop/admin
database=/var/lib/gaiop/admin/wizard.db
service=gaiop-storage-watermark-monitor.service
timer=gaiop-storage-watermark-monitor.timer
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(systemctl is-enabled "$timer" 2>/dev/null || true)" != enabled
verification_phase=systemd_verify
systemd-analyze verify \
  /etc/systemd/system/gaiop-admin.service \
  "/etc/systemd/system/$service" \
  "/etc/systemd/system/$timer"

db_counts() {
  /usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const integrity = db.pragma('integrity_check', { simple: true })
  const eventCount = Number(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_events').get().count)
  const statusCount = Number(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_status WHERE is_current=1').get().count)
  const selected = {}
  for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    selected[name] = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
  }
  process.stdout.write(JSON.stringify({ integrity, eventCount, statusCount, selected }))
} finally { db.close() }
NODE
}

verification_phase=database_baseline
before=$(db_counts)
before_events=$(/usr/local/bin/node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.eventCount))" "$before")

verification_phase=first_service_start
systemctl start "$service"
verification_phase=first_service_result
test "$(systemctl show "$service" -p Result --value)" = success
verification_phase=first_database_read
after_first=$(db_counts)
first_events=$(/usr/local/bin/node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.eventCount))" "$after_first")
verification_phase=first_event_delta
first_event_delta=$((first_events - before_events))
test "$first_event_delta" -eq 0 || test "$first_event_delta" -eq 2

verification_phase=second_service_start
systemctl start "$service"
verification_phase=second_service_result
test "$(systemctl show "$service" -p Result --value)" = success
verification_phase=second_database_read
after_second=$(db_counts)
second_events=$(/usr/local/bin/node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(String(v.eventCount))" "$after_second")
verification_phase=second_event_delta
second_event_delta=$((second_events - first_events))
test "$second_event_delta" -eq 0

verification_phase=status_contract
status_contract=$(/usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const statuses = db.prepare(
    'SELECT filesystem_id, state, detection_success, usage_percent, threshold_percent, ' +
    'reason_code, managed_root_labels ' +
    'FROM storage_watermark_status WHERE is_current=1 ORDER BY filesystem_id'
  ).all().map((row) => ({
    filesystemId: row.filesystem_id,
    state: row.state,
    detectionSuccess: row.detection_success === 1,
    usagePercent: row.usage_percent,
    thresholdPercent: row.threshold_percent,
    reasonCode: row.reason_code,
    managedRootLabels: JSON.parse(row.managed_root_labels),
  }))
  const allowedKeys = ['filesystemId', 'state', 'detectionSuccess', 'usagePercent', 'thresholdPercent', 'reasonCode', 'managedRootLabels']
  const errors = []
  if (statuses.some((row) => Object.keys(row).some((key) => !allowedKeys.includes(key)))) errors.push('unexpected_key')
  if (JSON.stringify(statuses).includes('/')) errors.push('path_like_output')
  const labels = statuses.flatMap((row) => row.managedRootLabels).sort()
  const expected = ['admin_state', 'runtime_state', 'formal_reports', 'upgrade_state', 'upgrade_rollback', 'admin_upgrade_staging', 'gateway_state', 'raw_syslog', 'caddy_access_logs'].sort()
  if (JSON.stringify(labels) !== JSON.stringify(expected)) errors.push('label_set:' + labels.length)
  const normal = statuses.filter((row) => row.detectionSuccess)
  const unknown = statuses.filter((row) => !row.detectionSuccess)
  if (normal.length !== 1 || normal.some((row) => row.state !== 'normal')) {
    errors.push('normal_contract:' + normal.length + ':' + normal.map((row) => row.state + ':' + row.managedRootLabels.join(',')).join('|'))
  }
  if (unknown.length < 1 || unknown.some((row) => row.state !== 'unknown' || row.reasonCode !== 'managed_root_permission_denied')) {
    errors.push('unknown_contract:' + unknown.length + ':' + unknown.map((row) => row.managedRootLabels.join(',') + ':' + row.state + ':' + row.reasonCode).join('|'))
  }
  process.stdout.write(JSON.stringify({ statuses, errors }))
} finally { db.close() }
NODE
)
summary=$(/usr/local/bin/node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(v.statuses))" "$status_contract")
status_errors=$(/usr/local/bin/node -e "const v=JSON.parse(process.argv[1]);process.stdout.write(v.errors.join(';'))" "$status_contract")
printf 'STATUS_ERRORS=%s\n' "$status_errors"
test -z "$status_errors"

verification_phase=database_invariants
/usr/local/bin/node - "$before" "$after_second" <<'NODE'
const [beforeJson, afterJson] = process.argv.slice(2).map(JSON.parse)
if (beforeJson.integrity !== 'ok' || afterJson.integrity !== 'ok') process.exit(1)
for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
  if (beforeJson.selected[name] !== afterJson.selected[name]) process.exit(1)
}
NODE

verification_phase=role_and_redaction_tests
test_log=$(mktemp)
if ! (cd "$admin_root" && runuser -u gaiop -- env NODE_ENV=test /usr/local/bin/node --test \
  server/lib/storage-watermark-service.test.js \
  server/routes/storage-watermark.test.js) >"$test_log" 2>&1; then
  test_failure=$(grep -E '^(# Subtest:|not ok |# fail |# error |  error:|  code:)' "$test_log" | tail -n 40 | base64 -w 0 || true)
  rm -f -- "$test_log"
  printf 'WATERMARK_VERIFY_FAILURE_PHASE=%s\n' "$verification_phase"
  printf 'TEST_FAILURE_B64=%s\n' "$test_failure"
  exit 61
fi
grep -Fq '# fail 0' "$test_log"
rm -f -- "$test_log"

verification_phase=timer_disabled
test "$(systemctl is-enabled "$timer" 2>/dev/null || true)" != enabled
test "$(systemctl is-active "$timer" 2>/dev/null || true)" != active
printf 'WATERMARK_VERIFY_COMPLETE=1\n'
printf 'NATIVE_SYSTEMD_VERIFY=ok\n'
printf 'EVENTS_BEFORE=%s\n' "$before_events"
printf 'EVENTS_AFTER_FIRST=%s\n' "$first_events"
printf 'EVENTS_AFTER_SECOND=%s\n' "$second_events"
printf 'FIRST_EVENT_DELTA=%s\n' "$((first_events - before_events))"
printf 'SECOND_EVENT_DELTA=%s\n' "$((second_events - first_events))"
printf 'DATABASE_INTEGRITY=ok\n'
printf 'ROLE_AND_REDACTION_TESTS=pass\n'
printf 'TIMER=disabled\n'
printf 'STATUSES_B64=%s\n' "$(printf '%s' "$summary" | base64 -w 0)"
`
}

const closeDisabledTimersScript = String.raw`set -euo pipefail
timer_state() {
  unit="$1"
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}
for unit in \
  gaiop-admin-retention-cleanup.timer \
  gaiop-upgrade-retention-cleanup.timer \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-upgrade-sqlite-backup.timer
do
  systemctl disable --now "$unit" >/dev/null
done
for unit in \
  gaiop-admin-retention-cleanup.timer \
  gaiop-upgrade-retention-cleanup.timer \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-upgrade-sqlite-backup.timer
do
  test "$(timer_state "$unit")" = 'inactive|disabled'
done
printf 'CLOSED_TIMERS_COMPLETE=1\n'
`

async function closeDisabledTimers(client) {
  const remote = await runSudoScript(client, closeDisabledTimersScript)
  const values = parseKeyValues(remote.output)
  return {
    completed: remote.ok && values.CLOSED_TIMERS_COMPLETE === '1',
    mode: 'close-disabled-timers',
    timer: 'all_non_watermark_retention_and_backup_timers_disabled',
  }
}

async function verifyWatermark(client) {
  const remote = await runSudoScript(client, watermarkVerificationScript())
  const values = parseKeyValues(remote.output)
  const completed = remote.ok && values.WATERMARK_VERIFY_COMPLETE === '1'
  return {
    completed,
    mode: 'verify-watermark',
    errorCode: completed ? null : 'WATERMARK_VERIFY_FAILED',
    failedPhase: completed ? null : (values.WATERMARK_VERIFY_FAILURE_PHASE || 'remote_script'),
    remoteExitCode: remote.exitCode ?? null,
    eventCounts: {
      before: values.EVENTS_BEFORE || null,
      afterFirst: values.EVENTS_AFTER_FIRST || null,
      afterSecond: values.EVENTS_AFTER_SECOND || null,
    },
    nativeSystemdVerify: values.NATIVE_SYSTEMD_VERIFY || null,
    eventDeltas: {
      firstRun: Number(values.FIRST_EVENT_DELTA || 0),
      secondRun: Number(values.SECOND_EVENT_DELTA || 0),
    },
    databaseIntegrity: values.DATABASE_INTEGRITY || null,
    roleAndRedactionTests: values.ROLE_AND_REDACTION_TESTS || null,
    timer: values.TIMER || null,
    statuses: parseBase64Json(values.STATUSES_B64, []),
    statusErrors: values.STATUS_ERRORS || null,
    testFailure: values.TEST_FAILURE_B64
      ? Buffer.from(values.TEST_FAILURE_B64, 'base64').toString('utf8')
      : null,
  }
}

function watermarkRollbackScript() {
  return String.raw`set -euo pipefail
backup_root='/var/backups/gaiop/storage-watermark-probes-${releaseId}'
service=gaiop-storage-watermark-monitor.service
timer=gaiop-storage-watermark-monitor.timer
test -d "$backup_root"
test -f "$backup_root/storage-watermark-roots.json"
test -f "$backup_root/$service"
test -f "$backup_root/$timer"
systemctl disable --now "$timer" >/dev/null 2>&1 || true
cp -a -- "$backup_root/storage-watermark-roots.json" /etc/gaiop/storage-watermark-roots.json
cp -a -- "$backup_root/$service" "/etc/systemd/system/$service"
cp -a -- "$backup_root/$timer" "/etc/systemd/system/$timer"
systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/gaiop-admin.service \
  "/etc/systemd/system/$service" \
  "/etc/systemd/system/$timer"
test "$(systemctl is-enabled "$timer" 2>/dev/null || true)" != enabled
test "$(systemctl is-active "$timer" 2>/dev/null || true)" != active
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)" = 200
printf 'WATERMARK_ROLLBACK_COMPLETE=1\n'
printf 'BACKUP_ROOT=%s\n' "$backup_root"
`
}

function watermarkProbeDeploymentScript({ remoteArchive, archiveSha }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
remote_archive='${remoteArchive}'
expected_sha='${archiveSha}'
backup_root="/var/backups/gaiop/storage-watermark-probes-$release_id"
service=gaiop-storage-watermark-monitor.service
timer=gaiop-storage-watermark-monitor.timer
phase=initial
backup_created=0
complete=0
candidate=$(mktemp -d /run/gaiop-watermark-probe.XXXXXX)

rollback() {
  set +e
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
  if [ "$backup_created" = 1 ]; then
    cp -a -- "$backup_root/storage-watermark-roots.json" /etc/gaiop/storage-watermark-roots.json
    cp -a -- "$backup_root/$service" "/etc/systemd/system/$service"
    cp -a -- "$backup_root/$timer" "/etc/systemd/system/$timer"
    systemctl daemon-reload
  fi
}

finish() {
  status=$?
  rm -rf -- "$candidate"
  rm -f -- "$remote_archive"
  if [ "$status" -ne 0 ] || [ "$complete" != 1 ]; then
    rollback
    printf 'FAILED_PHASE=%s\n' "$phase"
    printf 'ROLLBACK_COMPLETE=%s\n' "$(test "$backup_created" = 1 && printf 1 || printf 0)"
  fi
  exit "$status"
}
trap finish EXIT

phase=archive_hash
test "$(sha256sum "$remote_archive" | awk '{print $1}')" = "$expected_sha"
phase=archive_extract
tar -xzf "$remote_archive" -C "$candidate"
test -f "$candidate/managed-roots.json"
test -f "$candidate/$service"
test -f "$candidate/$timer"
archive_entries=$(tar -tzf "$remote_archive" | sed 's#^\./##' | LC_ALL=C sort)
expected_entries=$(printf '%s\n' managed-roots.json "$service" "$timer" | LC_ALL=C sort)
test "$archive_entries" = "$expected_entries"

phase=config_contract
/usr/local/bin/node - "$candidate/managed-roots.json" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const config = JSON.parse(fs.readFileSync(path, 'utf8'))
if (config.version !== 'gaiop_storage_watermark_roots.v1') process.exit(1)
if (JSON.stringify(config.managedRoots) !== JSON.stringify([
  { label: 'admin_state', path: '/var/lib/gaiop/admin' },
])) process.exit(2)
NODE

phase=candidate_systemd_verify
systemd-analyze verify \
  /etc/systemd/system/gaiop-admin.service \
  "$candidate/$service" \
  "$candidate/$timer"
phase=backup
test ! -e "$backup_root"
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- /etc/gaiop/storage-watermark-roots.json "$backup_root/storage-watermark-roots.json"
cp -a -- "/etc/systemd/system/$service" "$backup_root/$service"
cp -a -- "/etc/systemd/system/$timer" "$backup_root/$timer"
backup_created=1

phase=install
systemctl disable --now "$timer" >/dev/null 2>&1 || true
install -o root -g root -m 0644 "$candidate/managed-roots.json" /etc/gaiop/storage-watermark-roots.json
install -o root -g root -m 0644 "$candidate/$service" "/etc/systemd/system/$service"
install -o root -g root -m 0644 "$candidate/$timer" "/etc/systemd/system/$timer"
systemctl daemon-reload
phase=installed_systemd_verify
systemd-analyze verify \
  /etc/systemd/system/gaiop-admin.service \
  "/etc/systemd/system/$service" \
  "/etc/systemd/system/$timer"
test "$(systemctl is-enabled "$timer" 2>/dev/null || true)" != enabled
test "$(systemctl is-active "$timer" 2>/dev/null || true)" != active
complete=1
trap - EXIT
rm -rf -- "$candidate"
rm -f -- "$remote_archive"
printf 'WATERMARK_PROBE_DEPLOY_COMPLETE=1\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_ROOT=%s\n' "$backup_root"
printf 'ARCHIVE_SHA256=%s\n' "$expected_sha"
printf 'CONFIG_SHA256=%s\n' "$(sha256sum /etc/gaiop/storage-watermark-roots.json | awk '{print $1}')"
printf 'SERVICE_SHA256=%s\n' "$(sha256sum "/etc/systemd/system/$service" | awk '{print $1}')"
printf 'TIMER_SHA256=%s\n' "$(sha256sum "/etc/systemd/system/$timer" | awk '{print $1}')"
printf 'NATIVE_SYSTEMD_VERIFY=ok\n'
printf 'TIMER_STATE=inactive|disabled\n'
`
}

async function deployWatermarkProbes(client) {
  const remoteArchive = `/tmp/gaiop-storage-watermark-probes-${releaseId}.tgz`
  const archiveSha = await sha256(watermarkArchive)
  await upload(client, watermarkArchive, remoteArchive)
  const remote = await runSudoScript(client, watermarkProbeDeploymentScript({ remoteArchive, archiveSha }))
  const values = parseKeyValues(remote.output)
  const completed = remote.ok && values.WATERMARK_PROBE_DEPLOY_COMPLETE === '1'
  return {
    completed,
    mode: 'deploy-watermark-probes',
    errorCode: completed ? null : 'WATERMARK_PROBE_DEPLOY_FAILED',
    failedPhase: completed ? null : (values.FAILED_PHASE || 'remote_script'),
    rollbackComplete: values.ROLLBACK_COMPLETE === '1',
    releaseId: values.RELEASE_ID || releaseId,
    backupRoot: values.BACKUP_ROOT || null,
    archiveSha256: archiveSha,
    hashes: {
      config: values.CONFIG_SHA256 || null,
      service: values.SERVICE_SHA256 || null,
      timer: values.TIMER_SHA256 || null,
    },
    nativeSystemdVerify: values.NATIVE_SYSTEMD_VERIFY || null,
    timer: parseTimer(values.TIMER_STATE),
  }
}

function watermarkVerifyEnableScript() {
  return String.raw`set -euo pipefail
phase=initial
backup_root='/var/backups/gaiop/storage-watermark-probes-${releaseId}'
admin_root=/opt/gaiop/admin
database=/var/lib/gaiop/admin/wizard.db
probe=/var/lib/gaiop/admin
service=gaiop-storage-watermark-monitor.service
timer=gaiop-storage-watermark-monitor.timer
before_events=unknown
after_first_events=unknown
after_second_events=unknown
after_third_events=unknown

rollback() {
  set +e
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
  cp -a -- "$backup_root/storage-watermark-roots.json" /etc/gaiop/storage-watermark-roots.json
  cp -a -- "$backup_root/$service" "/etc/systemd/system/$service"
  cp -a -- "$backup_root/$timer" "/etc/systemd/system/$timer"
  systemctl daemon-reload
}
fail() {
  status=$?
  rollback
  printf 'WATERMARK_ENABLE_FAILURE_PHASE=%s\n' "$phase"
  printf 'ROLLBACK_COMPLETE=1\n'
  printf 'EVENTS=%s/%s/%s/%s\n' "$before_events" "$after_first_events" "$after_second_events" "$after_third_events"
  exit "$status"
}
trap fail ERR

timer_state() {
  unit="$1"
  printf '%s|%s' \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    "$(systemctl is-enabled "$unit" 2>/dev/null || true)"
}

db_summary() {
  /usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const selected = {}
  for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    selected[name] = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
  }
  const statuses = db.prepare(
    'SELECT filesystem_id, state, detection_success, usage_percent, threshold_percent, reason_code, managed_root_labels, checked_at ' +
    'FROM storage_watermark_status WHERE is_current=1 ORDER BY filesystem_id'
  ).all().map((row) => ({
    filesystemId: row.filesystem_id,
    state: row.state,
    detectionSuccess: row.detection_success === 1,
    usagePercent: row.usage_percent,
    thresholdPercent: row.threshold_percent,
    reasonCode: row.reason_code,
    managedRootLabels: JSON.parse(row.managed_root_labels),
    checkedAt: row.checked_at,
  }))
  process.stdout.write(JSON.stringify({
    integrity: db.pragma('integrity_check', { simple: true }),
    selected,
    events: Number(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_events').get().count),
    statuses,
  }))
} finally { db.close() }
NODE
}

events_from() {
  /usr/local/bin/node -e "process.stdout.write(String(JSON.parse(process.argv[1]).events))" "$1"
}

validate_status() {
  df_values=$(df -P -- "$probe" | awk 'NR == 2 { print $3 ":" $4 ":" $5 }')
  /usr/local/bin/node - "$1" "$df_values" <<'NODE'
const [summary, dfValues] = process.argv.slice(2)
const value = JSON.parse(summary)
if (value.integrity !== 'ok' || value.statuses.length !== 1) process.exit(1)
const row = value.statuses[0]
if (!row.detectionSuccess || row.reasonCode === 'managed_root_permission_denied') process.exit(2)
if (JSON.stringify(row).includes('/')) process.exit(3)
if (JSON.stringify(row.managedRootLabels) !== JSON.stringify(['admin_state'])) process.exit(4)
const [used, available] = dfValues.split(':').map((item) => Number.parseInt(item, 10))
const rawPercent = used * 100 / (used + available)
if (!Number.isFinite(rawPercent) || Math.abs(rawPercent - row.usagePercent) > 0.2) process.exit(5)
const expected = rawPercent >= 90 ? 'emergency' : rawPercent >= 80 ? 'cleanup_required' : rawPercent >= 75 ? 'warning' : 'normal'
if (row.state !== expected) process.exit(6)
NODE
}

phase=preconditions
test -d "$backup_root"
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(timer_state "$timer")" = 'inactive|disabled'
phase=systemd_verify
systemd-analyze verify \
  /etc/systemd/system/gaiop-admin.service \
  "/etc/systemd/system/$service" \
  "/etc/systemd/system/$timer"
phase=probe_access
probe_device=$(stat -Lc '%d' -- "$probe")
test "$(runuser -u gaiop -- stat -Lc '%d' -- "$probe")" = "$probe_device"
runuser -u gaiop -- /usr/local/bin/node - "$probe" "$probe_device" <<'NODE'
const fs = require('node:fs')
const [path, expectedDevice] = process.argv.slice(2)
const stat = fs.statSync(path, { bigint: true })
if (!stat.isDirectory() || stat.dev.toString() !== expectedDevice) process.exit(1)
const statfs = fs.statfsSync(path, { bigint: true })
if (statfs.blocks <= 0n || statfs.bavail < 0n || statfs.bfree < 0n) process.exit(2)
NODE
phase=unit_scope
grep -Fq 'ReadWritePaths=/var/lib/gaiop/admin' "/etc/systemd/system/$service"
if grep -Eq '/home/netinside/\.openclaw|/var/backups/gaiop|upgrade-upload-staging|/var/log/netinside|/var/log/caddy' "/etc/systemd/system/$service"; then
  exit 31
fi
phase=database_baseline
before=$(db_summary)
before_events=$(events_from "$before")

phase=oneshot_first
systemctl start "$service"
test "$(systemctl show "$service" -p Result --value)" = success
after_first=$(db_summary)
after_first_events=$(events_from "$after_first")
validate_status "$after_first"
phase=oneshot_second
systemctl start "$service"
test "$(systemctl show "$service" -p Result --value)" = success
after_second=$(db_summary)
after_second_events=$(events_from "$after_second")
validate_status "$after_second"
test "$after_second_events" = "$after_first_events"
phase=oneshot_third
systemctl start "$service"
test "$(systemctl show "$service" -p Result --value)" = success
after_third=$(db_summary)
after_third_events=$(events_from "$after_third")
validate_status "$after_third"
test "$after_third_events" = "$after_second_events"

phase=database_invariants
/usr/local/bin/node - "$before" "$after_third" <<'NODE'
const [before, after] = process.argv.slice(2).map(JSON.parse)
if (before.integrity !== 'ok' || after.integrity !== 'ok') process.exit(1)
for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
  if (before.selected[name] !== after.selected[name]) process.exit(2)
}
NODE
phase=role_and_redaction_tests
test_log=$(mktemp)
if ! (cd "$admin_root" && runuser -u gaiop -- env NODE_ENV=test /usr/local/bin/node --test \
  server/lib/storage-watermark-service.test.js \
  server/routes/storage-watermark.test.js) >"$test_log" 2>&1; then
  rm -f -- "$test_log"
  exit 41
fi
grep -Fq '# fail 0' "$test_log"
rm -f -- "$test_log"
phase=closed_timers
for closed_timer in \
  gaiop-admin-retention-cleanup.timer \
  gaiop-upgrade-retention-cleanup.timer \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-upgrade-sqlite-backup.timer
do
  test "$(timer_state "$closed_timer")" = 'inactive|disabled'
done
phase=enable_timer
systemctl enable --now "$timer" >/dev/null
test "$(timer_state "$timer")" = 'active|enabled'
trap - ERR
printf 'WATERMARK_ENABLE_COMPLETE=1\n'
printf 'NATIVE_SYSTEMD_VERIFY=ok\n'
printf 'PROBE_DEVICE=%s\n' "$probe_device"
printf 'EVENTS=%s/%s/%s/%s\n' "$before_events" "$after_first_events" "$after_second_events" "$after_third_events"
printf 'DATABASE_B64=%s\n' "$(printf '%s' "$after_third" | base64 -w 0)"
printf 'ROLE_AND_REDACTION_TESTS=pass\n'
printf 'TIMER_STATE=%s\n' "$(timer_state "$timer")"
printf 'LAST_TRIGGER=%s\n' "$(systemctl show "$timer" -p LastTriggerUSec --value)"
printf 'NEXT_TRIGGER=%s\n' "$(systemctl show "$timer" -p NextElapseUSecRealtime --value)"
`
}

async function verifyEnableWatermark(client) {
  const remote = await runSudoScript(client, watermarkVerifyEnableScript())
  const values = parseKeyValues(remote.output)
  const completed = remote.ok && values.WATERMARK_ENABLE_COMPLETE === '1'
  const [before, afterFirst, afterSecond, afterThird] = String(values.EVENTS || '').split('/')
  return {
    completed,
    mode: 'verify-enable-watermark',
    errorCode: completed ? null : 'WATERMARK_ENABLE_FAILED',
    failedPhase: completed ? null : (values.WATERMARK_ENABLE_FAILURE_PHASE || 'remote_script'),
    rollbackComplete: values.ROLLBACK_COMPLETE === '1',
    nativeSystemdVerify: values.NATIVE_SYSTEMD_VERIFY || null,
    probeDevice: values.PROBE_DEVICE || null,
    eventCounts: { before, afterFirst, afterSecond, afterThird },
    database: parseBase64Json(values.DATABASE_B64, null),
    roleAndRedactionTests: values.ROLE_AND_REDACTION_TESTS || null,
    timer: {
      ...parseTimer(values.TIMER_STATE),
      lastTrigger: values.LAST_TRIGGER || null,
      nextTrigger: values.NEXT_TRIGGER || null,
    },
  }
}

function watermarkObservationScript() {
  return String.raw`set -euo pipefail
phase=initial
backup_root='/var/backups/gaiop/storage-watermark-probes-${releaseId}'
admin_root=/opt/gaiop/admin
database=/var/lib/gaiop/admin/wizard.db
probe=/var/lib/gaiop/admin
service=gaiop-storage-watermark-monitor.service
timer=gaiop-storage-watermark-monitor.timer
start_epoch=$(date +%s)
initial_checked=unknown
first_checked=unknown
second_checked=unknown

rollback() {
  set +e
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
  cp -a -- "$backup_root/storage-watermark-roots.json" /etc/gaiop/storage-watermark-roots.json
  cp -a -- "$backup_root/$service" "/etc/systemd/system/$service"
  cp -a -- "$backup_root/$timer" "/etc/systemd/system/$timer"
  systemctl daemon-reload
}
fail() {
  status=$?
  rollback
  printf 'WATERMARK_OBSERVE_FAILURE_PHASE=%s\n' "$phase"
  printf 'ROLLBACK_COMPLETE=1\n'
  printf 'CHECKED=%s/%s/%s\n' "$initial_checked" "$first_checked" "$second_checked"
  exit "$status"
}
trap fail ERR

timer_state() {
  unit="$1"
  printf '%s|%s' \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    "$(systemctl is-enabled "$unit" 2>/dev/null || true)"
}

db_snapshot() {
  /usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$database" <<'NODE'
const [moduleRoot, databasePath] = process.argv.slice(2)
const Database = require(moduleRoot)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const selected = {}
  for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
    const quoted = '"' + name.replaceAll('"', '""') + '"'
    selected[name] = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
  }
  const statuses = db.prepare(
    'SELECT filesystem_id, state, detection_success, usage_percent, threshold_percent, reason_code, managed_root_labels, checked_at ' +
    'FROM storage_watermark_status WHERE is_current=1 ORDER BY filesystem_id'
  ).all().map((row) => ({
    filesystemId: row.filesystem_id,
    state: row.state,
    detectionSuccess: row.detection_success === 1,
    usagePercent: row.usage_percent,
    thresholdPercent: row.threshold_percent,
    reasonCode: row.reason_code,
    managedRootLabels: JSON.parse(row.managed_root_labels),
    checkedAt: row.checked_at,
  }))
  process.stdout.write(JSON.stringify({
    integrity: db.pragma('integrity_check', { simple: true }),
    selected,
    events: Number(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_events').get().count),
    statuses,
    checkedAt: statuses.length === 1 ? Number(statuses[0].checkedAt) : null,
  }))
} finally { db.close() }
NODE
}

checked_from() {
  /usr/local/bin/node -e "process.stdout.write(String(JSON.parse(process.argv[1]).checkedAt || 0))" "$1"
}

phase=preconditions
test -d "$backup_root"
test "$(timer_state "$timer")" = 'active|enabled'
before=$(db_snapshot)
initial_checked=$(checked_from "$before")
test "$initial_checked" -gt 0
deadline=$(( $(date +%s) + 780 ))

phase=wait_first_cycle
while [ "$(date +%s)" -lt "$deadline" ]; do
  current=$(db_snapshot)
  candidate=$(checked_from "$current")
  if [ "$candidate" -gt "$initial_checked" ]; then
    first="$current"
    first_checked="$candidate"
    break
  fi
  sleep 15
done
test "$first_checked" != unknown
test "$(systemctl show "$service" -p Result --value)" = success

phase=wait_second_cycle
while [ "$(date +%s)" -lt "$deadline" ]; do
  current=$(db_snapshot)
  candidate=$(checked_from "$current")
  if [ "$candidate" -gt "$first_checked" ]; then
    second="$current"
    second_checked="$candidate"
    break
  fi
  sleep 15
done
test "$second_checked" != unknown
test "$(systemctl show "$service" -p Result --value)" = success

phase=database_and_event_invariants
df_values=$(df -P -- "$probe" | awk 'NR == 2 { print $3 ":" $4 ":" $5 }')
/usr/local/bin/node - "$before" "$first" "$second" "$df_values" <<'NODE'
const [before, first, second] = process.argv.slice(2, 5).map(JSON.parse)
const dfValues = process.argv[5]
for (const value of [before, first, second]) {
  if (value.integrity !== 'ok' || value.statuses.length !== 1) process.exit(1)
  const row = value.statuses[0]
  if (!row.detectionSuccess || JSON.stringify(row.managedRootLabels) !== JSON.stringify(['admin_state'])) process.exit(2)
  if (JSON.stringify(row).includes('/')) process.exit(3)
}
for (const name of ['users', 'workspace_sessions', 'report_files', 'report_deliveries']) {
  if (before.selected[name] !== second.selected[name]) process.exit(4)
}
if (before.events !== first.events || first.events !== second.events) process.exit(5)
const [used, available] = dfValues.split(':').map((item) => Number.parseInt(item, 10))
const rawPercent = used * 100 / (used + available)
if (!Number.isFinite(rawPercent) || Math.abs(rawPercent - second.statuses[0].usagePercent) > 0.2) process.exit(6)
NODE

phase=closed_timers
for closed_timer in \
  gaiop-admin-retention-cleanup.timer \
  gaiop-upgrade-retention-cleanup.timer \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-session-retention.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-upgrade-sqlite-backup.timer
do
  test "$(timer_state "$closed_timer")" = 'inactive|disabled'
done
phase=service_health
test "$(timer_state "$timer")" = 'active|enabled'
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(systemctl is-active gaiop-upgrade.service)" = active
gateway_uid=$(id -u netinside)
test "$(runuser -u netinside -- env XDG_RUNTIME_DIR="/run/user/$gateway_uid" systemctl --user is-active openclaw-gateway.service)" = active
test "$(systemctl is-active caddy.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/health)" = 200
test "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/)" = 200
test "$(ss -ltnH 'sport = :3000' | awk '{print $4}' | head -n 1)" = '127.0.0.1:3000'
test "$(ss -ltnH 'sport = :18900' | awk '{print $4}' | head -n 1)" = '127.0.0.1:18900'
phase=logs
if journalctl -u "$service" -u gaiop-admin.service --since "@$start_epoch" --no-pager -o cat \
  | grep -Eqi 'SyntaxError|SQLITE_(CORRUPT|ERROR)|migration failed|Cannot find module|UnhandledPromiseRejection|monitor_failed'; then
  exit 51
fi
trap - ERR
printf 'WATERMARK_OBSERVE_COMPLETE=1\n'
printf 'CHECKED=%s/%s/%s\n' "$initial_checked" "$first_checked" "$second_checked"
printf 'DATABASE_B64=%s\n' "$(printf '%s' "$second" | base64 -w 0)"
printf 'TIMER_STATE=%s\n' "$(timer_state "$timer")"
printf 'LAST_TRIGGER=%s\n' "$(systemctl show "$timer" -p LastTriggerUSec --value)"
printf 'NEXT_TRIGGER=%s\n' "$(systemctl show "$timer" -p NextElapseUSecRealtime --value)"
printf 'ADMIN_SERVICE=active\n'
printf 'UPGRADE_SERVICE=active\n'
printf 'GATEWAY_SERVICE=active\n'
printf 'CADDY_SERVICE=active\n'
printf 'ADMIN_HEALTH=200\n'
printf 'UPGRADE_HEALTH=200\n'
printf 'GATEWAY_HEALTH=200\n'
printf 'HTTPS_LOOPBACK=200\n'
`
}

async function rollbackWatermark(client) {
  const remote = await runSudoScript(client, watermarkRollbackScript())
  const values = parseKeyValues(remote.output)
  return {
    completed: remote.ok && values.WATERMARK_ROLLBACK_COMPLETE === '1',
    mode: 'rollback-watermark',
    backupRoot: values.BACKUP_ROOT || null,
  }
}

async function observeWatermark(client) {
  const [remote, publicStatus] = await Promise.all([
    runSudoScript(client, watermarkObservationScript()),
    publicHttpsStatus(),
  ])
  const values = parseKeyValues(remote.output)
  let completed = remote.ok && values.WATERMARK_OBSERVE_COMPLETE === '1' && publicStatus === 200
  let rollbackComplete = values.ROLLBACK_COMPLETE === '1'
  if (!completed && remote.ok) {
    const rollback = await rollbackWatermark(client)
    rollbackComplete = rollback.completed
  }
  const [initial, first, second] = String(values.CHECKED || '').split('/')
  return {
    completed,
    mode: 'observe-watermark',
    errorCode: completed ? null : 'WATERMARK_OBSERVE_FAILED',
    failedPhase: completed ? null : (values.WATERMARK_OBSERVE_FAILURE_PHASE || (publicStatus === 200 ? 'remote_script' : 'public_https')),
    rollbackComplete,
    checkedAt: { initial, first, second },
    database: parseBase64Json(values.DATABASE_B64, null),
    timer: {
      ...parseTimer(values.TIMER_STATE),
      lastTrigger: values.LAST_TRIGGER || null,
      nextTrigger: values.NEXT_TRIGGER || null,
    },
    services: {
      admin: values.ADMIN_SERVICE || null,
      upgrade: values.UPGRADE_SERVICE || null,
      gateway: values.GATEWAY_SERVICE || null,
      caddy: values.CADDY_SERVICE || null,
    },
    health: {
      admin: Number(values.ADMIN_HEALTH || 0),
      upgrade: Number(values.UPGRADE_HEALTH || 0),
      gateway: Number(values.GATEWAY_HEALTH || 0),
      httpsLoopback: Number(values.HTTPS_LOOPBACK || 0),
      httpsPublic: publicStatus,
    },
  }
}

function upgradeRetentionRepairEnableScript(expectedHashes) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
expected_retention_cleanup='${expectedHashes.retentionCleanup}'
expected_retention_runner='${expectedHashes.retentionRunner}'
expected_package_cleaner='${expectedHashes.packageCleaner}'
expected_backup_cleaner='${expectedHashes.backupCleaner}'
expected_retention_qualification='${expectedHashes.retentionQualification}'
expected_database_connection='${expectedHashes.databaseConnection}'
expected_config='${expectedHashes.config}'
expected_timer_unit='${expectedHashes.timerUnit}'
service_template_b64='${expectedHashes.serviceTemplateB64}'
service=gaiop-upgrade-retention-cleanup.service
timer=gaiop-upgrade-retention-cleanup.timer
service_file=/etc/systemd/system/gaiop-upgrade-retention-cleanup.service
timer_file=/etc/systemd/system/gaiop-upgrade-retention-cleanup.timer
dropin_dir=/etc/systemd/system/gaiop-upgrade-retention-cleanup.service.d
dropin_file="$dropin_dir/99-gaiop-retention-production.conf"
policy_env=/etc/gaiop/upgrade-retention.policy
state_root=/var/lib/gaiop-upgrade
packages_root="$state_root/packages"
staging_root="$state_root/staging"
rollback_root=/var/backups/gaiop/upgrade
database="$state_root/napm-upgrade.db"
audit_root=/var/lib/gaiop-upgrade-retention
audit_log="$audit_root/retention-cleanup-audit.jsonl"
runtime_root=/run/gaiop-upgrade-retention
backup_root="/var/backups/gaiop/upgrade-retention-enable-$release_id"
work_root=$(mktemp -d /run/gaiop-upgrade-retention-enable.XXXXXX)
phase=precheck
mutation_started=0
complete=0
backup_created=0
backup_root_created=0
rollback_complete=0

timer_state() {
  active=$(systemctl is-active "$1" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$1" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || printf 000
}

audit_lines() {
  if [ -f "$audit_log" ]; then
    awk 'END { print NR + 0 }' "$audit_log"
  else
    printf 0
  fi
}

verify_root_owned_not_writable() {
  target="$1"
  test "$(stat -c '%u' "$target")" = 0
  target_mode=$(stat -c '%a' "$target")
  test "$((8#$target_mode & 8#22))" -eq 0
}

verify_root_owned_no_symlink() {
  target="$1"
  test ! -L "$target"
  test "$(stat -c '%u' "$target")" = 0
}

verify_trusted_tree_ownership() {
  target="$1"
  test -d "$target"
  test ! -L "$target"
  unsafe_entry=$(find -P "$target" -xdev \( -type l -o ! -uid 0 \) -print -quit)
  test -z "$unsafe_entry"
}

verify_trusted_tree() {
  target="$1"
  verify_trusted_tree_ownership "$target"
  unsafe_entry=$(find -P "$target" -xdev \( -type l -o -perm /022 \) -print -quit)
  test -z "$unsafe_entry"
}

write_policy() {
  enabled="$1"
  candidate=$(mktemp /etc/gaiop/.upgrade-retention.policy.XXXXXX)
  if ! { cat > "$candidate" <<EOF
NAPM_UPGRADE_DB_PATH=/var/lib/gaiop-upgrade/napm-upgrade.db
NAPM_UPGRADE_PACKAGE_STAGING_ROOT=/var/lib/gaiop-upgrade/staging
NAPM_UPGRADE_BACKUP_ROOT=/var/backups/gaiop/upgrade
GAIOP_UPGRADE_RETENTION_AUTO_DELETE=$enabled
GAIOP_UPGRADE_RETENTION_MAX_ITEMS=100
GAIOP_UPGRADE_RETENTION_AUDIT_LOG=/var/lib/gaiop-upgrade-retention/retention-cleanup-audit.jsonl
GAIOP_UPGRADE_RETENTION_LOCK_PATH=/run/gaiop-upgrade-retention/cleanup.lock
GAIOP_UPGRADE_FAILED_PACKAGE_RETENTION_DAYS=7
GAIOP_UPGRADE_STAGING_RETENTION_HOURS=24
GAIOP_UPGRADE_BACKUP_RETENTION_DAYS=90
GAIOP_UPGRADE_BACKUP_MIN_USABLE_GROUPS=5
EOF
    chown root:root "$candidate"
    chmod 0600 "$candidate"
    mv -f -- "$candidate" "$policy_env"
  }; then
    rm -f -- "$candidate"
    return 1
  fi
}

verify_effective_unit() {
  test "$(systemctl show "$service" -p WorkingDirectory --value)" = "$current_root"
  test "$(systemctl show "$service" -p DropInPaths --value)" = "$dropin_file"
  effective_exec=$(systemctl show "$service" -p ExecStart --value)
  test "$(printf '%s' "$effective_exec" | grep -o 'path=' | wc -l | tr -d '[:space:]')" = 1
  test "$(printf '%s' "$effective_exec" | grep -o 'argv\[\]=' | wc -l | tr -d '[:space:]')" = 1
  printf '%s' "$effective_exec" | grep -F -- 'path=/usr/local/bin/node' >/dev/null
  printf '%s' "$effective_exec" | grep -F -- "argv[]=/usr/local/bin/node $current_root/src/retention-cleanup.js ;" >/dev/null
  effective_environment_files=$(systemctl show "$service" -p EnvironmentFiles --value)
  printf '%s\n' "$effective_environment_files" | grep -F -- "$main_env (ignore_errors=no)" >/dev/null
  if printf '%s\n' "$effective_environment_files" | grep -F -- '/etc/gaiop/upgrade.env' >/dev/null; then
    return 1
  fi
  cmp -s "$work_root/99-gaiop-retention-production.conf" "$dropin_file"
  test -f "$policy_env"
  test ! -L "$policy_env"
  test "$(stat -c '%u:%a' "$policy_env")" = '0:600'
  test "$(systemctl show "$service" -p ReadWritePaths --value)" = '/var/lib/gaiop-upgrade /var/lib/gaiop-upgrade-retention /var/backups/gaiop/upgrade /run/gaiop-upgrade-retention'
}

verify_base_service_file() {
  test -f "$service_file"
  test ! -L "$service_file"
  test "$(stat -c '%u:%a' "$service_file")" = '0:644'
  printf '%s' "$service_template_b64" | base64 -d > "$work_root/source-cleanup.service"
  sed "s#/opt/gaiop/upgrade#$current_root#g; s/\r$//" "$work_root/source-cleanup.service" > "$work_root/expected-cleanup.service"
  sed 's/\r$//' "$service_file" > "$work_root/actual-cleanup.service"
  cmp -s "$work_root/expected-cleanup.service" "$work_root/actual-cleanup.service"
  normalized_service=$(sed 's/\r$//' "$service_file")
  printf '%s\n' "$normalized_service" | grep -Fx -- "WorkingDirectory=$current_root" >/dev/null
  printf '%s\n' "$normalized_service" | grep -Fx -- "ExecStart=/usr/local/bin/node $current_root/src/retention-cleanup.js" >/dev/null
  printf '%s\n' "$normalized_service" | grep -Fx -- 'EnvironmentFile=/etc/gaiop/upgrade.env' >/dev/null
  printf '%s\n' "$normalized_service" | grep -Fx -- 'ReadWritePaths=/var/lib/gaiop/upgrade' >/dev/null
  printf '%s\n' "$normalized_service" | grep -Fx -- 'ReadWritePaths=/var/backups/gaiop/upgrade' >/dev/null
  printf '%s\n' "$normalized_service" | grep -Fx -- 'ReadWritePaths=/run/gaiop-upgrade-retention' >/dev/null
  for required_directive in \
    'User=root' \
    'Group=root' \
    'NoNewPrivileges=true' \
    'PrivateTmp=true' \
    'PrivateDevices=true' \
    'ProtectSystem=strict' \
    'ProtectHome=read-only' \
    'UMask=0027'
  do
    printf '%s\n' "$normalized_service" | grep -Fx -- "$required_directive" >/dev/null
  done
}

unit_shape() {
  shape_exec=$(systemctl show "$service" -p ExecStart --value | sed -n 's/.*{ path=\([^;]*\) ; argv\[\]=\([^;]*\) ;.*/\1|\2/p')
  {
    systemctl show "$service" -p WorkingDirectory --value
    systemctl show "$service" -p DropInPaths --value
    printf '%s\n' "$shape_exec"
    systemctl show "$service" -p EnvironmentFiles --value
    systemctl show "$service" -p ReadWritePaths --value
  } | sha256sum | awk '{print $1}'
}

print_unit_diagnostics() {
  printf 'DIAG_WORKING_DIRECTORY=%s\n' "$(systemctl show "$service" -p WorkingDirectory --value 2>/dev/null || true)"
  printf 'DIAG_DROPIN_PATHS=%s\n' "$(systemctl show "$service" -p DropInPaths --value 2>/dev/null || true)"
  printf 'DIAG_EXEC_START=%s\n' "$(systemctl show "$service" -p ExecStart --value 2>/dev/null || true)"
  printf 'DIAG_ENVIRONMENT_FILES=%s\n' "$(systemctl show "$service" -p EnvironmentFiles --value 2>/dev/null || true)"
  printf 'DIAG_READ_WRITE_PATHS=%s\n' "$(systemctl show "$service" -p ReadWritePaths --value 2>/dev/null || true)"
}

verify_audit_file() {
  test -f "$audit_log"
  test ! -L "$audit_log"
  test "$(readlink -f "$audit_log")" = "$audit_log"
  test "$(stat -c '%u:%g' "$audit_log")" = '0:0'
  audit_mode=$(stat -c '%a' "$audit_log")
  test "$((8#$audit_mode & 8#22))" -eq 0
  current_audit_identity=$(stat -c '%d:%i' "$audit_log")
  if [ "$audit_identity" != absent ]; then test "$current_audit_identity" = "$audit_identity"; fi
}

create_audit_file() {
  if [ "$audit_identity" = absent ]; then
    test ! -e "$audit_log"
    test ! -L "$audit_log"
    audit_seed=$(mktemp "$audit_root/.retention-cleanup-audit.XXXXXX")
    if ! {
      chown root:root "$audit_seed"
      chmod 0640 "$audit_seed"
      ln -- "$audit_seed" "$audit_log"
    }; then
      rm -f -- "$audit_seed"
      return 1
    fi
    rm -f -- "$audit_seed"
    audit_identity=$(stat -c '%d:%i' "$audit_log")
  fi
  verify_audit_file
}

snapshot() {
  /usr/local/bin/node - "$current_root/node_modules/better-sqlite3" "$database" "$packages_root" "$staging_root" "$rollback_root" <<'NODE' | base64 -w 0
const fs = require('node:fs')
const [moduleRoot, databasePath, packagesRoot, stagingRoot, rollbackRoot] = process.argv.slice(2)
const Database = require(moduleRoot)

function rootSummary(root) {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-managed-root')
  const entries = fs.readdirSync(root, { withFileTypes: true })
  let directFileBytes = 0
  for (const entry of entries) {
    const child = fs.lstatSync(require('node:path').join(root, entry.name))
    if (child.isFile() && !child.isSymbolicLink()) directFileBytes += child.size
  }
  return { count: entries.length, directFileBytes }
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  db.pragma('query_only = ON')
  const integrity = db.pragma('integrity_check', { simple: true })
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  let totalRows = 0
  const selected = {}
  for (const { name } of tableNames) {
    const quoted = '"' + String(name).replaceAll('"', '""') + '"'
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM ' + quoted).get().count)
    totalRows += count
    if (['upgrade_tasks', 'backups', 'components'].includes(name)) selected[name] = count
  }
  const taskStatuses = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM upgrade_tasks GROUP BY status ORDER BY status')
    .all().map((row) => [String(row.status), Number(row.count)]))
  const componentStatuses = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM components GROUP BY status ORDER BY status')
    .all().map((row) => [String(row.status), Number(row.count)]))
  process.stdout.write(JSON.stringify({
    database: { integrity, totalRows, selected, taskStatuses, componentStatuses },
    roots: {
      packages: rootSummary(packagesRoot),
      staging: rootSummary(stagingRoot),
      rollback: rootSummary(rollbackRoot),
    },
  }))
} finally {
  db.close()
}
NODE
}

assert_no_active_tasks() {
  printf '%s' "$1" | base64 -d | /usr/local/bin/node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  const statuses = value.database.taskStatuses || {};
  const components = value.database.componentStatuses || {};
  if ((statuses.running || 0) !== 0 || (statuses.rolling_back || 0) !== 0 || (components.upgrading || 0) !== 0) process.exit(1);
});'
}

assert_managed_snapshot_unchanged() {
  /usr/local/bin/node - "$1" "$2" <<'NODE'
const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
const managed = (value) => ({
  database: {
    integrity: value.database.integrity,
    selected: value.database.selected,
    taskStatuses: value.database.taskStatuses,
    componentStatuses: value.database.componentStatuses,
  },
  roots: value.roots,
})
const before = managed(decode(process.argv[2]))
const after = managed(decode(process.argv[3]))
if (JSON.stringify(before) !== JSON.stringify(after)) process.exit(1)
NODE
}

journal_cursor() {
  journalctl --sync
  journalctl --quiet --no-pager -n 0 --show-cursor | sed -n 's/^-- cursor: //p'
}

journal_policy_record_count() {
  journalctl --quiet --no-pager --after-cursor="$1" --unit="$service" -o cat | /usr/local/bin/node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let count = 0;
  for (const line of input.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (value.policyVersion === "gaiop_upgrade_retention.v1" && value.phase === "completed") count += 1;
    } catch {}
  }
  process.stdout.write(String(count));
});'
}

validate_journal() {
  invocation="$1"
  output_file="$2"
  cursor=''
  if [ "$#" -ge 3 ]; then cursor="$3"; fi
  journalctl --sync
  if [ -n "$invocation" ]; then
    journalctl --quiet --no-pager _SYSTEMD_INVOCATION_ID="$invocation" -o cat > "$output_file"
  else
    test -n "$cursor"
    journalctl --quiet --no-pager --after-cursor="$cursor" --unit="$service" -o cat > "$output_file"
  fi
  /usr/local/bin/node - "$output_file" <<'NODE' | base64 -w 0
const fs = require('node:fs')
const records = []
for (const line of fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  try {
    const value = JSON.parse(line)
    if (value.policyVersion === 'gaiop_upgrade_retention.v1') records.push(value)
  } catch {}
}
const categories = ['upgrade_task_package', 'upgrade_staging_package', 'upgrade_rollback_backup']
if (records.length !== 3) process.exit(10)
if (JSON.stringify(records.map((item) => item.category).sort()) !== JSON.stringify(categories.slice().sort())) process.exit(11)
for (const item of records) {
  if (item.phase !== 'completed') process.exit(12)
  if (item.candidateCount !== 0 || item.failed !== 0 || item.success !== 0 || item.freedBytes !== 0) process.exit(13)
}
process.stdout.write(JSON.stringify(records.map((item) => ({
  category: item.category,
  candidateCount: item.candidateCount,
  skipped: item.skipped,
  failed: item.failed,
  success: item.success,
  freedBytes: item.freedBytes,
  failureReasons: item.failureReasons,
}))))
NODE
}

validate_audit_tail() {
  output_file="$1"
  tail -n 6 "$audit_log" > "$output_file"
  /usr/local/bin/node - "$output_file" <<'NODE' | base64 -w 0
const fs = require('node:fs')
const records = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const categories = ['upgrade_task_package', 'upgrade_staging_package', 'upgrade_rollback_backup']
if (records.length !== 6) process.exit(20)
for (const phase of ['reserved', 'completed']) {
  const selected = records.filter((item) => item.phase === phase)
  if (selected.length !== 3) process.exit(21)
  if (JSON.stringify(selected.map((item) => item.category).sort()) !== JSON.stringify(categories.slice().sort())) process.exit(22)
  for (const item of selected) {
    if (item.policyVersion !== 'gaiop_upgrade_retention.v1' || item.candidateCount !== 0 || item.failed !== 0) process.exit(23)
    if (phase === 'completed' && (item.success !== 0 || item.freedBytes !== 0)) process.exit(24)
  }
}
process.stdout.write(JSON.stringify(records.map((item) => ({
  phase: item.phase,
  category: item.category,
  candidateCount: item.candidateCount,
  skipped: item.skipped,
  failed: item.failed,
  success: item.success,
  freedBytes: item.freedBytes,
  failureReasons: item.failureReasons,
}))))
NODE
}

run_and_validate() {
  label="$1"
  test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
  systemctl reset-failed "$service" >/dev/null 2>&1 || true
  cursor=$(journal_cursor)
  test -n "$cursor"
  systemctl start "$service"
  test "$(systemctl show "$service" -p Result --value)" = success
  test "$(systemctl show "$service" -p ExecMainStatus --value)" = 0
  invocation=$(systemctl show "$service" -p InvocationID --value 2>/dev/null || true)
  validate_journal "$invocation" "$work_root/$label.journal" "$cursor"
}

restore_original_timer_state() {
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
  if [ "$original_timer_enabled" = enabled ]; then systemctl enable "$timer" >/dev/null 2>&1 || true; fi
  if [ "$original_timer_active" = active ]; then systemctl start "$timer" >/dev/null 2>&1 || true; fi
}

rollback() {
  set +e
  rollback_complete=0
  rollback_ok=1
  systemctl disable --now "$timer" >/dev/null 2>&1 || true
  systemctl stop "$service" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    rollback_service_state=$(systemctl is-active "$service" 2>/dev/null || true)
    case "$rollback_service_state" in
      active|activating|deactivating) sleep 1 ;;
      *) break ;;
    esac
  done
  systemctl reset-failed "$service" >/dev/null 2>&1 || true
  [ "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive ] || rollback_ok=0
  [ "$(timer_state "$timer")" = 'inactive|disabled' ] || rollback_ok=0
  if [ "$backup_created" = 1 ] && [ "$rollback_ok" = 1 ]; then
    if [ -f "$backup_root/original-dropin.conf" ]; then
      install -d -o root -g root -m 0755 "$dropin_dir"
      cp -a -- "$backup_root/original-dropin.conf" "$dropin_file"
    else
      rm -f -- "$dropin_file"
      rmdir "$dropin_dir" >/dev/null 2>&1 || true
    fi
    if [ -f "$backup_root/original-policy.policy" ]; then
      cp -a -- "$backup_root/original-policy.policy" "$policy_env"
    else
      rm -f -- "$policy_env"
    fi
    systemctl daemon-reload
    restore_original_timer_state
  fi
  if [ "$rollback_ok" = 1 ]; then rmdir "$audit_root" >/dev/null 2>&1 || true; fi
  [ "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive ] || rollback_ok=0
  [ "$(timer_state "$timer")" = "$original_timer_active|$original_timer_enabled" ] || rollback_ok=0
  if [ "$original_dropin_hash" = absent ]; then
    [ ! -e "$dropin_file" ] || rollback_ok=0
  else
    [ -f "$dropin_file" ] && [ "$(sha256sum "$dropin_file" | awk '{print $1}')" = "$original_dropin_hash" ] || rollback_ok=0
  fi
  if [ "$original_policy_hash" = absent ]; then
    [ ! -e "$policy_env" ] || rollback_ok=0
  else
    [ -f "$policy_env" ] && [ "$(sha256sum "$policy_env" | awk '{print $1}')" = "$original_policy_hash" ] || rollback_ok=0
  fi
  [ "$(unit_shape)" = "$original_unit_shape" ] || rollback_ok=0
  [ "$rollback_ok" = 1 ] && rollback_complete=1
  set -e
}

finish() {
  status=$?
  if [ "$status" -eq 0 ] && [ "$complete" = 1 ]; then exit 0; fi
  if [ "$mutation_started" = 1 ]; then
    rollback
  else
    rollback_complete=1
    if [ "$backup_root_created" = 1 ] && [ "$backup_created" != 1 ]; then
      case "$backup_root" in
        /var/backups/gaiop/upgrade-retention-enable-$release_id) rm -rf -- "$backup_root" ;;
        *) rollback_complete=0 ;;
      esac
      [ ! -e "$backup_root" ] || rollback_complete=0
    fi
  fi
  rm -rf -- "$work_root"
  printf 'FAILED_PHASE=%s\n' "$phase"
  if [ "$rollback_complete" = 1 ]; then
    printf 'ROLLBACK_COMPLETE=1\n'
  else
    printf 'ROLLBACK_COMPLETE=0\n'
  fi
  if [ -f "$audit_log" ] && [ ! -L "$audit_log" ]; then printf 'AUDIT_EVIDENCE_PRESERVED=1\n'; fi
  exit "$status"
}
trap finish EXIT

phase=precheck
test "$(systemctl is-active gaiop-upgrade.service)" = active
test "$(timer_state "$timer")" = 'inactive|disabled'
test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
test -f "$service_file"
test -f "$timer_file"
test "$(sed 's/\r$//' "$timer_file" | sha256sum | awk '{print $1}')" = "$expected_timer_unit"
test -z "$(systemctl show "$service" -p DropInPaths --value)"
test ! -e "$dropin_file"
test ! -L "$dropin_file"
test ! -e "$policy_env"
test ! -L "$policy_env"
test -d "$state_root"
test -d "$packages_root"
test -d "$staging_root"
test -d "$rollback_root"
for managed_root in "$state_root" "$packages_root" "$staging_root" "$rollback_root"; do
  test ! -L "$managed_root"
  test "$(readlink -f "$managed_root")" = "$managed_root"
done
test -f "$database"
test ! -L "$database"
test ! -e "$backup_root"
if [ -e "$audit_root" ] || [ -L "$audit_root" ]; then
  test -d "$audit_root"
  test ! -L "$audit_root"
  test "$(readlink -f "$audit_root")" = "$audit_root"
  verify_root_owned_not_writable "$audit_root"
  unexpected_audit_entry=$(find "$audit_root" -mindepth 1 -maxdepth 1 ! -name 'retention-cleanup-audit.jsonl' -print -quit)
  test -z "$unexpected_audit_entry"
  if [ -e "$audit_log" ] || [ -L "$audit_log" ]; then
    test -f "$audit_log"
    test ! -L "$audit_log"
    audit_identity=$(stat -c '%d:%i' "$audit_log")
    verify_audit_file
  else
    audit_identity=absent
  fi
else
  audit_identity=absent
fi

current_root=$(systemctl show gaiop-upgrade.service -p WorkingDirectory --value)
case "$current_root" in
  /opt/gaiop-upgrade-e2e-[0-9]*|/opt/gaiop/upgrade) ;;
  *) exit 41 ;;
esac
test -d "$current_root"
test ! -L "$current_root"
test "$(readlink -f "$current_root")" = "$current_root"
test -f "$current_root/src/retention-cleanup.js"
test -d "$current_root/node_modules/better-sqlite3"
for trusted_path in \
  "$current_root" \
  "$current_root/src" \
  "$current_root/src/services" \
  "$current_root/node_modules" \
  "$current_root/src/retention-cleanup.js" \
  "$current_root/src/services/RetentionRunner.js" \
  "$current_root/src/services/PackageCleaner.js" \
  "$current_root/src/services/BackupCleaner.js"
do
  verify_root_owned_no_symlink "$trusted_path"
done
for trusted_tree in \
  "$current_root/src" \
  "$current_root/node_modules/better-sqlite3" \
  "$current_root/node_modules/bindings" \
  "$current_root/node_modules/file-uri-to-path" \
  "$current_root/node_modules/dotenv"
do
  verify_trusted_tree_ownership "$trusted_tree"
done
if [ -e "$current_root/.env" ]; then
  test -f "$current_root/.env"
  test ! -L "$current_root/.env"
  verify_root_owned_not_writable "$current_root/.env"
fi
test "$(sha256sum "$current_root/src/retention-cleanup.js" | awk '{print $1}')" = "$expected_retention_cleanup"
test "$(sha256sum "$current_root/src/services/RetentionRunner.js" | awk '{print $1}')" = "$expected_retention_runner"
test "$(sha256sum "$current_root/src/services/PackageCleaner.js" | awk '{print $1}')" = "$expected_package_cleaner"
test "$(sha256sum "$current_root/src/services/BackupCleaner.js" | awk '{print $1}')" = "$expected_backup_cleaner"
test "$(sha256sum "$current_root/src/services/RetentionQualification.js" | awk '{print $1}')" = "$expected_retention_qualification"
test "$(sha256sum "$current_root/src/database/connection.js" | awk '{print $1}')" = "$expected_database_connection"
test "$(sha256sum "$current_root/src/config.js" | awk '{print $1}')" = "$expected_config"
verify_base_service_file

environment_files=$(systemctl show gaiop-upgrade.service -p EnvironmentFiles --value)
main_env=$(printf '%s\n' "$environment_files" | grep -oE '/etc/[A-Za-z0-9._/-]+\.env' | awk '/^\/etc\/gaiop-upgrade\// { print; exit }')
case "$main_env" in
  /etc/gaiop-upgrade/*.env) ;;
  *) exit 42 ;;
esac
test -f "$main_env"
test ! -L "$main_env"
test "$(stat -c '%u' "$main_env")" = 0
main_env_mode=$(stat -c '%a' "$main_env")
test "$((8#$main_env_mode & 8#22))" -eq 0

original_timer_active=$(systemctl is-active "$timer" 2>/dev/null || true)
original_timer_enabled=$(systemctl is-enabled "$timer" 2>/dev/null || true)
if [ -f "$dropin_file" ]; then
  original_dropin_hash=$(sha256sum "$dropin_file" | awk '{print $1}')
else
  original_dropin_hash=absent
fi
if [ -f "$policy_env" ]; then
  original_policy_hash=$(sha256sum "$policy_env" | awk '{print $1}')
else
  original_policy_hash=absent
fi
original_unit_shape=$(unit_shape)

phase=backup
install -d -o root -g root -m 0700 "$backup_root"
backup_root_created=1
cp -a -- "$service_file" "$backup_root/gaiop-upgrade-retention-cleanup.service"
cp -a -- "$timer_file" "$backup_root/gaiop-upgrade-retention-cleanup.timer"
if [ -f "$dropin_file" ]; then cp -a -- "$dropin_file" "$backup_root/original-dropin.conf"; fi
  if [ -f "$policy_env" ]; then cp -a -- "$policy_env" "$backup_root/original-policy.policy"; fi
printf '%s\n' "$original_timer_active" > "$backup_root/original-timer-active"
printf '%s\n' "$original_timer_enabled" > "$backup_root/original-timer-enabled"
printf '%s\n' "$original_unit_shape" > "$backup_root/original-unit-shape"
/usr/local/bin/node - "$current_root/node_modules/better-sqlite3" "$database" "$backup_root/napm-upgrade.db.before-enable" <<'NODE'
const [moduleRoot, source, destination] = process.argv.slice(2)
const Database = require(moduleRoot)
;(async () => {
  const sourceDb = new Database(source, { readonly: true, fileMustExist: true })
  try {
    if (sourceDb.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('source-integrity')
    await sourceDb.backup(destination)
  } finally {
    sourceDb.close()
  }
  const backupDb = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    if (backupDb.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup-integrity')
  } finally {
    backupDb.close()
  }
})().catch(() => process.exit(1))
NODE
chmod 0600 "$backup_root/napm-upgrade.db.before-enable"
backup_created=1

phase=install_closed_policy
mutation_started=1
systemctl disable --now "$timer" >/dev/null 2>&1 || true
install -d -o root -g root -m 0755 "$dropin_dir"
install -d -o root -g root -m 0750 "$audit_root"
verify_root_owned_not_writable "$audit_root"
permission_manifest="$backup_root/code-permissions-before"
: > "$permission_manifest"
for trusted_tree in \
  "$current_root/src" \
  "$current_root/node_modules/better-sqlite3" \
  "$current_root/node_modules/bindings" \
  "$current_root/node_modules/file-uri-to-path" \
  "$current_root/node_modules/dotenv"
do
  find -P "$trusted_tree" -xdev -printf '%u:%g:%m:%p\n' >> "$permission_manifest"
done
LC_ALL=C sort -o "$permission_manifest" "$permission_manifest"
chmod 0600 "$permission_manifest"
for trusted_tree in \
  "$current_root/src" \
  "$current_root/node_modules/better-sqlite3" \
  "$current_root/node_modules/bindings" \
  "$current_root/node_modules/file-uri-to-path" \
  "$current_root/node_modules/dotenv"
do
  find -P "$trusted_tree" -xdev -type d -exec chmod go-w -- {} +
  find -P "$trusted_tree" -xdev -type f -exec chmod go-w -- {} +
  verify_trusted_tree "$trusted_tree"
done
cat > "$work_root/99-gaiop-retention-production.conf" <<EOF
[Service]
WorkingDirectory=$current_root
EnvironmentFile=
EnvironmentFile=$main_env
EnvironmentFile=$policy_env
ExecStart=
ExecStart=/usr/local/bin/node $current_root/src/retention-cleanup.js
ReadWritePaths=
ReadWritePaths=/var/lib/gaiop-upgrade
ReadWritePaths=/var/lib/gaiop-upgrade-retention
ReadWritePaths=/var/backups/gaiop/upgrade
ReadWritePaths=/run/gaiop-upgrade-retention
EOF
install -o root -g root -m 0644 "$work_root/99-gaiop-retention-production.conf" "$dropin_file"
write_policy false
cmp -s "$work_root/99-gaiop-retention-production.conf" "$dropin_file"
systemctl daemon-reload

phase=verify_unit
print_unit_diagnostics
systemd-analyze verify "$service_file" "$timer_file" /etc/systemd/system/gaiop-upgrade.service
verify_effective_unit
test "$(timer_state "$timer")" = 'inactive|disabled'

phase=closed_run
before_snapshot=$(snapshot)
assert_no_active_tasks "$before_snapshot"
before_audit_lines=$(audit_lines)
closed_records=$(run_and_validate closed)
after_closed_snapshot=$(snapshot)
phase=closed_managed_snapshot
assert_managed_snapshot_unchanged "$before_snapshot" "$after_closed_snapshot"
phase=closed_audit
test "$before_audit_lines" = "$(audit_lines)"

phase=enabled_run
write_policy true
grep -Fx 'GAIOP_UPGRADE_RETENTION_AUTO_DELETE=true' "$policy_env" >/dev/null
before_enabled_snapshot=$(snapshot)
assert_managed_snapshot_unchanged "$before_snapshot" "$before_enabled_snapshot"
assert_no_active_tasks "$before_enabled_snapshot"
create_audit_file
before_enabled_audit=$(audit_lines)
enabled_records=$(run_and_validate enabled)
after_enabled_audit=$(audit_lines)
test "$after_enabled_audit" -eq "$((before_enabled_audit + 6))"
enabled_audit=$(validate_audit_tail "$work_root/enabled.audit")
verify_audit_file
if [ "$audit_identity" = absent ]; then audit_identity=$(stat -c '%d:%i' "$audit_log"); fi
after_enabled_snapshot=$(snapshot)
assert_managed_snapshot_unchanged "$before_snapshot" "$after_enabled_snapshot"

phase=enable_timer
before_timer_audit=$(audit_lines)
timer_cursor=$(journal_cursor)
test -n "$timer_cursor"
systemctl enable --now "$timer" >/dev/null
test "$(timer_state "$timer")" = 'active|enabled'
timer_records=''
timer_audit=''
timer_compensation=waiting
timer_observed=0
phase=observe_timer
for _ in $(seq 1 960); do
  timer_record_count=$(journal_policy_record_count "$timer_cursor")
  if [ "$timer_record_count" -ge 3 ]; then
    timer_observed=1
    break
  fi
  sleep 1
done
if [ "$timer_observed" = 1 ]; then
  phase=validate_timer
  for _ in $(seq 1 60); do
    timer_service_state=$(systemctl is-active "$service" 2>/dev/null || true)
    case "$timer_service_state" in
      active|activating|deactivating) sleep 1 ;;
      *) break ;;
    esac
  done
  test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
  test "$(systemctl show "$service" -p Result --value)" = success
  timer_records=$(validate_journal '' "$work_root/timer.journal" "$timer_cursor")
  after_timer_audit=$(audit_lines)
  test "$after_timer_audit" -eq "$((before_timer_audit + 6))"
  timer_audit=$(validate_audit_tail "$work_root/timer.audit")
  verify_audit_file
  timer_snapshot=$(snapshot)
  assert_managed_snapshot_unchanged "$before_snapshot" "$timer_snapshot"
  timer_compensation=validated
else
  scheduled_trigger=$(systemctl show "$timer" -p NextElapseUSecRealtime --value)
  test -n "$scheduled_trigger"
  scheduled_epoch=$(date -d "$scheduled_trigger" +%s)
  now_epoch=$(date -u +%s)
  test "$scheduled_epoch" -gt "$((now_epoch + 300))"
  systemctl stop "$timer"
  test "$(timer_state "$timer")" = 'inactive|enabled'
  for _ in $(seq 1 60); do
    timer_service_state=$(systemctl is-active "$service" 2>/dev/null || true)
    case "$timer_service_state" in
      active|activating|deactivating) sleep 1 ;;
      *) break ;;
    esac
  done
  test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
  late_record_count=$(journal_policy_record_count "$timer_cursor")
  if [ "$late_record_count" -ge 3 ]; then
    test "$(systemctl show "$service" -p Result --value)" = success
    timer_records=$(validate_journal '' "$work_root/timer-late.journal" "$timer_cursor")
    after_timer_audit=$(audit_lines)
    test "$after_timer_audit" -eq "$((before_timer_audit + 6))"
    timer_audit=$(validate_audit_tail "$work_root/timer-late.audit")
    verify_audit_file
    timer_snapshot=$(snapshot)
    assert_managed_snapshot_unchanged "$before_snapshot" "$timer_snapshot"
    timer_compensation=validated_late
  else
    test "$before_timer_audit" = "$(audit_lines)"
    timer_compensation=scheduled_next_run
  fi
  systemctl start "$timer"
  test "$(timer_state "$timer")" = 'active|enabled'
fi

phase=final_verify
test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
test "$(systemctl show "$service" -p Result --value)" = success
test "$(timer_state gaiop-admin-retention-cleanup.timer)" = 'active|enabled'
test "$(timer_state "$timer")" = 'active|enabled'
for other_timer in gaiop-report-retention-cleanup.timer gaiop-admin-session-retention.timer gaiop-admin-sqlite-backup.timer gaiop-upgrade-sqlite-backup.timer; do
  test "$(timer_state "$other_timer")" = 'inactive|disabled'
done
test "$(timer_state gaiop-storage-watermark-monitor.timer)" = 'active|enabled'
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(systemctl is-active gaiop-upgrade.service)" = active
test "$(systemctl is-active caddy.service)" = active
gateway_uid=$(id -u netinside)
test "$(runuser -u netinside -- env XDG_RUNTIME_DIR=/run/user/$gateway_uid systemctl --user is-active openclaw-gateway.service)" = active
test "$(http_status http://127.0.0.1:3000/api/health)" = 200
test "$(http_status http://127.0.0.1:18900/health)" = 200
test "$(http_status http://127.0.0.1:18900/api/v1/upgrade/status)" = 401
test "$(http_status http://127.0.0.1:18789/health)" = 200
test "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/)" = 200
final_snapshot=$(snapshot)
assert_managed_snapshot_unchanged "$before_snapshot" "$final_snapshot"
verify_audit_file
verify_effective_unit
test -f "$dropin_file"
test ! -L "$dropin_file"
test "$(stat -c '%u:%g:%a' "$dropin_file")" = '0:0:644'
test -f "$policy_env"
test ! -L "$policy_env"
test "$(stat -c '%u:%g:%a' "$policy_env")" = '0:0:600'
grep -Fx 'GAIOP_UPGRADE_RETENTION_AUTO_DELETE=true' "$policy_env" >/dev/null
next_trigger=$(systemctl show "$timer" -p NextElapseUSecRealtime --value)
test -n "$next_trigger"
dropin_sha=$(sha256sum "$dropin_file" | awk '{print $1}')
policy_sha=$(sha256sum "$policy_env" | awk '{print $1}')
printf '%s\n' "$dropin_sha" > "$backup_root/installed-dropin-sha256"
printf '%s\n' "$policy_sha" > "$backup_root/installed-policy-sha256"
chmod 0600 "$backup_root/installed-dropin-sha256" "$backup_root/installed-policy-sha256"

complete=1
trap - EXIT
rm -rf -- "$work_root"
printf 'UPGRADE_RETENTION_ENABLE_COMPLETE=1\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_ROOT=%s\n' "$backup_root"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'
printf 'WORKING_DIRECTORY=%s\n' "$current_root"
printf 'CODE_PERMISSIONS_HARDENED=1\n'
printf 'CODE_PERMISSIONS_MANIFEST=%s\n' "$permission_manifest"
printf 'MAIN_ENVIRONMENT_FILE=%s\n' "$main_env"
printf 'DROPIN_SHA256=%s\n' "$dropin_sha"
printf 'POLICY_SHA256=%s\n' "$policy_sha"
printf 'NATIVE_SYSTEMD_VERIFY=ok\n'
printf 'CLOSED_RECORDS_B64=%s\n' "$closed_records"
printf 'ENABLED_RECORDS_B64=%s\n' "$enabled_records"
printf 'ENABLED_AUDIT_B64=%s\n' "$enabled_audit"
printf 'TIMER_COMPENSATION=%s\n' "$timer_compensation"
printf 'TIMER_RECORDS_B64=%s\n' "$timer_records"
printf 'TIMER_AUDIT_B64=%s\n' "$timer_audit"
printf 'FINAL_SNAPSHOT_B64=%s\n' "$final_snapshot"
printf 'TIMER_STATE=%s\n' "$(timer_state "$timer")"
printf 'NEXT_TRIGGER=%s\n' "$next_trigger"
printf 'ADMIN_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-retention-cleanup.timer)"
printf 'WATERMARK_TIMER=%s\n' "$(timer_state gaiop-storage-watermark-monitor.timer)"
printf 'REPORT_RETENTION_TIMER=%s\n' "$(timer_state gaiop-report-retention-cleanup.timer)"
printf 'SESSION_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-session-retention.timer)"
printf 'ADMIN_SQLITE_TIMER=%s\n' "$(timer_state gaiop-admin-sqlite-backup.timer)"
printf 'UPGRADE_SQLITE_TIMER=%s\n' "$(timer_state gaiop-upgrade-sqlite-backup.timer)"
printf 'ADMIN_HEALTH=200\n'
printf 'UPGRADE_HEALTH=200\n'
printf 'UPGRADE_UNAUTHENTICATED=401\n'
printf 'GATEWAY_HEALTH=200\n'
printf 'HTTPS_LOOPBACK=200\n'
`
}

function upgradeRetentionPostcheckRollbackScript() {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
service=gaiop-upgrade-retention-cleanup.service
timer=gaiop-upgrade-retention-cleanup.timer
dropin_dir=/etc/systemd/system/gaiop-upgrade-retention-cleanup.service.d
dropin_file="$dropin_dir/99-gaiop-retention-production.conf"
policy_env=/etc/gaiop/upgrade-retention.policy
backup_root="/var/backups/gaiop/upgrade-retention-enable-$release_id"

timer_state() {
  active=$(systemctl is-active "$1" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$1" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

unit_shape() {
  shape_exec=$(systemctl show "$service" -p ExecStart --value | sed -n 's/.*{ path=\([^;]*\) ; argv\[\]=\([^;]*\) ;.*/\1|\2/p')
  {
    systemctl show "$service" -p WorkingDirectory --value
    systemctl show "$service" -p DropInPaths --value
    printf '%s\n' "$shape_exec"
    systemctl show "$service" -p EnvironmentFiles --value
    systemctl show "$service" -p ReadWritePaths --value
  } | sha256sum | awk '{print $1}'
}

test -d "$backup_root"
test ! -L "$backup_root"
test "$(readlink -f "$backup_root")" = "$backup_root"
test "$(stat -c '%u:%g:%a' "$backup_root")" = '0:0:700'
for state_file in original-timer-active original-timer-enabled original-unit-shape installed-dropin-sha256 installed-policy-sha256; do
  test -f "$backup_root/$state_file"
  test ! -L "$backup_root/$state_file"
  test "$(stat -c '%u' "$backup_root/$state_file")" = 0
  state_mode=$(stat -c '%a' "$backup_root/$state_file")
  test "$((8#$state_mode & 8#22))" -eq 0
done
test "$(<"$backup_root/original-timer-active")" = inactive
test "$(<"$backup_root/original-timer-enabled")" = disabled
original_unit_shape=$(<"$backup_root/original-unit-shape")
test -n "$original_unit_shape"
expected_dropin_sha=$(<"$backup_root/installed-dropin-sha256")
expected_policy_sha=$(<"$backup_root/installed-policy-sha256")
printf '%s\n' "$expected_dropin_sha" | grep -Eq '^[a-f0-9]{64}$'
printf '%s\n' "$expected_policy_sha" | grep -Eq '^[a-f0-9]{64}$'

systemctl disable --now "$timer" >/dev/null 2>&1 || true
systemctl stop "$service" >/dev/null 2>&1 || true
systemctl reset-failed "$service" >/dev/null 2>&1 || true
test "$(timer_state "$timer")" = 'inactive|disabled'
test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
test -f "$dropin_file"
test ! -L "$dropin_file"
test "$(sha256sum "$dropin_file" | awk '{print $1}')" = "$expected_dropin_sha"
test -f "$policy_env"
test ! -L "$policy_env"
test "$(sha256sum "$policy_env" | awk '{print $1}')" = "$expected_policy_sha"
rm -f -- "$dropin_file" "$policy_env"
rmdir "$dropin_dir" >/dev/null 2>&1 || true
systemctl daemon-reload

test "$(systemctl is-active "$service" 2>/dev/null || true)" = inactive
test "$(timer_state "$timer")" = 'inactive|disabled'
test ! -e "$dropin_file"
test ! -L "$dropin_file"
test ! -e "$policy_env"
test ! -L "$policy_env"
test "$(unit_shape)" = "$original_unit_shape"
printf 'POSTCHECK_ROLLBACK_COMPLETE=1\n'
printf 'AUDIT_EVIDENCE_PRESERVED=1\n'
printf 'BACKUP_ROOT=%s\n' "$backup_root"
printf 'TIMER_STATE=%s\n' "$(timer_state "$timer")"
printf 'UPGRADE_HEALTH=%s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health 2>/dev/null || printf 000)"
`
}

async function repairEnableUpgradeRetention(client) {
  const publicHttpsBefore = await publicHttpsStatus()
  if (publicHttpsBefore !== 200) {
    return {
      completed: false,
      mode: 'repair-enable-upgrade-retention',
      errorCode: 'UPGRADE_RETENTION_PUBLIC_PREFLIGHT_FAILED',
      failedPhase: 'public_https_preflight',
      rollbackComplete: true,
      health: { httpsPublicBefore: publicHttpsBefore, httpsPublicAfter: null },
    }
  }
  const expectedHashes = {
    retentionCleanup: await sha256(join(upgradeSourceRoot, 'src', 'retention-cleanup.js')),
    retentionRunner: await sha256(join(upgradeSourceRoot, 'src', 'services', 'RetentionRunner.js')),
    packageCleaner: await sha256(join(upgradeSourceRoot, 'src', 'services', 'PackageCleaner.js')),
    backupCleaner: await sha256(join(upgradeSourceRoot, 'src', 'services', 'BackupCleaner.js')),
    retentionQualification: await sha256(join(upgradeSourceRoot, 'src', 'services', 'RetentionQualification.js')),
    databaseConnection: await sha256(join(upgradeSourceRoot, 'src', 'database', 'connection.js')),
    config: await sha256(join(upgradeSourceRoot, 'src', 'config.js')),
    timerUnit: sha256NormalizedText(join(upgradeSourceRoot, 'deploy', 'systemd', 'gaiop-upgrade-retention-cleanup.timer')),
    serviceTemplateB64: readFileSync(join(upgradeSourceRoot, 'deploy', 'systemd', 'gaiop-upgrade-retention-cleanup.service')).toString('base64'),
  }
  const remote = await runValidatedSudoScript(client, upgradeRetentionRepairEnableScript(expectedHashes))
  const values = parseKeyValues(remote.output)
  const remoteCompleted = remote.ok && values.UPGRADE_RETENTION_ENABLE_COMPLETE === '1'
  const publicHttpsAfter = remote.ok ? await publicHttpsStatus() : null
  let postcheckRollback = null
  let postcheckRollbackValues = {}
  let publicHttpsAfterRollback = null
  const needsPostcheckRollback = (remote.ok && (!remoteCompleted || publicHttpsAfter !== 200))
    || (!remote.ok && values.ROLLBACK_COMPLETE !== '1')
  if (needsPostcheckRollback) {
    postcheckRollback = await runValidatedSudoScript(client, upgradeRetentionPostcheckRollbackScript())
    postcheckRollbackValues = parseKeyValues(postcheckRollback.output)
    publicHttpsAfterRollback = await publicHttpsStatus()
  }
  const completed = remoteCompleted && publicHttpsAfter === 200
  const rollbackComplete = completed
    ? false
    : (postcheckRollback
        ? postcheckRollback.ok && postcheckRollbackValues.POSTCHECK_ROLLBACK_COMPLETE === '1'
        : values.ROLLBACK_COMPLETE === '1')
  return {
    completed,
    mode: 'repair-enable-upgrade-retention',
    errorCode: completed ? null : 'UPGRADE_RETENTION_ENABLE_FAILED',
    failedPhase: completed ? null : (publicHttpsAfter !== 200 && remoteCompleted ? 'public_https_postcheck' : (values.FAILED_PHASE || 'remote_script')),
    rollbackComplete,
    releaseId: values.RELEASE_ID || releaseId,
    rollbackPoint: values.BACKUP_ROOT || null,
    databaseBackupIntegrity: values.DATABASE_BACKUP_INTEGRITY || null,
    auditEvidencePreserved: postcheckRollbackValues.AUDIT_EVIDENCE_PRESERVED === '1'
      || values.AUDIT_EVIDENCE_PRESERVED === '1',
    runtime: {
      workingDirectory: values.WORKING_DIRECTORY || null,
      mainEnvironmentFile: values.MAIN_ENVIRONMENT_FILE || null,
      dropInSha256: values.DROPIN_SHA256 || null,
      policySha256: values.POLICY_SHA256 || null,
      nativeSystemdVerify: values.NATIVE_SYSTEMD_VERIFY || null,
      sourceHashes: expectedHashes,
    },
    diagnostics: {
      workingDirectory: values.DIAG_WORKING_DIRECTORY || null,
      dropInPaths: values.DIAG_DROPIN_PATHS || null,
      execStart: values.DIAG_EXEC_START || null,
      environmentFiles: values.DIAG_ENVIRONMENT_FILES || null,
      readWritePaths: values.DIAG_READ_WRITE_PATHS || null,
    },
    validation: {
      closedRecords: parseBase64Json(values.CLOSED_RECORDS_B64, []),
      enabledRecords: parseBase64Json(values.ENABLED_RECORDS_B64, []),
      enabledAudit: parseBase64Json(values.ENABLED_AUDIT_B64, []),
      timerCompensation: values.TIMER_COMPENSATION || null,
      timerRecords: parseBase64Json(values.TIMER_RECORDS_B64, []),
      timerAudit: parseBase64Json(values.TIMER_AUDIT_B64, []),
    },
    snapshot: parseBase64Json(values.FINAL_SNAPSHOT_B64, null),
    timers: {
      upgradeRetention: parseTimer(postcheckRollbackValues.TIMER_STATE || values.TIMER_STATE),
      adminRetention: parseTimer(values.ADMIN_RETENTION_TIMER),
      watermark: parseTimer(values.WATERMARK_TIMER),
      reportRetention: parseTimer(values.REPORT_RETENTION_TIMER),
      sessionRetention: parseTimer(values.SESSION_RETENTION_TIMER),
      adminSqlite: parseTimer(values.ADMIN_SQLITE_TIMER),
      upgradeSqlite: parseTimer(values.UPGRADE_SQLITE_TIMER),
      nextTrigger: values.NEXT_TRIGGER || null,
    },
    health: {
      admin: Number(values.ADMIN_HEALTH || 0),
      upgrade: Number(postcheckRollbackValues.UPGRADE_HEALTH || values.UPGRADE_HEALTH || 0),
      upgradeUnauthenticated: Number(values.UPGRADE_UNAUTHENTICATED || 0),
      gateway: Number(values.GATEWAY_HEALTH || 0),
      httpsLoopback: Number(values.HTTPS_LOOPBACK || 0),
      httpsPublicBefore: publicHttpsBefore,
      httpsPublicAfter: publicHttpsAfter,
      httpsPublicAfterRollback: publicHttpsAfterRollback,
    },
  }
}

function sqliteBackupEnableScript(expected) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
admin_root=/opt/gaiop/admin
admin_db=/var/lib/gaiop/admin/wizard.db
admin_backup_root=/var/lib/gaiop/admin/sqlite-backups
admin_restore_root=/var/lib/gaiop/admin/sqlite-restore-tests
admin_service=gaiop-admin-sqlite-backup.service
admin_timer=gaiop-admin-sqlite-backup.timer
admin_service_file=/etc/systemd/system/gaiop-admin-sqlite-backup.service
admin_timer_file=/etc/systemd/system/gaiop-admin-sqlite-backup.timer
admin_dropin_dir=/etc/systemd/system/gaiop-admin-sqlite-backup.service.d
admin_dropin_file=$admin_dropin_dir/99-gaiop-sqlite-backup-production.conf
admin_policy=/etc/gaiop/admin-sqlite-backup.policy
upgrade_service=gaiop-upgrade-sqlite-backup.service
upgrade_timer=gaiop-upgrade-sqlite-backup.timer
upgrade_service_file=/etc/systemd/system/gaiop-upgrade-sqlite-backup.service
upgrade_timer_file=/etc/systemd/system/gaiop-upgrade-sqlite-backup.timer
upgrade_dropin_dir=/etc/systemd/system/gaiop-upgrade-sqlite-backup.service.d
upgrade_dropin_file=$upgrade_dropin_dir/99-gaiop-sqlite-backup-production.conf
upgrade_policy=/etc/gaiop/upgrade-sqlite-backup.policy
upgrade_backup_root=/var/lib/gaiop-upgrade/sqlite-backups
upgrade_restore_root=/var/lib/gaiop-upgrade/sqlite-restore-tests
backup_root=/var/backups/gaiop/sqlite-backup-enable-$release_id
work_root=$(mktemp -d /run/gaiop-sqlite-backup-enable.XXXXXX)
phase=preflight
completed=0
backup_captured=0
rollback_complete=0

timer_state() {
  active=$(systemctl is-active "$1" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$1" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || printf 000
}

normalized_sha() {
  sed 's/\r$//' "$1" | sha256sum | awk '{print $1}'
}

capture_file() {
  source_path=$1
  label=$2
  if [ -e "$source_path" ] || [ -L "$source_path" ]; then
    test -f "$source_path"
    test ! -L "$source_path"
    cp -a -- "$source_path" "$backup_root/$label"
  else
    : > "$backup_root/$label.absent"
  fi
}

restore_file() {
  target_path=$1
  label=$2
  if [ -f "$backup_root/$label" ]; then
    install -d -o root -g root -m 0755 "$(dirname "$target_path")"
    rm -f -- "$target_path"
    cp -a -- "$backup_root/$label" "$target_path"
  elif [ -f "$backup_root/$label.absent" ]; then
    rm -f -- "$target_path"
  else
    return 1
  fi
}

restore_mode() {
  target_path=$1
  label=$2
  if [ -f "$backup_root/$label.mode" ]; then
    if [ -e "$target_path" ]; then
      test ! -L "$target_path"
      chmod "$(cat "$backup_root/$label.mode")" "$target_path"
    fi
  elif [ ! -f "$backup_root/$label.absent" ]; then
    return 1
  fi
}

restore_timer() {
  timer_name=$1
  state=$2
  systemctl disable --now "$timer_name" >/dev/null 2>&1 || true
  case "$state" in
    active\|enabled) systemctl enable --now "$timer_name" >/dev/null 2>&1 ;;
    inactive\|enabled) systemctl enable "$timer_name" >/dev/null 2>&1 ;;
    active\|disabled) systemctl start "$timer_name" >/dev/null 2>&1 ;;
    inactive\|disabled) ;;
    *) return 1 ;;
  esac
  test "$(timer_state "$timer_name")" = "$state"
}

rollback() {
  set +e
  systemctl disable --now "$admin_timer" "$upgrade_timer" >/dev/null 2>&1
  systemctl stop "$admin_service" "$upgrade_service" >/dev/null 2>&1
  if [ "$backup_captured" = 1 ]; then
    restore_file "$admin_service_file" admin.service
    restore_file "$admin_timer_file" admin.timer
    restore_file "$admin_dropin_file" admin.dropin
    restore_file "$admin_policy" admin.policy
    restore_file "$upgrade_service_file" upgrade.service
    restore_file "$upgrade_timer_file" upgrade.timer
    restore_file "$upgrade_dropin_file" upgrade.dropin
    restore_file "$upgrade_policy" upgrade.policy
    restore_mode "$upgrade_db" upgrade-database
    restore_mode "$upgrade_db-wal" upgrade-database-wal
    restore_mode "$upgrade_db-shm" upgrade-database-shm
    rmdir "$admin_dropin_dir" >/dev/null 2>&1 || true
    rmdir "$upgrade_dropin_dir" >/dev/null 2>&1 || true
    systemctl daemon-reload
    admin_original=$(cat "$backup_root/admin.timer-state")
    upgrade_original=$(cat "$backup_root/upgrade.timer-state")
    restore_timer "$admin_timer" "$admin_original"
    restore_timer "$upgrade_timer" "$upgrade_original"
    restored_files=1
    for restored_entry in \
      "$admin_service_file:admin.service" "$admin_timer_file:admin.timer" \
      "$admin_dropin_file:admin.dropin" "$admin_policy:admin.policy" \
      "$upgrade_service_file:upgrade.service" "$upgrade_timer_file:upgrade.timer" \
      "$upgrade_dropin_file:upgrade.dropin" "$upgrade_policy:upgrade.policy"; do
      restored_path=$(printf '%s' "$restored_entry" | cut -d: -f1)
      restored_label=$(printf '%s' "$restored_entry" | cut -d: -f2)
      if [ -f "$backup_root/$restored_label" ]; then
        cmp -s "$backup_root/$restored_label" "$restored_path" || restored_files=0
      elif [ -f "$backup_root/$restored_label.absent" ]; then
        [ ! -e "$restored_path" ] && [ ! -L "$restored_path" ] || restored_files=0
      else
        restored_files=0
      fi
    done
    for mode_entry in "$upgrade_db:upgrade-database" "$upgrade_db-wal:upgrade-database-wal" "$upgrade_db-shm:upgrade-database-shm"; do
      mode_path=$(printf '%s' "$mode_entry" | cut -d: -f1)
      mode_label=$(printf '%s' "$mode_entry" | cut -d: -f2)
      if [ -f "$backup_root/$mode_label.mode" ] && [ -e "$mode_path" ]; then
        [ "$(stat -c '%a' "$mode_path")" = "$(cat "$backup_root/$mode_label.mode")" ] || restored_files=0
      elif [ ! -f "$backup_root/$mode_label.mode" ] && [ ! -f "$backup_root/$mode_label.absent" ]; then
        restored_files=0
      fi
    done
    if [ "$restored_files" = 1 ] \
      && [ "$(timer_state "$admin_timer")" = "$admin_original" ] \
      && [ "$(timer_state "$upgrade_timer")" = "$upgrade_original" ] \
      && [ "$(timer_state gaiop-admin-retention-cleanup.timer)" = "$(cat "$backup_root/admin-retention.timer-state")" ] \
      && [ "$(timer_state gaiop-upgrade-retention-cleanup.timer)" = "$(cat "$backup_root/upgrade-retention.timer-state")" ] \
      && [ "$(timer_state gaiop-storage-watermark-monitor.timer)" = "$(cat "$backup_root/watermark.timer-state")" ] \
      && [ "$(timer_state gaiop-report-retention-cleanup.timer)" = "$(cat "$backup_root/report.timer-state")" ] \
      && [ "$(timer_state gaiop-admin-session-retention.timer)" = "$(cat "$backup_root/session.timer-state")" ]; then
      rollback_complete=1
    fi
  fi
  set -e
}

finish() {
  rc=$?
  if [ "$completed" != 1 ]; then
    rollback
    printf 'FAILED_PHASE=%s\n' "$phase"
    printf 'ROLLBACK_COMPLETE=%s\n' "$rollback_complete"
    printf 'BACKUP_ROOT=%s\n' "$backup_root"
    printf 'BACKUP_EVIDENCE_PRESERVED=%s\n' "$backup_captured"
  fi
  rm -rf -- "$work_root"
  exit "$rc"
}
trap finish EXIT
trap 'phase=$phase"_line_"$LINENO' ERR

online_backup() {
  module_path=$1
  source_db=$2
  destination_db=$3
  /usr/local/bin/node - "$module_path" "$source_db" "$destination_db" <<'NODE'
const [modulePath, source, destination] = process.argv.slice(2)
const Database = require(modulePath)
;(async () => {
  const live = new Database(source, { readonly: true, fileMustExist: true })
  try { await live.backup(destination) } finally { live.close() }
  const copy = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    const rows = copy.pragma('integrity_check')
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].integrity_check !== 'ok') process.exit(21)
  } finally { copy.close() }
})().catch(() => process.exit(22))
NODE
  chmod 0600 "$destination_db"
}

source_integrity() {
  module_path=$1
  source_db=$2
  /usr/local/bin/node - "$module_path" "$source_db" <<'NODE'
const [modulePath, source] = process.argv.slice(2)
const Database = require(modulePath)
const db = new Database(source, { readonly: true, fileMustExist: true })
try {
  const rows = db.pragma('integrity_check')
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].integrity_check !== 'ok') process.exit(1)
} finally { db.close() }
NODE
}

validate_disabled_one_shot() {
  service_name=$1
  output_file=$2
  cursor=$(journal_cursor "$service_name")
  test -n "$cursor"
  systemctl reset-failed "$service_name" >/dev/null 2>&1 || true
  systemctl start "$service_name"
  test "$(systemctl show "$service_name" -p Result --value)" = success
  journalctl --sync
  journalctl --quiet --after-cursor="$cursor" -u "$service_name" -o cat --no-pager > "$work_root/journal-disabled.log"
  /usr/local/bin/node - "$work_root/journal-disabled.log" "$output_file" <<'NODE'
const fs = require('node:fs')
const [logFile, outputFile] = process.argv.slice(2)
let selected = null
for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  try {
    const value = JSON.parse(line)
    if (value && value.status === 'create_disabled') selected = value
  } catch {}
}
if (!selected || selected.ok !== true || selected.cleanup?.status !== 'not_run') process.exit(1)
fs.writeFileSync(outputFile, JSON.stringify({ ok: true, status: 'create_disabled', cleanup: 'not_run' }))
NODE
}

journal_cursor() {
  journalctl --sync
  journalctl --quiet --no-pager -n 0 --show-cursor | sed -n 's/^-- cursor: //p'
}

validate_one_shot() {
  service_name=$1
  component=$2
  expected_created=$3
  output_file=$4
  cursor=$(journal_cursor "$service_name")
  test -n "$cursor"
  systemctl reset-failed "$service_name" >/dev/null 2>&1 || true
  systemctl start "$service_name"
  test "$(systemctl show "$service_name" -p Result --value)" = success
  journalctl --sync
  journalctl --quiet --after-cursor="$cursor" -u "$service_name" -o cat --no-pager > "$work_root/journal.log"
  /usr/local/bin/node - "$work_root/journal.log" "$component" "$expected_created" "$output_file" <<'NODE'
const fs = require('node:fs')
const [logFile, component, expectedText, outputFile] = process.argv.slice(2)
let selected = null
for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  try {
    const value = JSON.parse(line)
    if (value && value.component === component && value.status === 'completed') selected = value
  } catch {}
}
if (!selected || selected.ok !== true || selected.cleanup?.status !== 'disabled') process.exit(31)
if (!Array.isArray(selected.created) || selected.created.length !== Number(expectedText)) process.exit(32)
const tiers = selected.created.map((item) => item.tier).sort()
if (Number(expectedText) === 3 && JSON.stringify(tiers) !== JSON.stringify(['daily', 'monthly', 'weekly'])) process.exit(33)
fs.writeFileSync(outputFile, JSON.stringify({ ok: true, status: selected.status, component, created: tiers, cleanup: 'disabled' }))
NODE
}

verify_backup_set() {
  module_path=$1
  backup_path=$2
  component=$3
  output_file=$4
  expected_uid=$5
  expected_gid=$6
  /usr/local/bin/node - "$module_path" "$backup_path" "$component" "$output_file" "$expected_uid" "$expected_gid" <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [modulePath, root, component, outputFile, expectedUidText, expectedGidText] = process.argv.slice(2)
const Database = require(modulePath)
const expectedUid = Number(expectedUidText)
const expectedGid = Number(expectedGidText)
function week(now) {
  const date = new Date(now)
  const day = date.getUTCDay() || 7
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day))
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1))
  return String(thursday.getUTCFullYear()) + '-W' + String(Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7)).padStart(2, '0')
}
const now = Date.now()
const periods = {
  daily: new Date(now).toISOString().slice(0, 10),
  weekly: week(now),
  monthly: new Date(now).toISOString().slice(0, 7),
}
const expected = []
for (const tier of ['daily', 'weekly', 'monthly']) {
  expected.push(component + '-' + tier + '-' + periods[tier] + '.manifest.json')
  expected.push(component + '-' + tier + '-' + periods[tier] + '.sqlite3')
}
const actual = fs.readdirSync(root).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) process.exit(41)
const fingerprints = []
for (const tier of ['daily', 'weekly', 'monthly']) {
  const base = component + '-' + tier + '-' + periods[tier]
  const dbPath = path.join(root, base + '.sqlite3')
  const manifestPath = path.join(root, base + '.manifest.json')
  const dbStat = fs.lstatSync(dbPath)
  const manifestStat = fs.lstatSync(manifestPath)
  if (!dbStat.isFile() || dbStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) process.exit(42)
  if ((dbStat.mode & 0o777) !== 0o600 || (manifestStat.mode & 0o777) !== 0o600) process.exit(43)
  if (dbStat.uid !== expectedUid || dbStat.gid !== expectedGid || manifestStat.uid !== expectedUid || manifestStat.gid !== expectedGid) process.exit(46)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const hash = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')
  if (manifest.policyVersion !== 'gaiop_sqlite_backup.v1' || manifest.component !== component
    || manifest.tier !== tier || manifest.period !== periods[tier] || manifest.fileName !== path.basename(dbPath)
    || manifest.sizeBytes !== dbStat.size || manifest.sha256 !== hash) process.exit(44)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db.pragma('integrity_check')
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].integrity_check !== 'ok') process.exit(45)
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete') process.exit(47)
  } finally { db.close() }
  fingerprints.push(String(dbStat.size) + ':' + hash)
}
if (new Set(fingerprints).size !== 1) process.exit(48)
fs.writeFileSync(outputFile, JSON.stringify({ component, tiers: ['daily', 'weekly', 'monthly'], manifests: 3, integrity: 'ok', journalMode: 'delete', identicalSnapshots: true }))
NODE
}

verify_restore_tiers() {
  component=$1
  backup_path=$2
  restore_path=$3
  output_file=$4
  : > "$output_file"
  for tier in daily weekly monthly; do
    backup_file=$(find "$backup_path" -mindepth 1 -maxdepth 1 -type f -name "$component-$tier-*.sqlite3" -print -quit)
    test -n "$backup_file"
    if [ "$component" = admin ]; then
      result=$(systemd-run --quiet --wait --pipe --collect --unit="gaiop-admin-restore-$release_id-$tier" \
        --uid=gaiop --gid=gaiop --working-directory=/ \
        --property=Type=oneshot --property=UMask=0077 --property=NoNewPrivileges=yes \
        --property=PrivateTmp=yes --property=PrivateDevices=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        --property="ReadOnlyPaths=$backup_path $admin_root/server" --property="ReadWritePaths=$restore_path" \
        --property="InaccessiblePaths=-/var/lib/gaiop-upgrade -/var/backups/gaiop/upgrade -/var/lib/gaiop/alerts -/etc/gaiop/admin.env" \
        env -i \
        GAIOP_ADMIN_DATA_DIR=/var/lib/gaiop/admin \
        GAIOP_ADMIN_SQLITE_BACKUP_DIR="$backup_path" \
        GAIOP_ADMIN_SQLITE_RESTORE_TEST_DIR="$restore_path" \
        /usr/local/bin/node "$admin_root/server/sqlite-restore-test.js" "$backup_file")
    else
      result=$(systemd-run --quiet --wait --pipe --collect --unit="gaiop-upgrade-restore-$release_id-$tier" \
        --working-directory=/ \
        --property=Type=oneshot --property=UMask=0077 --property=NoNewPrivileges=yes \
        --property=PrivateTmp=yes --property=PrivateDevices=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        --property="ReadOnlyPaths=$backup_path $upgrade_root/src" --property="ReadWritePaths=$restore_path" \
        --property="InaccessiblePaths=-/var/lib/gaiop/admin -/var/lib/gaiop/alerts -/etc/gaiop/upgrade.env -/etc/gaiop-upgrade -/var/backups/gaiop/upgrade -/var/lib/gaiop-upgrade/packages -/var/lib/gaiop/upgrade/staging" \
        env -i \
        NAPM_UPGRADE_DB_PATH="$upgrade_db" \
        GAIOP_UPGRADE_SQLITE_BACKUP_DIR="$backup_path" \
        GAIOP_UPGRADE_SQLITE_RESTORE_TEST_DIR="$restore_path" \
        /usr/local/bin/node "$upgrade_root/src/sqlite-restore-test.js" "$backup_file")
    fi
    printf '%s\n' "$result" | /usr/local/bin/node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const v=JSON.parse(s);if(v.ok!==true||v.status!=='verified'||v.component!=='$component')process.exit(1)})"
    printf '%s\n' "$tier" >> "$output_file"
    test -z "$(find "$restore_path" -mindepth 1 -maxdepth 1 -print -quit)"
  done
}

verify_effective_unit() {
  service_name=$1
  expected_user=$2
  expected_group=$3
  expected_workdir=$4
  expected_policy=$5
  expected_exec=$6
  expected_rw=$7
  expected_inaccessible=$8
  test "$(systemctl show "$service_name" -p User --value)" = "$expected_user"
  test "$(systemctl show "$service_name" -p Group --value)" = "$expected_group"
  test "$(systemctl show "$service_name" -p WorkingDirectory --value)" = "$expected_workdir"
  test "$(systemctl show "$service_name" -p EnvironmentFiles --value)" = "$expected_policy (ignore_errors=no)"
  effective_exec=$(systemctl show "$service_name" -p ExecStart --value)
  test "$(printf '%s' "$effective_exec" | grep -o 'path=' | wc -l | tr -d '[:space:]')" = 1
  printf '%s' "$effective_exec" | grep -F -- 'path=/usr/local/bin/node' >/dev/null
  printf '%s' "$effective_exec" | grep -F -- "argv[]=/usr/local/bin/node $expected_exec ;" >/dev/null
  test "$(systemctl show "$service_name" -p RuntimeDirectory --value)" = "$(basename "$expected_workdir")"
  test "$(systemctl show "$service_name" -p RuntimeDirectoryPreserve --value)" = no
  test "$(systemctl show "$service_name" -p TimeoutStartUSec --value)" = 15min
  test "$(systemctl show "$service_name" -p UMask --value)" = 0077
  test "$(systemctl show "$service_name" -p NoNewPrivileges --value)" = yes
  test "$(systemctl show "$service_name" -p PrivateTmp --value)" = yes
  test "$(systemctl show "$service_name" -p PrivateDevices --value)" = yes
  test "$(systemctl show "$service_name" -p ProtectSystem --value)" = strict
  actual_rw=$(systemctl show "$service_name" -p ReadWritePaths --value | tr ' ' '\n' | sed '/^$/d;s/^-//' | LC_ALL=C sort | paste -sd ' ' -)
  wanted_rw=$(printf '%s' "$expected_rw" | tr ' ' '\n' | LC_ALL=C sort | paste -sd ' ' -)
  test "$actual_rw" = "$wanted_rw"
  actual_hidden=$(systemctl show "$service_name" -p InaccessiblePaths --value | tr ' ' '\n' | sed '/^$/d;s/^-//' | LC_ALL=C sort | paste -sd ' ' -)
  wanted_hidden=$(printf '%s' "$expected_inaccessible" | tr ' ' '\n' | LC_ALL=C sort | paste -sd ' ' -)
  test "$actual_hidden" = "$wanted_hidden"
}

phase=preflight
test "$(id -u)" = 0
printf '%s\n' "$release_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z$'
test ! -e "$backup_root"
upgrade_root=$(systemctl show gaiop-upgrade.service -p WorkingDirectory --value)
case "$upgrade_root" in /opt/gaiop/*|/opt/gaiop-*) ;; *) exit 51 ;; esac
test -d "$admin_root"
test -d "$upgrade_root"
test -f "$admin_db"
test ! -L "$admin_db"
upgrade_db=
for candidate in /var/lib/gaiop-upgrade/napm-upgrade.db /var/lib/gaiop-upgrade/upgrade.db /var/lib/gaiop/upgrade/napm-upgrade.db /var/lib/gaiop/upgrade/upgrade.db; do
  if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
    test -z "$upgrade_db"
    upgrade_db=$candidate
  fi
done
test -n "$upgrade_db"
test "$(timer_state "$admin_timer")" = 'inactive|disabled'
test "$(timer_state "$upgrade_timer")" = 'inactive|disabled'
test "$(timer_state gaiop-admin-retention-cleanup.timer)" = 'active|enabled'
test "$(timer_state gaiop-upgrade-retention-cleanup.timer)" = 'active|enabled'
test "$(timer_state gaiop-storage-watermark-monitor.timer)" = 'active|enabled'
test "$(timer_state gaiop-report-retention-cleanup.timer)" = 'inactive|disabled'
test "$(timer_state gaiop-admin-session-retention.timer)" = 'inactive|disabled'
test "$(http_status http://127.0.0.1:3000/api/health)" = 200
test "$(http_status http://127.0.0.1:18900/health)" = 200
test "$(http_status http://127.0.0.1:18789/health)" = 200

for source_file in \
  "$admin_root/package.json" \
  "$admin_root/server/sqlite-backup.js" \
  "$admin_root/server/sqlite-restore-test.js" \
  "$admin_root/server/lib/sqlite-backup-service.js" \
  "$upgrade_root/package.json" \
  "$upgrade_root/src/sqlite-backup.js" \
  "$upgrade_root/src/sqlite-restore-test.js" \
  "$upgrade_root/src/services/SqliteBackupService.js" \
  "$upgrade_root/src/config.js"; do
  test -f "$source_file"
  test ! -L "$source_file"
done
test "$(sha256sum "$admin_root/server/sqlite-backup.js" | awk '{print $1}')" = '${expected.adminBackup}'
test "$(/usr/local/bin/node -p \"require('$admin_root/package.json').type || ''\")" = module
test "$(sha256sum "$admin_root/server/sqlite-restore-test.js" | awk '{print $1}')" = '${expected.adminRestore}'
test "$(sha256sum "$admin_root/server/lib/sqlite-backup-service.js" | awk '{print $1}')" = '${expected.adminLibrary}'
test "$(sha256sum "$upgrade_root/src/sqlite-backup.js" | awk '{print $1}')" = '${expected.upgradeBackup}'
test "$(sha256sum "$upgrade_root/src/sqlite-restore-test.js" | awk '{print $1}')" = '${expected.upgradeRestore}'
test "$(sha256sum "$upgrade_root/src/services/SqliteBackupService.js" | awk '{print $1}')" = '${expected.upgradeLibrary}'
test "$(sha256sum "$upgrade_root/src/config.js" | awk '{print $1}')" = '${expected.upgradeConfig}'
test "$(sha256sum "$upgrade_root/package.json" | awk '{print $1}')" = '${expected.upgradePackage}'
test "$(normalized_sha "$admin_service_file")" = '${expected.adminService}'
test "$(normalized_sha "$admin_timer_file")" = '${expected.adminTimer}'
test "$(normalized_sha "$upgrade_timer_file")" = '${expected.upgradeTimer}'
for dependency_dir in \
  "$admin_root/node_modules/better-sqlite3" "$admin_root/node_modules/bindings" "$admin_root/node_modules/file-uri-to-path" \
  "$upgrade_root/node_modules/better-sqlite3" "$upgrade_root/node_modules/bindings" "$upgrade_root/node_modules/file-uri-to-path" "$upgrade_root/node_modules/dotenv"; do
  test -d "$dependency_dir"
  test ! -L "$dependency_dir"
  test -z "$(find "$dependency_dir" -perm /0022 -print -quit)"
done
phase=capacity_and_source_integrity
source_integrity "$admin_root/node_modules/better-sqlite3" "$admin_db"
source_integrity "$upgrade_root/node_modules/better-sqlite3" "$upgrade_db"
source_bytes=0
for source_file in "$admin_db" "$admin_db-wal" "$admin_db-shm" "$upgrade_db" "$upgrade_db-wal" "$upgrade_db-shm"; do
  if [ -f "$source_file" ]; then source_bytes=$(( source_bytes + $(stat -c '%s' "$source_file") )); fi
done
required_bytes=$(( source_bytes * 60 + 104857600 ))
available_bytes=$(df -PB1 /var/backups/gaiop | awk 'NR == 2 {print $4}')
test "$available_bytes" -gt "$required_bytes"
for managed_dir in "$admin_backup_root" "$admin_restore_root" "$upgrade_backup_root" "$upgrade_restore_root"; do
  if [ -e "$managed_dir" ] || [ -L "$managed_dir" ]; then
    test -d "$managed_dir"
    test ! -L "$managed_dir"
    test -z "$(find "$managed_dir" -mindepth 1 -maxdepth 1 -print -quit)"
  fi
done

phase=capture
install -d -o root -g root -m 0700 "$backup_root"
capture_file "$admin_service_file" admin.service
capture_file "$admin_timer_file" admin.timer
capture_file "$admin_dropin_file" admin.dropin
capture_file "$admin_policy" admin.policy
capture_file "$upgrade_service_file" upgrade.service
capture_file "$upgrade_timer_file" upgrade.timer
capture_file "$upgrade_dropin_file" upgrade.dropin
capture_file "$upgrade_policy" upgrade.policy
timer_state "$admin_timer" > "$backup_root/admin.timer-state"
timer_state "$upgrade_timer" > "$backup_root/upgrade.timer-state"
timer_state gaiop-admin-retention-cleanup.timer > "$backup_root/admin-retention.timer-state"
timer_state gaiop-upgrade-retention-cleanup.timer > "$backup_root/upgrade-retention.timer-state"
timer_state gaiop-storage-watermark-monitor.timer > "$backup_root/watermark.timer-state"
timer_state gaiop-report-retention-cleanup.timer > "$backup_root/report.timer-state"
timer_state gaiop-admin-session-retention.timer > "$backup_root/session.timer-state"
for mode_entry in "$upgrade_db:upgrade-database" "$upgrade_db-wal:upgrade-database-wal" "$upgrade_db-shm:upgrade-database-shm"; do
  mode_path=$(printf '%s' "$mode_entry" | cut -d: -f1)
  mode_label=$(printf '%s' "$mode_entry" | cut -d: -f2)
  if [ -e "$mode_path" ]; then
    test -f "$mode_path"
    test ! -L "$mode_path"
    stat -c '%a' "$mode_path" > "$backup_root/$mode_label.mode"
  else
    : > "$backup_root/$mode_label.absent"
  fi
done
backup_captured=1

phase=database_safety_backups
online_backup "$admin_root/node_modules/better-sqlite3" "$admin_db" "$backup_root/wizard.db.before-enable"
online_backup "$upgrade_root/node_modules/better-sqlite3" "$upgrade_db" "$backup_root/upgrade.db.before-enable"

phase=trusted_tree_permissions
stat -c '%n|%U|%G|%a' \
  "$admin_root" "$admin_root/package.json" "$admin_root/server" "$admin_root/server/lib" \
  "$admin_root/server/sqlite-backup.js" "$admin_root/server/sqlite-restore-test.js" "$admin_root/server/lib/sqlite-backup-service.js" \
  "$upgrade_root" "$upgrade_root/package.json" "$upgrade_root/src" "$upgrade_root/src/services" \
  "$upgrade_root/src/sqlite-backup.js" "$upgrade_root/src/sqlite-restore-test.js" "$upgrade_root/src/services/SqliteBackupService.js" "$upgrade_root/src/config.js" \
  > "$backup_root/trusted-tree-modes.before"
chmod 0600 "$backup_root/trusted-tree-modes.before"
chmod go-w "$admin_root" "$admin_root/server" "$admin_root/server/lib" \
  "$admin_root/package.json" "$admin_root/server/sqlite-backup.js" "$admin_root/server/sqlite-restore-test.js" "$admin_root/server/lib/sqlite-backup-service.js"
chmod go-w "$upgrade_root" "$upgrade_root/src" "$upgrade_root/src/services" \
  "$upgrade_root/package.json" "$upgrade_root/src/sqlite-backup.js" "$upgrade_root/src/sqlite-restore-test.js" "$upgrade_root/src/services/SqliteBackupService.js" "$upgrade_root/src/config.js"
for trusted_path in \
  "$admin_root" "$admin_root/package.json" "$admin_root/server" "$admin_root/server/lib" \
  "$admin_root/server/sqlite-backup.js" "$admin_root/server/sqlite-restore-test.js" "$admin_root/server/lib/sqlite-backup-service.js" \
  "$upgrade_root" "$upgrade_root/package.json" "$upgrade_root/src" "$upgrade_root/src/services" \
  "$upgrade_root/src/sqlite-backup.js" "$upgrade_root/src/sqlite-restore-test.js" "$upgrade_root/src/services/SqliteBackupService.js" "$upgrade_root/src/config.js"; do
  test -z "$(find "$trusted_path" -maxdepth 0 -perm /0022 -print -quit)"
done
printf 'go-w\n' > "$backup_root/trusted-tree-permission-tightening"

phase=upgrade_database_permissions
for database_file in "$upgrade_db" "$upgrade_db-wal" "$upgrade_db-shm"; do
  if [ -e "$database_file" ]; then
    test -f "$database_file"
    test ! -L "$database_file"
    chmod 0640 "$database_file"
    test "$(stat -c '%a' "$database_file")" = 640
  fi
done
test "$(http_status http://127.0.0.1:18900/health)" = 200

phase=install_policy
install -d -o gaiop -g gaiop -m 0700 "$admin_backup_root" "$admin_restore_root"
install -d -o root -g root -m 0700 "$upgrade_backup_root" "$upgrade_restore_root"
cat > "$work_root/admin.policy" <<EOF
GAIOP_ADMIN_DATA_DIR=/var/lib/gaiop/admin
GAIOP_ADMIN_SQLITE_BACKUP_DIR=$admin_backup_root
GAIOP_ADMIN_SQLITE_RESTORE_TEST_DIR=$admin_restore_root
GAIOP_ADMIN_SQLITE_BACKUP_LOCK_PATH=/run/gaiop-admin-sqlite-backup/backup.lock
GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=false
GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false
EOF
cat > "$work_root/upgrade.policy" <<EOF
NAPM_UPGRADE_DB_PATH=$upgrade_db
GAIOP_UPGRADE_SQLITE_BACKUP_DIR=$upgrade_backup_root
GAIOP_UPGRADE_SQLITE_RESTORE_TEST_DIR=$upgrade_restore_root
GAIOP_UPGRADE_SQLITE_BACKUP_LOCK_PATH=/run/gaiop-upgrade-sqlite-backup/backup.lock
GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=false
GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED=false
EOF
install -o root -g gaiop -m 0640 "$work_root/admin.policy" "$admin_policy"
install -o root -g root -m 0600 "$work_root/upgrade.policy" "$upgrade_policy"

install -d -o root -g root -m 0755 "$admin_dropin_dir" "$upgrade_dropin_dir"
cat > "$work_root/admin.dropin" <<EOF
[Service]
WorkingDirectory=/run/gaiop-admin-sqlite-backup
EnvironmentFile=
EnvironmentFile=$admin_policy
ExecStart=
ExecStart=/usr/local/bin/node $admin_root/server/sqlite-backup.js
RuntimeDirectory=gaiop-admin-sqlite-backup
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
TimeoutStartSec=15min
ReadWritePaths=
ReadWritePaths=$admin_backup_root
ReadWritePaths=/run/gaiop-admin-sqlite-backup
InaccessiblePaths=
InaccessiblePaths=-/var/lib/gaiop-upgrade
InaccessiblePaths=-/var/backups/gaiop/upgrade
InaccessiblePaths=-/var/lib/gaiop/alerts
InaccessiblePaths=-/etc/gaiop/admin.env
EOF
cat > "$work_root/upgrade.dropin" <<EOF
[Service]
WorkingDirectory=/run/gaiop-upgrade-sqlite-backup
EnvironmentFile=
EnvironmentFile=$upgrade_policy
ExecStart=
ExecStart=/usr/local/bin/node $upgrade_root/src/sqlite-backup.js
RuntimeDirectory=gaiop-upgrade-sqlite-backup
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=no
TimeoutStartSec=15min
ReadWritePaths=
ReadWritePaths=$upgrade_backup_root
ReadWritePaths=/run/gaiop-upgrade-sqlite-backup
InaccessiblePaths=
InaccessiblePaths=-/var/lib/gaiop/admin
InaccessiblePaths=-/var/lib/gaiop/alerts
InaccessiblePaths=-/etc/gaiop/upgrade.env
InaccessiblePaths=-/etc/gaiop-upgrade
InaccessiblePaths=-/var/backups/gaiop/upgrade
InaccessiblePaths=-/var/lib/gaiop-upgrade/packages
InaccessiblePaths=-/var/lib/gaiop/upgrade/staging
EOF
install -o root -g root -m 0644 "$work_root/admin.dropin" "$admin_dropin_file"
install -o root -g root -m 0644 "$work_root/upgrade.dropin" "$upgrade_dropin_file"
systemctl daemon-reload

phase=unit_validation
systemd-analyze verify "$admin_service" "$admin_timer" "$upgrade_service" "$upgrade_timer"
verify_effective_unit "$admin_service" gaiop gaiop /run/gaiop-admin-sqlite-backup "$admin_policy" \
  "$admin_root/server/sqlite-backup.js" \
  "$admin_backup_root /run/gaiop-admin-sqlite-backup" \
  '/var/lib/gaiop-upgrade /var/backups/gaiop/upgrade /var/lib/gaiop/alerts /etc/gaiop/admin.env'
verify_effective_unit "$upgrade_service" root root /run/gaiop-upgrade-sqlite-backup "$upgrade_policy" \
  "$upgrade_root/src/sqlite-backup.js" \
  "$upgrade_backup_root /run/gaiop-upgrade-sqlite-backup" \
  '/var/lib/gaiop/admin /var/lib/gaiop/alerts /etc/gaiop/upgrade.env /etc/gaiop-upgrade /var/backups/gaiop/upgrade /var/lib/gaiop-upgrade/packages /var/lib/gaiop/upgrade/staging'
test "$(stat -c '%U:%G:%a' "$admin_policy")" = 'root:gaiop:640'
test "$(stat -c '%U:%G:%a' "$upgrade_policy")" = 'root:root:600'

phase=closed_one_shot
validate_disabled_one_shot "$admin_service" "$work_root/admin-disabled.json"
validate_disabled_one_shot "$upgrade_service" "$work_root/upgrade-disabled.json"
test -z "$(find "$admin_backup_root" -mindepth 1 -maxdepth 1 -print -quit)"
test -z "$(find "$upgrade_backup_root" -mindepth 1 -maxdepth 1 -print -quit)"

phase=enable_creation_policy
sed 's/GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=false/GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=true/' "$work_root/admin.policy" > "$work_root/admin.policy.enabled"
sed 's/GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=false/GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=true/' "$work_root/upgrade.policy" > "$work_root/upgrade.policy.enabled"
admin_policy_candidate=$(mktemp /etc/gaiop/.admin-sqlite-backup.policy.XXXXXX)
upgrade_policy_candidate=$(mktemp /etc/gaiop/.upgrade-sqlite-backup.policy.XXXXXX)
install -o root -g gaiop -m 0640 "$work_root/admin.policy.enabled" "$admin_policy_candidate"
install -o root -g root -m 0600 "$work_root/upgrade.policy.enabled" "$upgrade_policy_candidate"
mv -f -- "$admin_policy_candidate" "$admin_policy"
mv -f -- "$upgrade_policy_candidate" "$upgrade_policy"
grep -Fx 'GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=true' "$admin_policy" >/dev/null
grep -Fx 'GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false' "$admin_policy" >/dev/null
grep -Fx 'GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED=true' "$upgrade_policy" >/dev/null
grep -Fx 'GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED=false' "$upgrade_policy" >/dev/null

phase=first_enabled_one_shot
validate_one_shot "$admin_service" admin 3 "$work_root/admin-first.json"
validate_one_shot "$upgrade_service" upgrade 3 "$work_root/upgrade-first.json"
admin_uid=$(id -u gaiop)
admin_gid=$(id -g gaiop)
verify_backup_set "$admin_root/node_modules/better-sqlite3" "$admin_backup_root" admin "$work_root/admin-set.json" "$admin_uid" "$admin_gid"
verify_backup_set "$upgrade_root/node_modules/better-sqlite3" "$upgrade_backup_root" upgrade "$work_root/upgrade-set.json" 0 0

phase=restore_validation
verify_restore_tiers admin "$admin_backup_root" "$admin_restore_root" "$work_root/admin-restores.txt"
verify_restore_tiers upgrade "$upgrade_backup_root" "$upgrade_restore_root" "$work_root/upgrade-restores.txt"
test "$(wc -l < "$work_root/admin-restores.txt" | tr -d '[:space:]')" = 3
test "$(wc -l < "$work_root/upgrade-restores.txt" | tr -d '[:space:]')" = 3

phase=enable_timers
systemctl enable --now "$admin_timer" "$upgrade_timer"
test "$(timer_state "$admin_timer")" = 'active|enabled'
test "$(timer_state "$upgrade_timer")" = 'active|enabled'
for one_shot in "$admin_service" "$upgrade_service"; do
  for attempt in $(seq 1 60); do
    state=$(systemctl is-active "$one_shot" 2>/dev/null || true)
    [ "$state" = inactive ] && break
    [ "$state" = failed ] && exit 61
    sleep 1
  done
  test "$(systemctl is-active "$one_shot" 2>/dev/null || true)" = inactive
done

phase=enabled_one_shot
admin_tree_before=$(find "$admin_backup_root" -mindepth 1 -maxdepth 1 -type f -printf '%f %s\n' | LC_ALL=C sort | sha256sum | awk '{print $1}')
upgrade_tree_before=$(find "$upgrade_backup_root" -mindepth 1 -maxdepth 1 -type f -printf '%f %s\n' | LC_ALL=C sort | sha256sum | awk '{print $1}')
validate_one_shot "$admin_service" admin 0 "$work_root/admin-second.json"
validate_one_shot "$upgrade_service" upgrade 0 "$work_root/upgrade-second.json"
test "$admin_tree_before" = "$(find "$admin_backup_root" -mindepth 1 -maxdepth 1 -type f -printf '%f %s\n' | LC_ALL=C sort | sha256sum | awk '{print $1}')"
test "$upgrade_tree_before" = "$(find "$upgrade_backup_root" -mindepth 1 -maxdepth 1 -type f -printf '%f %s\n' | LC_ALL=C sort | sha256sum | awk '{print $1}')"
verify_backup_set "$admin_root/node_modules/better-sqlite3" "$admin_backup_root" admin "$work_root/admin-final-set.json" "$admin_uid" "$admin_gid"
verify_backup_set "$upgrade_root/node_modules/better-sqlite3" "$upgrade_backup_root" upgrade "$work_root/upgrade-final-set.json" 0 0

phase=final_validation
source_integrity "$admin_root/node_modules/better-sqlite3" "$admin_db"
source_integrity "$upgrade_root/node_modules/better-sqlite3" "$upgrade_db"
for database_file in "$upgrade_db" "$upgrade_db-wal" "$upgrade_db-shm"; do
  if [ -e "$database_file" ]; then test "$(stat -c '%a' "$database_file")" = 640; fi
done
test "$(timer_state gaiop-admin-retention-cleanup.timer)" = 'active|enabled'
test "$(timer_state gaiop-upgrade-retention-cleanup.timer)" = 'active|enabled'
test "$(timer_state gaiop-storage-watermark-monitor.timer)" = 'active|enabled'
test "$(timer_state gaiop-report-retention-cleanup.timer)" = 'inactive|disabled'
test "$(timer_state gaiop-admin-session-retention.timer)" = 'inactive|disabled'
admin_next=$(systemctl show "$admin_timer" -p NextElapseUSecRealtime --value)
upgrade_next=$(systemctl show "$upgrade_timer" -p NextElapseUSecRealtime --value)
test -n "$admin_next"
test "$admin_next" != n/a
test -n "$upgrade_next"
test "$upgrade_next" != n/a
test "$(http_status http://127.0.0.1:3000/api/health)" = 200
test "$(http_status http://127.0.0.1:18900/health)" = 200
test "$(http_status http://127.0.0.1:18789/health)" = 200
test "$(http_status http://127.0.0.1:18900/api/v1/upgrade/status)" = 401

printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_ROOT=%s\n' "$backup_root"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'
printf 'CAPACITY_AVAILABLE_BYTES=%s\n' "$available_bytes"
printf 'CAPACITY_REQUIRED_BYTES=%s\n' "$required_bytes"
printf 'TRUSTED_TREE_PERMISSIONS=go-w\n'
printf 'UPGRADE_DATABASE_PERMISSIONS=640\n'
printf 'ADMIN_DISABLED_B64=%s\n' "$(base64 -w 0 "$work_root/admin-disabled.json")"
printf 'UPGRADE_DISABLED_B64=%s\n' "$(base64 -w 0 "$work_root/upgrade-disabled.json")"
printf 'ADMIN_FIRST_B64=%s\n' "$(base64 -w 0 "$work_root/admin-first.json")"
printf 'UPGRADE_FIRST_B64=%s\n' "$(base64 -w 0 "$work_root/upgrade-first.json")"
printf 'ADMIN_SECOND_B64=%s\n' "$(base64 -w 0 "$work_root/admin-second.json")"
printf 'UPGRADE_SECOND_B64=%s\n' "$(base64 -w 0 "$work_root/upgrade-second.json")"
printf 'ADMIN_SET_B64=%s\n' "$(base64 -w 0 "$work_root/admin-final-set.json")"
printf 'UPGRADE_SET_B64=%s\n' "$(base64 -w 0 "$work_root/upgrade-final-set.json")"
printf 'ADMIN_RESTORE_TIERS=3\n'
printf 'UPGRADE_RESTORE_TIERS=3\n'
printf 'ADMIN_TIMER=%s\n' "$(timer_state "$admin_timer")"
printf 'UPGRADE_TIMER=%s\n' "$(timer_state "$upgrade_timer")"
printf 'ADMIN_NEXT=%s\n' "$admin_next"
printf 'UPGRADE_NEXT=%s\n' "$upgrade_next"
printf 'ADMIN_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-retention-cleanup.timer)"
printf 'UPGRADE_RETENTION_TIMER=%s\n' "$(timer_state gaiop-upgrade-retention-cleanup.timer)"
printf 'WATERMARK_TIMER=%s\n' "$(timer_state gaiop-storage-watermark-monitor.timer)"
printf 'REPORT_TIMER=%s\n' "$(timer_state gaiop-report-retention-cleanup.timer)"
printf 'SESSION_TIMER=%s\n' "$(timer_state gaiop-admin-session-retention.timer)"
printf 'ADMIN_HEALTH=%s\n' "$(http_status http://127.0.0.1:3000/api/health)"
printf 'UPGRADE_HEALTH=%s\n' "$(http_status http://127.0.0.1:18900/health)"
printf 'UPGRADE_UNAUTHENTICATED=%s\n' "$(http_status http://127.0.0.1:18900/api/v1/upgrade/status)"
printf 'GATEWAY_HEALTH=%s\n' "$(http_status http://127.0.0.1:18789/health)"
printf 'ADMIN_DROPIN_SHA256=%s\n' "$(sha256sum "$admin_dropin_file" | awk '{print $1}')"
printf 'UPGRADE_DROPIN_SHA256=%s\n' "$(sha256sum "$upgrade_dropin_file" | awk '{print $1}')"
printf 'ADMIN_POLICY_SHA256=%s\n' "$(sha256sum "$admin_policy" | awk '{print $1}')"
printf 'UPGRADE_POLICY_SHA256=%s\n' "$(sha256sum "$upgrade_policy" | awk '{print $1}')"
completed=1
printf 'SQLITE_BACKUP_ENABLE_COMPLETE=1\n'
`
}

function sqliteBackupPostcheckRollbackScript(values) {
  const hashes = [values.ADMIN_DROPIN_SHA256, values.UPGRADE_DROPIN_SHA256, values.ADMIN_POLICY_SHA256, values.UPGRADE_POLICY_SHA256]
  if (!hashes.every((value) => /^[a-f0-9]{64}$/.test(String(value || '')))) {
    throw new Error('The SQLite backup postcheck rollback identity is incomplete.')
  }
  return String.raw`set -euo pipefail
release_id='${releaseId}'
backup_root=/var/backups/gaiop/sqlite-backup-enable-$release_id
admin_service=gaiop-admin-sqlite-backup.service
admin_timer=gaiop-admin-sqlite-backup.timer
admin_service_file=/etc/systemd/system/gaiop-admin-sqlite-backup.service
admin_timer_file=/etc/systemd/system/gaiop-admin-sqlite-backup.timer
admin_dropin_dir=/etc/systemd/system/gaiop-admin-sqlite-backup.service.d
admin_dropin_file=$admin_dropin_dir/99-gaiop-sqlite-backup-production.conf
admin_policy=/etc/gaiop/admin-sqlite-backup.policy
upgrade_service=gaiop-upgrade-sqlite-backup.service
upgrade_timer=gaiop-upgrade-sqlite-backup.timer
upgrade_service_file=/etc/systemd/system/gaiop-upgrade-sqlite-backup.service
upgrade_timer_file=/etc/systemd/system/gaiop-upgrade-sqlite-backup.timer
upgrade_dropin_dir=/etc/systemd/system/gaiop-upgrade-sqlite-backup.service.d
upgrade_dropin_file=$upgrade_dropin_dir/99-gaiop-sqlite-backup-production.conf
upgrade_policy=/etc/gaiop/upgrade-sqlite-backup.policy

timer_state() {
  active=$(systemctl is-active "$1" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$1" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

restore_file() {
  target=$1
  label=$2
  if [ -f "$backup_root/$label" ]; then
    install -d -o root -g root -m 0755 "$(dirname "$target")"
    rm -f -- "$target"
    cp -a -- "$backup_root/$label" "$target"
  else
    test -f "$backup_root/$label.absent"
    rm -f -- "$target"
  fi
}

restore_timer() {
  unit=$1
  state=$2
  systemctl disable --now "$unit" >/dev/null 2>&1 || true
  case "$state" in
    active\|enabled) systemctl enable --now "$unit" >/dev/null ;;
    inactive\|enabled) systemctl enable "$unit" >/dev/null ;;
    active\|disabled) systemctl start "$unit" >/dev/null ;;
    inactive\|disabled) ;;
    *) exit 71 ;;
  esac
  test "$(timer_state "$unit")" = "$state"
}

test "$(id -u)" = 0
test -d "$backup_root"
test ! -L "$backup_root"
test "$(stat -c '%U:%G:%a' "$backup_root")" = 'root:root:700'
test "$(sha256sum "$admin_dropin_file" | awk '{print $1}')" = '${values.ADMIN_DROPIN_SHA256}'
test "$(sha256sum "$upgrade_dropin_file" | awk '{print $1}')" = '${values.UPGRADE_DROPIN_SHA256}'
test "$(sha256sum "$admin_policy" | awk '{print $1}')" = '${values.ADMIN_POLICY_SHA256}'
test "$(sha256sum "$upgrade_policy" | awk '{print $1}')" = '${values.UPGRADE_POLICY_SHA256}'

upgrade_db=
for candidate in /var/lib/gaiop-upgrade/napm-upgrade.db /var/lib/gaiop-upgrade/upgrade.db /var/lib/gaiop/upgrade/napm-upgrade.db /var/lib/gaiop/upgrade/upgrade.db; do
  if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
    test -z "$upgrade_db"
    upgrade_db=$candidate
  fi
done
test -n "$upgrade_db"

systemctl disable --now "$admin_timer" "$upgrade_timer" >/dev/null 2>&1 || true
systemctl stop "$admin_service" "$upgrade_service" >/dev/null 2>&1 || true
restore_file "$admin_service_file" admin.service
restore_file "$admin_timer_file" admin.timer
restore_file "$admin_dropin_file" admin.dropin
restore_file "$admin_policy" admin.policy
restore_file "$upgrade_service_file" upgrade.service
restore_file "$upgrade_timer_file" upgrade.timer
restore_file "$upgrade_dropin_file" upgrade.dropin
restore_file "$upgrade_policy" upgrade.policy
rmdir "$admin_dropin_dir" >/dev/null 2>&1 || true
rmdir "$upgrade_dropin_dir" >/dev/null 2>&1 || true
for mode_entry in "$upgrade_db:upgrade-database" "$upgrade_db-wal:upgrade-database-wal" "$upgrade_db-shm:upgrade-database-shm"; do
  mode_path=$(printf '%s' "$mode_entry" | cut -d: -f1)
  mode_label=$(printf '%s' "$mode_entry" | cut -d: -f2)
  if [ -f "$backup_root/$mode_label.mode" ]; then
    if [ -e "$mode_path" ]; then
      test ! -L "$mode_path"
      chmod "$(cat "$backup_root/$mode_label.mode")" "$mode_path"
    fi
  else
    test -f "$backup_root/$mode_label.absent"
  fi
done
systemctl daemon-reload
admin_original=$(cat "$backup_root/admin.timer-state")
upgrade_original=$(cat "$backup_root/upgrade.timer-state")
restore_timer "$admin_timer" "$admin_original"
restore_timer "$upgrade_timer" "$upgrade_original"

for restored_entry in \
  "$admin_service_file:admin.service" "$admin_timer_file:admin.timer" \
  "$admin_dropin_file:admin.dropin" "$admin_policy:admin.policy" \
  "$upgrade_service_file:upgrade.service" "$upgrade_timer_file:upgrade.timer" \
  "$upgrade_dropin_file:upgrade.dropin" "$upgrade_policy:upgrade.policy"; do
  restored_path=$(printf '%s' "$restored_entry" | cut -d: -f1)
  restored_label=$(printf '%s' "$restored_entry" | cut -d: -f2)
  if [ -f "$backup_root/$restored_label" ]; then
    cmp -s "$backup_root/$restored_label" "$restored_path"
  else
    test -f "$backup_root/$restored_label.absent"
    test ! -e "$restored_path"
    test ! -L "$restored_path"
  fi
done
test "$(timer_state "$admin_timer")" = "$admin_original"
test "$(timer_state "$upgrade_timer")" = "$upgrade_original"
test "$(timer_state gaiop-admin-retention-cleanup.timer)" = "$(cat "$backup_root/admin-retention.timer-state")"
test "$(timer_state gaiop-upgrade-retention-cleanup.timer)" = "$(cat "$backup_root/upgrade-retention.timer-state")"
test "$(timer_state gaiop-storage-watermark-monitor.timer)" = "$(cat "$backup_root/watermark.timer-state")"
test "$(timer_state gaiop-report-retention-cleanup.timer)" = "$(cat "$backup_root/report.timer-state")"
test "$(timer_state gaiop-admin-session-retention.timer)" = "$(cat "$backup_root/session.timer-state")"

printf 'POSTCHECK_ROLLBACK_COMPLETE=1\n'
printf 'BACKUP_EVIDENCE_PRESERVED=1\n'
printf 'BACKUP_ROOT=%s\n' "$backup_root"
printf 'ADMIN_TIMER=%s\n' "$(timer_state "$admin_timer")"
printf 'UPGRADE_TIMER=%s\n' "$(timer_state "$upgrade_timer")"
printf 'ADMIN_HEALTH=%s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health 2>/dev/null || printf 000)"
printf 'UPGRADE_HEALTH=%s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health 2>/dev/null || printf 000)"
`
}

async function enableSqliteBackups(client) {
  const publicHttpsBefore = await publicHttpsStatus()
  if (publicHttpsBefore !== 200) {
    return {
      completed: false,
      mode: 'enable-sqlite-backups',
      errorCode: 'SQLITE_BACKUP_PUBLIC_PREFLIGHT_FAILED',
      failedPhase: 'public_https_preflight',
      rollbackComplete: true,
      health: { httpsPublicBefore: publicHttpsBefore, httpsPublicAfter: null },
    }
  }
  const expected = {
    adminBackup: await sha256(join(adminSourceRoot, 'server', 'sqlite-backup.js')),
    adminRestore: await sha256(join(adminSourceRoot, 'server', 'sqlite-restore-test.js')),
    adminLibrary: await sha256(join(adminSourceRoot, 'server', 'lib', 'sqlite-backup-service.js')),
    adminService: sha256NormalizedText(join(adminSourceRoot, 'deploy', 'systemd', 'gaiop-admin-sqlite-backup.service')),
    adminTimer: sha256NormalizedText(join(adminSourceRoot, 'deploy', 'systemd', 'gaiop-admin-sqlite-backup.timer')),
    upgradeBackup: await sha256(join(upgradeSourceRoot, 'src', 'sqlite-backup.js')),
    upgradePackage: await sha256(join(upgradeSourceRoot, 'package.json')),
    upgradeRestore: await sha256(join(upgradeSourceRoot, 'src', 'sqlite-restore-test.js')),
    upgradeLibrary: await sha256(join(upgradeSourceRoot, 'src', 'services', 'SqliteBackupService.js')),
    upgradeConfig: await sha256(join(upgradeSourceRoot, 'src', 'config.js')),
    upgradeService: sha256NormalizedText(join(upgradeSourceRoot, 'deploy', 'systemd', 'gaiop-upgrade-sqlite-backup.service')),
    upgradeTimer: sha256NormalizedText(join(upgradeSourceRoot, 'deploy', 'systemd', 'gaiop-upgrade-sqlite-backup.timer')),
  }
  const remote = await runValidatedSudoScript(client, sqliteBackupEnableScript(expected))
  const values = parseKeyValues(remote.output)
  const publicHttpsAfter = await publicHttpsStatus()
  const remoteCompleted = remote.ok && values.SQLITE_BACKUP_ENABLE_COMPLETE === '1'
  let postcheckRollback = null
  let postcheckValues = {}
  let publicHttpsAfterRollback = null
  if (remoteCompleted && publicHttpsAfter !== 200) {
    postcheckRollback = await runValidatedSudoScript(client, sqliteBackupPostcheckRollbackScript(values))
    postcheckValues = parseKeyValues(postcheckRollback.output)
    publicHttpsAfterRollback = await publicHttpsStatus()
  }
  const completed = remoteCompleted && publicHttpsAfter === 200
  return {
    completed,
    mode: 'enable-sqlite-backups',
    errorCode: completed ? null : 'SQLITE_BACKUP_ENABLE_FAILED',
    failedPhase: completed
      ? null
      : (remoteCompleted && publicHttpsAfter !== 200 ? 'public_https_postcheck' : (values.FAILED_PHASE || 'remote_script')),
    rollbackComplete: completed
      ? false
      : (postcheckRollback
          ? postcheckRollback.ok && postcheckValues.POSTCHECK_ROLLBACK_COMPLETE === '1'
          : values.ROLLBACK_COMPLETE === '1'),
    releaseId: values.RELEASE_ID || releaseId,
    rollbackPoint: values.BACKUP_ROOT || null,
    backupEvidencePreserved: postcheckValues.BACKUP_EVIDENCE_PRESERVED === '1'
      || values.BACKUP_EVIDENCE_PRESERVED === '1',
    databaseBackupIntegrity: values.DATABASE_BACKUP_INTEGRITY || null,
    capacityGate: {
      availableBytes: Number(values.CAPACITY_AVAILABLE_BYTES || 0),
      requiredBytes: Number(values.CAPACITY_REQUIRED_BYTES || 0),
    },
    trustedTreePermissions: values.TRUSTED_TREE_PERMISSIONS || null,
    upgradeDatabasePermissions: values.UPGRADE_DATABASE_PERMISSIONS || null,
    validation: {
      adminDisabled: parseBase64Json(values.ADMIN_DISABLED_B64, null),
      upgradeDisabled: parseBase64Json(values.UPGRADE_DISABLED_B64, null),
      adminFirst: parseBase64Json(values.ADMIN_FIRST_B64, null),
      upgradeFirst: parseBase64Json(values.UPGRADE_FIRST_B64, null),
      adminSecond: parseBase64Json(values.ADMIN_SECOND_B64, null),
      upgradeSecond: parseBase64Json(values.UPGRADE_SECOND_B64, null),
      adminBackupSet: parseBase64Json(values.ADMIN_SET_B64, null),
      upgradeBackupSet: parseBase64Json(values.UPGRADE_SET_B64, null),
      adminRestoreTiers: Number(values.ADMIN_RESTORE_TIERS || 0),
      upgradeRestoreTiers: Number(values.UPGRADE_RESTORE_TIERS || 0),
    },
    timers: {
      adminSqlite: parseTimer(postcheckValues.ADMIN_TIMER || values.ADMIN_TIMER),
      upgradeSqlite: parseTimer(postcheckValues.UPGRADE_TIMER || values.UPGRADE_TIMER),
      adminNextTrigger: values.ADMIN_NEXT || null,
      upgradeNextTrigger: values.UPGRADE_NEXT || null,
      adminRetention: parseTimer(values.ADMIN_RETENTION_TIMER),
      upgradeRetention: parseTimer(values.UPGRADE_RETENTION_TIMER),
      watermark: parseTimer(values.WATERMARK_TIMER),
      report: parseTimer(values.REPORT_TIMER),
      session: parseTimer(values.SESSION_TIMER),
    },
    hashes: {
      expectedSources: expected,
      adminDropIn: values.ADMIN_DROPIN_SHA256 || null,
      upgradeDropIn: values.UPGRADE_DROPIN_SHA256 || null,
      adminPolicy: values.ADMIN_POLICY_SHA256 || null,
      upgradePolicy: values.UPGRADE_POLICY_SHA256 || null,
    },
    health: {
      admin: Number(postcheckValues.ADMIN_HEALTH || values.ADMIN_HEALTH || 0),
      upgrade: Number(postcheckValues.UPGRADE_HEALTH || values.UPGRADE_HEALTH || 0),
      upgradeUnauthenticated: Number(values.UPGRADE_UNAUTHENTICATED || 0),
      gateway: Number(values.GATEWAY_HEALTH || 0),
      httpsPublicBefore: publicHttpsBefore,
      httpsPublicAfter: publicHttpsAfter,
      httpsPublicAfterRollback: publicHttpsAfterRollback,
    },
  }
}

function publicHttpsStatus() {
  return new Promise((resolve) => {
    const request = https.get({
      hostname: connection.host,
      port: 443,
      path: '/',
      rejectUnauthorized: false,
      timeout: 8_000,
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode || 0))
    })
    request.on('timeout', () => {
      request.destroy()
      resolve(0)
    })
    request.on('error', () => resolve(0))
  })
}

function parseKeyValues(output) {
  const values = {}
  for (const line of String(output || '').split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return values
}

function parseBase64Json(value, fallback) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'))
  } catch {
    return fallback
  }
}

function parseTimer(value) {
  const [active = 'unknown', enabled = 'unknown'] = String(value || '').split('|')
  return { active, enabled }
}

function stableLabelSummary(managedRoots) {
  const devices = new Map()
  for (const root of managedRoots) {
    if (!root.filesystemId) continue
    if (!devices.has(root.filesystemId)) devices.set(root.filesystemId, [])
    devices.get(root.filesystemId).push(root.label)
  }
  return Array.from(devices, ([filesystemId, labels]) => ({ filesystemId, labels: labels.sort() }))
}

function summarizePreflight(remote, publicStatus) {
  const values = parseKeyValues(remote.output)
  const managedRoots = parseBase64Json(values.MANAGED_ROOTS_B64, [])
  return {
    completed: remote.ok,
    mode: 'preflight',
    checkedAt: values.UTC || null,
    versions: {
      adminSourceHash: values.ADMIN_HASH || null,
      upgradeSourceHash: values.UPGRADE_HASH || null,
      systemd: values.SYSTEMD_VERSION || null,
    },
    paths: {
      adminRoot: values.ADMIN_ROOT || null,
      adminDatabase: values.ADMIN_DB || null,
      upgradeRoot: values.UPGRADE_ROOT || null,
      upgradeDatabase: values.UPGRADE_DB || null,
    },
    services: {
      admin: values.ADMIN_SERVICE || null,
      upgrade: values.UPGRADE_SERVICE || null,
      gateway: values.GATEWAY_SERVICE || null,
      caddy: values.CADDY_SERVICE || null,
    },
    listeners: {
      admin: values.ADMIN_LISTENER || null,
      upgrade: values.UPGRADE_LISTENER || null,
    },
    health: {
      admin: Number(values.ADMIN_HEALTH || 0),
      adminRoot: Number(values.ADMIN_ROOT_HTTP || 0),
      upgrade: Number(values.UPGRADE_HEALTH || 0),
      upgradeUnauthenticated: Number(values.UPGRADE_UNAUTH || 0),
      gateway: Number(values.GATEWAY_HEALTH || 0),
      httpsLoopback: Number(values.HTTPS_LOOPBACK || 0),
      httpsPublic: publicStatus,
    },
    databases: {
      admin: parseBase64Json(values.ADMIN_DB_SUMMARY_B64, null),
      upgrade: parseBase64Json(values.UPGRADE_DB_SUMMARY_B64, null),
    },
    directoryCounts: {
      reportProvenance: values.PROVENANCE_COUNT || null,
      adminUpgradeStaging: values.ADMIN_STAGING_COUNT || null,
      upgradePackages: values.UPGRADE_PACKAGES_COUNT || null,
      upgradeStaging: values.UPGRADE_STAGING_COUNT || null,
      upgradeRollback: values.UPGRADE_ROLLBACK_COUNT || null,
      formalReports: values.FORMAL_REPORT_COUNT || null,
    },
    timers: {
      adminRetention: parseTimer(values.ADMIN_RETENTION_TIMER),
      upgradeRetention: parseTimer(values.UPGRADE_RETENTION_TIMER),
      reportRetention: parseTimer(values.REPORT_RETENTION_TIMER),
      sessionRetention: parseTimer(values.SESSION_RETENTION_TIMER),
      adminSqlite: parseTimer(values.ADMIN_SQLITE_TIMER),
      upgradeSqlite: parseTimer(values.UPGRADE_SQLITE_TIMER),
      watermark: parseTimer(values.WATERMARK_TIMER),
    },
    storage: {
      adminFilesystemUse: values.DISK_USE || null,
      managedRoots,
      filesystems: stableLabelSummary(managedRoots),
    },
    recentRetentionBackup: values.RECENT_RETENTION_BACKUP || null,
  }
}

const client = new Client()
let finished = false

client.on('ready', async () => {
  try {
    if (mode === 'verify-units') {
      const summary = await verifyUnits(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'deploy-upgrade') {
      const summary = await deployUpgrade(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'deploy-admin') {
      const summary = await deployAdmin(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'diagnose-admin') {
      const summary = await diagnoseAdmin(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'close-disabled-timers') {
      const summary = await closeDisabledTimers(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'verify-watermark') {
      const summary = await verifyWatermark(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'inspect-watermark-filesystems') {
      const summary = await inspectWatermarkFilesystems(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'deploy-watermark-probes') {
      const summary = await deployWatermarkProbes(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'verify-enable-watermark') {
      const summary = await verifyEnableWatermark(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'observe-watermark') {
      const summary = await observeWatermark(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'rollback-watermark') {
      const summary = await rollbackWatermark(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'repair-enable-upgrade-retention') {
      const summary = await repairEnableUpgradeRetention(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    if (mode === 'enable-sqlite-backups') {
      const summary = await enableSqliteBackups(client)
      finished = true
      process.stdout.write(`${JSON.stringify(summary)}\n`)
      if (!summary.completed) process.exitCode = 1
      return
    }
    const [remote, publicStatus] = await Promise.all([
      runSudoScript(client, preflightScript),
      publicHttpsStatus(),
    ])
    const summary = summarizePreflight(remote, publicStatus)
    finished = true
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.completed) process.exitCode = 1
  } catch {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, mode, errorCode: 'RETENTION_RELEASE_FAILED' })}\n`)
    process.exitCode = 1
  } finally {
    client.end()
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  process.stdout.write(`${JSON.stringify({ completed: false, mode, errorCode: 'RETENTION_RELEASE_SSH_FAILED' })}\n`)
  process.exitCode = 1
})

client.connect(connection)
