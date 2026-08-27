'use strict'

// This is a deliberately narrow release runner for the Syslog Receiver SSE
// implementation.  It never opens or prints remote configuration; the only
// service it can stop or start is the receiver user unit.
const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const shellDollar = '$'

const archivePath = String(process.env.GAIOP_RECEIVER_SSE_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_RECEIVER_SSE_RELEASE_ID || '')
const expectedCommit = String(process.env.GAIOP_RECEIVER_SSE_COMMIT || '')
const connection = {
  host: String(process.env.GAIOP_RECEIVER_SSE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_RECEIVER_SSE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_RECEIVER_SSE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !/^[0-9a-f]{40}$/i.test(expectedCommit)) {
  throw new Error('The controlled Receiver release inputs are incomplete.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Receiver release connection context is incomplete.')
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
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

function execSudo(client, script) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => resolve({ ok: code === 0, output }))
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  }))
}

function releaseScript({ checksum, remoteArchive }) {
  return String.raw`set -Eeuo pipefail
release_id='${releaseId}'
expected_sha='${checksum}'
archive='${remoteArchive}'
service='gaiop-syslog-receiver.service'
service_user='${connection.username.replace(/'/g, "'\\''")}'
expected_commit='${expectedCommit}'
phase='PRECHECK'
committed=0
stopped=0
target_root=''
stage_root=''
previous_root=''
backup_root="/var/backups/gaiop/syslog-receiver-sse-$release_id"

mark() { phase="$1"; printf 'PHASE_%s\n' "$phase"; }
userctl() {
  uid=$(id -u "$service_user")
  runuser -u "$service_user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$@"
}
load_receiver_env() {
  release_env_source=process
  env_file=$(userctl show "$service" -p EnvironmentFiles --value 2>/dev/null | grep -oE '/[^ "[:space:]]+' | head -n 1 | tr -d '"' || true)
  if test -n "$env_file" && test -f "$env_file"; then
    release_env_source=file
    set -a
    # The environment is imported only into this protected shell to make
    # loopback health requests.  It is never printed or stored in the release.
    . "$env_file"
    set +a
  else
    service_pid=$(userctl show "$service" -p MainPID --value)
    test "$service_pid" -gt 1
    receiver_env=$(tr '\0' '\n' < "/proc/$service_pid/environ" | grep -E '^(GAIOP_ALERT_RECEIVER_PORT|GAIOP_ALERT_RECEIVER_TOKEN|GAIOP_ALERTS_DATA_DIR)=' || true)
    test -n "$receiver_env"
    while IFS= read -r assignment; do export "$assignment"; done <<< "$receiver_env"
  fi
}
receiver_url() { printf 'http://127.0.0.1:%s' "${shellDollar}{GAIOP_ALERT_RECEIVER_PORT:-19090}"; }
receiver_header() { printf 'x-gaiop-alert-token: %s' "${shellDollar}{GAIOP_ALERT_RECEIVER_TOKEN:-}"; }
health_check() {
  curl -fsS --max-time 5 -H "$(receiver_header)" "$(receiver_url)/health" | node -e "let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const value=JSON.parse(body);process.exit(value&&value.ok?0:1)})"
}
alerts_check() {
  curl -fsS --max-time 5 -H "$(receiver_header)" "$(receiver_url)/alerts?page=1&pageSize=1" | node -e "let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const value=JSON.parse(body);process.exit(value&&value.ok?0:1)})"
}
events_check() {
  stream_probe=$(timeout 5 curl -fsSN --max-time 4 -H "$(receiver_header)" "$(receiver_url)/events" 2>/dev/null || true)
  printf '%s\n' "$stream_probe" | grep -q '^: connected'
}
stream_max() {
  node - "$1" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
let maximum = 0
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line) continue
  try { maximum = Math.max(maximum, Number(JSON.parse(line).streamSequence) || 0) } catch {}
}
process.stdout.write(String(maximum))
NODE
}
rollback() {
  status=$?
  if [ "$committed" -eq 1 ] && [ -d "$previous_root" ]; then
    userctl stop "$service" >/dev/null 2>&1 || true
    rm -rf -- "$target_root"
    mv -- "$previous_root" "$target_root"
    userctl start "$service" >/dev/null 2>&1 || true
    printf 'ROLLBACK_COMPLETE\n'
  elif [ "$stopped" -eq 1 ]; then
    userctl start "$service" >/dev/null 2>&1 || true
    printf 'ROLLBACK_RESTARTED_ORIGINAL\n'
  fi
  rm -rf -- "$stage_root" 2>/dev/null || true
  rm -f -- "$archive" 2>/dev/null || true
  exit "$status"
}
trap rollback ERR

mark PRECHECK
test "$(userctl is-active "$service")" = active
unit_exec=$(userctl show "$service" -p ExecStart --value)
unit_workdir=$(userctl show "$service" -p WorkingDirectory --value)
printf '%s\n' "$unit_exec" | grep -q 'openclaw-napm-syslog-receiver/scripts/run_syslog_receiver\.js'
case "$unit_workdir" in /*) ;; *) exit 41 ;; esac
target_root="$unit_workdir/skills/openclaw-napm-syslog-receiver"
case "$target_root" in /*) ;; *) exit 41 ;; esac
test -f "$target_root/scripts/run_syslog_receiver.js"
test "$(stat -c '%U' "$target_root")" = "$service_user"
load_receiver_env
data_dir=${shellDollar}{GAIOP_ALERTS_DATA_DIR:-"$target_root/data"}
alerts_file="$data_dir/alerts.jsonl"
test -f "$alerts_file"
before_lines=$(wc -l < "$alerts_file" | tr -d '[:space:]')
before_sequence=$(stream_max "$alerts_file")
printf 'PREFLIGHT_OK\n'

mark BACKUP
install -d -m 0700 "$backup_root"
cp -a -- "$target_root" "$backup_root/receiver-snapshot"
printf 'BACKUP_CREATED\n'

mark STAGE
actual_sha=$(sha256sum -- "$archive" | awk '{print $1}')
test "$actual_sha" = "$expected_sha"
stage_root="${shellDollar}{target_root}.stage-$release_id"
incoming_root="${shellDollar}{target_root}.incoming-$release_id"
previous_root="${shellDollar}{target_root}.previous-$release_id"
test ! -e "$stage_root" && test ! -e "$incoming_root" && test ! -e "$previous_root"
runuser -u "$service_user" -- mkdir -p "$stage_root" "$incoming_root"
runuser -u "$service_user" -- cp -a -- "$target_root/." "$stage_root/"
tar -tzf "$archive" | grep -Eq '^skills/openclaw-napm-syslog-receiver/(scripts|services)/'
tar -xzf "$archive" -C "$incoming_root" --no-same-owner
runuser -u "$service_user" -- cp -a -- "$incoming_root/skills/openclaw-napm-syslog-receiver/." "$stage_root/"
rm -rf -- "$incoming_root"
rm -f -- "$archive"
test -f "$stage_root/services/ReceiverHttpServer.js"
test -f "$stage_root/services/AlertEventStreamService.js"
node --check "$stage_root/scripts/run_syslog_receiver.js"
printf '%s\n' "$expected_commit" > "$backup_root/release-commit"
chmod 0600 "$backup_root/release-commit"

mark SWITCH
userctl stop "$service"
stopped=1
for _ in $(seq 1 30); do test "$(userctl is-active "$service" || true)" != active && break; sleep 1; done
test "$(userctl is-active "$service" || true)" != active
mv -- "$target_root" "$previous_root"
mv -- "$stage_root" "$target_root"
committed=1
userctl start "$service"
stopped=0
for _ in $(seq 1 45); do test "$(userctl is-active "$service" || true)" = active && break; sleep 1; done
test "$(userctl is-active "$service")" = active

mark VERIFY
printf 'VERIFY_HEALTH_BEGIN\n'
load_receiver_env
printf 'VERIFY_ENV_SOURCE=%s\n' "$release_env_source"
printf 'VERIFY_SERVICE_ACTIVE=%s\n' "$(userctl is-active "$service" || true)"
verify_health_http=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' -H "$(receiver_header)" "$(receiver_url)/health" || true)
printf 'VERIFY_HEALTH_HTTP=%s\n' "$verify_health_http"
health_check
printf 'VERIFY_HEALTH_OK\n'
alerts_check
printf 'VERIFY_ALERTS_OK\n'
events_check
printf 'VERIFY_EVENTS_OK\n'
after_lines=$(wc -l < "$alerts_file" | tr -d '[:space:]')
after_sequence=$(stream_max "$alerts_file")
test "$after_lines" -ge "$before_lines"
test "$after_sequence" -ge "$before_sequence"
printf 'VERIFY_HISTORY_OK\n'
rm -rf -- "$previous_root"
printf 'RELEASE_COMPLETE\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'BACKUP_ID=syslog-receiver-sse-%s\n' "$release_id"
printf 'HISTORY_PRESERVED\n'
`
}

