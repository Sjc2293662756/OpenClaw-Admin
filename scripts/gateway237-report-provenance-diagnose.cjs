'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_DIAG_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DIAG_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DIAG_SSH_PASSWORD || ''),
  readyTimeout: 15_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report provenance diagnostic context is incomplete.')
}

const diagnostic = String.raw`set -eu
node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const netinsideUid = cp.execFileSync('id', ['-u', 'netinside'], { encoding: 'utf8' }).trim()

const reportRoot = '/var/lib/gaiop/reports'
const storeRoot = '/var/lib/gaiop/runtime/report-provenance'
const targetStamp = '20260724_151123'
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}
function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
function treeSha256(directory) {
  const hash = crypto.createHash('sha256')
  walk(directory)
    .map((file) => ({
      file,
      relative: path.relative(directory, file).split(path.sep).join('/'),
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative, 'en'))
    .forEach(({ file, relative }) => {
      hash.update(relative)
      hash.update('\0')
      hash.update(fileSha256(file))
      hash.update('\n')
    })
  return hash.digest('hex')
}
const deployedArtifacts = {
  loadedGatewayPluginEntry: {
    path: '/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs',
    sha256: fileSha256('/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs'),
  },
  gatewayPlugin: {
    path: '/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js',
    sha256: fileSha256('/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js'),
  },
  reportInputContract: {
    path: '/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportInputContractService.js',
    sha256: fileSha256('/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportInputContractService.js'),
  },
  adminIndex: {
    path: '/opt/gaiop/admin/server/index.js',
    sha256: fileSha256('/opt/gaiop/admin/server/index.js'),
  },
  adminProvenanceService: {
    path: '/opt/gaiop/admin/server/report-provenance-service.js',
    sha256: fileSha256('/opt/gaiop/admin/server/report-provenance-service.js'),
  },
  adminDist: {
    path: '/opt/gaiop/admin/dist',
    sha256: treeSha256('/opt/gaiop/admin/dist'),
    fileCount: walk('/opt/gaiop/admin/dist').length,
  },
}
const loadedGatewayPluginSource = fs.readFileSync(
  '/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs',
  'utf8'
)
const loadedGatewayPluginFiles = fs.readdirSync('/home/netinside/.openclaw/extensions/napm-openclaw-plugin')
  .filter((name) => /\.(?:c?js|mjs)$/.test(name))
  .map((name) => {
    const file = path.join('/home/netinside/.openclaw/extensions/napm-openclaw-plugin', name)
    return { name, sha256: fileSha256(file), byteLength: fs.statSync(file).size }
  })
  .sort((left, right) => left.name.localeCompare(right.name, 'en'))
const loadedGatewayPluginEntry = {
  byteLength: Buffer.byteLength(loadedGatewayPluginSource),
  sourceExcerpt: loadedGatewayPluginSource.slice(0, 1200),
  importsWorkspacePlugin: loadedGatewayPluginSource.includes('napm-openclaw-plugin.remote.js'),
  reportToolOccurrences: (loadedGatewayPluginSource.match(/napm-report-export/g) || []).length,
  importSpecifiers: Array.from(loadedGatewayPluginSource.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g))
    .map((match) => match[2])
    .filter((value) => value.startsWith('.') || value.startsWith('/'))
    .slice(0, 30),
}
const targetPath = walk(reportRoot)
  .find((file) => path.basename(file).includes(targetStamp) && file.endsWith('.json'))
const audit = targetPath ? JSON.parse(fs.readFileSync(targetPath, 'utf8')) : null
const liveVerifierAudits = walk(reportRoot)
  .filter((file) => file.endsWith('.json'))
  .flatMap((file) => {
    let value
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
    if (value?.sourceUserId !== 'system-release-verifier') return []
    return [{
      relativeAuditPath: path.relative(reportRoot, file).split(path.sep).join('/'),
      relativeFilePath: String(value.relativeFilePath || ''),
      generatedAt: String(value.generatedAt || ''),
      sourceChannelRecorded: Boolean(value.sourceChannel),
      sourceUserRecorded: Boolean(value.sourceUserId),
      sourceSessionRecorded: Boolean(value.sourceSessionId),
      dataSourceRecorded: Boolean(value.dataSourceId),
    }]
  })
  .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
const recentReportAudits = walk(reportRoot)
  .filter((file) => file.endsWith('.json'))
  .flatMap((file) => {
    let value
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
    if (Date.parse(String(value?.generatedAt || '')) < Date.parse('2026-07-24T07:20:00Z')) return []
    return [{
      relativeAuditPath: path.relative(reportRoot, file).split(path.sep).join('/'),
      relativeFilePath: String(value.relativeFilePath || ''),
      generatedAt: String(value.generatedAt || ''),
      sourceChannel: String(value.sourceChannel || ''),
      sourceUserId: String(value.sourceUserId || ''),
      sourceSessionId: String(value.sourceSessionId || ''),
      dataSourceId: String(value.dataSourceId || ''),
    }]
  })
  .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
const snapshots = fs.existsSync(storeRoot)
  ? fs.readdirSync(storeRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(storeRoot, name)
        const stat = fs.statSync(file)
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))
        return {
          fileHash: name.slice(0, -5),
          sessionId: String(value.sessionId || ''),
          issuedAt: Number(value.issuedAt || 0),
          modifiedAt: stat.mtime.toISOString(),
          sourceChannel: String(value.sourceChannel || ''),
          hasUserId: Boolean(value.userId),
          hasDataSourceId: Boolean(value.dataSourceId),
        }
      })
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .slice(0, 12)
  : []

let gatewayLines = []
try {
  const output = cp.execFileSync('sudo', [
    '-u', 'netinside', 'env', 'XDG_RUNTIME_DIR=/run/user/' + netinsideUid,
    'journalctl',
    '--user-unit=openclaw-gateway.service',
    '--since=2026-07-24 07:08:00',
    '--until=2026-07-24 07:14:30',
    '--no-pager',
    '-o', 'cat',
  ], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  gatewayLines = output.split(/\r?\n/)
    .filter((line) => /before_tool_call|napm-report-export|report provenance|provenance/i.test(line))
    .slice(-80)
} catch {}

let pluginRuntime = { inspected: false }
try {
  const openclawBin = '/home/netinside/.npm-global/bin/openclaw'
  const raw = cp.execFileSync('sudo', [
    '-u', 'netinside', 'env', 'XDG_RUNTIME_DIR=/run/user/' + netinsideUid,
    openclawBin, 'plugins', 'info', 'napm-openclaw-plugin'
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  pluginRuntime = {
    inspected: true,
    status: /\bloaded\b/i.test(raw) ? 'loaded' : /\benabled\b/i.test(raw) ? 'enabled' : 'reported',
    reportToolRegistered: /napm-report-export/.test(raw),
    safeInfoLines: raw.split(/\r?\n/)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
      .filter((line) => /^(Status|State|Tools|ID|Name|Path|Source|Entry|Location|Root|Version)\b/i.test(line) || /napm-report-export/.test(line))
      .slice(0, 40),
  }
} catch {}

let agentCli = { inspected: false }
try {
  const openclawBin = '/home/netinside/.npm-global/bin/openclaw'
  const raw = cp.execFileSync('sudo', [
    '-u', 'netinside', 'env', 'XDG_RUNTIME_DIR=/run/user/' + netinsideUid,
    openclawBin, 'agent', '--help'
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  agentCli = {
    inspected: true,
    safeLines: raw.split(/\r?\n/)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
      .filter((line) => /--(message|session|json|timeout|agent|local)\b/.test(line))
      .slice(0, 30),
  }
} catch {}

let liveGatewayVerification = { inspected: false }
try {
  const pidText = cp.execFileSync('sudo', [
    '-u', 'netinside', 'env', 'XDG_RUNTIME_DIR=/run/user/' + netinsideUid,
    'systemctl', '--user', 'show', 'openclaw-gateway.service', '--property=MainPID', '--value'
  ], {
    encoding: 'utf8',
  }).trim()
  const environment = fs.readFileSync('/proc/' + pidText + '/environ')
    .toString('utf8')
    .split('\0')
    .reduce((result, row) => {
      const separator = row.indexOf('=')
      if (separator > 0) result[row.slice(0, separator)] = row.slice(separator + 1)
      return result
    }, {})
  const signingKey = String(environment.GAIOP_REPORT_PROVENANCE_SIGNING_KEY || '')
  const adminPid = cp.execFileSync('systemctl', [
    'show', 'gaiop-admin.service', '--property=MainPID', '--value'
  ], { encoding: 'utf8' }).trim()
  const adminEnvironment = fs.readFileSync('/proc/' + adminPid + '/environ')
    .toString('utf8')
    .split('\0')
    .reduce((result, row) => {
      const separator = row.indexOf('=')
      if (separator > 0) result[row.slice(0, separator)] = row.slice(separator + 1)
      return result
    }, {})
  const adminSigningKey = String(adminEnvironment.GAIOP_REPORT_PROVENANCE_SIGNING_KEY || '')
  function readDropInKey(file) {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .find((row) => row.startsWith('Environment=GAIOP_REPORT_PROVENANCE_SIGNING_KEY='))
    return line ? line.slice('Environment=GAIOP_REPORT_PROVENANCE_SIGNING_KEY='.length).trim() : ''
  }
  function readEnvFileKey(file) {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .find((row) => row.startsWith('GAIOP_REPORT_PROVENANCE_SIGNING_KEY='))
    return line ? line.slice('GAIOP_REPORT_PROVENANCE_SIGNING_KEY='.length).trim() : ''
  }
  const adminConfigKey = readEnvFileKey('/etc/gaiop/admin-report-provenance.env')
  const gatewayDropInKey = readDropInKey('/home/netinside/.config/systemd/user/openclaw-gateway.service.d/91-gaiop-report-provenance.conf')
  const plugin = require('/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js')
  const latestSessionId = snapshots[0]?.sessionId || ''
  const previousKey = process.env.GAIOP_REPORT_PROVENANCE_SIGNING_KEY
  const previousStore = process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR
  process.env.GAIOP_REPORT_PROVENANCE_SIGNING_KEY = signingKey
  process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR = storeRoot
  const verified = latestSessionId ? plugin.__test__.readStoredReportProvenance({ sessionKey: latestSessionId }) : null
  if (previousKey === undefined) delete process.env.GAIOP_REPORT_PROVENANCE_SIGNING_KEY
  else process.env.GAIOP_REPORT_PROVENANCE_SIGNING_KEY = previousKey
  if (previousStore === undefined) delete process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR
  else process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR = previousStore
  liveGatewayVerification = {
    inspected: true,
    gatewayPidPresent: Number(pidText) > 0,
    signingKeyPresent: signingKey.length >= 32,
    adminSigningKeyPresent: adminSigningKey.length >= 32,
    signingKeysMatch: signingKey.length >= 32 && signingKey === adminSigningKey,
    configuredKeysMatch: adminConfigKey.length >= 32 && adminConfigKey === gatewayDropInKey,
    adminProcessMatchesConfig: adminSigningKey.length >= 32 && adminSigningKey === adminConfigKey,
    gatewayProcessMatchesDropIn: signingKey.length >= 32 && signingKey === gatewayDropInKey,
    latestSnapshotVerified: Boolean(verified),
    verifiedSourceChannel: String(verified?.sourceChannel || ''),
    verifiedHasUser: Boolean(verified?.sourceUserId),
    verifiedHasSession: Boolean(verified?.sourceSessionId),
    verifiedHasDataSource: Boolean(verified?.dataSourceId),
  }
} catch {}

let openclawRuntimeSource = { inspected: false }
try {
  const distRoot = '/home/netinside/.npm-global/lib/node_modules/openclaw/dist'
  const distFiles = walk(distRoot).filter((file) => file.endsWith('.js'))
  const matches = distFiles
    .filter((file) => file.endsWith('.js'))
    .flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8')
      const index = source.indexOf('resolvePluginTools')
      if (index < 0) return []
      return [{
        file: path.basename(file),
        excerpt: source.slice(Math.max(0, index - 300), index + 1800)
          .replace(/\s+/g, ' ')
          .slice(0, 2100),
      }]
    })
    .slice(0, 4)
  const toolRegistryFile = distFiles.find((file) => {
    if (!/^tools-[^/\\]+\.js$/.test(path.basename(file))) return false
    const source = fs.readFileSync(file, 'utf8')
    return source.includes('function resolvePluginTools') || source.includes('toolFactories')
  })
  const registrySource = toolRegistryFile ? fs.readFileSync(toolRegistryFile, 'utf8') : ''
  const registryPatterns = [
    'function resolvePluginTools',
    'function resolvePluginToolFactoryEntry',
    'resolved = params.entry.factory(params.ctx)',
    'toolFactories',
    'factory(ctx)',
    'factory(context)',
  ]
  const registryExcerpts = registryPatterns.flatMap((pattern) => {
    const index = registrySource.indexOf(pattern)
    if (index < 0) return []
    return [{
      pattern,
      excerpt: registrySource.slice(Math.max(0, index - 350), index + 2100)
        .replace(/\s+/g, ' ')
        .slice(0, 2400),
    }]
  })
  const factoryExcerpts = Array.from(registrySource.matchAll(/.{0,180}factory.{0,520}/gi))
    .slice(0, 12)
    .map((match) => match[0].replace(/\s+/g, ' ').slice(0, 700))
  const resolveCallExcerpts = distFiles.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8')
    const excerpts = []
    let cursor = 0
    while (excerpts.length < 4) {
      const index = source.indexOf('resolvePluginTools({', cursor)
      if (index < 0) break
      excerpts.push({
        file: path.basename(file),
        excerpt: source.slice(Math.max(0, index - 250), index + 1800)
          .replace(/\s+/g, ' ')
          .slice(0, 2000),
      })
      cursor = index + 1
    }
    return excerpts
  }).slice(0, 16)
  const inputResolverExcerpts = distFiles.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8')
    const index = source.indexOf('function resolveOpenClawPluginToolInputs')
    if (index < 0) return []
    return [{
      file: path.basename(file),
      excerpt: source.slice(index, index + 2600).replace(/\s+/g, ' ').slice(0, 2500),
    }]
  }).slice(0, 6)
  openclawRuntimeSource = {
    inspected: true,
    matches,
    registryFile: path.basename(toolRegistryFile || ''),
    registryExcerpts,
    factoryExcerpts,
    resolveCallExcerpts,
    inputResolverExcerpts,
  }
} catch {}

let liveSessionStructure = { inspected: false }
try {
  const sessionsRoot = '/home/netinside/.openclaw/agents/main/sessions'
  const sessionIndexPath = path.join(sessionsRoot, 'sessions.json')
  const sessionIndex = JSON.parse(fs.readFileSync(sessionIndexPath, 'utf8'))
  const snapshotSessionIds = new Set(snapshots.map((entry) => entry.sessionId))
  const matchingIndexEntries = Object.entries(sessionIndex)
    .filter(([key]) => snapshotSessionIds.has(key))
    .map(([key, value]) => ({
      sessionKey: key,
      sessionId: String(value?.sessionId || ''),
      sessionFile: String(value?.sessionFile || ''),
      updatedAt: value?.updatedAt || null,
      channel: String(value?.channel || value?.lastChannel || ''),
      safeKeys: value && typeof value === 'object' ? Object.keys(value).sort() : [],
    }))
  const verifierSessionKeys = fs.readdirSync(storeRoot)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      let value
      try { value = JSON.parse(fs.readFileSync(path.join(storeRoot, name), 'utf8')) } catch { return [] }
      return value?.userId === 'system-release-verifier' ? [String(value.sessionId || '')] : []
    })
    .filter(Boolean)
  const verifierSessions = verifierSessionKeys.flatMap((sessionKey) => {
    const record = sessionIndex[sessionKey]
    if (!record?.sessionFile || !fs.existsSync(record.sessionFile)) {
      return [{ sessionKey, indexed: Boolean(record), transcriptPresent: false, events: [] }]
    }
    const events = fs.readFileSync(record.sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((row) => {
      let value
      try { value = JSON.parse(row) } catch { return [] }
      const message = value?.message && typeof value.message === 'object' ? value.message : {}
      const content = Array.isArray(message.content) ? message.content : []
      const toolNames = content
        .filter((item) => item && typeof item === 'object')
        .map((item) => String(item.name || item.toolName || ''))
        .filter(Boolean)
      return [{
        timestamp: String(value.timestamp || message.timestamp || ''),
        role: String(message.role || ''),
        stopReason: String(message.stopReason || ''),
        toolName: String(message.toolName || ''),
        toolNames,
        isError: Boolean(message.isError),
      }]
    })
    return [{
      sessionKey,
      indexed: true,
      transcriptPresent: true,
      transcriptModifiedAt: fs.statSync(record.sessionFile).mtime.toISOString(),
      status: String(record.status || ''),
      events: events.slice(-20),
    }]
  })
  const from = Date.parse('2026-07-24T07:08:00Z')
  const until = Date.parse('2026-07-24T07:14:30Z')
  const recentJsonl = walk(sessionsRoot)
    .filter((file) => file.endsWith('.jsonl'))
    .filter((file) => {
      const modifiedAt = fs.statSync(file).mtimeMs
      return modifiedAt >= from && modifiedAt <= until
    })
  const toolEvents = recentJsonl.flatMap((file) => {
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    return rows.flatMap((row, rowIndex) => {
      if (!row.includes('napm-report-export')) return []
      let value
      try { value = JSON.parse(row) } catch { return [] }
      const message = value?.message && typeof value.message === 'object' ? value.message : {}
      const content = Array.isArray(message.content) ? message.content : []
      const matchingContent = content.filter((item) => (
        item && typeof item === 'object'
        && (item.name === 'napm-report-export' || item.toolName === 'napm-report-export')
      ))
      return [{
        file: path.basename(file),
        row: rowIndex + 1,
        sessionKey: String(value.sessionKey || ''),
        sessionId: String(value.sessionId || ''),
        runId: String(value.runId || ''),
        topLevelKeys: Object.keys(value).sort(),
        messageKeys: Object.keys(message).sort(),
        role: String(message.role || value.role || ''),
        type: String(value.type || message.type || ''),
        timestamp: String(value.timestamp || message.timestamp || ''),
        matchingContent: matchingContent.map((item) => ({
          keys: Object.keys(item).sort(),
          type: String(item.type || ''),
          name: String(item.name || item.toolName || ''),
          argumentKeys: item.arguments && typeof item.arguments === 'object'
            ? Object.keys(item.arguments).sort()
            : (item.input && typeof item.input === 'object' ? Object.keys(item.input).sort() : []),
        })),
      }]
    })
  })
  liveSessionStructure = {
    inspected: true,
    matchingIndexEntries,
    verifierSessions,
    recentJsonl: recentJsonl.map((file) => ({
      file: path.basename(file),
      modifiedAt: fs.statSync(file).mtime.toISOString(),
    })),
    toolEvents,
  }
} catch {}

let reportHistoryPreview = { inspected: false }
try {
  const adminPid = cp.execFileSync('systemctl', [
    'show', 'gaiop-admin.service', '--property=MainPID', '--value'
  ], { encoding: 'utf8' }).trim()
  const adminEnvironment = fs.readFileSync('/proc/' + adminPid + '/environ', 'utf8')
    .split('\0')
    .reduce((result, row) => {
      const separator = row.indexOf('=')
      if (separator > 0) result[row.slice(0, separator)] = row.slice(separator + 1)
      return result
    }, {})
  const dataDirectory = String(adminEnvironment.GAIOP_ADMIN_DATA_DIR || '/opt/gaiop/admin/data')
  const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
  const database = new Database(path.join(dataDirectory, 'wizard.db'), { readonly: true, fileMustExist: true })
  const dataSources = database.prepare(
    'SELECT id, ip, description, status, is_active FROM data_sources ORDER BY is_active DESC, updated_at DESC'
  ).all()
  const reportCounts = database.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN source_channel IS NULL OR source_channel = '' THEN 1 ELSE 0 END) AS missing_channel, SUM(CASE WHEN source_user_id IS NULL OR source_user_id = '' THEN 1 ELSE 0 END) AS missing_user, SUM(CASE WHEN source_session_id IS NULL OR source_session_id = '' THEN 1 ELSE 0 END) AS missing_session, SUM(CASE WHEN data_source_id IS NULL OR data_source_id = '' THEN 1 ELSE 0 END) AS missing_data_source FROM report_files"
  ).get()
  const workspaceOwners = new Map(database.prepare(
    'SELECT workspace_sessions.session_key, workspace_sessions.owner_user_id, users.username FROM workspace_sessions LEFT JOIN users ON users.id = workspace_sessions.owner_user_id'
  ).all().map((row) => [row.session_key, row]))
  database.close()

  const sessionsRoot = '/home/netinside/.openclaw/agents/main/sessions'
  const sessionIndex = JSON.parse(fs.readFileSync(path.join(sessionsRoot, 'sessions.json'), 'utf8'))
  const reportCalls = Object.entries(sessionIndex).flatMap(([sessionKey, record]) => {
    if (!record?.sessionFile || !fs.existsSync(record.sessionFile)) return []
    return fs.readFileSync(record.sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((row) => {
      let value
      try { value = JSON.parse(row) } catch { return [] }
      const content = Array.isArray(value?.message?.content) ? value.message.content : []
      return content.flatMap((item) => {
        if (item?.name !== 'napm-report-export' || !item?.id) return []
        const argumentsValue = item.arguments && typeof item.arguments === 'object' ? item.arguments : {}
        return [{
          sessionKey,
          timestamp: Date.parse(String(value.timestamp || value?.message?.timestamp || '')),
          prompt: String(argumentsValue.prompt || '').trim(),
        }]
      })
    })
  }).filter((entry) => Number.isFinite(entry.timestamp))
  function normalizeComparisonText(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '')
  }
  const missingAudits = walk(reportRoot).filter((file) => file.endsWith('.json')).flatMap((file) => {
    let value
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
    if (value?.sourceChannel && value?.sourceUserId && value?.sourceSessionId && value?.dataSourceId) return []
    const generatedAt = Date.parse(String(value?.generatedAt || ''))
    if (!Number.isFinite(generatedAt)) return []
    return [{ file, value, generatedAt }]
  })
  const activeSources = dataSources.filter((source) => Number(source.is_active) === 1)
  const reliableMatches = []
  const ambiguousMatches = []
  for (const auditEntry of missingAudits) {
    const auditText = normalizeComparisonText(auditEntry.value.sourceQuestion)
    const candidates = reportCalls.map((call) => {
      const deltaMs = auditEntry.generatedAt - call.timestamp
      const promptText = normalizeComparisonText(call.prompt)
      return {
        ...call,
        deltaMs,
        promptMatched: Boolean(auditText && promptText && (auditText === promptText || auditText.includes(promptText) || promptText.includes(auditText))),
      }
    }).filter((call) => call.deltaMs >= -2_000 && call.deltaMs <= 300_000)
      .sort((left, right) => Number(right.promptMatched) - Number(left.promptMatched) || Math.abs(left.deltaMs) - Math.abs(right.deltaMs))
    if (candidates.length === 0) continue
    const first = candidates[0]
    const second = candidates[1]
    const uniqueByPrompt = first.promptMatched && (!second || !second.promptMatched)
    const uniqueByTime = Math.abs(first.deltaMs) <= 5_000
      && (!second || Math.abs(second.deltaMs) - Math.abs(first.deltaMs) >= 2_000)
    const owner = workspaceOwners.get(first.sessionKey)
    const webSession = first.sessionKey.includes(':webchat-')
    const channelParts = first.sessionKey.split(':')
    const channel = webSession ? 'web' : String(channelParts[2] || '')
    const peer = String(channelParts.slice(4).join(':') || '')
    const sourceUserId = webSession ? String(owner?.owner_user_id || '') : (channel && peer ? 'channel:' + channel + ':' + peer : '')
    const sourceUserName = webSession ? String(owner?.username || '') : peer
    const reliable = (uniqueByPrompt || uniqueByTime)
      && Boolean(sourceUserId)
      && activeSources.length === 1
    const summary = {
      relativeAuditPath: path.relative(reportRoot, auditEntry.file).split(path.sep).join('/'),
      sessionKey: first.sessionKey,
      sourceChannel: channel,
      sourceUserId,
      sourceUserName,
      dataSourceId: String(activeSources[0]?.id || ''),
      deltaMs: first.deltaMs,
      promptMatched: first.promptMatched,
    }
    if (reliable) reliableMatches.push(summary)
    else ambiguousMatches.push(summary)
  }
  reportHistoryPreview = {
    inspected: true,
    dataSources,
    reportCounts,
    auditFilesMissingCompleteProvenance: missingAudits.length,
    reportToolCallsIndexed: reportCalls.length,
    reliableBackfillCount: reliableMatches.length,
    ambiguousCandidateCount: ambiguousMatches.length,
    reliableMatches: reliableMatches.slice(0, 300),
  }
} catch {}

const safeAudit = audit ? {
  relativeFilePath: String(audit.relativeFilePath || ''),
  traceId: String(audit.traceId || ''),
  sourceChannel: String(audit.sourceChannel || ''),
  sourceUserId: String(audit.sourceUserId || ''),
  sourceSessionId: String(audit.sourceSessionId || ''),
  dataSourceId: String(audit.dataSourceId || ''),
  generatedAt: String(audit.generatedAt || ''),
  topLevelKeys: Object.keys(audit).sort(),
  nestedAuditKeys: audit.audit && typeof audit.audit === 'object' ? Object.keys(audit.audit).sort() : [],
  sourceQuestionLength: String(audit.sourceQuestion || '').length,
  exportPromptLength: String(audit.audit?.exportPrompt || '').length,
} : null

const comparisonTexts = audit
  ? [audit.sourceQuestion, audit.audit?.exportPrompt].map((value) => String(value || '').trim()).filter(Boolean)
  : []
const snapshotComparisons = snapshots.map((snapshot) => {
  const file = path.join(storeRoot, snapshot.fileHash + '.json')
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  const preview = String(value.sourceMessagePreview || '').trim()
  return {
    sessionId: snapshot.sessionId,
    previewLength: preview.length,
    exactAuditTextMatch: comparisonTexts.includes(preview),
    auditTextContainsPreview: Boolean(preview) && comparisonTexts.some((text) => text.includes(preview)),
    previewContainsAuditText: comparisonTexts.some((text) => Boolean(text) && preview.includes(text)),
  }
})
let provenanceResolutionEvents = []
try {
  const auditLog = '/home/netinside/.openclaw/logs/audit.log'
  provenanceResolutionEvents = fs.readFileSync(auditLog, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((row) => {
    let value
    try { value = JSON.parse(row) } catch { return [] }
    if (value?.event !== 'napm_report_provenance_resolution') return []
    return [{
      timestamp: String(value.timestamp || ''),
      toolCallIdType: String(value.toolCallIdType || ''),
      toolCallIdLength: Number(value.toolCallIdLength || 0),
      toolCallIdHash: String(value.toolCallIdHash || ''),
      resolutionMs: Number(value.resolutionMs || 0),
      transcriptMatched: Boolean(value.transcriptMatched),
      factoryMatched: Boolean(value.factoryMatched),
      factoryHasSessionKey: Boolean(value.factoryHasSessionKey),
      factoryHasSessionId: Boolean(value.factoryHasSessionId),
    }]
  }).slice(-20)
} catch {}

process.stdout.write(JSON.stringify({
  targetFound: Boolean(targetPath),
  liveVerifierAudits,
  recentReportAudits,
  deployedArtifacts,
  loadedGatewayPluginEntry,
  loadedGatewayPluginFiles,
  audit: safeAudit,
  snapshotCount: fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot).filter((name) => name.endsWith('.json')).length : 0,
  snapshots,
  snapshotComparisons,
  provenanceResolutionEvents,
  gatewayLines,
  pluginRuntime,
  agentCli,
  liveGatewayVerification,
  liveSessionStructure,
  reportHistoryPreview,
  openclawRuntimeSource,
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
      stream.write(`${connection.password}\n${diagnostic}`)
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
}, 120_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ ok: true, diagnostic: result })}\n`)
    client.end()
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"ok":false,"errorCode":"REMOTE_DIAGNOSTIC_FAILED"}\n')
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
