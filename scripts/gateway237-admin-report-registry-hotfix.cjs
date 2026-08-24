'use strict'

const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { join } = require('node:path')
const { Client } = require('ssh2')

const mode = String(process.env.GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_MODE || '').trim()
const releaseId = String(process.env.GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_RELEASE_ID || '').trim()
const sourceRoot = String(process.env.GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SOURCE_ROOT || '').trim()
const connection = {
  host: String(process.env.GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_REPORT_REGISTRY_HOTFIX_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
const files = [
  { key: 'index', relative: 'server/index.js', remote: 'index.js' },
  { key: 'routes', relative: 'server/routes/reports.js', remote: 'reports.js' },
  { key: 'sync', relative: 'server/report-registry-sync.js', remote: 'report-registry-sync.js' },
]

if (!['preflight', 'deploy'].includes(mode)) throw new Error('The Admin report registry hotfix mode is unavailable.')
if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) throw new Error('The Admin report registry hotfix release ID is invalid.')
if (mode === 'deploy' && !sourceRoot) throw new Error('The Admin report registry hotfix source root is missing.')
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled 237 connection is incomplete.')

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
    sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (putError) => { sftp.end(); putError ? reject(putError) : resolve() })
  }))
}
function execute(client, script) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '', errorOutput: error.message })
    let output = ''
    let errorOutput = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', (chunk) => { errorOutput += chunk.toString('utf8') })
    stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output, errorOutput, exitCode }))
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  }))
}

function remoteScript({ uploaded, checksums }) {
  const remote = Object.fromEntries(files.map((file) => [file.key, uploaded[file.key]]))
  return String.raw`set -euo pipefail
admin_root='/opt/gaiop/admin'
index_path="$admin_root/server/index.js"
routes_path="$admin_root/server/routes/reports.js"
sync_path="$admin_root/server/report-registry-sync.js"
admin_db='/var/lib/gaiop/admin/wizard.db'
backup_root="/var/backups/gaiop/admin-report-registry-${releaseId}"
admin_was_active=0
committed=0
phase='PRECHECK'
index_owner=''
index_mode=''
index_uid=''
index_gid=''
mark() { phase="$1"; printf 'PHASE_%s\n' "$phase"; }
cleanup() { rm -f -- '${remote.index}' '${remote.routes}' '${remote.sync}'; }
rollback() {
  status=$?
  set +e
  if [ "$committed" -eq 0 ] && [ -d "$backup_root" ]; then
    systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
    [ -f "$backup_root/index.js" ] && cp -a -- "$backup_root/index.js" "$index_path"
    [ -f "$backup_root/reports.js" ] && cp -a -- "$backup_root/reports.js" "$routes_path"
    if [ -f "$backup_root/report-registry-sync.js" ]; then
      cp -a -- "$backup_root/report-registry-sync.js" "$sync_path"
    else
      rm -f -- "$sync_path"
    fi
    [ "$admin_was_active" -eq 1 ] && systemctl start gaiop-admin.service >/dev/null 2>&1 || true
  fi
  cleanup
  printf 'FAILED_PHASE=%s\n' "$phase"
  exit "$status"
}
trap rollback ERR
mark PRECHECK
test -f "$index_path"
test -f "$routes_path"
test ! -e "$sync_path"
test -f "$admin_db"
test "$(sha256sum '${remote.index}' | awk '{print $1}')" = '${checksums.index}'
test "$(sha256sum '${remote.routes}' | awk '{print $1}')" = '${checksums.routes}'
test "$(sha256sum '${remote.sync}' | awk '{print $1}')" = '${checksums.sync}'
node --check '${remote.index}'
node --check '${remote.routes}'
node --check '${remote.sync}'
grep -Fq "app.use('/api/reports'" "$index_path"
grep -Fq 'function syncGeneratedReports(db)' "$routes_path"
grep -Fq 'function syncReportDeliveries(db)' "$routes_path"
! grep -Fq "./report-registry-sync.js" "$index_path"
! grep -Fq 'export function syncGeneratedReports(db)' "$routes_path"
! grep -Fq 'export function syncReportDeliveries(db)' "$routes_path"
index_owner=$(stat -c '%u:%g' "$index_path")
index_mode=$(stat -c '%a' "$index_path")
index_uid=$(stat -c '%u' "$index_path")
index_gid=$(stat -c '%g' "$index_path")
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else printf 'BLOCK_ADMIN_INACTIVE\n'; exit 41; fi
if [ -e "$backup_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 42; fi
install -d -m 0700 "$backup_root"
mark BACKUP_CODE
cp -a -- "$index_path" "$backup_root/index.js"
cp -a -- "$routes_path" "$backup_root/reports.js"
printf 'CODE_BACKUP_CREATED\n'
mark DATABASE_BACKUP
/usr/local/bin/node - "$admin_db" "$backup_root/wizard.db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const [sourcePath, destinationPath] = process.argv.slice(2)
const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
;(async () => { try { await source.backup(destinationPath); const backup = new Database(destinationPath, { readonly: true, fileMustExist: true }); try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup_integrity_failed') } finally { backup.close() } } finally { source.close() } })().catch((error) => { console.error(error.message); process.exit(1) })
NODE
printf 'DATABASE_BACKUP_CREATED\n'
mark DATABASE_BASELINE
before_count=$(/usr/local/bin/node - "$admin_db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try { if (db.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1); process.stdout.write(String(db.prepare('SELECT COUNT(*) AS count FROM report_files').get().count)) } finally { db.close() }
NODE
)
printf 'REPORT_COUNT_BEFORE=%s\n' "$before_count"
mark STOP
systemctl stop gaiop-admin.service
mark SWITCH
install -o "$index_uid" -g "$index_gid" -m "$index_mode" '${remote.index}' "$index_path"
install -o "$index_uid" -g "$index_gid" -m "$index_mode" '${remote.routes}' "$routes_path"
install -o "$index_uid" -g "$index_gid" -m "$index_mode" '${remote.sync}' "$sync_path"
test "$(sha256sum "$index_path" | awk '{print $1}')" = '${checksums.index}'
test "$(sha256sum "$routes_path" | awk '{print $1}')" = '${checksums.routes}'
test "$(sha256sum "$sync_path" | awk '{print $1}')" = '${checksums.sync}'
mark START
systemctl start gaiop-admin.service
for _ in $(seq 1 60); do systemctl is-active --quiet gaiop-admin.service && break; sleep 1; done
systemctl is-active --quiet gaiop-admin.service
mark VERIFY_REGISTRATION
after_count=''
for _ in $(seq 1 40); do after_count=$(/usr/local/bin/node - "$admin_db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try { process.stdout.write(String(db.prepare('SELECT COUNT(*) AS count FROM report_files').get().count)) } finally { db.close() }
NODE
); if [ "$after_count" -gt "$before_count" ]; then break; fi; sleep 3; done
if [ -z "$after_count" ] || [ "$after_count" -le "$before_count" ]; then printf 'BLOCK_REGISTRATION_NOT_OBSERVED\n'; exit 43; fi
printf 'REPORT_COUNT_AFTER=%s\n' "$after_count"
mark VERIFY_HEALTH
systemctl is-active --quiet gaiop-admin.service
integrity_after=$(/usr/local/bin/node - "$admin_db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try { process.stdout.write(String(db.pragma('integrity_check', { simple: true }))) } finally { db.close() }
NODE
)
test "$integrity_after" = 'ok'
printf 'INTEGRITY_AFTER=%s\n' "$integrity_after"
mark COMPLETE
committed=1
cleanup
printf 'INTEGRATION_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
`
}

