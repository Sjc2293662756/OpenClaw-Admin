'use strict'

const { Client } = require('ssh2')

const sessionKey = String(process.env.GAIOP_WEBCHAT_REPORT_SESSION_KEY || '').trim()
const connection = {
  host: String(process.env.GAIOP_WEBCHAT_REPORT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEBCHAT_REPORT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEBCHAT_REPORT_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^agent:main:main:dm:webchat-[a-f0-9]{32}$/.test(sessionKey)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled WebChat report inspection inputs are incomplete.')
}

const remoteInspection = String.raw`set -euo pipefail
session_key='${sessionKey}'
node_bin=$(command -v node)
plugin='/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js'
extension_plugin='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
loader='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs'
plugin_hash=$(sha256sum "$plugin" | awk '{print $1}')
extension_plugin_hash=$(sha256sum "$extension_plugin" | awk '{print $1}')
admin_server_hash=$(sha256sum /opt/gaiop/admin/server/index.js | awk '{print $1}')
admin_index_hash=$(sha256sum /opt/gaiop/admin/dist/index.html | awk '{print $1}')
admin_chat_asset=$(grep -E '^ChatWorkspace-[A-Za-z0-9_-]+\.js$' /opt/gaiop/admin/dist/.release-assets)
test "$(printf '%s\n' "$admin_chat_asset" | sed '/^$/d' | wc -l | tr -d '[:space:]')" = 1
admin_chat_asset_hash=$(sha256sum "/opt/gaiop/admin/dist/assets/$admin_chat_asset" | awk '{print $1}')
ownership_guard=$(grep -Fc 'if (!shouldOwnAutomaticReportReplyDispatch(messageCtx))' "$plugin" || true)
dispatch_anchor=$(grep -Fc 'const messageCtx = buildReplyDispatchMessageContext(event);' "$plugin" || true)
ownership_function=$(grep -Fc 'function shouldOwnAutomaticReportReplyDispatch' "$plugin" || true)
wecom_contract=$(grep -Fc "channelId || '').trim().toLowerCase() === 'wecom'" "$plugin" || true)
loader_reference=$(grep -Fc 'napm-openclaw-plugin.remote.js' "$loader" || true)
loader_workspace_reference=$(grep -Fc 'workspace/napm-openclaw-plugin.remote.js' "$loader" || true)
extension_ownership_guard=$(grep -Fc 'if (!shouldOwnAutomaticReportReplyDispatch(messageCtx))' "$extension_plugin" || true)
extension_dispatch_anchor=$(grep -Fc 'const messageCtx = buildReplyDispatchMessageContext(event);' "$extension_plugin" || true)
extension_ownership_function=$(grep -Fc 'function shouldOwnAutomaticReportReplyDispatch' "$extension_plugin" || true)
extension_wecom_contract=$(grep -Fc "channelId || '').trim().toLowerCase() === 'wecom'" "$extension_plugin" || true)
plugin_audit_evidence=$(GAIOP_TARGET_SESSION_KEY="$session_key" "$node_bin" - /home/netinside/.openclaw/logs/audit.log <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const target = process.env.GAIOP_TARGET_SESSION_KEY
const file = process.argv[2]
const targetToken = target.slice(target.lastIndexOf('webchat-'))
const allEntries = fs.readFileSync(file, 'utf8').split(/\r?\n/u).flatMap((line) => {
  if (!line) return []
  let value
  try { value = JSON.parse(line) } catch { return [] }
  return [value]
})
const events = allEntries.flatMap((value) => {
  if (String(value.event || '') !== 'napm_automatic_inspection_completed') return []
  if (!String(value.timestamp || '').startsWith('2026-09-02')) return []
  const conversationKey = String(value.conversationKey || '')
  return [{
    timestamp: String(value.timestamp || ''),
    turnId: String(value.turnId || ''),
    reportId: String(value.reportId || ''),
    runId: String(value.runId || ''),
    format: String(value.format || ''),
    conversationKeyRelation: conversationKey === target
      ? 'exact'
      : conversationKey.includes(targetToken) ? 'contains-webchat-token' : 'other',
    conversationKeySha256: crypto.createHash('sha256').update(conversationKey).digest('hex'),
  }]
})
const targetTurns = new Set(allEntries
  .filter((value) => String(value.event || '') === 'napm_automatic_inspection_completed')
  .filter((value) => String(value.conversationKey || '').includes(targetToken))
  .map((value) => String(value.turnId || ''))
  .filter(Boolean))
const targetTurnEvidence = allEntries
  .filter((value) => targetTurns.has(String(value.turnId || '')))
  .map((value) => ({
    timestamp: String(value.timestamp || ''),
    event: String(value.event || ''),
    turnId: String(value.turnId || ''),
    conversationKey: String(value.conversationKey || ''),
    reportId: String(value.reportId || ''),
    runId: String(value.runId || ''),
    messageId: String(value.messageId || ''),
    sourceMessageId: String(value.sourceMessageId || ''),
    sourceMessagePreview: String(value.sourceMessagePreview || '').replace(/\s+/gu, ' ').trim().slice(0, 300),
    promptPreview: String(value.prompt || value.userPrompt || '').replace(/\s+/gu, ' ').trim().slice(0, 300),
    keys: Object.keys(value).sort(),
  }))
process.stdout.write(JSON.stringify({ completedEventCount: events.length, events: events.slice(-20), targetTurnEvidence }))
NODE
)
transcript_evidence=$(GAIOP_TARGET_SESSION_KEY="$session_key" "$node_bin" - /home/netinside/.openclaw/agents/main/sessions <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const target = process.env.GAIOP_TARGET_SESSION_KEY
const root = path.resolve(process.argv[2])
const index = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'))
const record = index[target] || null
let events = []
if (record?.sessionFile) {
  const file = path.resolve(String(record.sessionFile))
  const stat = fs.lstatSync(file)
  if (!file.startsWith(root + path.sep) || !stat.isFile() || stat.isSymbolicLink()) process.exit(2)
  events = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    let value
    try { value = JSON.parse(line) } catch { return [] }
    const message = value?.message && typeof value.message === 'object' ? value.message : {}
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join(' ')
    return [{
      id: String(value.id || message.id || ''),
      parentId: String(value.parentId || message.parentId || ''),
      runId: String(value.runId || message.runId || value.metadata?.runId || message.metadata?.runId || ''),
      role: String(message.role || value.role || ''),
      timestamp: value.timestamp || message.timestamp || null,
      topKeys: Object.keys(value).sort(),
      messageKeys: Object.keys(message).sort(),
      contentTypes: [...new Set(content.map((item) => String(item?.type || '')).filter(Boolean))],
      textSha256: text ? crypto.createHash('sha256').update(text).digest('hex') : '',
    }]
  })
}
process.stdout.write(JSON.stringify({ indexed: Boolean(record), events }))
NODE
)
runtime_state=$("$node_bin" <<'NODE'
const cp = require('node:child_process')
function command(file, args) {
  try { return cp.execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch (error) { return String(error?.stdout || '').trim() }
}
function unit(name) {
  return { active: command('systemctl', ['is-active', name]) || 'unknown', enabled: command('systemctl', ['is-enabled', name]) || 'unknown' }
}
function http(url, extra = []) {
  return command('curl', ['-ksS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', ...extra, url]) || '000'
}
const uid = command('id', ['-u', 'netinside'])
const gateway = command('sudo', ['-u', 'netinside', 'env', 'XDG_RUNTIME_DIR=/run/user/' + uid, 'systemctl', '--user', 'is-active', 'openclaw-gateway.service']) || 'unknown'
const timers = {}
for (const name of [
  'gaiop-admin-retention-cleanup.timer', 'gaiop-report-retention-cleanup.timer',
  'gaiop-storage-watermark-monitor.timer', 'gaiop-upgrade-retention-cleanup.timer',
  'gaiop-admin-sqlite-backup.timer', 'gaiop-upgrade-sqlite-backup.timer',
  'gaiop-admin-session-retention.timer',
]) timers[name] = unit(name)
process.stdout.write(JSON.stringify({
  services: { gateway, admin: unit('gaiop-admin.service'), upgrade: unit('gaiop-upgrade.service'), caddy: unit('caddy.service') },
  adminListener: {
    loopback3000: /127\.0\.0\.1:3000\b/u.test(command('ss', ['-lntH', 'sport = :3000'])),
    wildcard3000: /(?:0\.0\.0\.0|\[::\]|\*):3000\b/u.test(command('ss', ['-lntH', 'sport = :3000'])),
  },
  health: {
    admin: http('http://127.0.0.1:3000/api/health'),
    upgrade: http('http://127.0.0.1:18900/health'),
    upgradeUnauthenticated: http('http://127.0.0.1:18900/api/v1/upgrade/status'),
    https: http('https://127.0.0.1/', ['-H', 'Host: 101.254.114.237']),
  },
  timers,
}))
NODE
)
sudo -u gaiop env GAIOP_TARGET_SESSION_KEY="$session_key" GAIOP_PLUGIN_AUDIT_EVIDENCE="$plugin_audit_evidence" GAIOP_TRANSCRIPT_EVIDENCE="$transcript_evidence" GAIOP_RUNTIME_STATE="$runtime_state" GAIOP_ADMIN_SERVER_HASH="$admin_server_hash" GAIOP_ADMIN_INDEX_HASH="$admin_index_hash" GAIOP_ADMIN_CHAT_ASSET="$admin_chat_asset" GAIOP_ADMIN_CHAT_ASSET_HASH="$admin_chat_asset_hash" GAIOP_RUNTIME_PLUGIN_HASH="$plugin_hash" GAIOP_RUNTIME_OWNERSHIP_GUARD="$ownership_guard" GAIOP_RUNTIME_DISPATCH_ANCHOR="$dispatch_anchor" GAIOP_RUNTIME_OWNERSHIP_FUNCTION="$ownership_function" GAIOP_RUNTIME_WECOM_CONTRACT="$wecom_contract" GAIOP_RUNTIME_LOADER_REFERENCE="$loader_reference" GAIOP_RUNTIME_LOADER_WORKSPACE_REFERENCE="$loader_workspace_reference" GAIOP_RUNTIME_EXTENSION_PLUGIN_HASH="$extension_plugin_hash" GAIOP_RUNTIME_EXTENSION_OWNERSHIP_GUARD="$extension_ownership_guard" GAIOP_RUNTIME_EXTENSION_DISPATCH_ANCHOR="$extension_dispatch_anchor" GAIOP_RUNTIME_EXTENSION_OWNERSHIP_FUNCTION="$extension_ownership_function" GAIOP_RUNTIME_EXTENSION_WECOM_CONTRACT="$extension_wecom_contract" "$node_bin" --env-file=/etc/gaiop/admin.env --input-type=module - <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import Database from '/opt/gaiop/admin/node_modules/better-sqlite3/lib/index.js'
import { OpenClawGateway } from '/opt/gaiop/admin/server/gateway.js'
import { __test__ as reportRouteTests } from '/opt/gaiop/admin/server/routes/reports.js'

const target = process.env.GAIOP_TARGET_SESSION_KEY
const dataDir = String(process.env.GAIOP_ADMIN_DATA_DIR || '/var/lib/gaiop/admin')
const reportRoot = String(process.env.GAIOP_REPORTS_DIR || '/var/lib/gaiop/reports')
const pluginAuditEvidence = JSON.parse(String(process.env.GAIOP_PLUGIN_AUDIT_EVIDENCE || '{}'))
const transcriptEvidence = JSON.parse(String(process.env.GAIOP_TRANSCRIPT_EVIDENCE || '{}'))
const runtimeState = JSON.parse(String(process.env.GAIOP_RUNTIME_STATE || '{}'))
const db = new Database(path.join(dataDir, 'wizard.db'), { readonly: true, fileMustExist: true })

function short(value, limit = 160) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim()
  return Array.from(normalized).slice(0, limit).join('')
}
function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function rows(payload) {
  if (Array.isArray(payload)) return payload
  const value = record(payload)
  for (const key of ['messages', 'items', 'data', 'results']) {
    if (Array.isArray(value[key])) return value[key]
  }
  return []
}
function contentSummary(value, limit = 160) {
  if (typeof value === 'string') return { text: short(value, limit), itemTypes: [], toolNames: [] }
  const items = Array.isArray(value) ? value : []
  const texts = []
  const itemTypes = []
  const toolNames = []
  for (const item of items) {
    if (typeof item === 'string') { texts.push(item); continue }
    const row = record(item)
    const type = String(row.type || '').trim()
    if (type) itemTypes.push(type)
    const name = String(row.name || row.toolName || '').trim()
    if (name) toolNames.push(name)
    if (typeof row.text === 'string') texts.push(row.text)
    else if (typeof row.content === 'string') texts.push(row.content)
  }
  return {
    text: short(texts.join(' '), limit),
    itemTypes: [...new Set(itemTypes)],
    toolNames: [...new Set(toolNames)],
  }
}
function safePath(name) {
  const value = String(name || '').trim().replace(/\\/gu, '/')
  if (!value || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) return null
  const resolved = path.resolve(reportRoot, ...value.split('/'))
  return resolved.startsWith(path.resolve(reportRoot) + path.sep) ? resolved : null
}
function regularFile(file) {
  if (!file) return { exists: false, regular: false, size: null }
  try {
    const stat = fs.lstatSync(file)
    return { exists: true, regular: stat.isFile() && !stat.isSymbolicLink(), size: stat.size }
  } catch {
    return { exists: false, regular: false, size: null }
  }
}
function walk(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name)
      return entry.isDirectory() ? walk(file) : [file]
    })
  } catch {
    return []
  }
}

const workspace = db.prepare(
  'SELECT ws.session_key, ws.owner_user_id, ws.status, ws.created_at, ws.updated_at, ' +
  'u.username, u.role, u.status AS user_status ' +
  'FROM workspace_sessions ws ' +
  'LEFT JOIN users u ON u.id = ws.owner_user_id ' +
  'WHERE ws.session_key = ?'
).get(target) || null
const reportColumns = new Set(db.prepare('PRAGMA table_info(report_files)').all().map((row) => row.name))
const reportRows = reportColumns.has('source_session_id')
  ? db.prepare('SELECT * FROM report_files WHERE source_session_id = ? ORDER BY created_at ASC').all(target)
  : []
const recentReportRows = db.prepare('SELECT * FROM report_files ORDER BY created_at DESC LIMIT 3').all()

const reports = reportRows.map((row) => {
  const stored = regularFile(safePath(row.stored_name))
  const audit = regularFile(safePath(row.audit_name))
  let auditRelation = null
  const auditPath = safePath(row.audit_name)
  if (audit.regular && auditPath) {
    try {
      const value = JSON.parse(fs.readFileSync(auditPath, 'utf8'))
      auditRelation = {
        sourceSessionMatches: String(value.sourceSessionId || '') === target,
        sourceUserMatches: String(value.sourceUserId || '') === String(row.source_user_id || ''),
        sourceMessageIdMatches: !row.source_message_id || String(value.sourceMessageId || '') === String(row.source_message_id),
      }
    } catch {
      auditRelation = { parseable: false }
    }
  }
  return {
    id: row.id,
    status: row.status,
    sourceUserId: row.source_user_id,
    sourceSessionId: row.source_session_id,
    sourceMessageId: row.source_message_id || null,
    sourceMessagePreview: short(row.source_message_preview, 120),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    registeredSize: Number(row.file_size ?? row.size_bytes ?? row.size ?? 0) || null,
    reportFile: stored,
    auditFile: audit,
    auditRelation,
  }
})
const recentReports = recentReportRows.map((row) => ({
  id: row.id,
  status: row.status,
  sourceUserId: row.source_user_id || null,
  sourceSessionId: row.source_session_id || null,
  sourceMessageId: row.source_message_id || null,
  sourceMessagePreview: short(row.source_message_preview, 120),
  createdAt: row.created_at,
  reportFile: regularFile(safePath(row.stored_name)),
  auditFile: regularFile(safePath(row.audit_name)),
}))
const exactAuditMatches = walk(reportRoot).filter((file) => file.endsWith('.json')).flatMap((file) => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (String(value.sourceSessionId || '') !== target) return []
    return [{
      reportId: String(value.reportId || ''),
      sourceUserId: String(value.sourceUserId || ''),
      sourceMessageId: String(value.sourceMessageId || '') || null,
      sourceMessagePreview: short(value.sourceMessagePreview, 120),
      generatedAt: String(value.generatedAt || ''),
      auditRegular: regularFile(file).regular,
    }]
  } catch {
    return []
  }
})
const accessContract = reportRows.length === 1 ? {
  ownerBasicVisible: reportRouteTests.canReadReport({ id: reportRows[0].source_user_id, role: 'basic' }, reportRows[0]),
  ownerStandardVisible: reportRouteTests.canReadReport({ id: reportRows[0].source_user_id, role: 'standard' }, reportRows[0]),
  nonOwnerBasicHidden: !reportRouteTests.canReadReport({ id: 'production-non-owner-probe', role: 'basic' }, reportRows[0]),
} : null
const businessCounts = Object.fromEntries(['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']
  .map((table) => [table, Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count)]))
const formalFiles = walk(reportRoot)
const auditFiles = formalFiles.filter((file) => file.endsWith('.json'))
const registeredPairs = db.prepare('SELECT stored_name, audit_name FROM report_files').all().filter((row) =>
  regularFile(safePath(row.stored_name)).regular && regularFile(safePath(row.audit_name)).regular)
const formalStorage = {
  totalFiles: formalFiles.length,
  reportFiles: formalFiles.filter((file) => !file.endsWith('.json')).length,
  auditFiles: auditFiles.length,
  registeredPairs: registeredPairs.length,
}

const gateway = new OpenClawGateway(
  process.env.OPENCLAW_WS_URL,
  process.env.OPENCLAW_AUTH_TOKEN,
  process.env.OPENCLAW_AUTH_PASSWORD,
  process.env.LOG_LEVEL || 'INFO',
)
const connected = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('gateway-timeout')), 20_000)
  gateway.once('connected', () => { clearTimeout(timer); resolve() })
  gateway.once('error', () => { clearTimeout(timer); reject(new Error('gateway-connect-failed')) })
})

let history = { ok: false, messages: [] }
try {
  gateway.connect()
  await connected
  const payload = await gateway.call('chat.history', { sessionKey: target }, 30_000)
  history = {
    ok: true,
    messages: rows(payload).map((item, index) => {
      const row = record(item)
      const message = record(row.message)
      const content = message.content ?? row.content ?? message.text ?? row.text
      const summary = contentSummary(content)
      const completionSummary = contentSummary(content, 1000)
      const metadata = record(message.metadata ?? row.metadata)
      const openclaw = record(message.__openclaw ?? row.__openclaw ?? metadata.__openclaw)
      const role = String(message.role || row.role || message.sender || row.sender || '').trim().toLowerCase()
      return {
        index,
        id: String(message.id || row.id || row.messageId || '').trim() || null,
        role,
        timestamp: row.timestamp || message.timestamp || row.createdAt || null,
        eventType: String(row.type || message.type || '').trim() || null,
        runId: String(message.runId || row.runId || metadata.runId || openclaw.runId || '').trim() || null,
        openclawId: String(openclaw.id || '').trim() || null,
        openclawSeq: openclaw.seq ?? null,
        itemTypes: summary.itemTypes,
        toolNames: summary.toolNames,
        preview: summary.text,
        completionPreview: completionSummary.text,
        reportCompletion: role === 'assistant' && /报告已生成|完整报告将以附件形式发送|格式[:：]\s*docx/iu.test(summary.text),
      }
    }),
  }
} catch {
  history = { ok: false, messages: [] }
} finally {
  gateway.disconnect()
  db.close()
}

process.stdout.write(JSON.stringify({
  sessionKey: target,
  adminRuntime: {
    serverHash: String(process.env.GAIOP_ADMIN_SERVER_HASH || ''),
    indexHash: String(process.env.GAIOP_ADMIN_INDEX_HASH || ''),
    chatAsset: String(process.env.GAIOP_ADMIN_CHAT_ASSET || ''),
    chatAssetHash: String(process.env.GAIOP_ADMIN_CHAT_ASSET_HASH || ''),
  },
  runtimeState,
  businessCounts,
  formalStorage,
  runtimePlugin: {
    hash: String(process.env.GAIOP_RUNTIME_PLUGIN_HASH || ''),
    ownershipGuardCount: Number(process.env.GAIOP_RUNTIME_OWNERSHIP_GUARD || 0),
    dispatchAnchorCount: Number(process.env.GAIOP_RUNTIME_DISPATCH_ANCHOR || 0),
    ownershipFunctionCount: Number(process.env.GAIOP_RUNTIME_OWNERSHIP_FUNCTION || 0),
    wecomContractCount: Number(process.env.GAIOP_RUNTIME_WECOM_CONTRACT || 0),
    loaderReferenceCount: Number(process.env.GAIOP_RUNTIME_LOADER_REFERENCE || 0),
    loaderWorkspaceReferenceCount: Number(process.env.GAIOP_RUNTIME_LOADER_WORKSPACE_REFERENCE || 0),
  },
  runtimeExtensionPlugin: {
    hash: String(process.env.GAIOP_RUNTIME_EXTENSION_PLUGIN_HASH || ''),
    ownershipGuardCount: Number(process.env.GAIOP_RUNTIME_EXTENSION_OWNERSHIP_GUARD || 0),
    dispatchAnchorCount: Number(process.env.GAIOP_RUNTIME_EXTENSION_DISPATCH_ANCHOR || 0),
    ownershipFunctionCount: Number(process.env.GAIOP_RUNTIME_EXTENSION_OWNERSHIP_FUNCTION || 0),
    wecomContractCount: Number(process.env.GAIOP_RUNTIME_EXTENSION_WECOM_CONTRACT || 0),
  },
  pluginAuditEvidence,
  transcriptEvidence,
  workspace,
  reports,
  accessContract,
  recentReports,
  exactAuditMatches,
  history,
}))
NODE
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`remote exit ${code}`)))
      stream.write(`${connection.password}\n${remoteInspection}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"ok":false,"errorCode":"TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 90_000)

client.on('ready', async () => {
  try {
    const inspection = await execute(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ ok: true, inspection })}\n`)
    client.end()
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"ok":false,"errorCode":"REMOTE_INSPECTION_FAILED"}\n')
    client.end()
    process.exitCode = 1
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"ok":false,"errorCode":"CONNECTION_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
