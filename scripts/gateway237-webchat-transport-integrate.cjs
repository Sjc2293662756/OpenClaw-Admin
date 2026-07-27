'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_WEBCHAT_TRANSPORT_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_WEBCHAT_TRANSPORT_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_WEBCHAT_TRANSPORT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEBCHAT_TRANSPORT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEBCHAT_TRANSPORT_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled WebChat transport release inputs are incomplete.')
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
stage_root="/tmp/gaiop-webchat-transport-stage-$release_id"
backup_root="/var/backups/gaiop/webchat-transport-$release_id"
admin_root='/opt/gaiop/admin'
admin_index="$admin_root/server/index.js"
provenance_service="$admin_root/server/report-provenance-service.js"
phase='INITIAL'
completed=0
admin_was_active=0

mark_phase() { phase="$1"; printf 'PHASE=%s\n' "$phase"; }
rollback() {
  status=$?
  if [ "$completed" -eq 0 ] && [ -d "$backup_root" ]; then
    systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
    test ! -f "$backup_root/index.js" || cp -a -- "$backup_root/index.js" "$admin_index"
    test ! -f "$backup_root/report-provenance-service.js" || cp -a -- "$backup_root/report-provenance-service.js" "$provenance_service"
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
test -f "$admin_index"
test -f "$provenance_service"
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else exit 42; fi
test ! -e "$stage_root"
test ! -e "$backup_root"

mark_phase STAGE
install -d -o root -g root -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/server/index.js"
test -f "$stage_root/server/report-provenance-service.js"
node --check "$stage_root/server/index.js"
node --check "$stage_root/server/report-provenance-service.js"
grep -Fq 'transportMetadata: false' "$stage_root/server/index.js"
grep -Fq 'transportMetadata !== false' "$stage_root/server/report-provenance-service.js"

mark_phase BACKUP
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$admin_index" "$backup_root/index.js"
cp -a -- "$provenance_service" "$backup_root/report-provenance-service.js"
printf 'BACKUP_CREATED\n'

mark_phase INSTALL
systemctl stop gaiop-admin.service
install -o gaiop -g gaiop -m 0644 "$stage_root/server/index.js" "$admin_index"
install -o gaiop -g gaiop -m 0644 "$stage_root/server/report-provenance-service.js" "$provenance_service"

mark_phase START
systemctl start gaiop-admin.service
for _ in $(seq 1 60); do
  if systemctl is-active --quiet gaiop-admin.service \
    && curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then break; fi
  sleep 1
done
systemctl is-active --quiet gaiop-admin.service
curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null

mark_phase VERIFY_STORE_ONLY
admin_pid=$(systemctl show gaiop-admin.service --property=MainPID --value)
admin_environment=$(tr '\0' '\n' < "/proc/$admin_pid/environ")
signing_key=$(printf '%s\n' "$admin_environment" | sed -n 's/^GAIOP_REPORT_PROVENANCE_SIGNING_KEY=//p' | head -n 1)
store_directory=$(printf '%s\n' "$admin_environment" | sed -n 's/^GAIOP_REPORT_PROVENANCE_STORE_DIR=//p' | head -n 1)
if [ -z "$store_directory" ]; then store_directory='/var/lib/gaiop/runtime/report-provenance'; fi
probe_session="agent:main:main:dm:webchat-transport-$release_id"
probe_digest=$(printf '%s' "$probe_session" | sha256sum | awk '{print $1}')
probe_file="$store_directory/$probe_digest.json"
sudo -u gaiop env \
  GAIOP_TRANSPORT_SIGNING_KEY="$signing_key" \
  GAIOP_TRANSPORT_STORE="$store_directory" \
  GAIOP_TRANSPORT_SESSION="$probe_session" \
  node --input-type=module - <<'NODE'
import { attachReportProvenance } from '/opt/gaiop/admin/server/report-provenance-service.js'
const params = {
  sessionKey: process.env.GAIOP_TRANSPORT_SESSION,
  message: 'transport separation deployment probe',
  idempotencyKey: 'transport-separation-probe',
}
const result = attachReportProvenance(params, { id: 'deployment-probe', username: 'deployment-probe' }, {
  enabled: true,
  signingKey: process.env.GAIOP_TRANSPORT_SIGNING_KEY,
  storeDirectory: process.env.GAIOP_TRANSPORT_STORE,
  dataSourceId: 'deployment-probe-source',
  transportMetadata: false,
})
if (result.attached || !result.stored || result.params !== params || result.params.metadata) process.exit(15)
NODE
test -f "$probe_file"
rm -f -- "$probe_file"

mark_phase VERIFY_HASHES
index_sha=$(sha256sum -- "$admin_index" | awk '{print $1}')
provenance_sha=$(sha256sum -- "$provenance_service" | awk '{print $1}')
test "$index_sha" = "$(sha256sum -- "$stage_root/server/index.js" | awk '{print $1}')"
test "$provenance_sha" = "$(sha256sum -- "$stage_root/server/report-provenance-service.js" | awk '{print $1}')"

mark_phase COMPLETE
completed=1
printf 'WEBCHAT_TRANSPORT_RELEASE_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'INDEX_SHA256=%s\n' "$index_sha"
printf 'PROVENANCE_SHA256=%s\n' "$provenance_sha"
rm -rf -- "$stage_root"
rm -f -- "$archive"
`
}

function summarize(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /WEBCHAT_TRANSPORT_RELEASE_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/^PHASE=([A-Z_]+)$/gm)?.at(-1)?.replace('PHASE=', '')
      || 'UNKNOWN',
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    indexSha256: output.match(/^INDEX_SHA256=(.+)$/m)?.[1] || null,
    provenanceSha256: output.match(/^PROVENANCE_SHA256=(.+)$/m)?.[1] || null,
    errorCode: result.ok ? null : 'WEBCHAT_TRANSPORT_RELEASE_FAILED',
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"WEBCHAT_TRANSPORT_RELEASE_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 180_000)

client.on('ready', async () => {
  const remoteArchive = `/tmp/gaiop-webchat-transport-${releaseId}.tgz`
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
    process.stdout.write('{"completed":false,"errorCode":"WEBCHAT_TRANSPORT_RELEASE_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"errorCode":"WEBCHAT_TRANSPORT_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
