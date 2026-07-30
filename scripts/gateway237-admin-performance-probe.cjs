'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_PERF_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_PERF_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_PERF_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled performance probe inputs are incomplete.')

const rpcProbeSource = String.raw`
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const { OpenClawGateway } = await import(pathToFileURL(resolve(root, 'server/gateway.js')).href)
const {
  enrichSessionPayload,
  filterHiddenLegacySessions,
} = await import(pathToFileURL(resolve(root, 'server/lib/session-ownership-service.js')).href)

const gateway = new OpenClawGateway(
  process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',
  process.env.OPENCLAW_AUTH_TOKEN || '',
  process.env.OPENCLAW_AUTH_PASSWORD || '',
  'ERROR',
)

const connected = new Promise((resolveConnected, rejectConnected) => {
  const timer = setTimeout(() => rejectConnected(new Error('Gateway probe connection timed out')), 20_000)
  gateway.on('connected', () => {
    clearTimeout(timer)
    resolveConnected()
  })
  gateway.on('error', (error) => {
    clearTimeout(timer)
    rejectConnected(error)
  })
})

function roundMs(value) {
  return Math.round(value * 100) / 100
}

async function measure(run) {
  const started = performance.now()
  const value = await run()
  return { value, ms: roundMs(performance.now() - started) }
}

function sessionRows(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const key of ['sessions', 'items', 'list', 'data']) {
    if (Array.isArray(payload[key])) return payload[key]
  }
  return []
}

function historyRows(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const queue = [payload]
  const visited = new Set()
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    for (const key of ['messages', 'history', 'transcript', 'items', 'list', 'data', 'events', 'turns']) {
      if (Array.isArray(current[key])) return current[key]
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return []
}

function isCompatibilityError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /unknown method|method not found|invalid params|missing required property|must have required property|unexpected property|must match a schema|must be equal to constant/i.test(message)
}

let db
try {
  gateway.connect()
  await connected

  const list = await measure(() => gateway.call('sessions.list', {}))
  const rows = sessionRows(list.value)

  const dataDir = process.env.GAIOP_ADMIN_DATA_DIR || resolve(root, 'data')
  db = new Database(resolve(dataDir, 'wizard.db'), { readonly: true, fileMustExist: true })

  const enhanced = await measure(async () =>
    enrichSessionPayload(db, filterHiddenLegacySessions(db, list.value))
  )
  const enhancedRows = sessionRows(enhanced.value)
  const originCounts = enhancedRows.reduce((counts, row) => {
    const source = typeof row?.sourceChannel === 'string' && row.sourceChannel
      ? row.sourceChannel
      : 'unknown'
    counts[source] = (counts[source] || 0) + 1
    return counts
  }, {})
  const externalOriginMismatches = enhancedRows.filter((row) => {
    const key = String(row?.key || row?.sessionKey || row?.id || '').toLowerCase()
    const externalKey = /(^|:)(feishu|lark|openclaw-lark|dingtalk|dingtalk-connector|wecom|wecom-app|wecom-openclaw-plugin)(:|$)/.test(key)
    return externalKey && row?.originKind === 'web'
  }).length
  const defaultSessionVisible = enhancedRows.some((row) => {
    const key = String(row?.key || row?.sessionKey || row?.id || '').toLowerCase()
    return key === 'main' || key === 'agent:main:main'
  })

  let usage
  try {
    const measured = await measure(() =>
      gateway.call('sessions.usage', { limit: Math.max(200, rows.length * 4) }, 65_000)
    )
    usage = { ok: true, ms: measured.ms }
  } catch (error) {
    usage = {
      ok: false,
      ms: null,
      category: isCompatibilityError(error) ? 'compatibility' : 'runtime',
    }
  }

  const workspace = db.prepare(
    "SELECT session_key FROM workspace_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1"
  ).get()
  const historyKey = typeof workspace?.session_key === 'string'
    ? workspace.session_key
    : rows.map((row) => row?.key || row?.sessionKey || row?.id)
      .find((key) => typeof key === 'string' && key.includes(':dm:webchat-'))

  const historyAttempts = []
  let history = { ok: false, totalMs: null, messageCount: null, method: null, params: null }
  if (historyKey) {
    const started = performance.now()
    const methods = ['chat.history', 'sessions.history', 'session.history', 'sessions.get', 'session.get']
    const paramsList = [
      { name: 'sessionKey', value: { sessionKey: historyKey } },
      { name: 'key', value: { key: historyKey } },
      { name: 'session', value: { session: historyKey } },
    ]
    let stop = false
    for (const params of paramsList) {
      for (const method of methods) {
        const attemptStarted = performance.now()
        try {
          const payload = await gateway.call(method, params.value, 20_000)
          historyAttempts.push({ method, params: params.name, ok: true, ms: roundMs(performance.now() - attemptStarted) })
          history = {
            ok: true,
            totalMs: roundMs(performance.now() - started),
            messageCount: historyRows(payload).length,
            method,
            params: params.name,
          }
          stop = true
          break
        } catch (error) {
          const compatibility = isCompatibilityError(error)
          historyAttempts.push({
            method,
            params: params.name,
            ok: false,
            compatibility,
            ms: roundMs(performance.now() - attemptStarted),
          })
          if (!compatibility) {
            stop = true
            break
          }
        }
      }
      if (stop) break
    }
    if (!history.ok) history.totalMs = roundMs(performance.now() - started)
  }

  process.stdout.write('PERF_JSON=' + JSON.stringify({
    sessionCount: rows.length,
    sessionsListMs: list.ms,
    bffSessionEnhanceMs: enhanced.ms,
    sessionsListWithEnhanceMs: roundMs(list.ms + enhanced.ms),
    enhancedSessionCount: enhancedRows.length,
    defaultSessionVisible,
    externalOriginMismatches,
    originCounts,
    sessionsUsage: usage,
    chatHistory: history,
    chatHistoryAttempts: historyAttempts,
  }) + '\n')
} finally {
  db?.close()
  gateway.disconnect()
}
`

