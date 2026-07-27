'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_WEBCHAT_TITLE_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_WEBCHAT_TITLE_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_WEBCHAT_TITLE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEBCHAT_TITLE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEBCHAT_TITLE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled WebChat title release inputs are incomplete.')
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
stage_root="/tmp/gaiop-webchat-title-stage-$release_id"
backup_root="/var/backups/gaiop/webchat-title-code-$release_id"
admin_root='/opt/gaiop/admin'
admin_index="$admin_root/server/index.js"
ownership_service="$admin_root/server/lib/session-ownership-service.js"
phase='INITIAL'
completed=0
admin_was_active=0

mark_phase() { phase="$1"; printf 'PHASE=%s\n' "$phase"; }
rollback() {
  status=$?
  if [ "$completed" -eq 0 ] && [ -d "$backup_root" ]; then
    systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
    test ! -f "$backup_root/index.js" || cp -a -- "$backup_root/index.js" "$admin_index"
    test ! -f "$backup_root/session-ownership-service.js" || cp -a -- "$backup_root/session-ownership-service.js" "$ownership_service"
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
test -f "$ownership_service"
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else exit 42; fi
test ! -e "$stage_root"
test ! -e "$backup_root"

mark_phase STAGE
install -d -o root -g root -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/server/index.js"
test -f "$stage_root/server/lib/session-ownership-service.js"
node --check "$stage_root/server/index.js"
node --check "$stage_root/server/lib/session-ownership-service.js"
grep -Fq "method === 'agent' && isConversationSend" "$stage_root/server/index.js"
grep -Fq 'setRecoveredWebChatTitle' "$stage_root/server/lib/session-ownership-service.js"

mark_phase BACKUP
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$admin_index" "$backup_root/index.js"
cp -a -- "$ownership_service" "$backup_root/session-ownership-service.js"
printf 'BACKUP_CREATED\n'

mark_phase INSTALL
systemctl stop gaiop-admin.service
install -o gaiop -g gaiop -m 0644 "$stage_root/server/index.js" "$admin_index"
install -o gaiop -g gaiop -m 0644 "$stage_root/server/lib/session-ownership-service.js" "$ownership_service"

mark_phase START
systemctl start gaiop-admin.service
for _ in $(seq 1 60); do
  if systemctl is-active --quiet gaiop-admin.service \
    && curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then break; fi
  sleep 1
done
systemctl is-active --quiet gaiop-admin.service
curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null

mark_phase VERIFY
grep -Fq "method === 'agent' && isConversationSend" "$admin_index"
grep -Fq 'setRecoveredWebChatTitle' "$ownership_service"
index_sha=$(sha256sum -- "$admin_index" | awk '{print $1}')
ownership_sha=$(sha256sum -- "$ownership_service" | awk '{print $1}')
test "$index_sha" = "$(sha256sum -- "$stage_root/server/index.js" | awk '{print $1}')"
test "$ownership_sha" = "$(sha256sum -- "$stage_root/server/lib/session-ownership-service.js" | awk '{print $1}')"

mark_phase COMPLETE
completed=1
printf 'WEBCHAT_TITLE_RELEASE_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'INDEX_SHA256=%s\n' "$index_sha"
printf 'OWNERSHIP_SHA256=%s\n' "$ownership_sha"
rm -rf -- "$stage_root"
rm -f -- "$archive"
`
}

function summarize(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /WEBCHAT_TITLE_RELEASE_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/^PHASE=([A-Z_]+)$/gm)?.at(-1)?.replace('PHASE=', '')
      || 'UNKNOWN',
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    indexSha256: output.match(/^INDEX_SHA256=(.+)$/m)?.[1] || null,
    ownershipSha256: output.match(/^OWNERSHIP_SHA256=(.+)$/m)?.[1] || null,
    errorCode: result.ok ? null : 'WEBCHAT_TITLE_RELEASE_FAILED',
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"WEBCHAT_TITLE_RELEASE_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 180_000)

client.on('ready', async () => {
  const remoteArchive = `/tmp/gaiop-webchat-title-${releaseId}.tgz`
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
    process.stdout.write('{"completed":false,"errorCode":"WEBCHAT_TITLE_RELEASE_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"errorCode":"WEBCHAT_TITLE_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
