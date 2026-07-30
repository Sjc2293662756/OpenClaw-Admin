'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_DASHBOARD_PROBE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_DASHBOARD_PROBE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_DASHBOARD_PROBE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled dashboard usage probe inputs are incomplete.')
}

const remoteScript = String.raw`set -euo pipefail
node --input-type=module - <<'NODE'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { OpenClawGateway } from '/opt/gaiop/admin/server/gateway.js'
import { createDashboardUsageRuntime } from '/opt/gaiop/admin/server/lib/dashboard-usage-runtime.js'

function readProcessEnvironment(pid) {
  return fs.readFileSync('/proc/' + pid + '/environ', 'utf8')
    .split('\0')
    .reduce((result, row) => {
      const separator = row.indexOf('=')
      if (separator > 0) result[row.slice(0, separator)] = row.slice(separator + 1)
      return result
    }, {})
}

function formatYmd(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

function calendarRange(days, now) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  return { startDate: formatYmd(start), endDate: formatYmd(now), limit: 1000 }
}

const adminPid = execFileSync('systemctl', [
  'show', 'gaiop-admin.service', '--property=MainPID', '--value'
], { encoding: 'utf8' }).trim()
const environment = readProcessEnvironment(adminPid)
const gateway = new OpenClawGateway(
  String(environment.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789'),
  String(environment.OPENCLAW_AUTH_TOKEN || ''),
  String(environment.OPENCLAW_AUTH_PASSWORD || ''),
  'INFO'
)
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

const now = new Date()
const ranges = []
for (const days of [7, 30, 90]) {
  const params = calendarRange(days, now)
  const startedAt = Date.now()
  const result = await gateway.call('sessions.usage', params, 160_000)
  const serialized = JSON.stringify(result)
  ranges.push({
    days,
    startDate: params.startDate,
    endDate: params.endDate,
    elapsedMs: Date.now() - startedAt,
    responseBytes: Buffer.byteLength(serialized),
    sessions: Array.isArray(result?.sessions) ? result.sessions.length : 0,
    dailyPoints: Array.isArray(result?.aggregates?.daily) ? result.aggregates.daily.length : 0,
  })
}

let runtimeLoadCalls = 0
const runtime = createDashboardUsageRuntime({
  loadUsage: async (params) => {
    runtimeLoadCalls += 1
    return gateway.call('sessions.usage', params, 160_000)
  },
})
const runtimeParams = {
  principal: 'probe:dashboard',
  ...calendarRange(7, now),
}
const concurrentStartedAt = Date.now()
const [runtimeFirst, runtimeShared] = await Promise.all([
  runtime.read(runtimeParams),
  runtime.read(runtimeParams),
])
const concurrentElapsedMs = Date.now() - concurrentStartedAt
const cacheStartedAt = Date.now()
const runtimeCached = await runtime.read(runtimeParams)
const cacheElapsedMs = Date.now() - cacheStartedAt
const projected = JSON.stringify(runtimeFirst.usage)
gateway.disconnect()

const indexHtml = fs.readFileSync('/opt/gaiop/admin/dist/index.html', 'utf8')
const entryAsset = indexHtml.match(/assets\/index-[^"']+\.js/)?.[0] || ''
process.stdout.write(JSON.stringify({
  completed: true,
  ranges,
  runtimeProbe: {
    loadCalls: runtimeLoadCalls,
    concurrentElapsedMs,
    cacheElapsedMs,
    firstCache: runtimeFirst.cache,
    sharedCache: runtimeShared.cache,
    repeatCache: runtimeCached.cache,
    responseBytes: Buffer.byteLength(projected),
    sessions: Array.isArray(runtimeFirst.usage?.sessions) ? runtimeFirst.usage.sessions.length : 0,
  },
  entryAsset,
}))
NODE
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    if (!result.ok) {
      process.stdout.write('{"completed":false,"status":"remote-probe-failed"}\n')
      process.exitCode = 1
      return
    }
    const line = result.output.split(/\r?\n/).find((value) => value.startsWith('{"completed":true'))
    if (!line) {
      process.stdout.write('{"completed":false,"status":"invalid-probe-response"}\n')
      process.exitCode = 1
      return
    }
    process.stdout.write(`${line}\n`)
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
