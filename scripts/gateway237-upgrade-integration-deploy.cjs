'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const releaseId = String(process.env.GAIOP_UPGRADE_DEPLOY_RELEASE_ID || '')
const upgradeArchive = String(process.env.GAIOP_UPGRADE_DEPLOY_SERVICE_ARCHIVE || '')
const adminArchive = String(process.env.GAIOP_UPGRADE_DEPLOY_ADMIN_ARCHIVE || '')
const connection = {
  host: String(process.env.GAIOP_UPGRADE_DEPLOY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_UPGRADE_DEPLOY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_UPGRADE_DEPLOY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !upgradeArchive || !adminArchive
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled upgrade integration deployment inputs are incomplete.')
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

function deploymentScript({ serviceSha, adminSha, remoteService, remoteAdmin }) {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
service_archive='${remoteService}'
admin_archive='${remoteAdmin}'
service_sha='${serviceSha}'
admin_sha='${adminSha}'
stage_root="/tmp/gaiop-upgrade-deploy-$release_id"
backup_root="/var/backups/gaiop/deployments/upgrade-$release_id"
phase='PRECHECK'
mutation_started=0
complete=0

rollback() {
  status=$?
  if [ "$status" -eq 0 ] || [ "$complete" -eq 1 ]; then
    rm -rf -- "$stage_root"
    rm -f -- "$service_archive" "$admin_archive"
    exit "$status"
  fi
  printf 'FAILED_PHASE=%s\n' "$phase"
  if [ "$mutation_started" -eq 1 ]; then
    set +e
    systemctl disable --now gaiop-upgrade.service >/dev/null 2>&1
    if [ -f "$backup_root/gaiop-upgrade.service" ]; then
      cp -a "$backup_root/gaiop-upgrade.service" /etc/systemd/system/gaiop-upgrade.service
    else
      rm -f -- /etc/systemd/system/gaiop-upgrade.service
    fi
    if [ -f "$backup_root/upgrade.env" ]; then
      cp -a "$backup_root/upgrade.env" /etc/gaiop/upgrade.env
    else
      rm -f -- /etc/gaiop/upgrade.env
    fi
    if [ -f "$backup_root/restart-helper" ]; then
      cp -a "$backup_root/restart-helper" /usr/local/libexec/gaiop-upgrade-restart-openclaw
    else
      rm -f -- /usr/local/libexec/gaiop-upgrade-restart-openclaw
    fi
    if [ -d "$backup_root/new-service-tree" ]; then
      rm -rf -- /opt/gaiop/upgrade
      cp -a "$backup_root/new-service-tree" /opt/gaiop/upgrade
    else
      rm -rf -- /opt/gaiop/upgrade
    fi
    cp -a "$backup_root/admin.env" /etc/gaiop/admin.env
    rm -rf -- /opt/gaiop/admin/dist
    install -d -o gaiop -g gaiop -m 0755 /opt/gaiop/admin/dist
    tar -xzf "$backup_root/admin-dist.tgz" -C /opt/gaiop/admin/dist --no-same-owner
    chown -R gaiop:gaiop /opt/gaiop/admin/dist
    find /opt/gaiop/admin/dist -type d -exec chmod 0755 {} +
    find /opt/gaiop/admin/dist -type f -exec chmod 0644 {} +
    systemctl daemon-reload
    systemctl restart gaiop-admin.service
    if [ -f "$backup_root/legacy-active" ]; then systemctl start napm-upgrade.service; fi
    if [ -f "$backup_root/legacy-enabled" ]; then systemctl enable napm-upgrade.service >/dev/null 2>&1; fi
    set -e
    printf 'ROLLBACK_COMPLETE\n'
  fi
  rm -rf -- "$stage_root"
  rm -f -- "$service_archive" "$admin_archive"
  exit "$status"
}
trap rollback EXIT

test "$(sha256sum -- "$service_archive" | awk '{print $1}')" = "$service_sha"
test "$(sha256sum -- "$admin_archive" | awk '{print $1}')" = "$admin_sha"
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)" = '200'
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/health)" = '200'
test "$(systemctl is-active napm-upgrade.service)" = 'active'
test ! -e "$stage_root"
test ! -e "$backup_root"

phase='STAGE_EXTRACT'
install -d -o root -g root -m 0700 "$stage_root/service" "$stage_root/admin"
tar -xzf "$service_archive" -C "$stage_root/service" --no-same-owner
tar -xzf "$admin_archive" -C "$stage_root/admin" --no-same-owner
test -f "$stage_root/service/src/index.js"
test -f "$stage_root/service/deploy/systemd/gaiop-upgrade.service"
test -f "$stage_root/service/deploy/scripts/gaiop-upgrade-restart-openclaw"
test -f "$stage_root/admin/index.html"
phase='STAGE_INSTALL'
chown -R netinside:netinside "$stage_root/service"
runuser -u netinside -- env HOME=/home/netinside npm --prefix "$stage_root/service" ci --omit=dev --no-audit --no-fund >/dev/null
phase='STAGE_TEST'
runuser -u netinside -- env HOME=/home/netinside NODE_ENV=test npm --prefix "$stage_root/service" test > "$stage_root/service-tests.log"
grep -Fq '# tests 66' "$stage_root/service-tests.log"
grep -Fq '# pass 66' "$stage_root/service-tests.log"
grep -Fq '# fail 0' "$stage_root/service-tests.log"

phase='BACKUP'
install -d -o root -g root -m 0700 "$backup_root"
cp -a /etc/gaiop/admin.env "$backup_root/admin.env"
tar -czf "$backup_root/admin-dist.tgz" -C /opt/gaiop/admin/dist .
cp -a /opt/napm-upgrade "$backup_root/legacy-service-tree"
cp -a /etc/systemd/system/napm-upgrade.service "$backup_root/napm-upgrade.service"
if systemctl is-active --quiet napm-upgrade.service; then touch "$backup_root/legacy-active"; fi
if systemctl is-enabled --quiet napm-upgrade.service; then touch "$backup_root/legacy-enabled"; fi
if [ -e /opt/gaiop/upgrade ]; then cp -a /opt/gaiop/upgrade "$backup_root/new-service-tree"; fi
if [ -f /etc/systemd/system/gaiop-upgrade.service ]; then cp -a /etc/systemd/system/gaiop-upgrade.service "$backup_root/gaiop-upgrade.service"; fi
if [ -f /etc/gaiop/upgrade.env ]; then cp -a /etc/gaiop/upgrade.env "$backup_root/upgrade.env"; fi
if [ -f /usr/local/libexec/gaiop-upgrade-restart-openclaw ]; then cp -a /usr/local/libexec/gaiop-upgrade-restart-openclaw "$backup_root/restart-helper"; fi

mutation_started=1
phase='STOP_LEGACY'
systemctl stop napm-upgrade.service
systemctl disable napm-upgrade.service >/dev/null

phase='INSTALL_SERVICE'
rm -rf -- /opt/gaiop/upgrade
install -d -o root -g root -m 0755 /opt/gaiop/upgrade
cp -a "$stage_root/service/." /opt/gaiop/upgrade/
chown -R root:root /opt/gaiop/upgrade
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 /opt/gaiop/upgrade/deploy/scripts/gaiop-upgrade-restart-openclaw /usr/local/libexec/gaiop-upgrade-restart-openclaw
install -o root -g root -m 0644 /opt/gaiop/upgrade/deploy/systemd/gaiop-upgrade.service /etc/systemd/system/gaiop-upgrade.service
install -d -o root -g root -m 0750 /var/lib/gaiop/upgrade /var/backups/gaiop/upgrade
if [ -d /var/backups/napm ]; then cp -a /var/backups/napm/. /var/backups/gaiop/upgrade/; fi
if [ -f /opt/napm-upgrade/data/napm-upgrade.db ]; then
  /usr/local/bin/node -e "const D=require('/opt/napm-upgrade/node_modules/better-sqlite3');const d=new D('/opt/napm-upgrade/data/napm-upgrade.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close()"
  cp -a /opt/napm-upgrade/data/napm-upgrade.db /var/lib/gaiop/upgrade/upgrade.db
fi

token="$(openssl rand -hex 32)"
encryption_line="$(sed -n 's/^NAPM_PACKAGE_ENCRYPTION_KEY=//p' /opt/napm-upgrade/.env 2>/dev/null | head -n 1)"
umask 077
{
  printf '%s\n' 'NODE_ENV=production'
  printf '%s\n' 'GAIOP_UPGRADE_HOST=127.0.0.1'
  printf 'GAIOP_UPGRADE_INTERNAL_TOKEN=%s\n' "$token"
  printf '%s\n' 'NAPM_UPGRADE_PORT=18900'
  printf '%s\n' 'NAPM_UPGRADE_DB_PATH=/var/lib/gaiop/upgrade/upgrade.db'
  printf '%s\n' 'NAPM_UPGRADE_BACKUP_ROOT=/var/backups/gaiop/upgrade'
  printf '%s\n' 'NAPM_UPGRADE_PACKAGE_STAGING_ROOT=/var/lib/gaiop/upgrade/staging'
  printf '%s\n' 'NAPM_UPGRADE_LOCK_DIR=/run/gaiop-upgrade'
  printf '%s\n' 'NAPM_UPGRADE_SKILLS_ROOT=/home/netinside/.openclaw/workspace/skills'
  printf '%s\n' 'NAPM_UPGRADE_PLUGIN_ROOT=/home/netinside/.openclaw/extensions/napm-openclaw-plugin'
  printf '%s\n' 'NAPM_UPGRADE_OPENCLAW_ROOT=/home/netinside/.npm-global/lib/node_modules/openclaw'
  printf '%s\n' 'NAPM_UPGRADE_FRONTEND_ROOT=/opt/gaiop/admin/dist'
  printf '%s\n' 'NAPM_UPGRADE_PUBLIC_KEY_PATH=/opt/gaiop/upgrade/config/public.pem'
  printf '%s\n' 'NAPM_UPGRADE_OPENCLAW_RESTART_HELPER=/usr/local/libexec/gaiop-upgrade-restart-openclaw'
  printf '%s\n' 'NAPM_UPGRADE_OPENCLAW_HEALTH_URL=http://127.0.0.1:18789/health'
  printf '%s\n' 'NAPM_UPGRADE_FRONTEND_HEALTH_URL=http://127.0.0.1:3000/api/health'
  printf '%s\n' 'NAPM_UPGRADE_RUNTIME_OWNER=netinside'
  printf '%s\n' 'NAPM_UPGRADE_RUNTIME_GROUP=netinside'
  printf '%s\n' 'NAPM_UPGRADE_FRONTEND_OWNER=gaiop'
  printf '%s\n' 'NAPM_UPGRADE_FRONTEND_GROUP=gaiop'
  printf '%s\n' 'NAPM_UPGRADE_BACKUP_RETENTION=5'
  if [ -n "$encryption_line" ]; then printf 'NAPM_PACKAGE_ENCRYPTION_KEY=%s\n' "$encryption_line"; fi
} > /etc/gaiop/upgrade.env
chown root:root /etc/gaiop/upgrade.env
chmod 0600 /etc/gaiop/upgrade.env

if [ -f /var/lib/gaiop/upgrade/upgrade.db ]; then
  env NAPM_UPGRADE_DB_PATH=/var/lib/gaiop/upgrade/upgrade.db /usr/local/bin/node - <<'NODE'
const { getDb, closeDb } = require('/opt/gaiop/upgrade/src/database/connection')
const db = getDb()
db.prepare("UPDATE components SET install_path = ? WHERE name = 'frontend'").run('/opt/gaiop/admin/dist')
db.prepare("UPDATE components SET install_path = ? WHERE name = 'openclaw'").run('/home/netinside/.npm-global/lib/node_modules/openclaw')
db.prepare("UPDATE backups SET backup_path = replace(backup_path, '/var/backups/napm', '/var/backups/gaiop/upgrade') WHERE backup_path LIKE '/var/backups/napm/%'").run()
closeDb()
NODE
fi

phase='INSTALL_ADMIN'
rm -rf -- /opt/gaiop/admin/dist
install -d -o gaiop -g gaiop -m 0755 /opt/gaiop/admin/dist
cp -a "$stage_root/admin/." /opt/gaiop/admin/dist/
chown -R gaiop:gaiop /opt/gaiop/admin/dist
find /opt/gaiop/admin/dist -type d -exec chmod 0755 {} +
find /opt/gaiop/admin/dist -type f -exec chmod 0644 {} +
sed -i '/^GAIOP_UPGRADE_SERVICE_URL=/d;/^GAIOP_UPGRADE_INTERNAL_TOKEN=/d' /etc/gaiop/admin.env
{
  printf '%s\n' 'GAIOP_UPGRADE_SERVICE_URL=http://127.0.0.1:18900'
  printf 'GAIOP_UPGRADE_INTERNAL_TOKEN=%s\n' "$token"
} >> /etc/gaiop/admin.env
chown root:gaiop /etc/gaiop/admin.env
chmod 0640 /etc/gaiop/admin.env

phase='START'
systemctl daemon-reload
systemctl enable --now gaiop-upgrade.service >/dev/null
systemctl restart gaiop-admin.service

phase='VERIFY'
for attempt in $(seq 1 30); do
  upgrade_health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18900/health || true)"
  admin_health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/api/health || true)"
  if [ "$upgrade_health" = '200' ] && [ "$admin_health" = '200' ]; then break; fi
  sleep 1
