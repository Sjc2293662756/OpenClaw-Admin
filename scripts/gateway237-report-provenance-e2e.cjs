'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_E2E_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_E2E_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_E2E_SSH_PASSWORD || ''),
  readyTimeout: 15_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report provenance E2E context is incomplete.')
}

const script = String.raw`set -euo pipefail
probe_root=$(mktemp -d /tmp/gaiop-report-provenance-e2e.XXXXXX)
trap 'rm -rf -- "$probe_root"' EXIT
store_dir="$probe_root/provenance"
reports_dir="$probe_root/reports"
chmod 0711 "$probe_root"
install -d -o gaiop -g gaiop -m 0750 "$store_dir"
setfacl -m u:netinside:rx "$store_dir"
setfacl -m d:u:netinside:r-- "$store_dir"
install -d -o netinside -g "$(id -gn netinside)" -m 0700 "$reports_dir"
admin_pid=$(systemctl show gaiop-admin.service --property=MainPID --value)
signing_key=$(tr '\0' '\n' < "/proc/$admin_pid/environ" | sed -n 's/^GAIOP_REPORT_PROVENANCE_SIGNING_KEY=//p' | head -n 1)
test "$(printf '%s' "$signing_key" | wc -c | tr -d '[:space:]')" -ge 32
printf 'PHASE_ATTACH\n'
sudo -u gaiop env \
  GAIOP_REPORT_PROVENANCE_SIGNING_KEY="$signing_key" \
  GAIOP_REPORT_PROVENANCE_STORE_DIR="$store_dir" \
  node --input-type=module - <<'NODE'
import { attachReportProvenance } from '/opt/gaiop/admin/server/report-provenance-service.js'
const sessionId = 'agent:main:main:dm:webchat-provenance-e2e'
const attached = attachReportProvenance(
  { sessionKey: sessionId, message: 'GAIOP provenance E2E probe' },
  { id: 'provenance-e2e-user', username: 'provenance-e2e-user' },
  {
    enabled: true,
    signingKey: process.env.GAIOP_REPORT_PROVENANCE_SIGNING_KEY,
    storeDirectory: process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR,
    dataSourceId: 'provenance-e2e-source',
    transportMetadata: false,
  },
)
if (attached.attached || !attached.stored || attached.params.metadata) process.exit(11)
NODE

printf 'PHASE_TOOL\n'
sudo -u netinside env \
  GAIOP_REPORT_PROVENANCE_SIGNING_KEY="$signing_key" \
  GAIOP_REPORT_PROVENANCE_STORE_DIR="$store_dir" \
  GAIOP_REPORTS_DIR="$reports_dir" \
  node --input-type=module - <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import plugin from '/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js'
const sessionId = 'agent:main:main:dm:webchat-provenance-e2e'
const directProvenance = plugin.__test__.readStoredReportProvenance({ sessionKey: sessionId })
if (!directProvenance?.sourceUserId || !directProvenance?.sourceSessionId || !directProvenance?.dataSourceId) {
  process.stderr.write(JSON.stringify({ directSnapshotVerified: false }))
  process.exit(15)
}
const tool = plugin.__test__.createReportExportToolDefinition({ sessionKey: sessionId })
const result = await tool.execute('provenance-e2e-call', {
  prompt: 'GAIOP provenance E2E probe',
  format: 'docx',
  reportData: {
    schema: 'openclaw_napm_report_data.v1',
    reportType: 'quick_report',
    format: 'docx',
    defaultFormat: 'docx',
    title: 'GAIOP provenance E2E probe',
    sourceQuestion: 'GAIOP provenance E2E probe',
    sections: [{ type: 'summary', title: 'Summary', content: 'Synthetic deployment verification only.' }],
  },
})
if (!result?.details?.ok) process.exit(12)

process.stdout.write('PHASE_AUDIT\n')
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}
const audits = walk(process.env.GAIOP_REPORTS_DIR).filter((file) => file.endsWith('.json'))
if (audits.length !== 1) process.exit(13)
const audit = JSON.parse(fs.readFileSync(audits[0], 'utf8'))
if (
  audit.sourceChannel !== 'web'
  || audit.sourceUserId !== 'provenance-e2e-user'
  || audit.sourceSessionId !== sessionId
  || audit.dataSourceId !== 'provenance-e2e-source'
) {
  process.stderr.write(JSON.stringify({
    sourceChannelRecorded: audit.sourceChannel === 'web',
    sourceUserRecorded: audit.sourceUserId === 'provenance-e2e-user',
    sourceSessionRecorded: audit.sourceSessionId === sessionId,
    dataSourceRecorded: audit.dataSourceId === 'provenance-e2e-source',
    auditKeys: Object.keys(audit).sort(),
  }))
  process.exit(14)
}
process.stdout.write(JSON.stringify({
  completed: true,
  reportGenerated: true,
  auditGenerated: true,
  sourceChannelRecorded: true,
  sourceUserRecorded: true,
  sourceSessionRecorded: true,
  dataSourceRecorded: true,
}))
NODE
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      let errorOutput = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', (chunk) => { errorOutput += chunk.toString('utf8') })
      stream.on('close', (code) => {
        if (code === 0) {
          const jsonLine = output.split(/\r?\n/).find((line) => line.startsWith('{'))
          resolve(JSON.parse(jsonLine))
          return
        }
        const error = new Error(`remote exit ${code}`)
        error.phase = output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '') || 'UNKNOWN'
        error.debug = errorOutput.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 1600)
        reject(error)
      })
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 60_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    client.end()
  } catch (error) {
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'E2E_FAILED', phase: error?.phase || 'UNKNOWN', debug: error?.debug || '' })}\n`)
    client.end()
    process.exitCode = 1
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"errorCode":"CONNECTION_FAILED"}\n')
  process.exitCode = 1
})

client.connect(connection)
