'use strict'

const { Client } = require('ssh2')
const { createHash } = require('crypto')
const { createReadStream } = require('fs')

const connection = {
  host: String(process.env.GAIOP_UPGRADE_GUARD_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_UPGRADE_GUARD_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_UPGRADE_GUARD_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
const releaseId = String(process.env.GAIOP_UPGRADE_GUARD_RELEASE_ID || '').trim()
const archivePath = String(process.env.GAIOP_UPGRADE_GUARD_ARCHIVE || '').trim()
if (!connection.host || !connection.username || !connection.password || !/^\d{8}T\d{6}Z$/.test(releaseId) || !archivePath) {
  throw new Error('The controlled upgrade-guard deployment context is incomplete.')
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
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
      putError ? reject(putError) : resolve()
    })
  }))
}

function remoteScript(remoteArchive, expectedSha) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
archive='${remoteArchive}'
expected_sha='${expectedSha}'
stage_root="/opt/gaiop/.upgrade-guard-stage-$release_id"
backup_root="/var/backups/gaiop/upgrade-guard-$release_id"
service_root='/opt/gaiop/upgrade'
env_file='/etc/gaiop/upgrade.env'
mutation=0
complete=0
phase='precheck'
baseline_output=''
rollback() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$mutation" -eq 1 ]; then
    systemctl stop gaiop-upgrade.service || true
    rm -rf -- "$service_root"
    cp -a "$backup_root/service" "$service_root"
    cp -a "$backup_root/upgrade.env" "$env_file"
    systemctl start gaiop-upgrade.service || true
    printf 'ROLLBACK_COMPLETE=true\n'
  fi
  if [ "$status" -ne 0 ]; then printf 'FAILED_PHASE=%s\n' "$phase"; fi
  rm -rf -- "$stage_root"
  rm -f -- "$archive"
  if [ -n "$baseline_output" ]; then rm -f -- "$baseline_output"; fi
  exit "$status"
}
trap rollback EXIT

