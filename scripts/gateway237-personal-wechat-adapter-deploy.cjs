'use strict'

const { Client } = require('ssh2')
const fs = require('node:fs')
const path = require('node:path')

const connection = {
  host: String(process.env.GAIOP_WEIXIN_DEPLOY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEIXIN_DEPLOY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEIXIN_DEPLOY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled adapter deploy connection context is incomplete.')
}

const repositoryRoot = process.env.GAIOP_WEIXIN_DEPLOY_ROOT
  ? path.resolve(process.env.GAIOP_WEIXIN_DEPLOY_ROOT)
  : path.resolve(__dirname, '..')
const localAdapter = path.join(repositoryRoot, 'scripts', 'personal-wechat-adapter.mjs')
const localWorker = path.join(repositoryRoot, 'scripts', 'personal-wechat-worker.mjs')
const localUnit = path.join(repositoryRoot, 'deploy', '237', 'gaiop-personal-wechat.service')

for (const file of [localAdapter, localWorker, localUnit]) {
  if (!fs.existsSync(file)) throw new Error(`Missing local adapter artifact: ${file}`)
}

const remoteDir = '/home/netinside/gaiop-personal-wechat'
const remoteAdapter = `${remoteDir}/adapter.mjs`
const remoteWorker = `${remoteDir}/worker.mjs`
const remoteEnv = `${remoteDir}/adapter.env`
const remoteUnit = '/home/netinside/.config/systemd/user/gaiop-personal-wechat.service'

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

function upload(client, localPath, remotePath, mode) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) return reject(error)
      sftp.fastPut(localPath, remotePath, { mode }, (putError) => {
        sftp.end()
        putError ? reject(putError) : resolve()
      })
    })
  })
}

function bindingsPatchScript() {
  return `set -euo pipefail
home=/home/netinside
openclaw="$home/.npm-global/bin/openclaw"
run_oc() { runuser -u netinside -- env HOME="$home" PATH="$home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR=/run/user/1000 "$@"; }

existing=$(run_oc "$openclaw" config get bindings 2>/dev/null || echo '[]')
weixin_binding=$(printf '%s' "$existing" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);const hit=(Array.isArray(a)?a:[]).find(b=>b&&b.match&&b.match.channel==='openclaw-weixin');console.log(hit?JSON.stringify(hit):'')}catch(e){console.log('')}})")
if [ -n "$weixin_binding" ]; then
  printf 'BINDING_ALREADY_PRESENT\\n'
else
  printf '%s' '{"bindings":[{"type":"route","agentId":"main","match":{"channel":"openclaw-weixin","accountId":"*"},"session":{"dmScope":"per-account-channel-peer"}}]}' | run_oc "$openclaw" config patch --stdin
  printf 'BINDING_APPLIED\\n'
fi
`
}

const client = new Client()

