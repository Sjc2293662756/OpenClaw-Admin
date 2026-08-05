'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_RESTORE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_RESTORE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_RESTORE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
const releaseId = String(process.env.GAIOP_REPORT_RESTORE_RELEASE_ID || '').trim()
const expectedSha = String(process.env.GAIOP_REPORT_RESTORE_EXPECTED_SHA256 || '').trim().toLowerCase()
if (!connection.host || !connection.username || !connection.password || !/^\d{8}T\d{6}Z$/.test(releaseId) || !/^[a-f0-9]{64}$/.test(expectedSha)) {
  throw new Error('The controlled report-backend restore context is incomplete.')
}

const script = String.raw`set -euo pipefail
release_id='${releaseId}'
expected_sha='${expectedSha}'
source_file='/tmp/gaiop-colleague-main-report-baseline-20260805/skills/openclaw-napm-report/services/ReportStorageService.js'
target_file='/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportStorageService.js'
backup_root="/var/backups/gaiop/report-backend-restore-$release_id"
backup_file="$backup_root/ReportStorageService.js"
index_file='/var/lib/gaiop/report-attribution/index.json'
uid=$(id -u netinside)
runtime="/run/user/$uid"
userctl() {
  sudo -u netinside env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user "$@"
}
restored=0
rollback() {
  status=$?
  if [ "$restored" -eq 1 ] && [ -f "$backup_file" ]; then
    install -o netinside -g netinside -m 0644 "$backup_file" "$target_file"
    userctl restart openclaw-gateway.service || true
  fi
  exit "$status"
}
trap rollback ERR

test -f "$source_file"
test -f "$target_file"
test "$(sha256sum -- "$source_file" | awk '{print $1}')" = "$expected_sha"
userctl is-active --quiet gaiop-report-attribution.service
/usr/local/bin/node - "$index_file" <<'NODE'
const fs = require('fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const age = Date.now() - Date.parse(value.updatedAt)
if (value.schemaVersion !== 'gaiop.report-attribution.v1' || !Number.isFinite(age) || age < -60000 || age > 120000) process.exit(2)
NODE

install -d -o root -g root -m 0750 "$backup_root"
install -o root -g root -m 0600 "$target_file" "$backup_file"
previous_sha=$(sha256sum -- "$target_file" | awk '{print $1}')
install -o netinside -g netinside -m 0644 "$source_file" "$target_file"
restored=1
sudo -u netinside /usr/local/bin/node -e "require(process.argv[1])" "$target_file"

userctl restart openclaw-gateway.service
for _ in $(seq 1 30); do
  userctl is-active --quiet openclaw-gateway.service && break
  sleep 1
done
userctl is-active --quiet openclaw-gateway.service
test "$(sha256sum -- "$target_file" | awk '{print $1}')" = "$expected_sha"
restored=0

printf 'RESTORE_COMPLETE=true\n'
printf 'PREVIOUS_SHA=%s\n' "$previous_sha"
printf 'CURRENT_SHA=%s\n' "$(sha256sum -- "$target_file" | awk '{print $1}')"
printf 'GATEWAY_ACTIVE='; userctl is-active openclaw-gateway.service
printf 'SIDECAR_ACTIVE='; userctl is-active gaiop-report-attribution.service
printf 'ADMIN_ACTIVE='; systemctl is-active gaiop-admin.service
printf 'BACKUP_CREATED='; test -s "$backup_file" && echo true || echo false
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const field = (name) => result.output.match(new RegExp(`^${name}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || null
    const payload = {
      completed: result.ok && field('RESTORE_COMPLETE') === 'true',
      previousSha256: field('PREVIOUS_SHA'),
      currentSha256: field('CURRENT_SHA'),
      gatewayActive: field('GATEWAY_ACTIVE'),
      sidecarActive: field('SIDECAR_ACTIVE'),
      adminActive: field('ADMIN_ACTIVE'),
      backupCreated: field('BACKUP_CREATED') === 'true',
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (!payload.completed) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
