'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_UPGRADE_PREFLIGHT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_UPGRADE_PREFLIGHT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_UPGRADE_PREFLIGHT_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled upgrade preflight connection is incomplete.')
}

const script = String.raw`set -eu
netinside_uid=$(id -u netinside)
gateway_state=$(runuser -u netinside -- env XDG_RUNTIME_DIR="/run/user/$netinside_uid" systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)
gateway_unit=$(runuser -u netinside -- env XDG_RUNTIME_DIR="/run/user/$netinside_uid" systemctl --user show openclaw-gateway.service -p FragmentPath --value 2>/dev/null || true)
gateway_health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/health || true)
gateway_root=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/ || true)
admin_health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/health || true)
upgrade_port=$(ss -ltnH 'sport = :18900' 2>/dev/null | wc -l | tr -d '[:space:]')
upgrade_health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/health || true)
upgrade_unauth=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18900/api/v1/upgrade/status || true)
upgrade_pid=$(ss -ltnpH 'sport = :18900' 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1)
if [ -n "$upgrade_pid" ] && [ -r "/proc/$upgrade_pid/cmdline" ]; then
  upgrade_command=$(tr '\0' ' ' < "/proc/$upgrade_pid/cmdline" | sed 's/[[:space:]]*$//')
  upgrade_cwd=$(readlink -f "/proc/$upgrade_pid/cwd" 2>/dev/null || true)
  upgrade_process=$(ps -o user=,ppid=,lstart= -p "$upgrade_pid" | sed 's/^[[:space:]]*//')
  upgrade_cgroup=$(tr '\n' ';' < "/proc/$upgrade_pid/cgroup")
else
  upgrade_command=missing
  upgrade_cwd=missing
  upgrade_process=missing
  upgrade_cgroup=missing
fi
upgrade_service=$(systemctl is-active gaiop-upgrade.service 2>/dev/null || true)
legacy_upgrade_service=$(systemctl is-active napm-upgrade.service 2>/dev/null || true)
upgrade_journal=$(journalctl -u gaiop-upgrade.service -n 40 --no-pager -o cat 2>/dev/null | tail -n 40 | base64 -w 0 || true)
admin_journal=$(journalctl -u gaiop-admin.service -n 60 --no-pager -o cat 2>/dev/null | tail -n 60 | base64 -w 0 || true)
if [ -d /opt/napm-upgrade/.git ]; then
  legacy_upgrade_commit=$(git -C /opt/napm-upgrade rev-parse HEAD 2>/dev/null || true)
  legacy_upgrade_dirty=$(git -C /opt/napm-upgrade status --porcelain 2>/dev/null | wc -l | tr -d '[:space:]')
else
  legacy_upgrade_commit=not-a-git-checkout
  legacy_upgrade_dirty=unknown
fi
if grep -Eq '^GAIOP_UPGRADE_INTERNAL_TOKEN=.+$' /opt/napm-upgrade/.env 2>/dev/null; then legacy_upgrade_token=configured; else legacy_upgrade_token=missing; fi
legacy_unit_user=$(systemctl show napm-upgrade.service -p User --value 2>/dev/null || true)
legacy_unit_group=$(systemctl show napm-upgrade.service -p Group --value 2>/dev/null || true)
legacy_unit_working=$(systemctl show napm-upgrade.service -p WorkingDirectory --value 2>/dev/null || true)
if [ -f /opt/napm-upgrade/src/config.js ]; then
  legacy_config=$(cd /opt/napm-upgrade && runuser -u netinside -- node - <<'NODE'
const c = require('./src/config')
process.stdout.write(JSON.stringify({
  dbPath: c.dbPath,
  backupRoot: c.backupRoot,
  skillsRoot: c.skillsRoot,
  pluginRoot: c.pluginRoot,
  openclawRoot: c.openclawRoot,
  frontendRoot: c.frontendRoot,
  publicKeyPath: c.publicKeyPath,
  packageStagingRoot: c.packageStagingRoot,
}))
NODE
)
else
  legacy_config='{}'
fi
admin_upgrade_url=$(sed -n 's/^GAIOP_UPGRADE_SERVICE_URL=//p' /etc/gaiop/admin.env 2>/dev/null | head -n 1)
if grep -Eq '^GAIOP_UPGRADE_INTERNAL_TOKEN=.+$' /etc/gaiop/admin.env 2>/dev/null; then admin_upgrade_token=configured; else admin_upgrade_token=missing; fi
path_state() {
  target="$1"
  if [ -e "$target" ]; then
    stat -c 'present|%U|%G|%a|%F' "$target"
  else
    printf 'missing||||'
  fi
}
printf 'OS=%s\n' "$(. /etc/os-release && printf '%s %s' "$ID" "$VERSION_ID")"
printf 'ARCH=%s\n' "$(uname -m)"
printf 'NODE=%s\n' "$(node --version 2>/dev/null || true)"
printf 'NODE_PATH=%s\n' "$(command -v node 2>/dev/null || true)"
printf 'NPM=%s\n' "$(npm --version 2>/dev/null || true)"
printf 'NETINSIDE_UID=%s\n' "$netinside_uid"
printf 'GAIOP_UID=%s\n' "$(id -u gaiop)"
printf 'GATEWAY_STATE=%s\n' "$gateway_state"
printf 'GATEWAY_UNIT=%s\n' "$gateway_unit"
printf 'GATEWAY_HEALTH=%s\n' "$gateway_health"
printf 'GATEWAY_ROOT=%s\n' "$gateway_root"
printf 'ADMIN_HEALTH=%s\n' "$admin_health"
printf 'UPGRADE_PORT_LISTENERS=%s\n' "$upgrade_port"
printf 'UPGRADE_HEALTH=%s\n' "$upgrade_health"
printf 'UPGRADE_UNAUTH=%s\n' "$upgrade_unauth"
printf 'UPGRADE_PID=%s\n' "$upgrade_pid"
printf 'UPGRADE_COMMAND=%s\n' "$upgrade_command"
printf 'UPGRADE_CWD=%s\n' "$upgrade_cwd"
printf 'UPGRADE_PROCESS=%s\n' "$upgrade_process"
printf 'UPGRADE_CGROUP=%s\n' "$upgrade_cgroup"
printf 'UPGRADE_SERVICE=%s\n' "$upgrade_service"
printf 'LEGACY_UPGRADE_SERVICE=%s\n' "$legacy_upgrade_service"
printf 'UPGRADE_JOURNAL_B64=%s\n' "$upgrade_journal"
printf 'ADMIN_JOURNAL_B64=%s\n' "$admin_journal"
printf 'LEGACY_UPGRADE_COMMIT=%s\n' "$legacy_upgrade_commit"
printf 'LEGACY_UPGRADE_DIRTY=%s\n' "$legacy_upgrade_dirty"
printf 'LEGACY_UPGRADE_TOKEN=%s\n' "$legacy_upgrade_token"
printf 'LEGACY_UNIT_USER=%s\n' "$legacy_unit_user"
printf 'LEGACY_UNIT_GROUP=%s\n' "$legacy_unit_group"
printf 'LEGACY_UNIT_WORKING=%s\n' "$legacy_unit_working"
printf 'LEGACY_CONFIG=%s\n' "$legacy_config"
if [ -n "$admin_upgrade_url" ]; then
  printf 'ADMIN_UPGRADE_URL=%s\n' "$admin_upgrade_url"
else
  printf 'ADMIN_UPGRADE_URL=missing\n'
fi
printf 'ADMIN_UPGRADE_TOKEN=%s\n' "$admin_upgrade_token"
printf 'ADMIN_ROOT=%s\n' "$(path_state /opt/gaiop/admin)"
printf 'ADMIN_DIST=%s\n' "$(path_state /opt/gaiop/admin/dist)"
printf 'OPENCLAW_ROOT=%s\n' "$(path_state /home/netinside/.npm-global/lib/node_modules/openclaw)"
printf 'SKILLS_ROOT=%s\n' "$(path_state /home/netinside/.openclaw/workspace/skills)"
printf 'PLUGIN_ROOT=%s\n' "$(path_state /home/netinside/.openclaw/extensions/napm-openclaw-plugin)"
printf 'BACKUP_ROOT=%s\n' "$(path_state /var/backups/gaiop)"
printf 'LEGACY_BACKUP_ROOT=%s\n' "$(path_state /var/backups/napm)"
printf 'LEGACY_BACKUP_KB=%s\n' "$(du -sk /var/backups/napm 2>/dev/null | awk '{print $1}' || printf '0')"
printf 'VAR_LIB=%s\n' "$(path_state /var/lib/gaiop)"
printf 'DISK_AVAILABLE_KB=%s\n' "$(df -Pk /var/lib/gaiop | awk 'NR==2 {print $4}')"
printf 'LINGER=%s\n' "$(loginctl show-user netinside -p Linger --value 2>/dev/null || true)"
`

