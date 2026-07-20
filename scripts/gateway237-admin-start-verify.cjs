'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_START_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_START_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_START_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin start connection context is incomplete.')
}

const script = String.raw`set -euo pipefail
phase='PRECHECK'
mark_phase() { phase="$1"; printf 'PHASE_%s\\n' "$phase"; }
rollback() {
  systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
  printf 'ADMIN_START_ROLLED_BACK_TO_STOPPED\\n'
}
trap rollback ERR

mark_phase 'ENVIRONMENT'
node --env-file=/etc/gaiop/admin.env -e "const keys=['AUTH_PASSWORD','DATA_SOURCE_ENCRYPTION_KEY','SENSITIVE_CONFIG_ENCRYPTION_KEY','OPENCLAW_AUTH_TOKEN']; if (keys.some((key) => !process.env[key])) process.exit(2)"
mark_phase 'SYSTEMD_START'
systemctl start gaiop-admin.service
mark_phase 'SERVICE_ACTIVE'
for i in $(seq 1 45); do
  systemctl is-active --quiet gaiop-admin.service && break
  sleep 1
done
systemctl is-active --quiet gaiop-admin.service
mark_phase 'LOOPBACK_LISTENER'
listener_scope='other-or-none'
for i in $(seq 1 45); do
  listeners=$(ss -ltn '( sport = :3000 )')
  if printf '%s\\n' "$listeners" | grep -Eq '127\\.0\\.0\\.1:3000'; then
    listener_scope='loopback-ipv4'
    break
  elif printf '%s\\n' "$listeners" | grep -Eq '\[::1\]:3000'; then
    listener_scope='loopback-ipv6'
    break
  elif printf '%s\\n' "$listeners" | grep -Eq '0\\.0\\.0\\.0:3000|\[::\]:3000|\\*:3000'; then
    listener_scope='wildcard'
    break
  fi
  sleep 1
done
if [ "$listener_scope" = 'loopback-ipv4' ]; then
  printf 'LISTENER_LOOPBACK_IPV4\\n'
elif [ "$listener_scope" = 'loopback-ipv6' ]; then
  printf 'LISTENER_LOOPBACK_IPV6\\n'
elif [ "$listener_scope" = 'wildcard' ]; then
  printf 'LISTENER_WILDCARD\\n'
  exit 3
else
  printf 'LISTENER_OTHER_OR_NONE\\n'
  exit 4
fi
mark_phase 'HEALTH'
node -e "const http=require('http'); const req=http.get('http://127.0.0.1:3000/api/health',{timeout:5000},(res)=>{res.resume(); res.on('end',()=>process.exit(res.statusCode===200?0:4));}); req.on('error',()=>process.exit(5)); req.on('timeout',()=>{req.destroy();process.exit(6);});"
mark_phase 'GATEWAY_CONNECTED'
gateway_state='disconnected'
for i in $(seq 1 30); do
  gateway_state=$(node -e "const http=require('http'); const req=http.get('http://127.0.0.1:3000/api/health',{timeout:5000},(res)=>{let body='';res.on('data',(chunk)=>body+=chunk);res.on('end',()=>{try {process.stdout.write(JSON.parse(body).gateway === 'connected' ? 'connected' : 'disconnected')} catch {process.stdout.write('disconnected')}})});req.on('error',()=>process.stdout.write('disconnected'));req.on('timeout',()=>{req.destroy();process.stdout.write('disconnected')});" 2>/dev/null || true)
  if [ "$gateway_state" = 'connected' ]; then break; fi
  sleep 1
done
test "$gateway_state" = 'connected'
printf 'ADMIN_START_VERIFIED\\n'
`

function execute(client) {
  return executeScript(client, script)
}

function executeScript(client, body) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${body}`)
      stream.end()
    })
  })
}

const diagnosticScript = String.raw`set -euo pipefail
status=$(systemctl show gaiop-admin.service --property=ActiveState --property=SubState --property=ExecMainStatus --property=NRestarts 2>/dev/null || true)
if printf '%s\\n' "$status" | grep -q '^ExecMainStatus=0$'; then printf 'DIAG_EXIT_ZERO\\n'; else printf 'DIAG_EXIT_NONZERO\\n'; fi
if journalctl -u gaiop-admin.service -n 120 --no-pager 2>/dev/null | grep -Eqi 'ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package'; then
  printf 'DIAG_MODULE\\n'
elif journalctl -u gaiop-admin.service -n 120 --no-pager 2>/dev/null | grep -Eqi 'EACCES|EPERM|permission denied|EROFS'; then
  printf 'DIAG_PERMISSION\\n'
elif journalctl -u gaiop-admin.service -n 120 --no-pager 2>/dev/null | grep -Eqi 'SQLITE|database is locked|unable to open database'; then
  printf 'DIAG_SQLITE\\n'
elif journalctl -u gaiop-admin.service -n 120 --no-pager 2>/dev/null | grep -Eqi 'EADDRINUSE|address already in use'; then
  printf 'DIAG_PORT\\n'
elif journalctl -u gaiop-admin.service -n 120 --no-pager 2>/dev/null | grep -Eqi 'env-file|AUTH_PASSWORD|ENCRYPTION_KEY|GAIOP_BIND_HOST must be a loopback address'; then
  printf 'DIAG_ENVIRONMENT\\n'
else
  printf 'DIAG_OTHER\\n'
fi
`

function diagnosis(value) {
  const output = String(value || '')
  if (output.includes('DIAG_MODULE')) return 'module'
  if (output.includes('DIAG_PERMISSION')) return 'permission'
  if (output.includes('DIAG_SQLITE')) return 'sqlite'
  if (output.includes('DIAG_PORT')) return 'port'
  if (output.includes('DIAG_ENVIRONMENT')) return 'environment'
  return 'other'
}

const client = new Client()
let done = false
const timeout = setTimeout(() => {
  if (!done) process.stdout.write(`${JSON.stringify({ completed: false, status: 'admin-start-timeout' })}\n`)
  done = true
  client.end()
  process.exitCode = 1
}, 90_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    const diagnostic = result.ok ? null : await executeScript(client, diagnosticScript)
    done = true
    const output = String(result.output || '')
    const phases = Array.from(output.matchAll(/PHASE_([A-Z_]+)/g), (match) => match[1])
    const listenerScope = output.includes('LISTENER_LOOPBACK_IPV4')
      ? 'loopback-ipv4'
      : output.includes('LISTENER_LOOPBACK_IPV6')
        ? 'loopback-ipv6'
        : output.includes('LISTENER_WILDCARD')
          ? 'wildcard'
          : output.includes('LISTENER_OTHER_OR_NONE')
            ? 'other-or-none'
            : null
    process.stdout.write(`${JSON.stringify({
      completed: result.ok && /ADMIN_START_VERIFIED/.test(output),
      status: result.ok ? 'admin-started-loopback-verified' : 'admin-start-failed-and-stopped',
      rolledBackToStopped: /ADMIN_START_ROLLED_BACK_TO_STOPPED/.test(output),
      failurePhase: result.ok ? null : (phases.at(-1) || 'UNKNOWN'),
      listenerScope,
      diagnosticCategory: diagnostic ? diagnosis(diagnostic.output) : null,
      publicRoutingChanged: false,
    })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})
client.on('error', () => {
  if (!done) {
    done = true
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
    clearTimeout(timeout)
    process.exitCode = 1
  }
})
client.connect(connection)
