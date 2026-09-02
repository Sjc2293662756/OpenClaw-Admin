'use strict'

const { Client } = require('ssh2')

const mode = String(process.env.GAIOP_REPORT_DISPATCH_MODE || 'stage').trim().toLowerCase()
const releaseId = String(process.env.GAIOP_REPORT_DISPATCH_RELEASE_ID || '').trim()
const connection = {
  host: String(process.env.GAIOP_REPORT_DISPATCH_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DISPATCH_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DISPATCH_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!['stage', 'release'].includes(mode)
  || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report dispatch repair inputs are incomplete.')
}

const remoteScript = String.raw`set -euo pipefail
mode='${mode}'
release_id='${releaseId}'
expected_sha='10341c944d034a227b6bc86efca3f223e80ecb78b02321e60537298d2aaf1a07'
target='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
backup_root="/var/backups/gaiop/report-reply-dispatch-channel-$release_id"
stage_root=$(mktemp -d /tmp/gaiop-report-dispatch.XXXXXX)
node_bin=$(command -v node)
switched=0
failure_phase='initialize'

gateway_control() {
  local action="$1" uid
  uid=$(id -u netinside)
  sudo -u netinside env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$action" openclaw-gateway.service
}
rollback() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$switched" -eq 1 ] && [ -f "$backup_root/napm-openclaw-plugin.remote.js" ]; then
    install -m 0644 -o netinside -g netinside "$backup_root/napm-openclaw-plugin.remote.js" "$target"
    gateway_control restart >/dev/null 2>&1 || true
  fi
  rm -rf "$stage_root"
  if [ "$code" -ne 0 ]; then
    printf '{"completed":false,"status":"remote-gate-failed","phase":"%s"}\n' "$failure_phase"
  fi
  exit "$code"
}
trap rollback EXIT

failure_phase='runtime-file'
test -f "$target"
current_sha=$(sha256sum "$target" | awk '{print $1}')
target_guard_count=$("$node_bin" - "$target" <<'NODE'
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const anchor = [
  '        const messageCtx = buildReplyDispatchMessageContext(event);',
  '        if (!shouldOwnAutomaticReportReplyDispatch(messageCtx)) {'
].join('\n')
process.stdout.write(String(source.split(anchor).length - 1))
NODE
)
if [ "$target_guard_count" -eq 1 ]; then
  printf '{"completed":true,"status":"already-patched","runtimeHash":"%s"}\n' "$current_sha"
  exit 0
fi
failure_phase='runtime-hash'
test "$current_sha" = "$expected_sha"
failure_phase='ownership-function'
test "$(grep -Fc 'function shouldOwnAutomaticReportReplyDispatch' "$target")" = 1
failure_phase='wecom-contract'
test "$(grep -Fc "channelId || '').trim().toLowerCase() === 'wecom'" "$target")" = 1
failure_phase='loader-workspace-reference'
test "$(grep -Fc 'workspace/napm-openclaw-plugin.remote.js' /home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs || true)" = 0
failure_phase='loader-plugin-reference'
test "$(grep -Fc 'napm-openclaw-plugin.remote.js' /home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs)" = 1
cp "$target" "$stage_root/plugin.js"
failure_phase='patch-anchor'
"$node_bin" - "$stage_root/plugin.js" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
let source = fs.readFileSync(file, 'utf8')
const anchor = [
  '        const messageCtx = buildReplyDispatchMessageContext(event);',
  '        if (isNativeCommandTurn(messageCtx)) {'
].join('\n')
const replacement = [
  '        const messageCtx = buildReplyDispatchMessageContext(event);',
  '        if (!shouldOwnAutomaticReportReplyDispatch(messageCtx)) {',
  '          return undefined;',
  '        }',
  '        if (isNativeCommandTurn(messageCtx)) {'
].join('\n')
if (source.split(anchor).length !== 2) process.exit(2)
source = source.replace(anchor, replacement)
fs.writeFileSync(file, source)
NODE
failure_phase='patched-syntax'
"$node_bin" --check "$stage_root/plugin.js"
grep -Fq 'if (!shouldOwnAutomaticReportReplyDispatch(messageCtx))' "$stage_root/plugin.js"
test "$("$node_bin" - "$stage_root/plugin.js" <<'NODE'
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const anchor = [
  '        const messageCtx = buildReplyDispatchMessageContext(event);',
  '        if (!shouldOwnAutomaticReportReplyDispatch(messageCtx)) {'
].join('\n')
process.stdout.write(String(source.split(anchor).length - 1))
NODE
)" = 1
patched_sha=$(sha256sum "$stage_root/plugin.js" | awk '{print $1}')

if [ "$mode" = stage ]; then
  trap - EXIT
  rm -rf "$stage_root"
  printf '{"completed":true,"status":"staged","currentHash":"%s","patchedHash":"%s"}\n' "$current_sha" "$patched_sha"
  exit 0
fi

test ! -e "$backup_root"
install -d -m 0700 -o root -g root "$backup_root"
install -m 0600 -o root -g root "$target" "$backup_root/napm-openclaw-plugin.remote.js"
tar -czf "$backup_root/admin-code-config.tgz" \
  /opt/gaiop/admin/dist /opt/gaiop/admin/server /opt/gaiop/admin/package.json /opt/gaiop/admin/package-lock.json \
  /etc/systemd/system/gaiop-admin.service /etc/gaiop/admin.env 2>/dev/null
chmod 0600 "$backup_root/admin-code-config.tgz"
"$node_bin" - /var/lib/gaiop/admin/wizard.db "$backup_root/wizard.db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const source = new Database(process.argv[2], { readonly: true, fileMustExist: true })
source.backup(process.argv[3]).then(() => {
  const backup = new Database(process.argv[3], { readonly: true, fileMustExist: true })
  if (backup.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(2)
  backup.close()
  source.close()
}).catch(() => process.exit(3))
NODE
chmod 0600 "$backup_root/wizard.db"

install -m 0644 -o netinside -g netinside "$stage_root/plugin.js" "$target"
switched=1
gateway_control restart >/dev/null
test "$(gateway_control is-active)" = active
test "$(sha256sum "$target" | awk '{print $1}')" = "$patched_sha"
grep -Fq 'if (!shouldOwnAutomaticReportReplyDispatch(messageCtx))' "$target"
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(systemctl is-active gaiop-upgrade.service)" = active
test "$(systemctl is-active caddy.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health)" = 200
test "$(curl -ksS -o /dev/null -w '%{http_code}' https://127.0.0.1/ -H 'Host: 101.254.114.237')" = 200
db_integrity=$("$node_bin" - <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database('/var/lib/gaiop/admin/wizard.db', { readonly: true, fileMustExist: true })
process.stdout.write(String(db.pragma('integrity_check', { simple: true })))
db.close()
NODE
)
test "$db_integrity" = ok
reports=$(find /var/lib/gaiop/reports -type f ! -name '*.json' -printf x | wc -c | tr -d '[:space:]')
audits=$(find /var/lib/gaiop/reports -type f -name '*.json' -printf x | wc -c | tr -d '[:space:]')
switched=0
trap - EXIT
rm -rf "$stage_root"
printf '{"completed":true,"status":"released","releaseId":"%s","rollbackPoint":"%s","runtimeHash":"%s","dbIntegrity":"ok","services":{"gateway":"active","admin":"active","upgrade":"active","caddy":"active"},"health":{"admin":200,"https":200},"reportCounts":{"reports":%s,"audits":%s}}\n' "$release_id" "$backup_root" "$patched_sha" "$reports" "$audits"
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => {
        try {
          const result = JSON.parse(output)
          if (code === 0 || result?.status === 'remote-gate-failed') return resolve(result)
        } catch {}
        reject(new Error(`remote exit ${code}`))
      })
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"status":"timeout"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 120_000)
client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    client.end()
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"completed":false,"status":"failed"}\n')
    client.end()
    process.exitCode = 1
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"status":"connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
