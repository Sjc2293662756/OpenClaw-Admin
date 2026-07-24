'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_REPORT_PROVENANCE_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_REPORT_PROVENANCE_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_PROVENANCE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_PROVENANCE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_PROVENANCE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) throw new Error('The controlled report-provenance release inputs are incomplete.')
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled report-provenance connection context is incomplete.')

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
expected_sha='${checksum}'
workspace='/home/netinside/.openclaw/workspace'
plugin_file="$workspace/napm-openclaw-plugin.remote.js"
contract_file="$workspace/skills/openclaw-napm-report/services/ReportInputContractService.js"
admin_root='/opt/gaiop/admin'
admin_dist="$admin_root/dist"
admin_index="$admin_root/server/index.js"
admin_provenance_service="$admin_root/server/report-provenance-service.js"
admin_env='/etc/gaiop/admin.env'
provenance_store='/var/lib/gaiop/runtime/report-provenance'
admin_dropin_dir='/etc/systemd/system/gaiop-admin.service.d'
admin_dropin="$admin_dropin_dir/91-gaiop-report-provenance.conf"
gateway_dropin_dir='/home/netinside/.config/systemd/user/openclaw-gateway.service.d'
gateway_dropin="$gateway_dropin_dir/91-gaiop-report-provenance.conf"
backup_root="/var/backups/gaiop/report-provenance-$release_id"
stage_root="/tmp/gaiop-report-provenance-$release_id"
gateway_runtime="/run/user/$(id -u netinside)"
gateway_group="$(id -gn netinside)"
admin_was_active=0
gateway_was_active=0
committed=0
store_created=0

gatewayctl() { sudo -u netinside XDG_RUNTIME_DIR="$gateway_runtime" systemctl --user "$@"; }
mark() { printf 'PHASE_%s\n' "$1"; }
replace_env() {
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp)
  awk -v key="$key" -v value="$value" 'BEGIN { found=0 } index($0, key "=") == 1 { print key "=" value; found=1; next } { print } END { if (!found) print key "=" value }' "$file" > "$tmp"
  install -o root -g gaiop -m 0640 "$tmp" "$file"
  rm -f -- "$tmp"
}
rollback() {
  status=$?
  if [ "$committed" -eq 0 ]; then
    if [ -f "$backup_root/plugin.js" ]; then install -o netinside -g "$gateway_group" -m 0644 "$backup_root/plugin.js" "$plugin_file"; fi
    if [ -f "$backup_root/ReportInputContractService.js" ]; then install -o netinside -g "$gateway_group" -m 0644 "$backup_root/ReportInputContractService.js" "$contract_file"; fi
    if [ -f "$backup_root/admin-index.js" ]; then install -o gaiop -g gaiop -m 0644 "$backup_root/admin-index.js" "$admin_index"; fi
    if [ -f "$backup_root/report-provenance-service.js" ]; then install -o gaiop -g gaiop -m 0644 "$backup_root/report-provenance-service.js" "$admin_provenance_service"; fi
    if [ -d "$backup_root/preexisting-dist" ]; then
      rm -rf -- "$admin_dist"
      mv -- "$backup_root/preexisting-dist" "$admin_dist"
      chown -R gaiop:gaiop "$admin_dist" || true
    fi
    if [ -f "$backup_root/admin.env" ]; then install -o root -g gaiop -m 0640 "$backup_root/admin.env" "$admin_env"; fi
    if [ -f "$backup_root/admin-dropin.conf" ]; then
      install -d -o root -g root -m 0755 "$admin_dropin_dir"
      install -o root -g root -m 0600 "$backup_root/admin-dropin.conf" "$admin_dropin"
    else
      rm -f -- "$admin_dropin"
    fi
    if [ -f "$backup_root/gateway-dropin.conf" ]; then
      install -d -o netinside -g "$gateway_group" -m 0750 "$gateway_dropin_dir"
      install -o netinside -g "$gateway_group" -m 0600 "$backup_root/gateway-dropin.conf" "$gateway_dropin"
    else
      rm -f -- "$gateway_dropin"
    fi
    if [ -f "$backup_root/provenance-path.acl" ]; then setfacl --restore="$backup_root/provenance-path.acl" || true; fi
    if [ "$store_created" -eq 1 ]; then rm -rf -- "$provenance_store"; fi
    systemctl daemon-reload || true
    gatewayctl daemon-reload || true
    if [ "$gateway_was_active" -eq 1 ]; then gatewayctl restart openclaw-gateway.service || true; fi
    if [ "$admin_was_active" -eq 1 ]; then systemctl restart gaiop-admin.service || true; fi
    rm -rf -- "$stage_root"
    rm -f -- "$archive"
  fi
  exit "$status"
}
trap rollback ERR

