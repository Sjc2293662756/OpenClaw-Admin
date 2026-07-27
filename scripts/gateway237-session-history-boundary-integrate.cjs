'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_SESSION_BOUNDARY_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_SESSION_BOUNDARY_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_SESSION_BOUNDARY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_SESSION_BOUNDARY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_SESSION_BOUNDARY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled session boundary release inputs are incomplete.')
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
stage_root="/tmp/gaiop-session-boundary-stage-$release_id"
backup_root="/var/backups/gaiop/session-history-boundary-$release_id"
admin_root='/opt/gaiop/admin'
admin_dist="$admin_root/dist"
ownership_service="$admin_root/server/lib/session-ownership-service.js"
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
    test ! -f "$backup_root/session-ownership-service.js" \
      || cp -a -- "$backup_root/session-ownership-service.js" "$ownership_service"
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
test -f "$ownership_service"
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else exit 42; fi
test ! -e "$stage_root"
test ! -e "$backup_root"

mark_phase STAGE
install -d -o root -g root -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/dist/index.html"
test -f "$stage_root/server/lib/session-ownership-service.js"
node --check "$stage_root/server/lib/session-ownership-service.js"
grep -Fq "new Set(['web', 'webchat', 'workspace'])" "$stage_root/server/lib/session-ownership-service.js"
grep -Fq 'conversationLastActivity' "$stage_root/server/lib/session-ownership-service.js"
grep -RFl '历史默认会话' "$stage_root/dist" >/dev/null
grep -RFl '企业微信' "$stage_root/dist" >/dev/null
grep -RFl '对话' "$stage_root/dist" >/dev/null
stage_dist_sha=$(tree_sha "$stage_root/dist")

mark_phase BACKUP
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$admin_dist" "$backup_root/dist"
cp -a -- "$ownership_service" "$backup_root/session-ownership-service.js"
printf 'BACKUP_CREATED\n'

mark_phase INSTALL
systemctl stop gaiop-admin.service
rm -rf -- "$admin_dist"
cp -a -- "$stage_root/dist" "$admin_dist"
install -o gaiop -g gaiop -m 0644 \
  "$stage_root/server/lib/session-ownership-service.js" "$ownership_service"
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

mark_phase VERIFY_ACTIVITY
node --input-type=module - <<'NODE'
import { enrichSessionPayload, __test__ } from '/opt/gaiop/admin/server/lib/session-ownership-service.js'
const db = { prepare() { return { get() { return null } } } }
const payload = enrichSessionPayload(db, { sessions: [
  {
    key: 'agent:main:main',
    channel: 'main',
    lastInteractionAt: 1783584390254,
    updatedAt: 1785131550912,
    pendingFinalDeliveryLastAttemptAt: 1785131550912,
  },
  {
    key: 'agent:main:wecom:direct:yangs',
    channel: 'wecom',
    lastInteractionAt: 1785131685788,
    updatedAt: 1785131704158,
  },
] })
if (payload.sessions[0].originKind !== 'channel') process.exit(11)
if (payload.sessions[0].conversationLastActivity !== '2026-07-09T08:06:30.254Z') process.exit(12)
if (payload.sessions[1].sourceChannel !== 'wecom') process.exit(13)
if (__test__.resolveConversationLastActivity({ updatedAt: 1785131704158 }) !== null) process.exit(14)
NODE

mark_phase VERIFY_ASSET_TEXT
grep -RFl '历史默认会话' "$admin_dist" >/dev/null
grep -RFl '企业微信' "$admin_dist" >/dev/null
grep -RFl '对话' "$admin_dist" >/dev/null
mark_phase VERIFY_DIST_HASH
test "$(tree_sha "$admin_dist")" = "$stage_dist_sha"
mark_phase VERIFY_SERVER_HASH
ownership_sha=$(sha256sum -- "$ownership_service" | awk '{print $1}')
test "$ownership_sha" = "$(sha256sum -- "$stage_root/server/lib/session-ownership-service.js" | awk '{print $1}')"
mark_phase VERIFY_INDEX
index_asset=$(sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' "$admin_dist/index.html" | head -n 1)
test -n "$index_asset"
index_relative=$(printf '%s' "$index_asset" | sed 's#^/##')
test -f "$admin_dist/$index_relative"

mark_phase COMPLETE
completed=1
printf 'SESSION_BOUNDARY_RELEASE_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'DIST_SHA256=%s\n' "$stage_dist_sha"
printf 'OWNERSHIP_SHA256=%s\n' "$ownership_sha"
rm -rf -- "$stage_root"
rm -f -- "$archive"
`
}

function summarize(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /SESSION_BOUNDARY_RELEASE_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/^PHASE=([A-Z_]+)$/gm)?.at(-1)?.replace('PHASE=', '')
      || 'UNKNOWN',
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    distSha256: output.match(/^DIST_SHA256=(.+)$/m)?.[1] || null,
    ownershipSha256: output.match(/^OWNERSHIP_SHA256=(.+)$/m)?.[1] || null,
    errorCode: result.ok ? null : 'SESSION_BOUNDARY_RELEASE_FAILED',
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"SESSION_BOUNDARY_RELEASE_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 180_000)

client.on('ready', async () => {
  const remoteArchive = `/tmp/gaiop-session-boundary-${releaseId}.tgz`
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
    process.stdout.write('{"completed":false,"errorCode":"SESSION_BOUNDARY_RELEASE_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"errorCode":"SESSION_BOUNDARY_SSH_FAILED"}\n')
  process.exitCode = 1
})

client.connect(connection)
