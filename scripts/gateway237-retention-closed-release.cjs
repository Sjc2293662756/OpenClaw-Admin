'use strict'

const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const https = require('node:https')
const { Client } = require('ssh2')

const mode = String(process.env.GAIOP_RETENTION_RELEASE_MODE || '').trim()
const releaseId = String(process.env.GAIOP_RETENTION_RELEASE_ID || '').trim()
const adminArchive = String(process.env.GAIOP_RETENTION_RELEASE_ADMIN_ARCHIVE || '').trim()
const upgradeArchive = String(process.env.GAIOP_RETENTION_RELEASE_UPGRADE_ARCHIVE || '').trim()
const connection = {
  host: String(process.env.GAIOP_RETENTION_RELEASE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_RETENTION_RELEASE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_RETENTION_RELEASE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!['preflight', 'verify-units', 'deploy-upgrade', 'deploy-admin', 'diagnose-admin', 'close-disabled-timers', 'verify-watermark'].includes(mode)) {
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

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
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
phase=precheck
mutation_started=0
complete=0

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
    systemctl stop gaiop-upgrade.service
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
      && [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health 2>/dev/null || true)" = 200 ]; then
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

phase=precheck
test "$(systemctl is-active gaiop-upgrade.service)" = active
test ! -e "$stage_root"
test ! -e "$backup_root"
test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_sha"
test -d "$current_root/node_modules/better-sqlite3"

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

phase=closed_state
before_packages=$(find /var/lib/gaiop-upgrade/packages -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
before_staging=$(find /var/lib/gaiop-upgrade/staging -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
before_rollback=$(find /var/backups/gaiop/upgrade -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
before_sqlite=$(find "$database_root/sqlite-backups" -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
systemctl start gaiop-upgrade-retention-cleanup.service
systemctl start gaiop-upgrade-sqlite-backup.service
after_packages=$(find /var/lib/gaiop-upgrade/packages -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
after_staging=$(find /var/lib/gaiop-upgrade/staging -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
after_rollback=$(find /var/backups/gaiop/upgrade -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
after_sqlite=$(find "$database_root/sqlite-backups" -mindepth 1 -maxdepth 1 -printf x 2>/dev/null | wc -c | tr -d '[:space:]')
test "$before_packages" = "$after_packages"
test "$before_staging" = "$after_staging"
test "$before_rollback" = "$after_rollback"
test "$before_sqlite" = "$after_sqlite"
test "$(systemctl show gaiop-upgrade-retention-cleanup.service -p Result --value)" = success
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

complete=1
printf 'UPGRADE_DEPLOY_COMPLETE=1\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'DATABASE_BACKUP=%s\n' "$database_backup"
printf 'DATABASE_BACKUP_INTEGRITY=ok\n'
printf 'SOURCE_HASH=%s\n' "$staged_source_hash"
printf 'HEALTH=200\n'
printf 'UNAUTHENTICATED_STATUS=401\n'
printf 'RETENTION_ONESHOT=success\n'
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
  const expected = ['report_retention_plans', 'session_retention_records', 'storage_watermark_status']
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
    process.stdout.write('{"completed":false,"mode":"preflight","errorCode":"RETENTION_PREFLIGHT_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  process.stdout.write('{"completed":false,"mode":"preflight","errorCode":"RETENTION_PREFLIGHT_SSH_FAILED"}\n')
  process.exitCode = 1
})

client.connect(connection)