function parseResult(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /INTEGRATION_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1] || output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '') || 'UNKNOWN',
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    reportCountBefore: Number(output.match(/^REPORT_COUNT_BEFORE=(\d+)$/m)?.[1] || 0),
    reportCountAfter: Number(output.match(/^REPORT_COUNT_AFTER=(\d+)$/m)?.[1] || 0),
    integrityAfter: output.match(/^INTEGRITY_AFTER=(.+)$/m)?.[1] || null,
    rollbackAttempted: /FAILED_PHASE=/.test(output),
    failureDiagnostic: String(result.errorOutput || '').trim().split(/\r?\n/).slice(-8).join(' | ') || null,
  }
}

async function main() {
  const client = new Client()
  const timeout = setTimeout(() => { process.stdout.write(JSON.stringify({ completed: false, errorCode: 'ADMIN_REPORT_REGISTRY_HOTFIX_TIMEOUT' }) + '\n'); client.end(); process.exitCode = 1 }, 180_000)
  const result = await new Promise((resolve, reject) => {
    client.once('error', reject)
    client.on('ready', async () => {
      try {
        if (mode === 'preflight') {
          const check = await execute(client, "set -eu\nsystemctl is-active gaiop-admin.service\ntest -f /opt/gaiop/admin/server/index.js\ntest -f /opt/gaiop/admin/server/routes/reports.js\ntest -f /var/lib/gaiop/admin/wizard.db\nprintf 'ADMIN_REPORT_REGISTRY_PREFLIGHT_OK\\n'\n")
          resolve({ completed: check.ok && /ADMIN_REPORT_REGISTRY_PREFLIGHT_OK/.test(check.output), phase: 'PREFLIGHT', diagnostic: check.output.trim() })
          return
        }
        const checksums = {}
        const uploaded = {}
        for (const file of files) { const localPath = join(sourceRoot, file.relative); checksums[file.key] = await sha256(localPath); uploaded[file.key] = `/tmp/gaiop-admin-report-registry-${releaseId}-${file.remote}`; await upload(client, localPath, uploaded[file.key]) }
        resolve(parseResult(await execute(client, remoteScript({ uploaded, checksums }))))
      } catch (error) { reject(error) }
    })
    client.connect(connection)
  })
  clearTimeout(timeout)
  client.end()
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.completed) process.exitCode = 1
}
main().catch((error) => { process.stdout.write(JSON.stringify({ completed: false, errorCode: 'ADMIN_REPORT_REGISTRY_HOTFIX_FAILED', message: error.message }) + '\n'); process.exitCode = 1 })