function parse(output) {
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1)
  }
  const parsePath = (value = '') => {
    const [state, owner, group, mode, type] = value.split('|')
    return { state, owner, group, mode, type }
  }
  let legacyConfig = {}
  try { legacyConfig = JSON.parse(values.LEGACY_CONFIG || '{}') } catch {}
  let upgradeJournal = ''
  try { upgradeJournal = Buffer.from(values.UPGRADE_JOURNAL_B64 || '', 'base64').toString('utf8') } catch {}
  let adminJournal = ''
  try { adminJournal = Buffer.from(values.ADMIN_JOURNAL_B64 || '', 'base64').toString('utf8') } catch {}
  return {
    completed: true,
    os: values.OS,
    architecture: values.ARCH,
    node: { version: values.NODE, path: values.NODE_PATH, npm: values.NPM },
    users: { netinsideUid: values.NETINSIDE_UID, gaiopUid: values.GAIOP_UID, netinsideLinger: values.LINGER },
    gateway: { state: values.GATEWAY_STATE, unit: values.GATEWAY_UNIT, healthStatus: values.GATEWAY_HEALTH, rootStatus: values.GATEWAY_ROOT },
    admin: {
      healthStatus: values.ADMIN_HEALTH,
      upgradeServiceUrl: values.ADMIN_UPGRADE_URL,
      upgradeToken: values.ADMIN_UPGRADE_TOKEN,
      recentJournal: adminJournal,
    },
    upgrade: {
      serviceState: values.UPGRADE_SERVICE,
      portListeners: Number(values.UPGRADE_PORT_LISTENERS || 0),
      healthStatus: values.UPGRADE_HEALTH,
      unauthenticatedStatus: values.UPGRADE_UNAUTH,
      pid: values.UPGRADE_PID,
      command: values.UPGRADE_COMMAND,
      cwd: values.UPGRADE_CWD,
      process: values.UPGRADE_PROCESS,
      cgroup: values.UPGRADE_CGROUP,
      legacyServiceState: values.LEGACY_UPGRADE_SERVICE,
      recentJournal: upgradeJournal,
      legacyCommit: values.LEGACY_UPGRADE_COMMIT,
      legacyDirtyCount: values.LEGACY_UPGRADE_DIRTY,
      legacyToken: values.LEGACY_UPGRADE_TOKEN,
      legacyUnit: {
        user: values.LEGACY_UNIT_USER,
        group: values.LEGACY_UNIT_GROUP,
        workingDirectory: values.LEGACY_UNIT_WORKING,
      },
      legacyConfig,
    },
    paths: {
      adminRoot: parsePath(values.ADMIN_ROOT),
      adminDist: parsePath(values.ADMIN_DIST),
      openclawRoot: parsePath(values.OPENCLAW_ROOT),
      skillsRoot: parsePath(values.SKILLS_ROOT),
      pluginRoot: parsePath(values.PLUGIN_ROOT),
      backupRoot: parsePath(values.BACKUP_ROOT),
      legacyBackupRoot: parsePath(values.LEGACY_BACKUP_ROOT),
      varLib: parsePath(values.VAR_LIB),
    },
    diskAvailableKb: Number(values.DISK_AVAILABLE_KB || 0),
    legacyBackupKb: Number(values.LEGACY_BACKUP_KB || 0),
  }
}

const client = new Client()
client.on('ready', () => {
  client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) {
      process.stdout.write('{"completed":false,"errorCode":"UPGRADE_PREFLIGHT_EXEC_FAILED"}\n')
      process.exitCode = 1
      client.end()
      return
    }
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => {
      if (code === 0) process.stdout.write(`${JSON.stringify(parse(output))}\n`)
      else {
        process.stdout.write('{"completed":false,"errorCode":"UPGRADE_PREFLIGHT_FAILED"}\n')
        process.exitCode = 1
      }
      client.end()
    })
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  })
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"errorCode":"UPGRADE_PREFLIGHT_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
