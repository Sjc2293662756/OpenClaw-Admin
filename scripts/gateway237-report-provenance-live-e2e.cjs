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
import { execFileSync } from 'node:child_process'
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

const sourceEnvelopes = fs.readdirSync(storeDirectory)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(storeDirectory, name), 'utf8')))
  .filter((value) => value?.dataSourceId)
  .sort((left, right) => Number(right.issuedAt || 0) - Number(left.issuedAt || 0))
if (sourceEnvelopes.length === 0) throw new Error('ACTIVE_DATA_SOURCE_UNAVAILABLE')

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
  dataSourceId: sourceEnvelopes[0].dataSourceId,
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
console.error('PHASE_COMPLETE')

process.stdout.write(JSON.stringify({
  completed: true,
  reportGenerated: true,
  sourceChannelRecorded: true,
  sourceUserRecorded: true,
  sourceSessionRecorded: true,
  dataSourceRecorded: true,
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