const rpcProbeBase64 = Buffer.from(rpcProbeSource, 'utf8').toString('base64')

const script = String.raw`set -euo pipefail
printf 'SERVICE_ACTIVE='; systemctl is-active gaiop-admin.service || true
for key in MemoryCurrent CPUUsageNSec NRestarts ExecMainStatus; do printf '%s=' "$key"; systemctl show gaiop-admin.service -p "$key" --value || true; done
printf 'LOAD='; awk '{print $1","$2","$3}' /proc/loadavg
printf 'MEMORY='; free -b | awk '/^Mem:/ {print $2","$3","$7}'
printf 'DISK='; df -P /var/lib/gaiop | awk 'NR==2 {print $5}'
health=$(mktemp)
trap 'rm -f -- "$health"' EXIT
health_code=$(curl -sS --max-time 15 -o "$health" -w '%{http_code}' http://127.0.0.1:3000/api/health || true)
printf 'HEALTH_CODE=%s\n' "$health_code"
printf 'HEALTH_GATEWAY='; node -e "const fs=require('fs');try {const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(x.gateway==='connected'?'connected':'not-connected')} catch {process.stdout.write('invalid')}" "$health"; echo
printf 'HEALTH_MS='; curl -sS --max-time 15 -o /dev/null -w '%{time_total}' http://127.0.0.1:3000/api/health || true; echo
printf 'BINDING='; ss -ltnH '( sport = :3000 )' | awk '{print $4}' | sort -u | tr '\n' ','; echo
work_dir=$(systemctl show gaiop-admin.service -p WorkingDirectory --value)
env_file=$(systemctl show gaiop-admin.service -p EnvironmentFiles --value | awk 'NF {print $1; exit}')
service_user=$(systemctl show gaiop-admin.service -p User --value)
service_group=$(systemctl show gaiop-admin.service -p Group --value)
node_path=$(command -v node || true)
printf 'WORK_DIR_PRESENT=%s\n' "$([ -n "$work_dir" ] && echo yes || echo no)"
printf 'ENV_FILE_PRESENT=%s\n' "$([ -n "$env_file" ] && echo yes || echo no)"
printf 'SERVICE_USER_PRESENT=%s\n' "$([ -n "$service_user" ] && echo yes || echo no)"
if [ -n "$work_dir" ] && [ -n "$service_user" ] && [ -n "$node_path" ]; then
  printf 'SESSION_PROBE_ATTEMPTED=yes\n'
  probe=$(mktemp "$work_dir/.gaiop-session-performance-XXXXXX.mjs")
  printf '%s' '${rpcProbeBase64}' | base64 -d > "$probe"
  chmod 600 "$probe"
  set +e
  if [ -n "$env_file" ]; then
    (cd "$work_dir" && "$node_path" --env-file="$env_file" "$probe")
  elif [ -f "$work_dir/.env" ]; then
    (cd "$work_dir" && "$node_path" --env-file="$work_dir/.env" "$probe")
  else
    false
  fi
  probe_exit=$?
  set -e
  printf 'SESSION_PROBE_EXIT=%s\n' "$probe_exit"
  rm -f -- "$probe"
fi
`