test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_sha"
test -d "$service_root"
test -f "$env_file"
systemctl is-active --quiet gaiop-upgrade.service
systemctl is-active --quiet gaiop-admin.service
test ! -e "$stage_root"
test ! -e "$backup_root"
/usr/local/bin/node - /var/lib/gaiop/report-attribution/index.json <<'NODE'
const fs = require('fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const age = Date.now() - Date.parse(value.updatedAt)
if (value.schemaVersion !== 'gaiop.report-attribution.v1' || !Number.isFinite(age) || age < -60000 || age > 120000) process.exit(2)
NODE

phase='baseline-test'
baseline_output=$(mktemp)
baseline_status=0
(cd "$service_root" && NODE_ENV=test npm test -- --test-concurrency=1 > "$baseline_output" 2>&1) || baseline_status=$?

phase='stage'
install -d -o root -g root -m 0755 "$stage_root"
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/src/services/ReportAttributionGuard.js"
test -f "$stage_root/src/index.js"
if [ -d "$service_root/node_modules" ] && cmp -s "$stage_root/package-lock.json" "$service_root/package-lock.json"; then
  cp -a "$service_root/node_modules" "$stage_root/node_modules"
else
  cd "$stage_root"
  npm ci --omit=dev --no-audit --no-fund >/dev/null
fi
cd "$stage_root"
phase='test'
candidate_status=0
NODE_ENV=test npm test -- --test-concurrency=1 > test-output.log 2>&1 || candidate_status=$?
if [ "$candidate_status" -ne 0 ]; then
  test "$baseline_status" -ne 0
  grep '^not ok [0-9][0-9]* - ' "$baseline_output" | sed -E 's/^not ok [0-9]+ - //' | sort -u > baseline-failures.txt
  grep '^not ok [0-9][0-9]* - ' test-output.log | sed -E 's/^not ok [0-9]+ - //' | sort -u > candidate-failures.txt
  cmp -s baseline-failures.txt candidate-failures.txt
  NODE_ENV=test /usr/local/bin/node --test test/report-attribution-guard.test.js > guard-test-output.log
  grep -Fq '# fail 0' guard-test-output.log
  printf 'BASELINE_FAILURES_MATCH=true\n'
else
  grep -Fq '# fail 0' test-output.log
fi

install -d -o root -g root -m 0700 "$backup_root"
phase='backup'
cp -a "$service_root" "$backup_root/service"
cp -a "$env_file" "$backup_root/upgrade.env"
mutation=1
phase='install'
systemctl stop gaiop-upgrade.service
rm -rf -- "$service_root"
mv -- "$stage_root" "$service_root"
chown -R root:root "$service_root"
sed -i '/^GAIOP_REPORT_ATTRIBUTION_REQUIRED=/d;/^GAIOP_REPORT_ATTRIBUTION_INDEX_PATH=/d;/^GAIOP_REPORT_ATTRIBUTION_MAX_AGE_MS=/d' "$env_file"
{
  printf '%s\n' 'GAIOP_REPORT_ATTRIBUTION_REQUIRED=true'
  printf '%s\n' 'GAIOP_REPORT_ATTRIBUTION_INDEX_PATH=/var/lib/gaiop/report-attribution/index.json'
  printf '%s\n' 'GAIOP_REPORT_ATTRIBUTION_MAX_AGE_MS=30000'
} >> "$env_file"
chmod 0600 "$env_file"
systemctl start gaiop-upgrade.service
phase='verify'
for _ in $(seq 1 30); do
  systemctl is-active --quiet gaiop-upgrade.service && break
  sleep 1
done
systemctl is-active --quiet gaiop-upgrade.service
/usr/local/bin/node --env-file="$env_file" - <<'NODE'
const config = require('/opt/gaiop/upgrade/src/config')
const { checkReportAttributionGuard } = require('/opt/gaiop/upgrade/src/services/ReportAttributionGuard')
const result = checkReportAttributionGuard(config)
if (!result.enabled || result.entries < 1) process.exit(2)
process.stdout.write('GUARD_ENTRIES=' + result.entries + '\n')
NODE
for _ in $(seq 1 30); do
  listener_count=$(ss -lntp | awk '$4 ~ /:18900$/ {print $4}' | sort -u | wc -l)
  test "$listener_count" -ge 1 && break
  sleep 1
done
listener_count=$(ss -lntp | awk '$4 ~ /:18900$/ {print $4}' | sort -u | wc -l)
printf 'LISTENER_COUNT=%s\n' "$listener_count"
test "$listener_count" = '1'
ss -lntp | awk '$4 ~ /:18900$/ {print $4}' | grep -Eq '^(127\.0\.0\.1|\[::1\]):18900$'
printf 'LISTENER_SCOPE=loopback\n'
complete=1
mutation=0
printf 'DEPLOY_COMPLETE=true\n'
printf 'SERVICE_ACTIVE='; systemctl is-active gaiop-upgrade.service
printf 'ADMIN_ACTIVE='; systemctl is-active gaiop-admin.service
printf 'BACKUP_CREATED='; test -s "$backup_root/upgrade.env" && echo true || echo false
printf 'GUARD_REQUIRED='; grep -Fxq 'GAIOP_REPORT_ATTRIBUTION_REQUIRED=true' "$env_file" && echo true || echo false
`
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

const client = new Client()
client.on('ready', async () => {
  try {
    const checksum = await sha256(archivePath)
    const remoteArchive = `/tmp/gaiop-upgrade-guard-${releaseId}.tgz`
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, remoteScript(remoteArchive, checksum))
    const field = (name) => result.output.match(new RegExp(`^${name}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || null
    const payload = {
      completed: result.ok && field('DEPLOY_COMPLETE') === 'true',
      serviceActive: field('SERVICE_ACTIVE'),
      adminActive: field('ADMIN_ACTIVE'),
      backupCreated: field('BACKUP_CREATED') === 'true',
      guardRequired: field('GUARD_REQUIRED') === 'true',
      guardEntries: Number(field('GUARD_ENTRIES') || 0),
      rollbackComplete: field('ROLLBACK_COMPLETE') === 'true',
      failedPhase: field('FAILED_PHASE'),
      listenerCount: Number(field('LISTENER_COUNT') || 0),
      listenerScope: field('LISTENER_SCOPE'),
      testDiagnostic: Array.from(result.output.matchAll(/^TEST_DIAGNOSTIC=([^\r\n]*)/gm), (match) => match[1]),
      testErrors: Array.from(result.output.matchAll(/^TEST_ERROR=([^\r\n]*)/gm), (match) => match[1]),
      testDetail: Array.from(result.output.matchAll(/^TEST_DETAIL=([^\r\n]*)/gm), (match) => match[1]),
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
