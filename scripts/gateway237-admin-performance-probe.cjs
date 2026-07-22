'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_PERF_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_PERF_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_PERF_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled performance probe inputs are incomplete.')

const script = String.raw`set -euo pipefail
printf 'SERVICE_ACTIVE='; systemctl is-active gaiop-admin.service || true
for key in MemoryCurrent CPUUsageNSec NRestarts ExecMainStatus; do printf '%s=' "$key"; systemctl show gaiop-admin.service -p "$key" --value || true; done
printf 'LOAD='; awk '{print $1","$2","$3}' /proc/loadavg
printf 'MEMORY='; free -b | awk '/^Mem:/ {print $2","$3","$7}'
printf 'DISK='; df -P /var/lib/gaiop | awk 'NR==2 {print $5}'
health=$(mktemp)
trap 'rm -f -- "$health"' EXIT
health_code=$(curl -sS --max-time 15 -o "$health" -w '%{http_code}' http://127.0.0.1:3000/api/health || true)
printf 'HEALTH_CODE=%s\n' "$health_code"
printf 'HEALTH_GATEWAY='; node -e "const fs=require('fs');try {const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(x.gateway==='connected'?'connected':'not-connected')} catch {process.stdout.write('invalid')}" "$health"; echo
printf 'HEALTH_MS='; curl -sS --max-time 15 -o /dev/null -w '%{time_total}' http://127.0.0.1:3000/api/health || true; echo
printf 'BINDING='; ss -ltnH '( sport = :3000 )' | awk '{print $4}' | sort -u | tr '\n' ','; echo
`

function execute(client) {
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
    const result = await execute(client)
    const get = (key) => result.output.match(new RegExp(`^${key}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || 'unknown'
    process.stdout.write(`${JSON.stringify({ completed: result.ok, service: get('SERVICE_ACTIVE'), memoryBytes: get('MemoryCurrent'), cpuUsageNs: get('CPUUsageNSec'), restarts: get('NRestarts'), processExit: get('ExecMainStatus'), load: get('LOAD'), memory: get('MEMORY'), disk: get('DISK'), healthCode: get('HEALTH_CODE'), gateway: get('HEALTH_GATEWAY'), healthSeconds: get('HEALTH_MS'), binding: get('BINDING') })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
