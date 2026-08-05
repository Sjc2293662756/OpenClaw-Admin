'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-attribution connection context is incomplete.')
}

const script = String.raw`set -euo pipefail
phase='precheck'
trap 'printf "FAILED_PHASE=%s\\n" "$phase"' ERR
worker='/opt/gaiop/admin/server/report-attribution-worker.js'
library='/opt/gaiop/admin/server/lib/report-attribution-index.js'
source_unit='/opt/gaiop/admin/deploy/systemd/gaiop-report-attribution.service'
target_unit='/home/netinside/.config/systemd/user/gaiop-report-attribution.service'
target_root='/home/netinside/.local/lib/gaiop-report-attribution'
target_worker="$target_root/report-attribution-worker.js"
runtime_dir='/var/lib/gaiop/report-attribution'
node_bin='/usr/local/bin/node'

test -x "$node_bin"
test -f "$worker"
test -f "$library"
test -f "$source_unit"
grep -Fq "ExecStart=$node_bin $target_worker" "$source_unit"
"$node_bin" --check "$worker"

phase='install'
install -d -o netinside -g netinside -m 0750 /home/netinside/.config/systemd/user
install -d -o netinside -g netinside -m 0750 "$target_root" "$target_root/lib"
install -o netinside -g netinside -m 0644 "$worker" "$target_worker"
install -o netinside -g netinside -m 0644 "$library" "$target_root/lib/report-attribution-index.js"
install -o netinside -g netinside -m 0644 /opt/gaiop/admin/package.json "$target_root/package.json"
install -d -o netinside -g gaiop -m 0750 "$runtime_dir"
install -o netinside -g netinside -m 0644 "$source_unit" "$target_unit"
sudo -u netinside "$node_bin" --check "$target_worker"

uid=$(id -u netinside)
runtime="/run/user/$uid"
test -S "$runtime/bus"
userctl() {
  sudo -u netinside env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user "$@"
}
phase='service'
userctl daemon-reload
userctl enable --now gaiop-report-attribution.service >/dev/null
for _ in $(seq 1 20); do
  userctl is-active --quiet gaiop-report-attribution.service && break
  sleep 1
done
userctl is-active --quiet gaiop-report-attribution.service

for _ in $(seq 1 20); do
  test -f "$runtime_dir/index.json" && break
  sleep 1
done
test -f "$runtime_dir/index.json"

phase='index'
"$node_bin" - "$runtime_dir/index.json" <<'NODE'
const fs = require('fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (value.schemaVersion !== 'gaiop.report-attribution.v1') process.exit(2)
if (!Array.isArray(value.entries)) process.exit(3)
const age = Date.now() - Date.parse(value.updatedAt)
if (!Number.isFinite(age) || age < -60_000 || age > 120_000) process.exit(4)
process.stdout.write('INDEX_ENTRIES=' + value.entries.length + '\n')
process.stdout.write('INDEX_FRESH=true\n')
NODE

printf 'SERVICE_ACTIVE='; userctl is-active gaiop-report-attribution.service
printf 'SERVICE_ENABLED='; userctl is-enabled gaiop-report-attribution.service
printf 'WORKER_SHA='; sha256sum -- "$target_worker" | awk '{print $1}'
printf 'UNIT_SHA='; sha256sum -- "$target_unit" | awk '{print $1}'
printf 'LISTENERS='; ss -lntup 2>/dev/null | grep -c 'report-attribution' || true
`

const diagnosticScript = String.raw`set -u
uid=$(id -u netinside)
runtime="/run/user/$uid"
userctl() {
  sudo -u netinside env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user "$@"
}
printf 'DIAG_WORKER='; test -f /opt/gaiop/admin/server/report-attribution-worker.js && echo present || echo missing
printf 'DIAG_UNIT='; test -f /home/netinside/.config/systemd/user/gaiop-report-attribution.service && echo present || echo missing
printf 'DIAG_BUS='; test -S "$runtime/bus" && echo present || echo missing
printf 'DIAG_ACTIVE='; userctl is-active gaiop-report-attribution.service 2>/dev/null || true
printf 'DIAG_RESULT='; userctl show gaiop-report-attribution.service -p Result --value 2>/dev/null || true
printf 'DIAG_EXIT='; userctl show gaiop-report-attribution.service -p ExecMainStatus --value 2>/dev/null || true
log=$(mktemp)
userctl status gaiop-report-attribution.service --no-pager >"$log" 2>&1 || true
if grep -Eqi 'EACCES|EPERM|permission denied|read-only file system' "$log"; then echo 'DIAG_CLASS=permission-or-filesystem'
elif grep -Eqi 'Cannot find module|MODULE_NOT_FOUND' "$log"; then echo 'DIAG_CLASS=missing-module'
elif grep -Eqi 'SyntaxError|Unexpected token|Invalid or unexpected token' "$log"; then echo 'DIAG_CLASS=syntax-error'
elif grep -Eqi 'No such file or directory|status=203/EXEC' "$log"; then echo 'DIAG_CLASS=missing-executable-or-file'
else echo 'DIAG_CLASS=unclassified'; fi
rm -f -- "$log"
`

function execute(client, commandScript = script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '', error: 'exec-failed' })
      let output = ''
      let diagnostic = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', (chunk) => { diagnostic += chunk.toString('utf8') })
      stream.on('close', (code, signal) => resolve({ ok: code === 0, code, signal, output, error: diagnostic.trim().slice(-1000) || null }))
      stream.write(`${connection.password}\n${commandScript}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const diagnostic = result.ok ? null : await execute(client, diagnosticScript)
    const field = (name) => result.output.match(new RegExp(`^${name}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || null
    const payload = {
      completed: result.ok,
      serviceActive: field('SERVICE_ACTIVE'),
      serviceEnabled: field('SERVICE_ENABLED'),
      indexFresh: field('INDEX_FRESH') === 'true',
      indexEntries: Number(field('INDEX_ENTRIES') || 0),
      workerSha256: field('WORKER_SHA'),
      unitSha256: field('UNIT_SHA'),
      listeners: Number(field('LISTENERS') || 0),
      failedPhase: field('FAILED_PHASE'),
      diagnostic: result.error,
      exitCode: result.code,
      signal: result.signal,
      remoteDiagnostic: diagnostic?.output || null,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