done
test "$(systemctl is-active gaiop-upgrade.service)" = 'active'
test "$(systemctl is-active gaiop-admin.service)" = 'active'
test "$(systemctl is-active napm-upgrade.service 2>/dev/null || true)" != 'active'
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health)" = '200'
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/api/v1/upgrade/status)" = '401'
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "X-GAIOP-Upgrade-Token: $token" -H 'X-GAIOP-Upgrade-Actor: deployment-verifier' http://127.0.0.1:18900/api/v1/upgrade/status)" = '200'
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)" = '200'
test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/health)" = '200'
/usr/local/libexec/gaiop-upgrade-restart-openclaw --check
production_tree_sha="$(cd /opt/gaiop/admin/dist && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
staged_tree_sha="$(cd "$stage_root/admin" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"
test "$production_tree_sha" = "$staged_tree_sha"
grep -Rql '升级、Skill 回滚和备份删除均通过 Admin BFF' /opt/gaiop/admin/dist/assets

complete=1
printf 'UPGRADE_INTEGRATION_DEPLOY_COMPLETE\n'
printf 'RELEASE_ID=%s\n' "$release_id"
printf 'SERVICE_SHA256=%s\n' "$service_sha"
printf 'ADMIN_SHA256=%s\n' "$admin_sha"
printf 'SERVICE_STATE=%s\n' "$(systemctl is-active gaiop-upgrade.service)"
printf 'LEGACY_SERVICE_STATE=%s\n' "$(systemctl is-active napm-upgrade.service 2>/dev/null || true)"
printf 'UNAUTHENTICATED_STATUS=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/api/v1/upgrade/status)"
printf 'AUTHENTICATED_STATUS=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "X-GAIOP-Upgrade-Token: $token" -H 'X-GAIOP-Upgrade-Actor: deployment-verifier' http://127.0.0.1:18900/api/v1/upgrade/status)"
printf 'ADMIN_HEALTH=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health)"
printf 'GATEWAY_HEALTH=%s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/health)"
printf 'BACKUP_PATH=%s\n' "$backup_root"
`
}

function summarize(result) {
  const output = String(result.output || '')
  const value = (name) => output.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] || null
  return {
    completed: result.ok && /UPGRADE_INTEGRATION_DEPLOY_COMPLETE/.test(output),
    releaseId: value('RELEASE_ID'),
    failedPhase: value('FAILED_PHASE'),
    rollbackComplete: /ROLLBACK_COMPLETE/.test(output),
    serviceSha256: value('SERVICE_SHA256'),
    adminSha256: value('ADMIN_SHA256'),
    serviceState: value('SERVICE_STATE'),
    legacyServiceState: value('LEGACY_SERVICE_STATE'),
    unauthenticatedStatus: Number(value('UNAUTHENTICATED_STATUS') || 0),
    authenticatedStatus: Number(value('AUTHENTICATED_STATUS') || 0),
    adminHealth: Number(value('ADMIN_HEALTH') || 0),
    gatewayHealth: Number(value('GATEWAY_HEALTH') || 0),
    backupPath: value('BACKUP_PATH'),
    errorCode: result.ok ? null : 'UPGRADE_INTEGRATION_DEPLOY_FAILED',
  }
}

const client = new Client()
client.on('ready', async () => {
  const remoteService = `/tmp/gaiop-upgrade-service-${releaseId}.tgz`
  const remoteAdmin = `/tmp/gaiop-upgrade-admin-${releaseId}.tgz`
  try {
    const [serviceSha, adminSha] = await Promise.all([
      sha256(upgradeArchive),
      sha256(adminArchive),
    ])
    await upload(client, upgradeArchive, remoteService)
    await upload(client, adminArchive, remoteAdmin)
    const result = await execute(client, deploymentScript({
      serviceSha,
      adminSha,
      remoteService,
      remoteAdmin,
    }))
    const summary = summarize(result)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.completed) process.exitCode = 1
  } catch {
    process.stdout.write('{"completed":false,"errorCode":"UPGRADE_INTEGRATION_DEPLOY_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"errorCode":"UPGRADE_INTEGRATION_DEPLOY_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
