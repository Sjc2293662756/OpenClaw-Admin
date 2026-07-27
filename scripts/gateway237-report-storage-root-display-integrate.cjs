'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_REPORT_ROOT_DISPLAY_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_REPORT_ROOT_DISPLAY_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_ROOT_DISPLAY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_ROOT_DISPLAY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_ROOT_DISPLAY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report root display release inputs are incomplete.')
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
stage_root="/tmp/gaiop-report-root-display-stage-$release_id"
backup_root="/var/backups/gaiop/report-root-display-$release_id"
admin_root='/opt/gaiop/admin'
admin_dist="$admin_root/dist"
report_storage_route="$admin_root/server/routes/report-storage.js"
phase='INITIAL'
completed=0
admin_was_active=0

mark_phase() { phase="$1"; printf 'PHASE=%s\n' "$phase"; }
tree_sha() {
  root="$1"
  find "$root" -type f -printf '%P\0' \
    | sort -z \
    | while IFS= read -r -d '' relative; do
        printf '%s  %s\n' "$(sha256sum -- "$root/$relative" | awk '{print $1}')" "$relative"
      done \
    | sha256sum \
    | awk '{print $1}'
}
rollback() {
  status=$?
  if [ "$completed" -eq 0 ] && [ -d "$backup_root" ]; then
    systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
    if [ -d "$backup_root/dist" ]; then
      rm -rf -- "$admin_dist"
      cp -a -- "$backup_root/dist" "$admin_dist"
    fi
    test ! -f "$backup_root/report-storage.js" \
      || cp -a -- "$backup_root/report-storage.js" "$report_storage_route"
    if [ "$admin_was_active" -eq 1 ]; then systemctl start gaiop-admin.service >/dev/null 2>&1 || true; fi
  fi
  rm -rf -- "$stage_root"
  rm -f -- "$archive"
  printf 'FAILED_PHASE=%s\n' "$phase"
  exit "$status"
}
trap rollback ERR

mark_phase PRECHECK
test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_archive_sha"
test -d "$admin_dist"
test -f "$report_storage_route"
grep -Fxq 'GAIOP_REPORTS_DIR=/var/lib/gaiop/reports' /etc/gaiop/admin.env
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else exit 42; fi
test ! -e "$stage_root"
test ! -e "$backup_root"

mark_phase STAGE
install -d -o root -g root -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/dist/index.html"
test -f "$stage_root/server/routes/report-storage.js"
node --check "$stage_root/server/routes/report-storage.js"
grep -Fq 'reportStorageRoot' "$stage_root/server/routes/report-storage.js"
grep -RFl '真实存储路径' "$stage_root/dist" >/dev/null
stage_dist_sha=$(tree_sha "$stage_root/dist")

mark_phase BACKUP
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$admin_dist" "$backup_root/dist"
cp -a -- "$report_storage_route" "$backup_root/report-storage.js"
printf 'BACKUP_CREATED\n'

mark_phase INSTALL
systemctl stop gaiop-admin.service
rm -rf -- "$admin_dist"
cp -a -- "$stage_root/dist" "$admin_dist"
install -o gaiop -g gaiop -m 0644 \
  "$stage_root/server/routes/report-storage.js" "$report_storage_route"
chown -R gaiop:gaiop "$admin_dist"

mark_phase START
systemctl start gaiop-admin.service
for _ in $(seq 1 60); do
  if systemctl is-active --quiet gaiop-admin.service \
    && curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then break; fi
  sleep 1
done
systemctl is-active --quiet gaiop-admin.service
curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null

mark_phase VERIFY_ROUTE
cd "$admin_root"
GAIOP_REPORTS_DIR=/var/lib/gaiop/reports node --input-type=module - <<'NODE'
import express from 'express'
import { once } from 'node:events'
import { createReportStorageRouter } from './server/routes/report-storage.js'
const app = express()
app.use('/probe', createReportStorageRouter({
  adminMiddleware(req, _res, next) { req.user = { id: 'deployment-probe', role: 'admin' }; next() },
  recordAudit() {},
}))
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/probe')
  const payload = await response.json()
  if (!response.ok || payload.reportStorageRoot !== '/var/lib/gaiop/reports') process.exit(11)
} finally {
  server.close()
}
NODE

mark_phase VERIFY_ASSETS
grep -RFl '真实存储路径' "$admin_dist" >/dev/null
test "$(tree_sha "$admin_dist")" = "$stage_dist_sha"
route_sha=$(sha256sum -- "$report_storage_route" | awk '{print $1}')
test "$route_sha" = "$(sha256sum -- "$stage_root/server/routes/report-storage.js" | awk '{print $1}')"
index_asset=$(sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' "$admin_dist/index.html" | head -n 1)
test -n "$index_asset"
index_relative=$(printf '%s' "$index_asset" | sed 's#^/##')
test -f "$admin_dist/$index_relative"

mark_phase COMPLETE
completed=1
printf 'REPORT_ROOT_DISPLAY_RELEASE_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'DIST_SHA256=%s\n' "$stage_dist_sha"
printf 'ROUTE_SHA256=%s\n' "$route_sha"
rm -rf -- "$stage_root"
rm -f -- "$archive"
`
}

function summarize(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /REPORT_ROOT_DISPLAY_RELEASE_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/^PHASE=([A-Z_]+)$/gm)?.at(-1)?.replace('PHASE=', '')
      || 'UNKNOWN',
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    distSha256: output.match(/^DIST_SHA256=(.+)$/m)?.[1] || null,
    routeSha256: output.match(/^ROUTE_SHA256=(.+)$/m)?.[1] || null,
    errorCode: result.ok ? null : 'REPORT_ROOT_DISPLAY_RELEASE_FAILED',
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"REPORT_ROOT_DISPLAY_RELEASE_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 180_000)

client.on('ready', async () => {
  const remoteArchive = `/tmp/gaiop-report-root-display-${releaseId}.tgz`
  try {
    const checksum = await sha256(archivePath)
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, remoteScript({ checksum, remoteArchive }))
    finished = true
    clearTimeout(timeout)
    const summary = summarize(result)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.completed) process.exitCode = 1
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"completed":false,"errorCode":"REPORT_ROOT_DISPLAY_RELEASE_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"errorCode":"REPORT_ROOT_DISPLAY_SSH_FAILED"}\n')
  process.exitCode = 1
})

client.connect(connection)
