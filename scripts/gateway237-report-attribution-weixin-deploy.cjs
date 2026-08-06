'use strict'

const { Client } = require('ssh2')
const fs = require('node:fs')
const path = require('node:path')

const connection = {
  host: String(process.env.GAIOP_WEIXIN_REPORT_DEPLOY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEIXIN_REPORT_DEPLOY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEIXIN_REPORT_DEPLOY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled attribution deploy connection context is incomplete.')
}

const repositoryRoot = process.env.GAIOP_WEIXIN_DEPLOY_ROOT
  ? path.resolve(process.env.GAIOP_WEIXIN_DEPLOY_ROOT)
  : path.resolve(__dirname, '..')
const localWorker = path.join(repositoryRoot, 'server', 'report-attribution-worker.js')
if (!fs.existsSync(localWorker)) throw new Error(`Missing local worker: ${localWorker}`)

const remoteWorker = '/home/netinside/.local/lib/gaiop-report-attribution/report-attribution-worker.js'

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

const verifyScript = String.raw`set -u
home=/home/netinside
run_oc() { runuser -u netinside -- env HOME="$home" PATH="$home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR=/run/user/1000 "$@"; }
echo '=== restart attribution service ==='
run_oc systemctl --user restart gaiop-report-attribution.service
run_oc systemctl --user is-active gaiop-report-attribution.service
for n in $(seq 1 20); do
  wx=$(node -e "const fs=require('fs'); const p='/var/lib/gaiop/report-attribution/index.json'; if(!fs.existsSync(p)){process.exit(0)} const j=JSON.parse(fs.readFileSync(p,'utf8')); process.stdout.write(String((j.entries||[]).filter(e=>e.sourceChannel==='openclaw-weixin').length))")
  [ "$wx" -gt 0 ] 2>/dev/null && { echo "WEIXIN_ENTRIES=$wx"; break; }
  sleep 3
done
echo '=== weixin entries in index ==='
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('/var/lib/gaiop/report-attribution/index.json','utf8')); for(const e of (j.entries||[]).filter(e=>e.sourceChannel==='openclaw-weixin')){console.log(JSON.stringify({storedName:e.storedName, auditName:e.auditName, reportId:e.reportId, sourceUserId:e.sourceUserId, sourceChannelUserId:e.sourceChannelUserId, sourceSessionId:e.sourceSessionId, evidence:e.evidence, fileSha256:e.fileSha256&&e.fileSha256.slice(0,12)}))}"
echo '=== archived files exist ==='
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('/var/lib/gaiop/report-attribution/index.json','utf8')); for(const e of (j.entries||[]).filter(e=>e.sourceChannel==='openclaw-weixin')){console.log('report='+fs.existsSync('/var/lib/gaiop/reports/'+e.storedName)+' audit='+fs.existsSync('/var/lib/gaiop/reports/'+e.auditName))}"
`

const client = new Client()
client.on('ready', async () => {
  try {
    await upload(client, localWorker, remoteWorker, 0o600)
    const verify = await execSudoScript(client, verifyScript)
    if (!verify.ok) {
      process.stdout.write(`${JSON.stringify({ completed: false, status: 'verify-failed', remoteExitCode: verify.exitCode, output: verify.output.slice(-3000) })}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${JSON.stringify({ completed: true, status: 'attribution-weixin-deployed', output: verify.output.slice(-6000) })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ completed: false, status: `deploy-error: ${error.message}` })}\n`)
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
