'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_WEIXIN_LIVECHECK_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEIXIN_LIVECHECK_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEIXIN_LIVECHECK_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled live check connection context is incomplete.')
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

const script = String.raw`set -u
home=/home/netinside
run_oc() { runuser -u netinside -- env HOME="$home" PATH="$home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR=/run/user/1000 "$@"; }
token=$(grep '^GAIOP_WEIXIN_ADAPTER_TOKEN=' "$home/gaiop-personal-wechat/adapter.env" | cut -d= -f2-)
echo '=== admin health ==='
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:3000/api/health
echo '=== personal-wechat route unauth (expect 401) ==='
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:3000/api/channels/personal-wechat
echo '=== admin process env presence ==='
pid=$(pgrep -f 'server/index.js' | head -1)
tr '\0' '\n' < "/proc/$pid/environ" | grep -c '^PERSONAL_WECHAT_ADAPTER_URL=' || true
tr '\0' '\n' < "/proc/$pid/environ" | grep -c '^PERSONAL_WECHAT_ADAPTER_TOKEN=' || true
echo '=== adapter /status ==='
curl -fsS --max-time 5 -H "x-gaiop-weixin-token: $token" http://127.0.0.1:19091/status
echo
echo '=== adapter qr start ==='
curl -fsS --max-time 10 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:19091/qr/start > /tmp/gaiop-weixin-session.json
node -e "const j=require('/tmp/gaiop-weixin-session.json'); console.log('status='+j.status+' hasQrcode='+(typeof j.qrcodeUrl==='string'&&j.qrcodeUrl.length>20)+' expiresAt='+j.expiresAt+' sessionKeyLen='+String(j.sessionKey||'').length)"
session_key=$(node -e "const j=require('/tmp/gaiop-weixin-session.json'); process.stdout.write(j.sessionKey)")
echo '=== adapter qr wait (12s) ==='
curl -fsS --max-time 20 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$session_key\",\"timeoutMs\":12000}" http://127.0.0.1:19091/qr/wait | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('wait_status='+j.status+' hasQrcode='+(typeof j.qrcodeUrl==='string'&&j.qrcodeUrl.length>20))})"
echo '=== adapter qr cancel ==='
curl -fsS --max-time 10 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$session_key\"}" http://127.0.0.1:19091/qr/cancel | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('cancel_status='+j.status)})"
rm -f /tmp/gaiop-weixin-session.json
echo '=== gateway health ==='
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:18789/health
echo '=== public entry ==='
curl -sS -o /dev/null -w 'public_https=%{http_code}\n' --max-time 8 https://127.0.0.1/ -k
`

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execSudoScript(client, script)
    process.stdout.write(`${JSON.stringify({ completed: result.ok, exitCode: result.exitCode, output: result.output })}\n`)
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
  process.exitCode = 1
})
client.connect(connection)
