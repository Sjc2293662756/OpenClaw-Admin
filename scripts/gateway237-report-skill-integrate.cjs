'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_REPORT_SKILL_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_REPORT_SKILL_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_SKILL_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_SKILL_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_SKILL_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The controlled report-skill integration inputs are incomplete.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-skill integration connection context is incomplete.')
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
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error)
      sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (putError) => {
        sftp.end()
        putError ? reject(putError) : resolve()
      })
    })
  })
}

function execute(client, script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, exitCode: null, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, exitCode, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function integrationScript({ checksum, remoteArchive }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
archive='${remoteArchive}'
expected_sha='${checksum}'
workspace='/home/netinside/.openclaw/workspace'
skill_root="$workspace/skills/openclaw-napm-report"
reports_root='/var/lib/gaiop/reports'
gaiop_data_root='/var/lib/gaiop'
backup_root="/var/backups/gaiop/report-skill-$release_id"
stage_root="/tmp/gaiop-report-skill-$release_id"
dropin_dir='/home/netinside/.config/systemd/user/openclaw-gateway.service.d'
dropin_file="$dropin_dir/90-gaiop-reports.conf"
gateway_runtime="/run/user/$(id -u netinside)"
gateway_group="$(id -gn netinside)"
smoke_result="$stage_root/smoke-result.json"
gateway_was_active=0
dropin_existed=0
committed=0

gatewayctl() { sudo -u netinside XDG_RUNTIME_DIR="$gateway_runtime" systemctl --user "$@"; }
mark() { printf 'PHASE_%s\n' "$1"; }
remove_smoke_artifacts() {
  if [ -f "$smoke_result" ]; then
    REPORTS_ROOT="$reports_root" SMOKE_RESULT="$smoke_result" node - <<'NODE' || true
const fs = require('node:fs'); const path = require('node:path');
try {
  const root = path.resolve(process.env.REPORTS_ROOT);
  const value = JSON.parse(fs.readFileSync(process.env.SMOKE_RESULT, 'utf8'));
  for (const candidate of [value.filePath, value.auditPath]) {
    if (!candidate) continue;
    const file = path.resolve(candidate);
    if (file.startsWith(root + path.sep)) fs.rmSync(file, { force: true });
  }
} catch {}
NODE
  fi
}
rollback() {
  status=$?
  if [ "$committed" -eq 0 ]; then
    remove_smoke_artifacts
    if [ -f "$backup_root/gaiop-data.acl" ]; then setfacl --restore="$backup_root/gaiop-data.acl" || true; fi
    if [ -f "$backup_root/reports.acl" ]; then setfacl --restore="$backup_root/reports.acl" || true; fi
    if [ -d "$backup_root/skill" ]; then
      rm -rf -- "$skill_root"
      cp -a -- "$backup_root/skill" "$skill_root"
      chown -R netinside:"$gateway_group" "$skill_root" || true
    fi
    if [ "$dropin_existed" -eq 1 ]; then
      cp -a -- "$backup_root/90-gaiop-reports.conf" "$dropin_file"
    else
      rm -f -- "$dropin_file"
    fi
    gatewayctl daemon-reload || true
    if [ "$gateway_was_active" -eq 1 ]; then gatewayctl restart openclaw-gateway.service || true; fi
    rm -rf -- "$stage_root"
    rm -f -- "$archive"
  fi
  exit "$status"
}
trap rollback ERR

mark PRECHECK
test -d "$skill_root"
test -d "$reports_root"
command -v setfacl >/dev/null
command -v getfacl >/dev/null
if gatewayctl is-active --quiet openclaw-gateway.service; then gateway_was_active=1; else printf 'BLOCK_GATEWAY_INACTIVE\n'; exit 41; fi
if [ -e "$stage_root" ] || [ -e "$backup_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 42; fi
test "$(sha256sum "$archive" | awk '{print $1}')" = "$expected_sha"

mark BACKUP
install -d -m 0700 "$backup_root"
cp -a -- "$skill_root" "$backup_root/skill"
getfacl -p "$reports_root" > "$backup_root/reports.acl"
getfacl -p "$gaiop_data_root" > "$backup_root/gaiop-data.acl"
if [ -f "$dropin_file" ]; then cp -a -- "$dropin_file" "$backup_root/90-gaiop-reports.conf"; dropin_existed=1; fi
printf 'BACKUP_CREATED\n'

mark STAGE
install -d -m 0700 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
rm -f -- "$archive"
new_skill="$stage_root/openclaw-napm-report"
test -f "$new_skill/services/ReportStorageService.js"
test -f "$new_skill/services/ReportGenerationService.js"
grep -Fq 'GAIOP_REPORTS_DIR' "$new_skill/services/ReportStorageService.js"
grep -Fq 'relativeFilePath' "$new_skill/services/ReportGenerationService.js"
find "$new_skill" -type f -name '*.js' -print0 | xargs -0 -r -n1 node --check

mark DIRECTORY_ACCESS
setfacl -m u:netinside:--x "$gaiop_data_root"
setfacl -m u:netinside:rwx "$reports_root"
setfacl -m d:u:netinside:rwx "$reports_root"
sudo -u netinside test -x "$gaiop_data_root"
sudo -u netinside test -r "$reports_root"
sudo -u netinside test -w "$reports_root"

mark SKILL_SWITCH
rm -rf -- "$skill_root"
mv -- "$new_skill" "$skill_root"
cp -a -- "$backup_root/skill/output" "$skill_root/output"
chown -R netinside:"$gateway_group" "$skill_root"

mark GATEWAY_ENVIRONMENT
install -d -o netinside -g "$gateway_group" -m 0750 "$dropin_dir"
cat > "$dropin_file" <<'ENV'
[Service]
Environment=GAIOP_REPORTS_DIR=/var/lib/gaiop/reports
ENV
chown netinside:"$gateway_group" "$dropin_file"
chmod 0640 "$dropin_file"
gatewayctl daemon-reload

mark GATEWAY_RESTART
gatewayctl restart openclaw-gateway.service
gatewayctl is-active --quiet openclaw-gateway.service

mark SMOKE_REPORT
sudo -u netinside env REPORT_SERVICE="$skill_root/services/ReportGenerationService.js" GAIOP_REPORTS_DIR="$reports_root" node - <<'NODE' > "$smoke_result"
const ReportGenerationService = require(process.env.REPORT_SERVICE);
(async () => {
  const result = await new ReportGenerationService().generate({
    reportType: 'quick_report', format: 'docx', title: 'GAIOP 正式报告存储联调测试',
    sourceQuestion: '生成不含客户数据的正式报告存储联调测试文件。',
    sections: [
      { type: 'summary', title: '联调结论', content: '这是用于验证 GAIOP 正式报告存储链路的示例内容，不包含客户业务数据。' },
      { type: 'table', title: '验证项目', columns: ['项目', '结果'], rows: [['正式目录写入', '通过']] },
      { type: 'recommendation', title: '后续建议', items: ['完成来源签名和 Web 会话归属联调。'] }
    ]
  });
  if (!result.ok || !String(result.relativeFilePath || '').startsWith('_unattributed/quick_report/') || !String(result.relativeAuditPath || '').startsWith('_unattributed/quick_report/')) process.exit(1);
  process.stdout.write(JSON.stringify(result));
})().catch(() => process.exit(1));
NODE
REPORTS_ROOT="$reports_root" SMOKE_RESULT="$smoke_result" node - <<'NODE'
const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(process.env.REPORTS_ROOT);
const result = JSON.parse(fs.readFileSync(process.env.SMOKE_RESULT, 'utf8'));
for (const candidate of [result.filePath, result.auditPath]) {
  const item = path.resolve(candidate || '');
  if (!item.startsWith(root + path.sep) || !fs.existsSync(item)) process.exit(1);
}
NODE

mark COMPLETE
committed=1
rm -rf -- "$stage_root"
printf 'INTEGRATION_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
`
}

function parseResult(output) {
  const phase = String(output).match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '') || 'UNKNOWN'
  const backupPath = String(output).match(/^BACKUP_PATH=(.+)$/m)?.[1] || null
  return { phase, backupPath, completed: /INTEGRATION_COMPLETE/.test(output) }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write(`${JSON.stringify({ completed: false, status: 'timeout', phase: 'UNKNOWN' })}\n`)
  finished = true
  client.end()
  process.exitCode = 1
}, 120_000)

client.on('ready', async () => {
  try {
    const checksum = await sha256(archivePath)
    const remoteArchive = `/tmp/gaiop-report-skill-${releaseId}.tgz`
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, integrationScript({ checksum, remoteArchive }))
    const parsed = parseResult(result.output)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ completed: result.ok && parsed.completed, status: result.ok ? 'completed' : 'failed', ...parsed })}\n`)
    client.end()
    if (!result.ok) process.exitCode = 1
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'connection-or-upload-failed', phase: 'PRECHECK' })}\n`)
    client.end()
    process.exitCode = 1
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write(`${JSON.stringify({ completed: false, status: 'connection-failed', phase: 'PRECHECK' })}\n`)
  process.exitCode = 1
})

client.connect(connection)
