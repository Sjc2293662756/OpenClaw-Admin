'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_REPORT_RUNTIME_ARCHIVE || '').trim()
const archiveSha256 = String(process.env.GAIOP_REPORT_RUNTIME_ARCHIVE_SHA256 || '').trim().toLowerCase()
const releaseId = String(process.env.GAIOP_REPORT_RUNTIME_RELEASE_ID || '').trim()
const deploymentMode = String(process.env.GAIOP_REPORT_RUNTIME_MODE || 'release').trim().toLowerCase()
const connection = {
  host: String(process.env.GAIOP_REPORT_RUNTIME_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_RUNTIME_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_RUNTIME_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (
  !archivePath
  || !/^[0-9a-f]{64}$/.test(archiveSha256)
  || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host
  || !connection.username
  || !connection.password
  || !['inspect', 'stage', 'release'].includes(deploymentMode)
) {
  throw new Error('Controlled report runtime restoration inputs are incomplete.')
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function upload(client, localPath, remotePath) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => {
    if (error) return reject(error)
    sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (putError) => {
      sftp.end()
      if (putError) reject(putError)
      else resolve()
    })
  }))
}

function execute(client, script) {
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

function readLastJson(output) {
  const lines = String(output || '').trim().split(/\r?\n/u).reverse()
  for (const line of lines) {
    try { return JSON.parse(line) } catch {}
  }
  return null
}

function deploymentScript(remoteArchive) {
  return String.raw`set -Eeuo pipefail
release_id='${releaseId}'
deployment_mode='${deploymentMode}'
remote_archive='${remoteArchive}'
expected_archive_sha='${archiveSha256}'
stage_root="/var/tmp/gaiop-report-runtime-$release_id"
backup_root="/var/backups/gaiop/report-runtime-contract-$release_id"
plugin_target=/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js
  storage_target=/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportStorageService.js
  input_target=/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportInputContractService.js
  generation_target=/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportGenerationService.js
gateway_dropin=/home/netinside/.config/systemd/user/openclaw-gateway.service.d/90-gaiop-reports.conf
admin_db=/var/lib/gaiop/admin/wizard.db
node_bin=/usr/local/bin/node
phase=preflight
switched=0
rolled_back=false

cleanup() {
  rm -f -- "$remote_archive"
  rm -rf -- "$stage_root"
}

gateway_control() {
  local action="$1"
  local uid
  uid=$(id -u netinside)
  if [ "$action" = daemon-reload ]; then
    sudo -u netinside env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user daemon-reload
  else
    sudo -u netinside env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$action" openclaw-gateway.service
  fi
}

rollback() {
  local exit_code=$?
  trap - ERR
  if [ "$switched" = 1 ]; then
    install -o netinside -g netinside -m 0644 "$backup_root/napm-openclaw-plugin.remote.js" "$plugin_target"
    install -o netinside -g netinside -m 0644 "$backup_root/ReportStorageService.js" "$storage_target"
    install -o netinside -g netinside -m 0644 "$backup_root/ReportInputContractService.js" "$input_target"
    install -o netinside -g netinside -m 0644 "$backup_root/ReportGenerationService.js" "$generation_target"
    if [ -f "$backup_root/90-gaiop-reports.conf" ]; then
      install -o netinside -g netinside -m 0644 "$backup_root/90-gaiop-reports.conf" "$gateway_dropin"
    fi
    gateway_control daemon-reload >/dev/null 2>&1 || true
    gateway_control restart >/dev/null 2>&1 || true
    rolled_back=true
  fi
  cleanup
  printf '{"completed":false,"status":"failed","failurePhase":"%s","rolledBack":%s}\n' "$phase" "$rolled_back"
  exit "$exit_code"
}
trap rollback ERR
trap cleanup EXIT

for command_name in tar sha256sum diff patch install find stat curl ss awk; do
  command -v "$command_name" >/dev/null
done
test -x "$node_bin"
test ! -e "$backup_root"
test -f "$plugin_target"
test -f "$storage_target"
test -f "$input_target"
test -f "$generation_target"
test ! -L "$plugin_target"
test ! -L "$storage_target"
test ! -L "$input_target"
test ! -L "$generation_target"
test "$(sha256sum "$remote_archive" | awk '{print $1}')" = "$expected_archive_sha"

archive_entries=$(tar -tzf "$remote_archive" | sed 's#^\./##' | sed '/^$/d' | sort)
expected_entries=$(printf '%s\n' \
  base/napm-openclaw-plugin.remote.js \
  base/skills/openclaw-napm-report/services/ReportInputContractService.js \
  base/skills/openclaw-napm-report/services/ReportStorageService.js \
  base/skills/openclaw-napm-report/services/ReportGenerationService.js \
  fixed/napm-openclaw-plugin.remote.js \
  fixed/skills/openclaw-napm-report/services/ReportInputContractService.js \
  fixed/skills/openclaw-napm-report/services/ReportStorageService.js \
  fixed/skills/openclaw-napm-report/services/ReportGenerationService.js | sort)
test "$archive_entries" = "$expected_entries"

install -d -o root -g root -m 0700 "$stage_root/archive" "$stage_root/current" "$stage_root/patched" "$stage_root/patches"
tar -xzf "$remote_archive" -C "$stage_root/archive" --no-same-owner --no-same-permissions
cp -- "$plugin_target" "$stage_root/current/napm-openclaw-plugin.remote.js"
cp -- "$storage_target" "$stage_root/current/ReportStorageService.js"
cp -- "$input_target" "$stage_root/current/ReportInputContractService.js"
cp -- "$generation_target" "$stage_root/current/ReportGenerationService.js"
cp -a -- "$stage_root/current/." "$stage_root/patched/"

make_patch() {
  local base="$1" fixed="$2" output="$3"
  local code
  if diff -u --label base --label fixed "$base" "$fixed" > "$output"; then
    code=0
  else
    code=$?
  fi
  test "$code" -eq 1
}

apply_patch_file() {
  local current="$1" patch_file="$2"
  patch --dry-run --silent "$current" < "$patch_file"
  patch --silent "$current" < "$patch_file"
}

apply_patch_with_known_reject() {
  local current="$1" patch_file="$2" reject_file="$3"
  local code
  if patch --batch --forward --reject-file="$reject_file" "$current" < "$patch_file" >/dev/null 2>&1; then
    code=0
  else
    code=$?
  fi
  test "$code" -eq 1
  test -s "$reject_file"
  test "$(grep -c '^@@' "$reject_file")" -eq 1
}

patch_status() {
  local current="$1" patch_file="$2"
  local probe_log="$3"
  if patch --dry-run --verbose "$current" < "$patch_file" > "$probe_log" 2>&1; then
    printf applicable
  else
    printf 'incompatible:hunks=%s' "$(awk '/^Hunk #[0-9]+ FAILED/{gsub(/[^0-9]/, "", $2); printf "%s%s", separator, $2; separator=","}' "$probe_log")"
  fi
}

phase=patch_dry_run
make_patch "$stage_root/archive/base/napm-openclaw-plugin.remote.js" "$stage_root/archive/fixed/napm-openclaw-plugin.remote.js" "$stage_root/patches/plugin.patch"
make_patch "$stage_root/archive/base/skills/openclaw-napm-report/services/ReportStorageService.js" "$stage_root/archive/fixed/skills/openclaw-napm-report/services/ReportStorageService.js" "$stage_root/patches/storage.patch"
make_patch "$stage_root/archive/base/skills/openclaw-napm-report/services/ReportInputContractService.js" "$stage_root/archive/fixed/skills/openclaw-napm-report/services/ReportInputContractService.js" "$stage_root/patches/input.patch"
make_patch "$stage_root/archive/base/skills/openclaw-napm-report/services/ReportGenerationService.js" "$stage_root/archive/fixed/skills/openclaw-napm-report/services/ReportGenerationService.js" "$stage_root/patches/generation.patch"
plugin_patch_status=$(patch_status "$stage_root/patched/napm-openclaw-plugin.remote.js" "$stage_root/patches/plugin.patch" "$stage_root/patches/plugin.probe")
storage_patch_status=$(patch_status "$stage_root/patched/ReportStorageService.js" "$stage_root/patches/storage.patch" "$stage_root/patches/storage.probe")
input_patch_status=$(patch_status "$stage_root/patched/ReportInputContractService.js" "$stage_root/patches/input.patch" "$stage_root/patches/input.probe")
generation_patch_status=$(patch_status "$stage_root/patched/ReportGenerationService.js" "$stage_root/patches/generation.patch" "$stage_root/patches/generation.probe")
if [ "$deployment_mode" = inspect ]; then
  phase=inspected
  trap - ERR
  PLUGIN_PATCH_STATUS="$plugin_patch_status" STORAGE_PATCH_STATUS="$storage_patch_status" INPUT_PATCH_STATUS="$input_patch_status" GENERATION_PATCH_STATUS="$generation_patch_status" \
    PLUGIN_CONTRACT=$(grep -Fq 'shouldOwnAutomaticReportReplyDispatch' "$plugin_target" && printf present || printf missing) \
    STORAGE_CONTRACT=$(grep -Fq 'GAIOP_REPORTS_DIR' "$storage_target" && printf present || printf missing) \
    INPUT_CONTRACT=$(grep -Fq 'sourceMessagePreview' "$input_target" && printf present || printf missing) \
    GENERATION_CONTRACT=$(grep -Fq 'relativeAuditPath' "$generation_target" && printf present || printf missing) \
    PLUGIN_SHA=$(sha256sum "$plugin_target" | awk '{print $1}') \
    STORAGE_SHA=$(sha256sum "$storage_target" | awk '{print $1}') \
    INPUT_SHA=$(sha256sum "$input_target" | awk '{print $1}') \
    GENERATION_SHA=$(sha256sum "$generation_target" | awk '{print $1}') \
    "$node_bin" - <<'NODE'
process.stdout.write(JSON.stringify({
  completed: true,
  status: 'inspected',
  patchStatus: {
    plugin: process.env.PLUGIN_PATCH_STATUS,
    reportStorage: process.env.STORAGE_PATCH_STATUS,
    reportInput: process.env.INPUT_PATCH_STATUS,
    reportGeneration: process.env.GENERATION_PATCH_STATUS,
  },
  existingContracts: {
    nativeWebChatTurn: process.env.PLUGIN_CONTRACT,
    formalReportRoot: process.env.STORAGE_CONTRACT,
    sourceMessagePreview: process.env.INPUT_CONTRACT,
    formalAudit: process.env.GENERATION_CONTRACT,
  },
  runtimeHashes: {
    plugin: process.env.PLUGIN_SHA,
    reportStorage: process.env.STORAGE_SHA,
    reportInput: process.env.INPUT_SHA,
    reportGeneration: process.env.GENERATION_SHA,
  },
}))
NODE
  exit 0
fi
plugin_contract_present=$(grep -Fq 'shouldOwnAutomaticReportReplyDispatch' "$plugin_target" && printf yes || printf no)
input_contract_present=$(grep -Fq 'sourceMessagePreview' "$input_target" && printf yes || printf no)
if [ "$plugin_contract_present" = yes ]; then
  :
elif [ "$plugin_patch_status" = applicable ]; then
  apply_patch_file "$stage_root/patched/napm-openclaw-plugin.remote.js" "$stage_root/patches/plugin.patch"
else
  apply_patch_with_known_reject "$stage_root/patched/napm-openclaw-plugin.remote.js" "$stage_root/patches/plugin.patch" "$stage_root/patches/plugin.rej"
  "$node_bin" - "$stage_root/patched/napm-openclaw-plugin.remote.js" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
let source = fs.readFileSync(file, 'utf8')
const turnAnchor = '        const turnId = buildNapmTurnId();'
if (source.split(turnAnchor).length !== 2 || source.includes('const channelReportProvenance = extractTrustedChannelReportProvenance(event, ctx);')) process.exit(2)
source = source.replace(turnAnchor, turnAnchor + '\n        const channelReportProvenance = extractTrustedChannelReportProvenance(event, ctx);')
const stateStart = source.indexOf('        const nextState = {', source.indexOf(turnAnchor))
const stateEnd = source.indexOf('        };', stateStart)
if (stateStart < 0 || stateEnd < 0) process.exit(3)
const stateBlock = source.slice(stateStart, stateEnd)
if (stateBlock.includes('channelReportProvenance:')) process.exit(4)
const contextPattern = /^(\s*)contextTurnKey:\s*getContextTurnKey\(ctx\)\s*\|\|\s*null(,?)[ \t]*$/m
const match = stateBlock.match(contextPattern)
if (!match) process.exit(5)
const replacement = match[1] + 'contextTurnKey: getContextTurnKey(ctx) || null,\n'
  + match[1] + 'channelReportProvenance: channelReportProvenance || previousState?.channelReportProvenance || null'
const patchedState = stateBlock.replace(contextPattern, replacement)
source = source.slice(0, stateStart) + patchedState + source.slice(stateEnd)
fs.writeFileSync(file, source)
NODE
fi
if [ "$storage_patch_status" = applicable ]; then
  apply_patch_file "$stage_root/patched/ReportStorageService.js" "$stage_root/patches/storage.patch"
elif [ "$storage_patch_status" = 'incompatible:hunks=2' ]; then
  apply_patch_with_known_reject "$stage_root/patched/ReportStorageService.js" "$stage_root/patches/storage.patch" "$stage_root/patches/storage.rej"
else
  false
fi
if [ "$input_contract_present" = yes ]; then
  :
elif [ "$input_patch_status" = applicable ]; then
  apply_patch_file "$stage_root/patched/ReportInputContractService.js" "$stage_root/patches/input.patch"
else
  apply_patch_with_known_reject "$stage_root/patched/ReportInputContractService.js" "$stage_root/patches/input.patch" "$stage_root/patches/input.rej"
  "$node_bin" - "$stage_root/patched/ReportInputContractService.js" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
let source = fs.readFileSync(file, 'utf8')
const anchor = '\n  if (!sourceReportData) {'
if (source.split(anchor).length !== 2 || source.includes('const sourceOwnership = {')) process.exit(2)
const ownership = [
  '',
  '  const sourceOwnership = {',
  "    sourceUserId: String(payload.sourceUserId || options.sourceUserId || '').trim() || undefined,",
  "    sourceSessionId: String(payload.sourceSessionId || options.sourceSessionId || '').trim() || undefined,",
  "    sourceChannel: String(payload.sourceChannel || options.sourceChannel || '').trim() || undefined,",
  "    sourceChannelUserId: String(payload.sourceChannelUserId || options.sourceChannelUserId || '').trim() || undefined,",
  "    sourceChannelUserName: String(payload.sourceChannelUserName || options.sourceChannelUserName || '').trim() || undefined,",
  "    sourceMessageId: String(payload.sourceMessageId || options.sourceMessageId || '').trim() || undefined,",
  "    sourceMessagePreview: String(payload.sourceMessagePreview || options.sourceMessagePreview || '').trim() || undefined,",
  "    dataSourceId: String(payload.dataSourceId || options.dataSourceId || '').trim() || undefined",
  '  };',
].join('\n') + '\n'
source = source.replace(anchor, ownership + anchor)
fs.writeFileSync(file, source)
NODE
fi
test "$generation_patch_status" = applicable
apply_patch_file "$stage_root/patched/ReportGenerationService.js" "$stage_root/patches/generation.patch"

phase=staged_contract
"$node_bin" --check "$stage_root/patched/napm-openclaw-plugin.remote.js"
"$node_bin" --check "$stage_root/patched/ReportStorageService.js"
"$node_bin" --check "$stage_root/patched/ReportInputContractService.js"
"$node_bin" --check "$stage_root/patched/ReportGenerationService.js"
grep -Fq 'shouldOwnAutomaticReportReplyDispatch' "$stage_root/patched/napm-openclaw-plugin.remote.js"
grep -Fq "channelId || '').trim().toLowerCase() === 'wecom'" "$stage_root/patched/napm-openclaw-plugin.remote.js"
grep -Fq 'GAIOP_REPORTS_DIR' "$stage_root/patched/ReportStorageService.js"
grep -Fq 'sourceMessagePreview' "$stage_root/patched/ReportInputContractService.js"
grep -Fq 'relativeFilePath' "$stage_root/patched/ReportStorageService.js"
grep -Fq 'relativeAuditPath' "$stage_root/patched/ReportGenerationService.js"
grep -Fxq 'Environment=GAIOP_REPORTS_DIR=/var/lib/gaiop/reports' "$gateway_dropin"
if [ "$deployment_mode" = stage ]; then
  phase=staged
  trap - ERR
  PLUGIN_SHA=$(sha256sum "$stage_root/patched/napm-openclaw-plugin.remote.js" | awk '{print $1}') \
    STORAGE_SHA=$(sha256sum "$stage_root/patched/ReportStorageService.js" | awk '{print $1}') \
    INPUT_SHA=$(sha256sum "$stage_root/patched/ReportInputContractService.js" | awk '{print $1}') \
    GENERATION_SHA=$(sha256sum "$stage_root/patched/ReportGenerationService.js" | awk '{print $1}') \
    "$node_bin" - <<'NODE'
process.stdout.write(JSON.stringify({
  completed: true,
  status: 'staged',
  stagedHashes: {
    plugin: process.env.PLUGIN_SHA,
    reportStorage: process.env.STORAGE_SHA,
    reportInput: process.env.INPUT_SHA,
    reportGeneration: process.env.GENERATION_SHA,
  },
}))
NODE
  exit 0
fi

report_files_before=$(find /var/lib/gaiop/reports -type f ! -name '*.json' -printf x | wc -c | tr -d '[:space:]')
audit_json_before=$(find /var/lib/gaiop/reports -type f -name '*.json' -printf x | wc -c | tr -d '[:space:]')
db_before=$(
  "$node_bin" - "$admin_db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try {
  const tables = ['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']
  const counts = Object.fromEntries(tables.map((name) => [name, db.prepare('SELECT COUNT(*) AS count FROM ' + name).get().count]))
  process.stdout.write(JSON.stringify({ integrity: db.pragma('integrity_check', { simple: true }), counts }))
} finally { db.close() }
NODE
)
test "$(printf '%s' "$db_before" | "$node_bin" -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).integrity))")" = ok

phase=backup
install -d -o root -g root -m 0700 "$backup_root"
cp -a -- "$plugin_target" "$backup_root/napm-openclaw-plugin.remote.js"
cp -a -- "$storage_target" "$backup_root/ReportStorageService.js"
cp -a -- "$input_target" "$backup_root/ReportInputContractService.js"
cp -a -- "$generation_target" "$backup_root/ReportGenerationService.js"
cp -a -- "$gateway_dropin" "$backup_root/90-gaiop-reports.conf"
tar -czf "$backup_root/admin-code-config.tgz" \
  /opt/gaiop/admin/dist /opt/gaiop/admin/server /opt/gaiop/admin/package.json /opt/gaiop/admin/package-lock.json \
  /etc/systemd/system/gaiop-admin.service /etc/gaiop/admin.env
chmod 0600 "$backup_root/admin-code-config.tgz"
"$node_bin" - "$admin_db" "$backup_root/wizard.db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const source = new Database(process.argv[2], { readonly: true, fileMustExist: true })
if (source.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(2)
source.backup(process.argv[3]).then(() => {
  source.close()
  const backup = new Database(process.argv[3], { readonly: true, fileMustExist: true })
  const ok = backup.pragma('integrity_check', { simple: true }) === 'ok'
  backup.close()
  process.exit(ok ? 0 : 3)
}).catch(() => { try { source.close() } catch {}; process.exit(4) })
NODE
chmod 0600 "$backup_root/wizard.db"

phase=switch
install -o netinside -g netinside -m 0644 "$stage_root/patched/napm-openclaw-plugin.remote.js" "$plugin_target"
install -o netinside -g netinside -m 0644 "$stage_root/patched/ReportStorageService.js" "$storage_target"
install -o netinside -g netinside -m 0644 "$stage_root/patched/ReportInputContractService.js" "$input_target"
install -o netinside -g netinside -m 0644 "$stage_root/patched/ReportGenerationService.js" "$generation_target"
switched=1
gateway_control daemon-reload >/dev/null
gateway_control restart >/dev/null

phase=runtime_verify
test "$(gateway_control is-active)" = active
test "$(systemctl is-active gaiop-admin.service)" = active
test "$(systemctl is-active gaiop-upgrade.service)" = active
test "$(systemctl is-active caddy.service)" = active
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3000/api/health)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:18900/api/v1/upgrade/status)" = 401
test "$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 8 https://127.0.0.1/)" = 200
test "$(ss -ltnH 'sport = :3000' | awk '{print $4}' | sort -u)" = 127.0.0.1:3000

sudo -u netinside "$node_bin" - "$plugin_target" <<'NODE'
const plugin = require(process.argv[2])
const fn = plugin?.__test__?.shouldOwnAutomaticReportReplyDispatch
if (typeof fn !== 'function' || fn({ channelId: 'web' }) !== false || fn({ channelId: 'wecom' }) !== true) process.exit(1)
NODE
sudo -u netinside env GAIOP_REPORTS_DIR=/var/lib/gaiop/reports "$node_bin" - "$storage_target" <<'NODE'
const Storage = require(process.argv[2])
const value = new Storage()
const paths = value.buildPaths('probe', 'docx', { sourceUserId: 'probe-user', reportType: 'summary_report' })
if (value.outputDir !== '/var/lib/gaiop/reports' || paths.relativeAuditPath !== 'probe-user/summary_report/probe.json') process.exit(1)
NODE
sudo -u netinside "$node_bin" - "$generation_target" <<'NODE'
const Generation = require(process.argv[2])
if (typeof Generation !== 'function') process.exit(1)
NODE

report_files_after=$(find /var/lib/gaiop/reports -type f ! -name '*.json' -printf x | wc -c | tr -d '[:space:]')
audit_json_after=$(find /var/lib/gaiop/reports -type f -name '*.json' -printf x | wc -c | tr -d '[:space:]')
test "$report_files_before" = "$report_files_after"
test "$audit_json_before" = "$audit_json_after"
db_after=$(
  "$node_bin" - "$admin_db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try {
  const tables = ['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']
  const counts = Object.fromEntries(tables.map((name) => [name, db.prepare('SELECT COUNT(*) AS count FROM ' + name).get().count]))
  process.stdout.write(JSON.stringify({ integrity: db.pragma('integrity_check', { simple: true }), counts }))
} finally { db.close() }
NODE
)
test "$db_before" = "$db_after"

phase=retention_verify
retention_state=$(for unit in \
  gaiop-report-retention-cleanup.timer \
  gaiop-admin-retention-cleanup.timer \
  gaiop-upgrade-retention-cleanup.timer \
  gaiop-storage-watermark-monitor.timer \
  gaiop-admin-sqlite-backup.timer \
  gaiop-upgrade-sqlite-backup.timer \
  gaiop-session-retention-cleanup.timer; do
    printf '%s:%s:%s;' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)" "$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  done)

phase=completed
trap - ERR
plugin_sha=$(sha256sum "$plugin_target" | awk '{print $1}')
storage_sha=$(sha256sum "$storage_target" | awk '{print $1}')
input_sha=$(sha256sum "$input_target" | awk '{print $1}')
generation_sha=$(sha256sum "$generation_target" | awk '{print $1}')
printf '%s\n' "$(
  RELEASE_ID="$release_id" BACKUP_ROOT="$backup_root" PLUGIN_SHA="$plugin_sha" STORAGE_SHA="$storage_sha" INPUT_SHA="$input_sha" GENERATION_SHA="$generation_sha" \
  REPORTS="$report_files_after" AUDITS="$audit_json_after" DB="$db_after" RETENTION="$retention_state" \
  "$node_bin" - <<'NODE'
process.stdout.write(JSON.stringify({
  completed: true,
  status: 'released-and-verified',
  releaseId: process.env.RELEASE_ID,
  backupCreated: true,
  databaseBackupCreated: true,
  databaseBackupIntegrity: 'ok',
  backupRoot: process.env.BACKUP_ROOT,
  runtimeHashes: {
    plugin: process.env.PLUGIN_SHA,
    reportStorage: process.env.STORAGE_SHA,
    reportInput: process.env.INPUT_SHA,
    reportGeneration: process.env.GENERATION_SHA,
  },
  services: { gateway: 'active', admin: 'active', upgrade: 'active', caddy: 'active' },
  adminBinding: 'loopback-ipv4',
  health: { admin: 200, upgradeUnauthenticated: 401, https: 200 },
  reportCounts: { files: Number(process.env.REPORTS), auditJson: Number(process.env.AUDITS) },
  database: JSON.parse(process.env.DB),
  retentionState: process.env.RETENTION,
  nativeWebChatTurn: true,
  wecomReplyDispatch: true,
  rolledBack: false,
  failurePhase: null,
}))
NODE
)"
`
}

async function main() {
  if (await fileSha256(archivePath) !== archiveSha256) {
    throw new Error('The local release archive hash does not match the approved value.')
  }
  const remoteArchive = `/tmp/gaiop-report-runtime-contract-${releaseId}.tgz`
  const client = new Client()
  const timeout = setTimeout(() => client.end(), 180_000)
  await new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect(connection)
  })
  try {
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, deploymentScript(remoteArchive))
    const summary = readLastJson(result.output) || {
      completed: false,
      status: 'invalid-remote-receipt',
      failurePhase: 'receipt',
      rolledBack: false,
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!result.ok || !summary.completed) process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
}

module.exports = { deploymentScript }

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({
      completed: false,
      status: 'runner-failed',
      failurePhase: 'local-runner',
      rolledBack: false,
    }) + '\n')
    process.exitCode = 1
  })
}
