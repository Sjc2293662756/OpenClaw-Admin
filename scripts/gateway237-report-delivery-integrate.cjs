'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const pluginPath = String(process.env.GAIOP_REPORT_DELIVERY_PLUGIN || '')
const releaseId = String(process.env.GAIOP_REPORT_DELIVERY_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_DELIVERY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DELIVERY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DELIVERY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!pluginPath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The controlled report-delivery release inputs are incomplete.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-delivery connection context is incomplete.')
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

function remoteScript({ checksum, remotePlugin }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
uploaded_plugin='${remotePlugin}'
expected_sha='${checksum}'
workspace_plugin='/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js'
extension_plugin='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
extension_entry='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs'
outbound_root='/home/netinside/.openclaw/media/outbound'
delivery_root="$outbound_root/napm-reports"
backup_root="/var/backups/gaiop/report-channel-delivery-$release_id"
stage_root="/tmp/gaiop-report-channel-delivery-$release_id"
gateway_runtime="/run/user/$(id -u netinside)"
gateway_group="$(id -gn netinside)"
gateway_was_active=0
committed=0
phase='PRECHECK'

gatewayctl() { sudo -u netinside XDG_RUNTIME_DIR="$gateway_runtime" systemctl --user "$@"; }
mark() { phase="$1"; printf 'PHASE_%s\n' "$phase"; }

rollback() {
  status=$?
  if [ "$committed" -eq 0 ] && [ -d "$backup_root" ]; then
    if [ -f "$backup_root/workspace-plugin.js" ]; then
      install -o netinside -g "$gateway_group" -m 0644 "$backup_root/workspace-plugin.js" "$workspace_plugin"
    fi
    if [ -f "$backup_root/extension-plugin.js" ]; then
      install -o netinside -g "$gateway_group" -m 0644 "$backup_root/extension-plugin.js" "$extension_plugin"
    fi
    if [ "$gateway_was_active" -eq 1 ]; then gatewayctl restart openclaw-gateway.service >/dev/null 2>&1 || true; fi
  fi
  rm -rf -- "$stage_root"
  rm -f -- "$uploaded_plugin"
  printf 'FAILED_PHASE=%s\n' "$phase"
  exit "$status"
}
trap rollback ERR

mark PRECHECK
test -f "$workspace_plugin"
test -f "$extension_plugin"
test -f "$extension_entry"
test -d "$outbound_root"
test "$(sha256sum "$uploaded_plugin" | awk '{print $1}')" = "$expected_sha"
node --check "$uploaded_plugin"
grep -Fq 'GAIOP_REPORT_DELIVERY_DIR' "$uploaded_plugin"
grep -Fq 'prepareReportForChannelDelivery' "$uploaded_plugin"
grep -Fq 'MEDIA:' "$uploaded_plugin"
if gatewayctl is-active --quiet openclaw-gateway.service; then gateway_was_active=1; else printf 'BLOCK_GATEWAY_INACTIVE\n'; exit 41; fi
if [ -e "$backup_root" ] || [ -e "$stage_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 42; fi
install -d -m 0700 "$backup_root" "$stage_root"

mark BACKUP
cp -a -- "$workspace_plugin" "$backup_root/workspace-plugin.js"
cp -a -- "$extension_plugin" "$backup_root/extension-plugin.js"
printf 'BACKUP_CREATED\n'

mark SWITCH
install -o netinside -g "$gateway_group" -m 0644 "$uploaded_plugin" "$workspace_plugin"
install -o netinside -g "$gateway_group" -m 0644 "$uploaded_plugin" "$extension_plugin"
install -d -o netinside -g "$gateway_group" -m 0700 "$delivery_root"
test "$(sha256sum "$workspace_plugin" | awk '{print $1}')" = "$expected_sha"
test "$(sha256sum "$extension_plugin" | awk '{print $1}')" = "$expected_sha"

mark RESTART
gatewayctl restart openclaw-gateway.service
for _ in $(seq 1 60); do
  if gatewayctl is-active --quiet openclaw-gateway.service; then break; fi
  sleep 1
done
gatewayctl is-active --quiet openclaw-gateway.service

mark VERIFY_DELIVERY
install -d -o netinside -g "$gateway_group" -m 0700 "$stage_root/reports/channel_wecom/summary_report"
printf 'synthetic report delivery probe' > "$stage_root/reports/channel_wecom/summary_report/probe.docx"
chown -R netinside:"$gateway_group" "$stage_root"
sudo -u netinside env \
  GAIOP_REPORTS_DIR="$stage_root/reports" \
  GAIOP_REPORT_DELIVERY_DIR="$delivery_root" \
  node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const plugin = require('/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js')
const sourcePath = path.join(process.env.GAIOP_REPORTS_DIR, 'channel_wecom', 'summary_report', 'probe.docx')
const result = plugin.__test__.prepareReportForChannelDelivery({
  ok: true,
  reportId: 'report-delivery-probe',
  fileName: 'probe.docx',
  filePath: sourcePath,
}, { sourceChannel: 'wecom' })
if (!result.deliveryFilePath || !fs.existsSync(result.deliveryFilePath)) process.exit(1)
if (!plugin.__test__.buildReportExportReply(result).includes('MEDIA:' + result.deliveryFilePath)) process.exit(1)
if (fs.readFileSync(result.deliveryFilePath, 'utf8') !== 'synthetic report delivery probe') process.exit(1)
fs.rmSync(result.deliveryFilePath, { force: true })
NODE

mark VERIFY_RUNTIME
test "$(sha256sum "$workspace_plugin" | awk '{print $1}')" = "$(sha256sum "$extension_plugin" | awk '{print $1}')"
gatewayctl is-active --quiet openclaw-gateway.service
sudo -u netinside test -w "$delivery_root"

mark COMPLETE
committed=1
printf 'INTEGRATION_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'PLUGIN_SHA256=%s\n' "$expected_sha"
rm -rf -- "$stage_root"
rm -f -- "$uploaded_plugin"
`
}

function parseResult(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /INTEGRATION_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '')
      || 'UNKNOWN',
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    pluginSha256: output.match(/^PLUGIN_SHA256=([a-f0-9]+)$/m)?.[1] || null,
    errorCode: result.ok ? null : (
      output.includes('BLOCK_GATEWAY_INACTIVE') ? 'REPORT_DELIVERY_GATEWAY_INACTIVE'
        : output.includes('BLOCK_RELEASE_PATH_EXISTS') ? 'REPORT_DELIVERY_RELEASE_PATH_EXISTS'
          : 'REPORT_DELIVERY_INTEGRATION_FAILED'
    ),
  }
}

const client = new Client()
let finished = false
const timer = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"REPORT_DELIVERY_INTEGRATION_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 120_000)

client.on('ready', async () => {
  try {
    const checksum = await sha256(pluginPath)
    const remotePlugin = `/tmp/gaiop-report-delivery-${releaseId}.js`
    await upload(client, pluginPath, remotePlugin)
    const result = await execute(client, remoteScript({ checksum, remotePlugin }))
    const parsed = parseResult(result)
    finished = true
    clearTimeout(timer)
    process.stdout.write(`${JSON.stringify(parsed)}\n`)
    if (!parsed.completed) process.exitCode = 1
  } catch {
    finished = true
    clearTimeout(timer)
    process.stdout.write('{"completed":false,"errorCode":"REPORT_DELIVERY_UPLOAD_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  process.stdout.write('{"completed":false,"errorCode":"REPORT_DELIVERY_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
