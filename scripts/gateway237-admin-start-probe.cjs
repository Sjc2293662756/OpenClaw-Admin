'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_PROBE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_PROBE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_PROBE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled Admin probe inputs are incomplete.')

const script = String.raw`set -euo pipefail
cleanup() { systemctl stop gaiop-admin.service >/dev/null 2>&1 || true; }
trap cleanup ERR
systemctl start gaiop-admin.service
bindings=''
for _ in $(seq 1 75); do
  bindings=$(ss -ltnH '( sport = :3000 )' | awk '{print $4}' | sort -u | tr '\n' ',')
  case "$bindings" in
    *127.0.0.1:3000,*|*\[::1\]:3000,*) break ;;
    '') sleep 1 ;;
    *) printf 'BINDINGS=%s\n' "$bindings"; printf 'RESULT=non-loopback-or-unexpected\n'; exit 71 ;;
  esac
done
test -n "$bindings"
printf 'BINDINGS=%s\n' "$bindings"
for _ in $(seq 1 45); do
  gateway=$(node -e "const http=require('http'); const r=http.get('http://127.0.0.1:3000/api/health',{timeout:5000},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>{try{process.stdout.write(JSON.parse(b).gateway==='connected'?'connected':'disconnected')}catch{process.stdout.write('invalid')}})});r.on('error',()=>process.stdout.write('unavailable'));r.on('timeout',()=>{r.destroy();process.stdout.write('timeout')})" 2>/dev/null || true)
  if [ "$gateway" = connected ]; then printf 'RESULT=connected\n'; exit 0; fi
  sleep 1
done
printf 'RESULT=gateway-not-connected\n'
exit 72
`

function execute(client) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''; stream.on('data', (chunk) => { output += chunk.toString('utf8') }); stream.stderr.on('data', () => {})
    stream.on('close', (code) => resolve({ ok: code === 0, output })); stream.write(`${connection.password}\n${script}`); stream.end()
  }))
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client); const bindings = result.output.match(/^BINDINGS=([^\r\n]*)/m)?.[1]?.split(',').filter(Boolean) || []
    const status = result.output.match(/^RESULT=([^\r\n]*)/m)?.[1] || 'unknown'
    process.stdout.write(`${JSON.stringify({ completed: result.ok && status === 'connected', status, bindings, stoppedOnFailure: !result.ok })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