client.on('ready', async () => {
  try {
    const ensureDirs = await execSudoScript(client, `set -eu
mkdir -p /home/netinside/gaiop-personal-wechat
mkdir -p /home/netinside/.config/systemd/user
chown -R netinside:netinside /home/netinside/gaiop-personal-wechat /home/netinside/.config/systemd/user
`)
    if (!ensureDirs.ok) {
      process.stdout.write(`${JSON.stringify({ completed: false, status: 'mkdir-failed', remoteExitCode: ensureDirs.exitCode })}\n`)
      process.exitCode = 1
      return
    }
    await upload(client, localAdapter, remoteAdapter, 0o600)
    await upload(client, localWorker, remoteWorker, 0o600)
    await upload(client, localUnit, remoteUnit, 0o644)

    const setupScript = `set -euo pipefail
home=/home/netinside
remote_dir='${remoteDir}'
install -d -o netinside -g netinside -m 0700 "$remote_dir"
chown -R netinside:netinside "$remote_dir"
chmod 0600 "$remote_dir/adapter.mjs" "$remote_dir/worker.mjs"

if [ ! -s "$remote_dir/adapter.env" ]; then
  token=$(openssl rand -hex 24)
  cat > "$remote_dir/adapter.env" <<EOF
GAIOP_WEIXIN_ADAPTER_PORT=19091
GAIOP_WEIXIN_ADAPTER_TOKEN=$token
EOF
  chown netinside:netinside "$remote_dir/adapter.env"
  chmod 0600 "$remote_dir/adapter.env"
fi

token=$(grep '^GAIOP_WEIXIN_ADAPTER_TOKEN=' "$remote_dir/adapter.env" | cut -d= -f2-)

if [ -f /etc/gaiop/admin.env ]; then
  grep -qx 'PERSONAL_WECHAT_ADAPTER_URL=http://127.0.0.1:19091' /etc/gaiop/admin.env || printf 'PERSONAL_WECHAT_ADAPTER_URL=http://127.0.0.1:19091\\n' >> /etc/gaiop/admin.env
  grep -qx "PERSONAL_WECHAT_ADAPTER_TOKEN=$token" /etc/gaiop/admin.env || printf 'PERSONAL_WECHAT_ADAPTER_TOKEN=%s\\n' "$token" >> /etc/gaiop/admin.env
fi

runuser -u netinside -- env HOME="$home" PATH="$home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload
runuser -u netinside -- env HOME="$home" PATH="$home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable --now gaiop-personal-wechat.service
printf 'ADAPTER_UNIT_ENABLED\\n'
`

    const setup = await execSudoScript(client, setupScript)
    if (!setup.ok) {
      process.stdout.write(`${JSON.stringify({ completed: false, status: 'adapter-setup-failed', remoteExitCode: setup.exitCode, output: setup.output.slice(-2000) })}\n`)
      process.exitCode = 1
      return
    }

    const binding = await execSudoScript(client, bindingsPatchScript())
    if (!binding.ok) {
      process.stdout.write(`${JSON.stringify({ completed: false, status: 'binding-apply-failed', remoteExitCode: binding.exitCode, output: binding.output.slice(-2000) })}\n`)
      process.exitCode = 1
      return
    }

    const verifyScript = `set -euo pipefail
home=/home/netinside
token=$(grep '^GAIOP_WEIXIN_ADAPTER_TOKEN=' /home/netinside/gaiop-personal-wechat/adapter.env | cut -d= -f2-)
run_oc() { runuser -u netinside -- env HOME="$home" PATH="$home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR=/run/user/1000 "$@"; }

echo '=== adapter health ==='
for n in $(seq 1 30); do
  curl -fsS --max-time 3 -H "x-gaiop-weixin-token: $token" http://127.0.0.1:19091/status >/dev/null 2>&1 && { echo 'ADAPTER_HEALTH_OK'; break; }
  sleep 1
done
curl -fsS --max-time 5 -H "x-gaiop-weixin-token: $token" http://127.0.0.1:19091/status
echo
echo '=== restart admin ==='
systemctl restart gaiop-admin.service
for n in $(seq 1 60); do
  curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && { echo 'ADMIN_HEALTH_200'; break; }
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:3000/api/health >/dev/null
echo '=== restart gateway ==='
run_oc systemctl --user restart openclaw-gateway.service
for n in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1:18789/health >/dev/null 2>&1; then
    echo 'GATEWAY_HEALTH_200'
    break
  fi
  sleep 2
done
curl -fsS --max-time 5 http://127.0.0.1:18789/health >/dev/null
echo '=== binding check ==='
run_oc openclaw config get bindings
echo '=== channels status summary ==='
run_oc openclaw channels status --json --timeout 15000 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('order='+JSON.stringify(j.channelOrder));console.log('wecom='+JSON.stringify(j.channels&&j.channels.wecom));console.log('feishu='+JSON.stringify(j.channels&&j.channels.feishu));console.log('dingtalk='+JSON.stringify(j.channels&&j.channels['dingtalk-connector']));}catch(e){console.log(s.slice(0,1200))}})"
`
    const verify = await execSudoScript(client, verifyScript)
    if (!verify.ok) {
      process.stdout.write(`${JSON.stringify({ completed: false, status: 'verify-failed', remoteExitCode: verify.exitCode, output: verify.output.slice(-3000) })}\n`)
      process.exitCode = 1
      return
    }

    process.stdout.write(`${JSON.stringify({
      completed: true,
      status: 'adapter-deployed',
      adapterPath: remoteDir,
      adapterUrl: 'http://127.0.0.1:19091',
      output: verify.output.slice(-6000),
    })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ completed: false, status: `adapter-deploy-error: ${error.message}` })}\n`)
    process.exitCode = 1
  } finally {
    client.end()
  }
})

client.on('error', () => {
  process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
  process.exitCode = 1
})

client.connect(connection)
