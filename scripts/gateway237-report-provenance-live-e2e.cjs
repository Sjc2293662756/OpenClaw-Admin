'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_LIVE_E2E_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_LIVE_E2E_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_LIVE_E2E_SSH_PASSWORD || ''),
  readyTimeout: 15_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled live report verification context is incomplete.')
}

const remoteScript = String.raw`set -eu
node --input-type=module - <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { OpenClawGateway } from '/opt/gaiop/admin/server/gateway.js'
import { attachReportProvenance } from '/opt/gaiop/admin/server/report-provenance-service.js'

function readProcessEnvironment(pid) {
  return fs.readFileSync('/proc/' + pid + '/environ', 'utf8')
    .split('\0')
    .reduce((result, row) => {
      const separator = row.indexOf('=')
      if (separator > 0) result[row.slice(0, separator)] = row.slice(separator + 1)
      return result
    }, {})
}
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const adminPid = execFileSync('systemctl', [
  'show', 'gaiop-admin.service', '--property=MainPID', '--value'
], { encoding: 'utf8' }).trim()
console.error('PHASE_ENVIRONMENT')
const environment = readProcessEnvironment(adminPid)
const signingKey = String(environment.GAIOP_REPORT_PROVENANCE_SIGNING_KEY || '')
const storeDirectory = String(environment.GAIOP_REPORT_PROVENANCE_STORE_DIR || '/var/lib/gaiop/runtime/report-provenance')
const reportsDirectory = String(environment.GAIOP_REPORTS_DIR || '/var/lib/gaiop/reports')
if (signingKey.length < 32) throw new Error('REPORT_SIGNING_KEY_UNAVAILABLE')

const require = createRequire('/opt/gaiop/admin/server/index.js')
const Database = require('better-sqlite3')
const dataDirectory = String(environment.GAIOP_ADMIN_DATA_DIR || '/var/lib/gaiop/admin')
const database = new Database(path.join(dataDirectory, 'wizard.db'), {
  readonly: true,
  fileMustExist: true,
})
const activeDataSource = database.prepare(
  'SELECT id FROM data_sources WHERE is_active = 1 ORDER BY id LIMIT 1'
).get()
database.close()
const activeDataSourceId = String(activeDataSource?.id || '').trim()
if (!activeDataSourceId) throw new Error('ACTIVE_DATA_SOURCE_UNAVAILABLE')

const sessionKey = 'agent:main:main:dm:webchat-' + crypto.randomBytes(16).toString('hex')
const idempotencyKey = 'report-live-e2e-' + Date.now()
const message = '请生成一份“237报告来源链路验收报告”，使用最近1小时数据；必须调用 napm-summary 后调用 napm-report-export 输出 Word。'
const attached = attachReportProvenance({
  sessionKey,
  message,
  idempotencyKey,
}, {
  id: 'system-release-verifier',
  username: '237发布验收',
}, {
  enabled: true,
  signingKey,
  storeDirectory,
  dataSourceId: activeDataSourceId,
  transportMetadata: false,
})
console.error('PHASE_SNAPSHOT')
if (attached.attached || !attached.stored || attached.params.metadata) throw new Error('PROVENANCE_SNAPSHOT_FAILED')

const snapshotDigest = crypto.createHash('sha256').update(sessionKey, 'utf8').digest('hex')
const snapshotFile = path.join(storeDirectory, snapshotDigest + '.json')
const uid = Number(execFileSync('id', ['-u', 'gaiop'], { encoding: 'utf8' }).trim())
const gid = Number(execFileSync('id', ['-g', 'gaiop'], { encoding: 'utf8' }).trim())
fs.chownSync(snapshotFile, uid, gid)
fs.chmodSync(snapshotFile, 0o640)

const gateway = new OpenClawGateway(
  String(environment.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789'),
  String(environment.OPENCLAW_AUTH_TOKEN || ''),
  String(environment.OPENCLAW_AUTH_PASSWORD || ''),
  'INFO'
)
console.error('PHASE_GATEWAY_CONNECT')
if (environment.OPENCLAW_DEVICE_IDENTITY_PATH) {
  gateway.deviceIdentityPath = environment.OPENCLAW_DEVICE_IDENTITY_PATH
}
const connected = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('GATEWAY_CONNECT_TIMEOUT')), 20_000)
  gateway.once('connected', () => {
    clearTimeout(timer)
    resolve()
  })
  gateway.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
})
gateway.connect()
await connected
console.error('PHASE_CHAT_SEND')
const startedAt = Date.now()
const liveChatParams = {
  sessionKey: attached.params.sessionKey,
  message: attached.params.message,
  idempotencyKey: attached.params.idempotencyKey,
}
await gateway.call('chat.send', liveChatParams, 120_000)
console.error('PHASE_REPORT_POLL')

let audit = null
let auditFile = ''
for (let attempt = 0; attempt < 90 && !audit; attempt += 1) {
  const candidates = walk(reportsDirectory)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => fs.statSync(file).mtimeMs >= startedAt - 5_000)
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  for (const file of candidates) {
    let value
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
    if (String(value.sourceSessionId || '') !== sessionKey) continue
    audit = value
    auditFile = file
    break
  }
  if (!audit) await delay(2_000)
}
gateway.disconnect()
if (!audit) throw new Error('LIVE_REPORT_AUDIT_TIMEOUT')
if (
  audit.sourceChannel !== 'web'
  || audit.sourceUserId !== 'system-release-verifier'
  || audit.sourceSessionId !== sessionKey
  || !audit.dataSourceId
) throw new Error('LIVE_REPORT_PROVENANCE_INCOMPLETE')
console.error('PHASE_ADMIN_SYNC')
const registryScript = [
  "import db from 'file:///opt/gaiop/admin/server/database.js'",
  "import { __test__ } from 'file:///opt/gaiop/admin/server/routes/reports.js'",
  '__test__.syncGeneratedReports(db)',
  "const row = db.prepare('SELECT * FROM report_files WHERE id = ?').get(process.env.REPORT_ID)",
  'if (!row) process.exit(1)',
  'if (row.stored_name !== process.env.REPORT_STORED_NAME || row.audit_name !== process.env.REPORT_AUDIT_NAME) process.exit(1)',
  "if (row.status !== 'ready' || !row.source_user_id || !row.source_session_id || !row.data_source_id) process.exit(1)",
  "process.stdout.write(JSON.stringify({ registered: true }))",
].join('\\n')
const registryResult = JSON.parse(execFileSync('sudo', [
  '-u', 'gaiop', 'env',
  'GAIOP_REPORTS_DIR=' + reportsDirectory,
  'GAIOP_ADMIN_DATA_DIR=' + dataDirectory,
  'REPORT_ID=' + String(audit.reportId || ''),
  'REPORT_STORED_NAME=' + String(audit.relativeFilePath || ''),
  'REPORT_AUDIT_NAME=' + path.relative(reportsDirectory, auditFile).split(path.sep).join('/'),
  '/usr/local/bin/node', '--input-type=module', '-e', registryScript,
], { encoding: 'utf8' }))
if (!registryResult.registered) throw new Error('LIVE_REPORT_ADMIN_SYNC_FAILED')

console.error('PHASE_DOWNLOAD_AUTH')
const unauthenticatedDownloadStatus = await new Promise((resolve, reject) => {
  const request = http.get(
    'http://127.0.0.1:3000/api/reports/' + encodeURIComponent(String(audit.reportId || '')) + '/download',
    { timeout: 5_000 },
    (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    },
  )
  request.on('error', reject)
  request.on('timeout', () => request.destroy(new Error('DOWNLOAD_AUTH_TIMEOUT')))
})
if (![401, 403].includes(unauthenticatedDownloadStatus)) throw new Error('DOWNLOAD_AUTH_BOUNDARY_FAILED')
console.error('PHASE_COMPLETE')

process.stdout.write(JSON.stringify({
  completed: true,
  reportGenerated: true,
  sourceChannelRecorded: true,
  sourceUserRecorded: true,
  sourceSessionRecorded: true,
  dataSourceRecorded: true,
  adminRegistered: true,
  unauthenticatedDownloadBlocked: true,
  reportFile: String(audit.relativeFilePath || ''),
  auditFile: path.relative(reportsDirectory, auditFile).split(path.sep).join('/'),
  generatedAt: String(audit.generatedAt || ''),
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
        if (code !== 0) {
          const safeCodes = [
            'REPORT_SIGNING_KEY_UNAVAILABLE',
            'ACTIVE_DATA_SOURCE_UNAVAILABLE',
            'PROVENANCE_SNAPSHOT_FAILED',
            'GATEWAY_CONNECT_TIMEOUT',
            'LIVE_REPORT_AUDIT_TIMEOUT',
            'LIVE_REPORT_PROVENANCE_INCOMPLETE',
            'LIVE_REPORT_ADMIN_SYNC_FAILED',
            'DOWNLOAD_AUTH_TIMEOUT',
            'DOWNLOAD_AUTH_BOUNDARY_FAILED',
            'additional properties',
            'invalid params',
            'invalid request',
            'required property',
            'unauthorized',
            'forbidden',
            'session not found',
            'message required',
            'metadata',
            'device identity',
            'permission denied',
            'RPC call',
          ]
          const matched = safeCodes.find((candidate) => errorOutput.toLowerCase().includes(candidate.toLowerCase()))
          const phases = Array.from(errorOutput.matchAll(/PHASE_([A-Z_]+)/g)).map((match) => match[1])
          const phase = phases.at(-1) || 'UNKNOWN'
          return reject(new Error(matched
            ? matched.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
            : `REMOTE_EXECUTION_FAILED_${phase}`))
        }
        try {
          resolve(JSON.parse(output))
        } catch {
          reject(new Error('invalid live verification output'))
        }
      })
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"status":"timeout"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 240_000)

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
    const status = /^[A-Z0-9_]+$/.test(String(error?.message || ''))
      ? String(error.message)
      : 'LIVE_VERIFICATION_FAILED'
    process.stdout.write(`${JSON.stringify({ completed: false, status })}\n`)
    client.end()
    process.exitCode = 1
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"status":"connection-failed"}\n')
  process.exitCode = 1
})

client.connect(connection)
