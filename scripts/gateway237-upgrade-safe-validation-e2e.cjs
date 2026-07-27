'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_UPGRADE_E2E_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_UPGRADE_E2E_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_UPGRADE_E2E_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_UPGRADE_E2E_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The safe upgrade validation E2E inputs are incomplete.')
}

const script = String.raw`set -euo pipefail
probe="/tmp/gaiop-upgrade-invalid-${releaseId}.zip"
response="/tmp/gaiop-upgrade-invalid-${releaseId}.json"
cleanup() { rm -f -- "$probe" "$response"; }
trap cleanup EXIT
token="$(sed -n 's/^GAIOP_UPGRADE_INTERNAL_TOKEN=//p' /etc/gaiop/upgrade.env | head -n 1)"
test -n "$token"
before_tasks="$(env NAPM_UPGRADE_DB_PATH=/var/lib/gaiop/upgrade/upgrade.db /usr/local/bin/node -e "const D=require('/opt/gaiop/upgrade/node_modules/better-sqlite3');const d=new D(process.env.NAPM_UPGRADE_DB_PATH,{readonly:true});process.stdout.write(String(d.prepare('select count(*) n from upgrade_tasks').get().n));d.close()")"
if [ -d /var/lib/gaiop/upgrade/staging ]; then before_staging="$(find /var/lib/gaiop/upgrade/staging -maxdepth 1 -type f | wc -l)"; else before_staging=0; fi
/usr/local/bin/node - <<'NODE'
const AdmZip = require('/opt/gaiop/upgrade/node_modules/adm-zip')
const zip = new AdmZip()
zip.addFile('manifest.json', Buffer.from('{}'))
zip.writeZip('/tmp/gaiop-upgrade-invalid-${releaseId}.zip')
NODE
status="$(curl -sS -o "$response" -w '%{http_code}' --max-time 15 \
  -H "X-GAIOP-Upgrade-Token: $token" \
  -H 'X-GAIOP-Upgrade-Actor: safe-validation-e2e' \
  -F "file=@$probe;type=application/zip" \
  http://127.0.0.1:18900/api/v1/upgrade/validate)"
test "$status" = '422'
test "$(env RESPONSE_PATH="$response" /usr/local/bin/node -e "const p=require(process.env.RESPONSE_PATH);if(p.valid!==false)process.exit(1)")" = ''
after_tasks="$(env NAPM_UPGRADE_DB_PATH=/var/lib/gaiop/upgrade/upgrade.db /usr/local/bin/node -e "const D=require('/opt/gaiop/upgrade/node_modules/better-sqlite3');const d=new D(process.env.NAPM_UPGRADE_DB_PATH,{readonly:true});process.stdout.write(String(d.prepare('select count(*) n from upgrade_tasks').get().n));d.close()")"
if [ -d /var/lib/gaiop/upgrade/staging ]; then after_staging="$(find /var/lib/gaiop/upgrade/staging -maxdepth 1 -type f | wc -l)"; else after_staging=0; fi
test "$before_tasks" = "$after_tasks"
test "$before_staging" = "$after_staging"
printf 'SAFE_VALIDATION_E2E_COMPLETE\n'
printf 'HTTP_STATUS=%s\n' "$status"
printf 'TASK_COUNT_UNCHANGED=%s\n' "$after_tasks"
printf 'STAGING_COUNT_UNCHANGED=%s\n' "$after_staging"
`

const client = new Client()
client.on('ready', () => {
  client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) {
      process.stdout.write('{"completed":false,"errorCode":"UPGRADE_SAFE_E2E_EXEC_FAILED"}\n')
      process.exitCode = 1
      client.end()
      return
    }
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => {
      const value = (name) => output.match(new RegExp(`^${name}=([0-9]+)$`, 'm'))?.[1] || null
      const result = {
        completed: code === 0 && /SAFE_VALIDATION_E2E_COMPLETE/.test(output),
        httpStatus: Number(value('HTTP_STATUS') || 0),
        taskCountUnchanged: Number(value('TASK_COUNT_UNCHANGED') || 0),
        stagingCountUnchanged: Number(value('STAGING_COUNT_UNCHANGED') || 0),
        errorCode: code === 0 ? null : 'UPGRADE_SAFE_VALIDATION_E2E_FAILED',
      }
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (!result.completed) process.exitCode = 1
      client.end()
    })
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  })
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"errorCode":"UPGRADE_SAFE_VALIDATION_E2E_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
