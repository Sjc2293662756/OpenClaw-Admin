'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_ADMIN_STAGE_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_ADMIN_STAGE_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_ADMIN_STAGE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_STAGE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_STAGE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The controlled Admin staging inputs are incomplete.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin staging connection context is incomplete.')
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function execSudoScript(client, script) {
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

function stageScript({ checksum, remoteArchive }) {
  return `set -euo pipefail
release_id='${releaseId}'
backup_root="/var/backups/gaiop/admin-prestage-$release_id"
stage_root="/opt/gaiop/.admin-stage-$release_id"
final_root='/opt/gaiop/admin'
unit_file='/etc/systemd/system/gaiop-admin.service'
env_file='/etc/gaiop/admin.env'
archive='${remoteArchive}'
expected_sha='${checksum}'
created_unit=0
created_env=0
committed=0
service_was_active=0
phase='INITIAL'
mark_phase() { phase="$1"; printf 'PHASE_%s\\n' "$phase"; }
ensure_fixed_env() {
  key="$1"
  value="$2"
  if grep -q "^$key=" "$env_file"; then
    grep -qx "$key=$value" "$env_file" || { printf 'BLOCK_ENV_%s\\n' "$key"; exit 46; }
  else
    printf '%s=%s\\n' "$key" "$value" >> "$env_file"
  fi
}
rollback() {
  status=$?
  if [ "$committed" -eq 0 ]; then
    rm -rf -- "$stage_root"
    rm -f -- "$archive"
    if [ -d "$backup_root/preexisting-admin" ]; then
      rm -rf -- "$final_root"
      mv -- "$backup_root/preexisting-admin" "$final_root"
    fi
    if [ -f "$backup_root/gaiop-admin.service" ]; then
      cp -a -- "$backup_root/gaiop-admin.service" "$unit_file"
    elif [ "$created_unit" -eq 1 ]; then
      rm -f -- "$unit_file"
    fi
    if [ "$created_env" -eq 1 ]; then rm -f -- "$env_file"; fi
    systemctl daemon-reload || true
    if [ "$service_was_active" -eq 1 ]; then systemctl start gaiop-admin.service || true; fi
  fi
  exit "$status"
}
trap rollback ERR

mark_phase 'PRECHECK'
if systemctl is-active --quiet gaiop-admin.service; then service_was_active=1; fi
if [ -e "$stage_root" ]; then
  printf 'BLOCK_STAGING_PATH_EXISTS\\n'
  exit 43
fi

mkdir -p -- "$backup_root"
for item in /etc/gaiop /opt/gaiop/admin /etc/systemd/system/gaiop-admin.service; do
  if [ -e "$item" ]; then
    case "$item" in
      /etc/gaiop) cp -a -- "$item" "$backup_root/etc-gaiop" ;;
      /opt/gaiop/admin) cp -a -- "$item" "$backup_root/admin-snapshot" ;;
      /etc/systemd/system/gaiop-admin.service) cp -a -- "$item" "$backup_root/gaiop-admin.service" ;;
    esac
  fi
done
printf 'BACKUP_CREATED\\n'

mark_phase 'ARCHIVE_VERIFY'
actual_sha=$(sha256sum -- "$archive" | awk '{print $1}')
test "$actual_sha" = "$expected_sha"

mark_phase 'DIRECTORIES'
if ! id -u gaiop >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gaiop --shell /usr/sbin/nologin gaiop
fi
install -d -o gaiop -g gaiop -m 0750 /opt/gaiop /var/lib/gaiop /var/lib/gaiop/admin /var/lib/gaiop/runtime /var/log/gaiop
# The formal report archive may carry an additional Gateway ACL.  Do not run
# install(1) with a mode on an existing archive directory: that resets the ACL
# mask and can silently downgrade the Gateway from read-write to read-only.
if [ ! -d /var/lib/gaiop/reports ]; then
  install -d -o gaiop -g gaiop -m 0750 /var/lib/gaiop/reports
fi
install -d -o root -g gaiop -m 0750 /etc/gaiop
install -d -o gaiop -g gaiop -m 0750 "$stage_root"
mark_phase 'EXTRACT'
tar -xzf "$archive" -C "$stage_root" --no-same-owner
rm -f -- "$archive"
test -f "$stage_root/server/index.js"
test -f "$stage_root/dist/index.html"
chown -R gaiop:gaiop "$stage_root"

reused_dependencies=0
if [ -d "$final_root/node_modules" ] && cmp -s "$stage_root/package-lock.json" "$final_root/package-lock.json"; then
  mark_phase 'DEPENDENCY_REUSE'
  cp -a -- "$final_root/node_modules" "$stage_root/node_modules"
  reused_dependencies=1
fi

mark_phase 'DEPENDENCIES'
cd "$stage_root"
if [ "$reused_dependencies" -eq 1 ] && npm ls --omit=dev --all >/dev/null 2>&1; then
  printf 'DEPENDENCIES_REUSED\\n'
else
  rm -rf -- node_modules
  npm_result=$(mktemp)
  if ! npm ci --omit=dev --no-audit --no-fund >"$npm_result" 2>&1; then
  if grep -Eqi 'node-gyp|make:|g\+\+:|python|compiler|build-essential' "$npm_result"; then
    printf 'NPM_FAILURE_NATIVE_BUILD_TOOLCHAIN\\n'
  elif grep -Eqi 'EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|registry|network' "$npm_result"; then
    printf 'NPM_FAILURE_NETWORK_OR_REGISTRY\\n'
  elif grep -Eqi 'EACCES|EPERM|permission denied|read-only file system|EROFS' "$npm_result"; then
    printf 'NPM_FAILURE_PERMISSION_OR_FILESYSTEM\\n'
  elif grep -Eqi 'lockfile|package-lock|ERESOLVE|unsupported platform|unsupported engine' "$npm_result"; then
    printf 'NPM_FAILURE_LOCKFILE_OR_PACKAGE_COMPATIBILITY\\n'
  else
    printf 'NPM_FAILURE_UNKNOWN\\n'
  fi
  rm -f -- "$npm_result"
  exit 77
  fi
  rm -f -- "$npm_result"
fi
mark_phase 'NODE_CHECK'
node --check server/index.js

mark_phase 'ENVIRONMENT'
if [ ! -e "$env_file" ]; then
  cat > "$env_file" <<'ENV'
# Fill blank secret values directly on this server. Do not commit or transmit this file.
PORT=3000
GAIOP_BIND_HOST=127.0.0.1
GAIOP_ADMIN_DATA_DIR=/var/lib/gaiop/admin
GAIOP_ADMIN_BACKUP_DIR=/var/lib/gaiop/admin/backups
OPENCLAW_DEVICE_IDENTITY_PATH=/var/lib/gaiop/admin/gateway-device-identity.json
AUTH_USERNAME=admin
AUTH_PASSWORD=
DATA_SOURCE_ENCRYPTION_KEY=
SENSITIVE_CONFIG_ENCRYPTION_KEY=
GAIOP_ACTIVE_DATA_SOURCE_FILE=/var/lib/gaiop/runtime/runtime-active-data-source.json
GAIOP_REPORTS_DIR=/var/lib/gaiop/reports
GAIOP_ALERT_RECEIVER_URL=http://127.0.0.1:19090
GAIOP_ALERT_RECEIVER_TOKEN=
GAIOP_REPORT_PROVENANCE_ENABLED=false
GAIOP_REPORT_PROVENANCE_SIGNING_KEY=
OPENCLAW_WS_URL=ws://127.0.0.1:18789
OPENCLAW_AUTH_TOKEN=
OPENCLAW_AUTH_PASSWORD=
LOG_LEVEL=INFO
ENV
  created_env=1
fi
ensure_fixed_env 'GAIOP_BIND_HOST' '127.0.0.1'
ensure_fixed_env 'GAIOP_ADMIN_DATA_DIR' '/var/lib/gaiop/admin'
ensure_fixed_env 'GAIOP_ADMIN_BACKUP_DIR' '/var/lib/gaiop/admin/backups'
ensure_fixed_env 'OPENCLAW_DEVICE_IDENTITY_PATH' '/var/lib/gaiop/admin/gateway-device-identity.json'
chown root:gaiop "$env_file"
chmod 0640 "$env_file"

mark_phase 'UNIT'
node_path=$(command -v node)
test -x "$node_path"
cat > "$unit_file" <<EOF
[Unit]
Description=GAIOP Admin BFF and Web Application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gaiop
Group=gaiop
WorkingDirectory=/opt/gaiop/admin
EnvironmentFile=/etc/gaiop/admin.env
ExecStart=$node_path --env-file=/etc/gaiop/admin.env server/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20s
KillSignal=SIGTERM
SendSIGKILL=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=/var/lib/gaiop/admin /var/lib/gaiop/reports /var/lib/gaiop/runtime /var/log/gaiop
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
created_unit=1
mark_phase 'UNIT_VALIDATE'
systemctl daemon-reload
systemd-analyze verify "$unit_file"
mark_phase 'RELEASE_SWITCH'
if [ "$service_was_active" -eq 1 ]; then
  mark_phase 'SERVICE_STOP'
  systemctl stop --no-block gaiop-admin.service
  for _ in $(seq 1 30); do
    systemctl is-active --quiet gaiop-admin.service || break
    sleep 1
  done
  if systemctl is-active --quiet gaiop-admin.service; then
    mark_phase 'SERVICE_FORCE_STOP'
    systemctl kill --kill-who=all --signal=KILL gaiop-admin.service || true
    for _ in $(seq 1 10); do
      systemctl is-active --quiet gaiop-admin.service || break
      sleep 1
    done
  fi
  if systemctl is-active --quiet gaiop-admin.service; then exit 45; fi
fi
if [ -e "$final_root" ]; then mv -- "$final_root" "$backup_root/preexisting-admin"; fi
mv -- "$stage_root" "$final_root"
committed=1
printf 'STAGE_COMPLETE\\n'
printf 'SERVICE_NOT_STARTED\\n'
`
}

function summarize(result) {
  const output = String(result.output || '')
  const phases = Array.from(output.matchAll(/PHASE_([A-Z_]+)/g), (match) => match[1])
  const npmFailure = output.match(/NPM_FAILURE_([A-Z_]+)/)?.[1] || null
  return {
    completed: result.ok && /STAGE_COMPLETE/.test(output),
    backupCreated: /BACKUP_CREATED/.test(output),
    serviceStarted: false,
    caddyChanged: false,
    networkChanged: false,
    failurePhase: result.ok ? null : (phases.at(-1) || 'UNKNOWN'),
    dependencyFailure: npmFailure,
    status: result.ok ? 'staged-awaiting-secret-injection' : (/BLOCK_EXISTING_ACTIVE_SERVICE/.test(output) ? 'blocked-existing-active-service' : 'stage-failed-rolled-back'),
  }
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-stage-timeout' })}\n`)
  }
  client.end()
  process.exitCode = 1
}, 15 * 60_000)

client.on('ready', async () => {
  try {
    const checksum = await sha256(archivePath)
    const remoteArchive = `/tmp/gaiop-admin-${releaseId}.tgz`
    await upload(client, archivePath, remoteArchive)
    const result = await execSudoScript(client, stageScript({ checksum, remoteArchive }))
    finished = true
    process.stdout.write(`${JSON.stringify(summarize(result))}\n`)
    if (!result.ok) process.exitCode = 1
  } catch {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'stage-transfer-or-runner-failed' })}\n`)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})

client.on('error', () => {
  if (!finished) {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
    clearTimeout(timeout)
    process.exitCode = 1
  }
})

client.connect(connection)
