'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_REPORT_DELIVERY_AUDIT_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_REPORT_DELIVERY_AUDIT_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_DELIVERY_AUDIT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DELIVERY_AUDIT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DELIVERY_AUDIT_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The controlled report-delivery audit release inputs are incomplete.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-delivery audit connection context is incomplete.')
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
  return new Promise((resolve, reject) => client.sftp((error, sftp) => {
    if (error) return reject(error)
    sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (putError) => {
      sftp.end()
      putError ? reject(putError) : resolve()
    })
  }))
}

function execute(client, script) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  }))
}

function remoteScript({ checksum, remoteArchive }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
archive='${remoteArchive}'
expected_archive_sha='${checksum}'
stage_root="/tmp/gaiop-report-delivery-audit-stage-$release_id"
backup_root="/var/backups/gaiop/report-delivery-audit-$release_id"
workspace_plugin='/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js'
extension_plugin='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
admin_root='/opt/gaiop/admin'
admin_database="$admin_root/server/database.js"
admin_reports="$admin_root/server/routes/reports.js"
admin_dist="$admin_root/dist"
database_file='/var/lib/gaiop/admin/wizard.db'
event_root='/var/lib/gaiop/reports/.delivery-events'
gateway_runtime="/run/user/$(id -u netinside)"
phase='INITIAL'
completed=0
gateway_was_active=0
admin_was_active=0

gatewayctl() { sudo -u netinside XDG_RUNTIME_DIR="$gateway_runtime" systemctl --user "$@"; }
mark_phase() { phase="$1"; printf 'PHASE=%s\n' "$phase"; }
rollback() {
  status=$?
  if [ "$completed" -eq 0 ] && [ -d "$backup_root" ]; then
    systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
    gatewayctl stop openclaw-gateway.service >/dev/null 2>&1 || true
    test ! -f "$backup_root/workspace-plugin.js" || cp -a -- "$backup_root/workspace-plugin.js" "$workspace_plugin"
    test ! -f "$backup_root/extension-plugin.js" || cp -a -- "$backup_root/extension-plugin.js" "$extension_plugin"
    test ! -f "$backup_root/database.js" || cp -a -- "$backup_root/database.js" "$admin_database"
    test ! -f "$backup_root/reports.js" || cp -a -- "$backup_root/reports.js" "$admin_reports"
    if [ -d "$backup_root/dist" ]; then
      rm -rf -- "$admin_dist"
      cp -a -- "$backup_root/dist" "$admin_dist"
    fi
    if [ -f "$backup_root/wizard.db" ]; then
      rm -f -- "$database_file-wal" "$database_file-shm"
      cp -a -- "$backup_root/wizard.db" "$database_file"
    fi
    chown gaiop:gaiop "$database_file" >/dev/null 2>&1 || true
    if [ "$gateway_was_active" -eq 1 ]; then gatewayctl start openclaw-gateway.service >/dev/null 2>&1 || true; fi
    if [ "$admin_was_active" -eq 1 ]; then systemctl start gaiop-admin.service >/dev/null 2>&1 || true; fi
  fi
  rm -rf -- "$stage_root"
  rm -f -- "$archive"
  exit "$status"
}
trap rollback ERR

mark_phase PRECHECK
test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_archive_sha"
test -f "$workspace_plugin"
test -f "$extension_plugin"
test -f "$admin_database"
test -f "$admin_reports"
test -d "$admin_dist"
if gatewayctl is-active --quiet openclaw-gateway.service; then gateway_was_active=1; fi
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; fi

mark_phase STAGE
test ! -e "$stage_root"
install -d -o root -g root -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/napm-openclaw-plugin.remote.js"
test -f "$stage_root/admin/server/database.js"
test -f "$stage_root/admin/server/routes/reports.js"
test -f "$stage_root/admin/dist/index.html"
node --check "$stage_root/napm-openclaw-plugin.remote.js"
node --check "$stage_root/admin/server/database.js"
node --check "$stage_root/admin/server/routes/reports.js"
grep -Fq 'gaiop.report-delivery.v1' "$stage_root/napm-openclaw-plugin.remote.js"
grep -Fq 'CREATE TABLE IF NOT EXISTS report_deliveries' "$stage_root/admin/server/database.js"
grep -Fq 'syncReportDeliveries' "$stage_root/admin/server/routes/reports.js"
if grep -Rqs '交付状态' "$stage_root/admin/dist"; then exit 48; fi

mark_phase BACKUP
test ! -e "$backup_root"
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$workspace_plugin" "$backup_root/workspace-plugin.js"
cp -a -- "$extension_plugin" "$backup_root/extension-plugin.js"
cp -a -- "$admin_database" "$backup_root/database.js"
cp -a -- "$admin_reports" "$backup_root/reports.js"
cp -a -- "$admin_dist" "$backup_root/dist"
if [ -f "$database_file" ]; then
  systemctl stop gaiop-admin.service
  cp -a -- "$database_file" "$backup_root/wizard.db"
fi
gatewayctl stop openclaw-gateway.service

mark_phase INSTALL
install -o netinside -g netinside -m 0644 "$stage_root/napm-openclaw-plugin.remote.js" "$workspace_plugin"
install -o netinside -g netinside -m 0644 "$stage_root/napm-openclaw-plugin.remote.js" "$extension_plugin"
install -o gaiop -g gaiop -m 0644 "$stage_root/admin/server/database.js" "$admin_database"
install -o gaiop -g gaiop -m 0644 "$stage_root/admin/server/routes/reports.js" "$admin_reports"
rm -rf -- "$admin_dist"
mv -- "$stage_root/admin/dist" "$admin_dist"
chown -R gaiop:gaiop "$admin_dist"
install -d -o netinside -g gaiop -m 2750 "$event_root"

mark_phase MIGRATE
sudo -u gaiop node --env-file=/etc/gaiop/admin.env --input-type=module \
  -e "await import('file:///opt/gaiop/admin/server/database.js')"

mark_phase START
gatewayctl start openclaw-gateway.service
systemctl start gaiop-admin.service
for _ in $(seq 1 30); do
  gatewayctl is-active --quiet openclaw-gateway.service && systemctl is-active --quiet gaiop-admin.service && break
  sleep 1
done
gatewayctl is-active --quiet openclaw-gateway.service
systemctl is-active --quiet gaiop-admin.service

mark_phase VERIFY_PLUGIN
plugin_sha=$(sha256sum -- "$workspace_plugin" | awk '{print $1}')
test "$plugin_sha" = "$(sha256sum -- "$extension_plugin" | awk '{print $1}')"
test "$plugin_sha" = "$(sha256sum -- "$stage_root/napm-openclaw-plugin.remote.js" | awk '{print $1}')"
mark_phase VERIFY_EVENT_ACCESS
sudo -u netinside sh -c "printf probe > '$event_root/.permission-probe-$release_id'"
sudo -u gaiop test -r "$event_root/.permission-probe-$release_id"
rm -f -- "$event_root/.permission-probe-$release_id"
mark_phase VERIFY_SCHEMA
node - "$database_file" "$admin_root/node_modules/better-sqlite3" <<'NODE'
const [databasePath, modulePath] = process.argv.slice(2)
try {
  const Database = require(modulePath)
  const db = new Database(databasePath, { readonly: true })
  const columns = new Set(db.prepare('PRAGMA table_info(report_deliveries)').all().map((row) => row.name))
  const required = ['id', 'report_id', 'event_name', 'channel', 'status', 'prepared_at', 'handed_off_at', 'error_code']
  const missing = required.filter((column) => !columns.has(column))
  db.close()
  if (missing.length > 0) {
    process.stdout.write('SCHEMA_REASON=MISSING_' + missing.join('_') + '\n')
    process.exit(1)
  }
} catch {
  process.stdout.write('SCHEMA_REASON=DATABASE_OPEN_OR_MODULE_FAILED\n')
  process.exit(1)
}
NODE
mark_phase VERIFY_HEALTH
health_ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    health_ready=1
    break
  fi
  sleep 1
done
test "$health_ready" -eq 1
completed=1
rm -rf -- "$stage_root"
rm -f -- "$archive"
printf 'COMPLETE=1\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'PLUGIN_SHA=%s\n' "$plugin_sha"
printf 'GATEWAY_SERVICE=%s\n' "$(gatewayctl is-active openclaw-gateway.service)"
printf 'ADMIN_SERVICE=%s\n' "$(systemctl is-active gaiop-admin.service)"
printf 'DELIVERY_SCHEMA=ready\n'
printf 'EVENT_ACCESS=ready\n'
`
}

function summarize(result) {
  const values = Object.create(null)
  for (const line of String(result.output || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match) values[match[1]] = match[2]
  }
  return {
    completed: result.ok && values.COMPLETE === '1',
    phase: values.PHASE || 'UNKNOWN',
    backupPath: values.BACKUP_PATH || null,
    pluginSha256: values.PLUGIN_SHA || null,
    gatewayService: values.GATEWAY_SERVICE || null,
    adminService: values.ADMIN_SERVICE || null,
    deliverySchema: values.DELIVERY_SCHEMA || null,
    eventAccess: values.EVENT_ACCESS || null,
    schemaReason: values.SCHEMA_REASON || null,
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write(`${JSON.stringify({ completed: false, phase: 'TIMEOUT' })}\n`)
  finished = true
  client.end()
  process.exitCode = 1
}, 5 * 60_000)

client.on('ready', async () => {
  try {
    const checksum = await sha256(archivePath)
    const remoteArchive = `/tmp/gaiop-report-delivery-audit-${releaseId}.tgz`
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, remoteScript({ checksum, remoteArchive }))
    const summary = summarize(result)
    finished = true
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.completed) process.exitCode = 1
  } catch {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, phase: 'TRANSFER_OR_RUNNER_FAILED' })}\n`)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})

client.on('error', () => {
  if (!finished) {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, phase: 'SSH_CONNECTION_FAILED' })}\n`)
    clearTimeout(timeout)
    process.exitCode = 1
  }
})

client.connect(connection)