function execute(client) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '', errorOutput: '' })
    let output = ''
    let errorOutput = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', (chunk) => { errorOutput += chunk.toString('utf8') })
    stream.on('close', (code) => resolve({ ok: code === 0, output, errorOutput }))
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  }))
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const get = (key) => result.output.match(new RegExp(`^${key}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || 'unknown'
    const rpcJson = result.output.match(/^PERF_JSON=(.+)$/m)?.[1]
    let sessionPerformance = null
    try { sessionPerformance = rpcJson ? JSON.parse(rpcJson) : null } catch {}
    const diagnosticText = `${result.output}\n${result.errorOutput}`.toLowerCase()
    const diagnosticSample = `${result.output}\n${result.errorOutput}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        line &&
        !/^(SERVICE_ACTIVE|MemoryCurrent|CPUUsageNSec|NRestarts|ExecMainStatus|LOAD|MEMORY|DISK|HEALTH_CODE|HEALTH_GATEWAY|HEALTH_MS|BINDING|WORK_DIR_PRESENT|ENV_FILE_PRESENT|SERVICE_USER_PRESENT|SESSION_PROBE_ATTEMPTED|SESSION_PROBE_EXIT|PERF_JSON)=/i.test(line) &&
        !/token|password|secret|authorization|cookie|openclaw_auth/i.test(line)
      )
      .slice(-4)
      .join(' | ')
      .slice(0, 500)
    const sessionProbeStatus = sessionPerformance
      ? 'completed'
      : diagnosticText.includes('cannot find package') || diagnosticText.includes('err_module_not_found') || diagnosticText.includes('cannot find module')
        ? 'module-resolution-failed'
        : diagnosticText.includes('gateway probe connection timed out')
          ? 'gateway-connect-timeout'
          : diagnosticText.includes('connection closed')
            ? 'gateway-connection-closed'
            : diagnosticText.includes('syntaxerror')
              ? 'probe-syntax-error'
              : diagnosticText.includes('enoent')
                ? 'probe-path-missing'
                : diagnosticText.includes('database')
                  ? 'database-open-failed'
        : diagnosticText.includes('unknown option')
          ? 'node-option-unsupported'
          : diagnosticText.includes('permission denied')
            ? 'permission-denied'
            : diagnosticText.includes('failed to start transient')
              ? 'transient-unit-failed'
              : 'not-emitted'
    process.stdout.write(`${JSON.stringify({ completed: result.ok, service: get('SERVICE_ACTIVE'), memoryBytes: get('MemoryCurrent'), cpuUsageNs: get('CPUUsageNSec'), restarts: get('NRestarts'), processExit: get('ExecMainStatus'), load: get('LOAD'), memory: get('MEMORY'), disk: get('DISK'), healthCode: get('HEALTH_CODE'), gateway: get('HEALTH_GATEWAY'), healthSeconds: get('HEALTH_MS'), binding: get('BINDING'), workDirectoryPresent: get('WORK_DIR_PRESENT'), environmentFilePresent: get('ENV_FILE_PRESENT'), serviceUserPresent: get('SERVICE_USER_PRESENT'), sessionProbeAttempted: get('SESSION_PROBE_ATTEMPTED'), sessionProbeExit: get('SESSION_PROBE_EXIT'), sessionProbeStatus, diagnosticSample, sessionPerformance })}\n`)
    // Keep the diagnostic result machine-readable even when one remote probe
    // phase fails; callers inspect `completed` instead of losing the evidence.
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