function summarize(result) {
  const output = String(result.output || '')
  const phases = Array.from(output.matchAll(/PHASE_([A-Z_]+)/g), (match) => match[1])
  const verificationStep = Array.from(output.matchAll(/VERIFY_([A-Z_]+)_(?:BEGIN|OK)/g), (match) => match[1]).at(-1) || null
  return {
    completed: result.ok && /RELEASE_COMPLETE/.test(output),
    releaseId,
    backupId: /BACKUP_CREATED/.test(output) ? `syslog-receiver-sse-${releaseId}` : null,
    historyPreserved: /HISTORY_PRESERVED/.test(output),
    rollbackCompleted: /ROLLBACK_COMPLETE|ROLLBACK_RESTARTED_ORIGINAL/.test(output),
    failurePhase: result.ok ? null : (phases.at(-1) || 'UNKNOWN'),
    verificationStep: result.ok ? null : verificationStep,
    verificationHealthHttp: result.ok ? null : (output.match(/^VERIFY_HEALTH_HTTP=([^\r\n]*)/m)?.[1] || null),
    verificationServiceActive: result.ok ? null : (output.match(/^VERIFY_SERVICE_ACTIVE=([^\r\n]*)/m)?.[1] || null),
    status: result.ok ? 'receiver-sse-released-and-verified' : 'receiver-sse-release-failed-rolled-back',
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write(`${JSON.stringify({ completed: false, status: 'receiver-sse-release-timeout' })}\n`)
  finished = true
  client.end()
  process.exitCode = 1
}, 10 * 60_000)

client.on('ready', async () => {
  try {
    const checksum = await sha256(archivePath)
    const remoteArchive = `/tmp/gaiop-receiver-sse-${releaseId}.tgz`
    await upload(client, archivePath, remoteArchive)
    const result = await execSudo(client, releaseScript({ checksum, remoteArchive }))
    finished = true
    process.stdout.write(`${JSON.stringify(summarize(result))}\n`)
    if (!result.ok) process.exitCode = 1
  } catch {
    finished = true
    process.stdout.write('{"completed":false,"status":"receiver-sse-transfer-or-runner-failed"}\n')
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})
client.on('error', () => {
  if (!finished) {
    finished = true
    process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
    clearTimeout(timeout)
    process.exitCode = 1
  }
})
client.connect(connection)
