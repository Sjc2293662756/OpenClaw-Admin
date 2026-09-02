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
expected_workspace_sha='905099f1f5922f5b04dcda246c3b1f0b0af844ca18385a4f304b4507316e6983'
expected_extension_sha='760c8d02c71a90e2744a82e62e43effeaa21cba3aecf3a6fd2bcf0193a58ae21'
workspace_target='/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js'
extension_target='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
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
  if [ "$code" -ne 0 ] && [ "$switched" -eq 1 ]; then
    if [ -f "$backup_root/workspace-plugin.js" ]; then install -m 0644 -o netinside -g netinside "$backup_root/workspace-plugin.js" "$workspace_target"; fi
    if [ -f "$backup_root/extension-plugin.js" ]; then install -m 0644 -o netinside -g netinside "$backup_root/extension-plugin.js" "$extension_target"; fi
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
test -f "$workspace_target"
test -f "$extension_target"
workspace_sha=$(sha256sum "$workspace_target" | awk '{print $1}')
extension_sha=$(sha256sum "$extension_target" | awk '{print $1}')
target_guard_count=$("$node_bin" - "$extension_target" <<'NODE'
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const anchor = [
  '        const messageCtx = buildReplyDispatchMessageContext(event);',
  '        if (!shouldOwnAutomaticReportReplyDispatch(messageCtx)) {'
].join('\n')
process.stdout.write(String(source.split(anchor).length - 1))
NODE
)
if [ "$target_guard_count" -eq 1 ] && grep -Fq "sessionKey.startsWith('agent:main:main:dm:webchat-')" "$extension_target" && grep -Fq "sessionKey.startsWith('agent:main:main:dm:webchat-')" "$workspace_target"; then
  printf '{"completed":true,"status":"already-patched","workspaceHash":"%s","extensionHash":"%s"}\n' "$workspace_sha" "$extension_sha"
  exit 0
fi
failure_phase='runtime-hash'
test "$workspace_sha" = "$expected_workspace_sha"
test "$extension_sha" = "$expected_extension_sha"
failure_phase='ownership-function'
test "$(grep -Fc 'function shouldOwnAutomaticReportReplyDispatch' "$workspace_target" || true)" = 0
test "$(grep -Fc 'function shouldOwnAutomaticReportReplyDispatch' "$extension_target")" = 1
failure_phase='wecom-contract'
test "$(grep -Fc "channelId || '').trim().toLowerCase() === 'wecom'" "$extension_target")" = 1
failure_phase='loader-workspace-reference'
test "$(grep -Fc 'workspace/napm-openclaw-plugin.remote.js' /home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs || true)" = 0
failure_phase='loader-plugin-reference'
test "$(grep -Fc 'napm-openclaw-plugin.remote.js' /home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs)" = 1
cp "$workspace_target" "$stage_root/workspace-plugin.js"
cp "$extension_target" "$stage_root/extension-plugin.js"
failure_phase='patch-anchor'
"$node_bin" - "$stage_root/workspace-plugin.js" "$stage_root/extension-plugin.js" <<'NODE'
const fs = require('node:fs')
const workspaceFile = process.argv[2]
const extensionFile = process.argv[3]
let source = fs.readFileSync(workspaceFile, 'utf8')
const functionAnchor = '\nfunction getReplyDispatchPrompt(event = {}, conversationState = null) {'
const ownershipFunction = [
  '',
  'function shouldOwnAutomaticReportReplyDispatch(messageContext = {}) {',
  "  const sessionKey = String(messageContext?.sessionKey || '').trim().toLowerCase();",
  "  if (sessionKey.startsWith('agent:main:main:dm:webchat-')) return false;",
  "  return String(messageContext?.channelId || '').trim().toLowerCase() === 'wecom';",
  '}',
].join('\n')
if (source.split(functionAnchor).length !== 2) process.exit(2)
source = source.replace(functionAnchor, ownershipFunction + functionAnchor)
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
if (source.split(anchor).length !== 2) process.exit(3)
source = source.replace(anchor, replacement)
fs.writeFileSync(workspaceFile, source)

