'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_REPORT_ACL_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_ACL_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_ACL_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_ACL_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report ACL repair inputs are incomplete.')
}

const script = String.raw`set -euo pipefail
reports_dir=/var/lib/gaiop/reports
backup_dir=/var/backups/gaiop/admin-report-acl-${releaseId}
backup_file="$backup_dir/reports-recursive-before-bff-access.acl"
changed=0
rollback() {
  status=$?
  if [ "$changed" -eq 1 ] && [ -f "$backup_file" ]; then
    setfacl --restore="$backup_file" || true
  fi
  exit "$status"
}
trap rollback ERR

test -d "$reports_dir"
command -v getfacl >/dev/null
command -v setfacl >/dev/null
install -d -m 0700 "$backup_dir"
getfacl -R -p "$reports_dir" > "$backup_file"
printf 'ACL_BACKUP_CREATED\n'

# The Gateway creates user/type subdirectories.  Named ACLs on the archive
# root alone do not grant the BFF account access to those children, because
# their owner is the Gateway account.  Repair directory and file access
# separately, then set inheritable defaults for subsequent reports.
find "$reports_dir" -type d -exec setfacl -m u:gaiop:rwx,u:netinside:rwx,m::rwx {} +
find "$reports_dir" -type f -exec setfacl -m u:gaiop:rw-,u:netinside:rw-,m::rw- {} +
find "$reports_dir" -type d -exec setfacl -d -m u:gaiop:rwx,u:netinside:rwx,m::rwx {} +
changed=1
sudo -u netinside test -r "$reports_dir"
sudo -u netinside test -w "$reports_dir"
sudo -u netinside test -x "$reports_dir"
if sudo -u gaiop find "$reports_dir" -type d \( ! -readable -o ! -executable \) -print -quit | grep -q .; then exit 41; fi
if sudo -u gaiop find "$reports_dir" -type f ! -readable -print -quit | grep -q .; then exit 42; fi
printf 'GATEWAY_REPORT_ACCESS_READ_WRITE\n'
printf 'ADMIN_REPORT_ARCHIVE_ACCESS_READABLE\n'
printf 'ACL_REPAIR_COMPLETE\n'
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
let complete = false
const timeout = setTimeout(() => {
  if (!complete) process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'REPORT_ACL_REPAIR_TIMEOUT' })}\n`)
  complete = true
  client.end()
  process.exitCode = 1
}, 60_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    complete = true
    clearTimeout(timeout)
    const output = String(result.output || '')
    process.stdout.write(`${JSON.stringify({
      ok: result.ok && /ACL_REPAIR_COMPLETE/.test(output),
      backupCreated: /ACL_BACKUP_CREATED/.test(output),
      gatewayReportAccess: /GATEWAY_REPORT_ACCESS_READ_WRITE/.test(output) ? 'read-write' : 'unverified',
      adminReportArchiveAccess: /ADMIN_REPORT_ARCHIVE_ACCESS_READABLE/.test(output) ? 'readable' : 'unverified',
      errorCode: result.ok ? null : 'REPORT_ACL_REPAIR_FAILED',
    })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally {
    client.end()
  }
})

client.on('error', () => {
  if (complete) return
  complete = true
  clearTimeout(timeout)
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'REPORT_ACL_REPAIR_CONNECTION_FAILED' })}\n`)
  process.exitCode = 1
})

client.connect(connection)
