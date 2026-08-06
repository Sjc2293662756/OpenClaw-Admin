'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_WEIXIN_PERF_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEIXIN_PERF_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEIXIN_PERF_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled perf check connection context is incomplete.')
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
echo '=== adapter process start time ==='
run_oc systemctl --user show gaiop-personal-wechat.service -p ExecMainStartTimestamp | head -1
token=$(grep '^GAIOP_WEIXIN_ADAPTER_TOKEN=' "$home/gaiop-personal-wechat/adapter.env" | cut -d= -f2-)
fake=zzz-perf2-$(date +%s)
echo '=== COLD delete ==='
curl -sS -o /dev/null -w 'cold_delete_seconds=%{time_total}\n' --max-time 60 -X DELETE -H "x-gaiop-weixin-token: $token" "http://127.0.0.1:19091/accounts/$fake"
fake2=zzz-perf2-$(date +%s)
echo '=== WARM delete ==='
curl -sS -o /dev/null -w 'warm_delete_seconds=%{time_total}\n' --max-time 60 -X DELETE -H "x-gaiop-weixin-token: $token" "http://127.0.0.1:19091/accounts/$fake2"
echo '=== WARM enable ==='
curl -sS -o /dev/null -w 'warm_enable_seconds=%{time_total}\n' --max-time 60 -X PUT -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d '{"enabled":true}' "http://127.0.0.1:19091/accounts/$fake2/enabled"
echo '=== real account intact ==='
ls -1 "$home/.openclaw/openclaw-weixin/accounts/" 2>/dev/null | head
echo '=== QR session cold (first after restart) ==='
curl -sS --max-time 60 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d '{}' -o /tmp/qr-session.json -w 'qr_start_seconds=%{time_total}\n' http://127.0.0.1:19091/qr/start
sk=$(node -e "const j=require('/tmp/qr-session.json'); process.stdout.write(j.sessionKey||'')")
curl -sS --max-time 25 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$sk\",\"timeoutMs\":22000}" -o /tmp/qr-wait.json -w 'qr_ready_seconds=%{time_total}\n' http://127.0.0.1:19091/qr/wait
node -e "const j=require('/tmp/qr-wait.json'); console.log('qr_wait_status='+j.status+' hasQrcode='+(typeof j.qrcodeUrl==='string'&&j.qrcodeUrl.length>20))"
curl -sS --max-time 10 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$sk\"}" http://127.0.0.1:19091/qr/cancel >/dev/null
sleep 4
echo '=== QR session warm (pool reuse) ==='
curl -sS --max-time 60 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d '{}' -o /tmp/qr-session2.json -w 'qr_start_seconds=%{time_total}\n' http://127.0.0.1:19091/qr/start
sk2=$(node -e "const j=require('/tmp/qr-session2.json'); process.stdout.write(j.sessionKey||'')")
curl -sS --max-time 25 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$sk2\",\"timeoutMs\":22000}" -o /tmp/qr-wait2.json -w 'qr_ready_seconds=%{time_total}\n' http://127.0.0.1:19091/qr/wait
node -e "const j=require('/tmp/qr-wait2.json'); console.log('qr_wait_status='+j.status+' hasQrcode='+(typeof j.qrcodeUrl==='string'&&j.qrcodeUrl.length>20))"
curl -sS --max-time 10 -H "x-gaiop-weixin-token: $token" -H 'Content-Type: application/json' -d "{\"sessionKey\":\"$sk2\"}" http://127.0.0.1:19091/qr/cancel >/dev/null
rm -f /tmp/qr-session.json /tmp/qr-wait.json /tmp/qr-session2.json /tmp/qr-wait2.json
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