source = fs.readFileSync(extensionFile, 'utf8')
const oldFunction = [
  'function shouldOwnAutomaticReportReplyDispatch(messageContext = {}) {',
  "  return String(messageContext?.channelId || '').trim().toLowerCase() === 'wecom';",
  '}',
].join('\n')
const newFunction = [
  'function shouldOwnAutomaticReportReplyDispatch(messageContext = {}) {',
  "  const sessionKey = String(messageContext?.sessionKey || '').trim().toLowerCase();",
  "  if (sessionKey.startsWith('agent:main:main:dm:webchat-')) return false;",
  "  return String(messageContext?.channelId || '').trim().toLowerCase() === 'wecom';",
  '}',
].join('\n')
if (source.split(oldFunction).length !== 2) process.exit(4)
fs.writeFileSync(extensionFile, source.replace(oldFunction, newFunction))
NODE
failure_phase='patched-syntax'
"$node_bin" --check "$stage_root/workspace-plugin.js"
"$node_bin" --check "$stage_root/extension-plugin.js"
for staged_plugin in "$stage_root/workspace-plugin.js" "$stage_root/extension-plugin.js"; do
  grep -Fq "sessionKey.startsWith('agent:main:main:dm:webchat-')" "$staged_plugin"
done
test "$("$node_bin" - "$stage_root/extension-plugin.js" <<'NODE'
const fs = require('node:fs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const anchor = [
  '        const messageCtx = buildReplyDispatchMessageContext(event);',
  '        if (!shouldOwnAutomaticReportReplyDispatch(messageCtx)) {'
].join('\n')
process.stdout.write(String(source.split(anchor).length - 1))
NODE
)" = 1
failure_phase='ownership-behavior'
"$node_bin" - "$stage_root/workspace-plugin.js" "$stage_root/extension-plugin.js" <<'NODE'
const fs = require('node:fs')
for (const file of process.argv.slice(2)) {
  const source = fs.readFileSync(file, 'utf8')
  const match = source.match(/function shouldOwnAutomaticReportReplyDispatch\(messageContext = \{\}\) \{[\s\S]*?\n\}/u)
  if (!match) process.exit(2)
  const fn = Function(match[0] + '; return shouldOwnAutomaticReportReplyDispatch;')()
  const webchat = 'agent:main:main:dm:webchat-' + 'a'.repeat(32)
  if (fn({ channelId: 'wecom', sessionKey: webchat }) !== false) process.exit(3)
  if (fn({ channelId: 'wecom', sessionKey: 'agent:main:main:dm:wecom-user' }) !== true) process.exit(4)
  if (fn({ channelId: 'webchat', sessionKey: webchat }) !== false) process.exit(5)
}
NODE
patched_workspace_sha=$(sha256sum "$stage_root/workspace-plugin.js" | awk '{print $1}')
patched_extension_sha=$(sha256sum "$stage_root/extension-plugin.js" | awk '{print $1}')

if [ "$mode" = stage ]; then
  trap - EXIT
  rm -rf "$stage_root"
  printf '{"completed":true,"status":"staged","workspaceCurrentHash":"%s","extensionCurrentHash":"%s","workspacePatchedHash":"%s","extensionPatchedHash":"%s"}\n' "$workspace_sha" "$extension_sha" "$patched_workspace_sha" "$patched_extension_sha"
  exit 0
fi

test ! -e "$backup_root"
install -d -m 0700 -o root -g root "$backup_root"
install -m 0600 -o root -g root "$workspace_target" "$backup_root/workspace-plugin.js"
install -m 0600 -o root -g root "$extension_target" "$backup_root/extension-plugin.js"
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

install -m 0644 -o netinside -g netinside "$stage_root/workspace-plugin.js" "$workspace_target"
install -m 0644 -o netinside -g netinside "$stage_root/extension-plugin.js" "$extension_target"
switched=1
gateway_control restart >/dev/null
test "$(gateway_control is-active)" = active
test "$(sha256sum "$workspace_target" | awk '{print $1}')" = "$patched_workspace_sha"
test "$(sha256sum "$extension_target" | awk '{print $1}')" = "$patched_extension_sha"
grep -Fq "sessionKey.startsWith('agent:main:main:dm:webchat-')" "$workspace_target"
grep -Fq "sessionKey.startsWith('agent:main:main:dm:webchat-')" "$extension_target"
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
printf '{"completed":true,"status":"released","releaseId":"%s","rollbackPoint":"%s","workspaceRuntimeHash":"%s","extensionRuntimeHash":"%s","dbIntegrity":"ok","services":{"gateway":"active","admin":"active","upgrade":"active","caddy":"active"},"health":{"admin":200,"https":200},"reportCounts":{"reports":%s,"audits":%s}}\n' "$release_id" "$backup_root" "$patched_workspace_sha" "$patched_extension_sha" "$reports" "$audits"
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