mark PRECHECK
test -f "$plugin_file"
test -f "$contract_file"
test -d "$admin_dist"
test -f "$admin_index"
test -f "$admin_provenance_service"
grep -Fq 'gaiop_report_provenance.v3' "$admin_provenance_service"
test -r "$admin_env"
test "$(sha256sum "$archive" | awk '{print $1}')" = "$expected_sha"
if ! gatewayctl is-active --quiet openclaw-gateway.service; then printf 'BLOCK_GATEWAY_INACTIVE\n'; exit 41; fi
gateway_was_active=1
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else printf 'BLOCK_ADMIN_INACTIVE\n'; exit 42; fi
if [ -e "$backup_root" ] || [ -e "$stage_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 43; fi
available_kb=$(df -Pk /var/backups/gaiop | awk 'NR==2 { print $4 }')
required_kb=$(( $(du -sk "$plugin_file" "$contract_file" | awk '{sum += $1} END {print sum + 8192}') + 8192 ))
if [ -z "$available_kb" ] || [ "$available_kb" -lt "$required_kb" ]; then printf 'BLOCK_INSUFFICIENT_SPACE\n'; exit 44; fi

mark BACKUP
install -d -m 0700 "$backup_root"
cp -a -- "$plugin_file" "$backup_root/plugin.js"
cp -a -- "$contract_file" "$backup_root/ReportInputContractService.js"
cp -a -- "$admin_index" "$backup_root/admin-index.js"
cp -a -- "$admin_provenance_service" "$backup_root/report-provenance-service.js"
cp -a -- "$admin_env" "$backup_root/admin.env"
if [ -f "$admin_dropin" ]; then cp -a -- "$admin_dropin" "$backup_root/admin-dropin.conf"; fi
if [ -f "$gateway_dropin" ]; then cp -a -- "$gateway_dropin" "$backup_root/gateway-dropin.conf"; fi
getfacl -p /var/lib/gaiop /var/lib/gaiop/runtime > "$backup_root/provenance-path.acl"
if [ -d "$provenance_store" ]; then getfacl -p "$provenance_store" >> "$backup_root/provenance-path.acl"; fi
printf 'BACKUP_CREATED\n'

mark STAGE
install -d -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
rm -f -- "$archive"
new_plugin="$stage_root/napm-openclaw-plugin.remote.js"
new_contract="$stage_root/gateway/skills/openclaw-napm-report/services/ReportInputContractService.js"
new_dist="$stage_root/admin-dist"
new_admin_index="$stage_root/admin-server/index.js"
new_admin_provenance_service="$stage_root/admin-server/report-provenance-service.js"
test -f "$new_plugin"
test -f "$new_contract"
test -f "$new_dist/index.html"
test -f "$new_admin_index"
test -f "$new_admin_provenance_service"
grep -Fq 'gaiop_report_provenance.v3' "$new_plugin"
grep -Fq 'readStoredReportProvenance' "$new_plugin"
grep -Fq 'sourceChannelUserName' "$new_contract"
grep -Fq 'GAIOP_REPORT_PROVENANCE_STORE_DIR' "$new_admin_index"
grep -Fq 'persistEnvelope' "$new_admin_provenance_service"
node --check "$new_plugin"
node --check "$new_contract"
node --check "$new_admin_index"
node --check "$new_admin_provenance_service"

mark SWITCH
install -o netinside -g "$gateway_group" -m 0644 "$new_plugin" "$plugin_file"
install -o netinside -g "$gateway_group" -m 0644 "$new_contract" "$contract_file"
install -o gaiop -g gaiop -m 0644 "$new_admin_index" "$admin_index"
install -o gaiop -g gaiop -m 0644 "$new_admin_provenance_service" "$admin_provenance_service"
mv -- "$admin_dist" "$backup_root/preexisting-dist"
mv -- "$new_dist" "$admin_dist"
chown -R gaiop:gaiop "$admin_dist"
signing_key=$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")
if [ ! -d "$provenance_store" ]; then install -d -o gaiop -g gaiop -m 0750 "$provenance_store"; store_created=1; fi
chown gaiop:gaiop "$provenance_store"
chmod 0750 "$provenance_store"
setfacl -m u:netinside:x /var/lib/gaiop
setfacl -m u:netinside:x /var/lib/gaiop/runtime
setfacl -m u:netinside:rx "$provenance_store"
setfacl -m d:u:netinside:r-- "$provenance_store"
install -d -o root -g root -m 0755 "$admin_dropin_dir"
umask 077
cat > "$admin_dropin" <<ENV
[Service]
Environment=GAIOP_REPORT_PROVENANCE_ENABLED=true
Environment=GAIOP_REPORT_PROVENANCE_SIGNING_KEY=$signing_key
ENV
chown root:root "$admin_dropin"
chmod 0600 "$admin_dropin"
install -d -o netinside -g "$gateway_group" -m 0750 "$gateway_dropin_dir"
umask 077
cat > "$gateway_dropin" <<ENV
[Service]
Environment=GAIOP_REPORT_PROVENANCE_SIGNING_KEY=$signing_key
ENV
chown netinside:"$gateway_group" "$gateway_dropin"
chmod 0600 "$gateway_dropin"

mark RESTART
systemctl daemon-reload
gatewayctl daemon-reload
gatewayctl restart openclaw-gateway.service
gatewayctl is-active --quiet openclaw-gateway.service
systemctl restart gaiop-admin.service
systemctl is-active --quiet gaiop-admin.service

mark VERIFY
mark VERIFY_GATEWAY_CONFIG
grep -Eq '^Environment=GAIOP_REPORT_PROVENANCE_SIGNING_KEY=.{32,}$' "$gateway_dropin"
mark VERIFY_ADMIN_CONFIG
mark VERIFY_ADMIN_ENABLED
systemctl show gaiop-admin.service -p Environment --value | grep -Eq '(^| )GAIOP_REPORT_PROVENANCE_ENABLED=true( |$)'
mark VERIFY_ADMIN_KEY
grep -Eq '^Environment=GAIOP_REPORT_PROVENANCE_SIGNING_KEY=.{32,}$' "$admin_dropin"
mark VERIFY_STORE_ADMIN_WRITE
sudo -u gaiop test -w "$provenance_store"
mark VERIFY_STORE_GATEWAY_READ
sudo -u netinside test -r "$provenance_store"
mark VERIFY_ADMIN_HEALTH
admin_healthy=0
for _ in $(seq 1 60); do
  if node -e "const http=require('node:http'); const request=http.get('http://127.0.0.1:3000/api/health',{timeout:5000},(response)=>{response.resume();response.on('end',()=>process.exit(response.statusCode===200?0:1))}); request.on('error',()=>process.exit(1)); request.on('timeout',()=>{request.destroy();process.exit(1)})"; then admin_healthy=1; break; fi
  sleep 2
done
test "$admin_healthy" = 1

mark VERIFY_PROVENANCE_BRIDGE
probe_session="agent:main:main:dm:webchat-deploy-probe-$release_id"
probe_file="$provenance_store/$(printf '%s' "$probe_session" | sha256sum | awk '{print $1}').json"
sudo -u gaiop env PROBE_SESSION="$probe_session" GAIOP_REPORT_PROVENANCE_SIGNING_KEY="$signing_key" GAIOP_REPORT_PROVENANCE_STORE_DIR="$provenance_store" node --input-type=module - <<'NODE'
import { attachReportProvenance } from '/opt/gaiop/admin/server/report-provenance-service.js'
const result = attachReportProvenance({ sessionKey: process.env.PROBE_SESSION, message: 'GAIOP report provenance deployment probe' }, { id: 'deployment-probe', username: 'deployment-probe' }, {
  enabled: true,
  signingKey: process.env.GAIOP_REPORT_PROVENANCE_SIGNING_KEY,
  storeDirectory: process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR,
  dataSourceId: 'deployment-probe',
})
if (!result.attached || !result.stored) process.exit(1)
NODE
sudo -u netinside env GAIOP_REPORT_PROVENANCE_SIGNING_KEY="$signing_key" GAIOP_REPORT_PROVENANCE_STORE_DIR="$provenance_store" PROBE_SESSION="$probe_session" node - <<'NODE'
const plugin = require('/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js')
const value = plugin.__test__.readStoredReportProvenance({ sessionKey: process.env.PROBE_SESSION })
if (!value || value.sourceUserId !== 'deployment-probe' || value.sourceChannel !== 'web' || value.dataSourceId !== 'deployment-probe') process.exit(1)
NODE
rm -f -- "$probe_file"

mark COMPLETE
committed=1
rm -rf -- "$stage_root"
printf 'BACKUP_PATH=%s\n' "$backup_root"
printf 'INTEGRATION_COMPLETE\n'
`
}

function parseResult(output) {
  return {
    phase: String(output).match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '') || 'UNKNOWN',
    backupPath: String(output).match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    completed: /INTEGRATION_COMPLETE/.test(output),
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"status":"timeout","phase":"UNKNOWN"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 120_000)

client.on('ready', async () => {
  try {
    const checksum = await sha256(archivePath)
    const remoteArchive = `/tmp/gaiop-report-provenance-${releaseId}.tgz`
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, remoteScript({ checksum, remoteArchive }))
    const parsed = parseResult(result.output)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ completed: result.ok && parsed.completed, status: result.ok ? 'completed' : 'failed', ...parsed })}\n`)
    client.end()
    if (!result.ok) process.exitCode = 1
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"completed":false,"status":"connection-or-upload-failed","phase":"PRECHECK"}\n')
    client.end()
    process.exitCode = 1
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"status":"connection-failed","phase":"PRECHECK"}\n')
  process.exitCode = 1
})

client.connect(connection)
