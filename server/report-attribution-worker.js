import { createHash } from 'crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { REPORT_ATTRIBUTION_SCHEMA } from './lib/report-attribution-index.js'

const DEFAULT_SESSIONS_ROOT = '/home/netinside/.openclaw/agents/main/sessions'
const DEFAULT_LEGACY_ROOT = '/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output'
const DEFAULT_REPORT_ROOT = '/var/lib/gaiop/reports'
const DEFAULT_PROVENANCE_ROOT = '/var/lib/gaiop/runtime/report-provenance'
const DEFAULT_ATTRIBUTION_ROOT = '/var/lib/gaiop/report-attribution'
const EXTERNAL_CHANNELS = new Set(['wecom', 'wecom-openclaw-plugin', 'feishu', 'lark', 'openclaw-lark', 'dingtalk', 'dingtalk-connector'])

function safeText(value, maxLength = 1024) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : null
}

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) } catch { return null }
}

function firstText(values, maxLength = 512) {
  return values.map((value) => safeText(value, maxLength)).find(Boolean) || null
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isWithin(root, candidate) {
  const inside = relative(root, candidate)
  return Boolean(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

function canonicalArtifactPath(value, roots) {
  const candidate = safeText(value, 4096)
  if (!candidate || !isAbsolute(candidate)) return null
  const resolved = resolve(candidate)
  return roots.some((root) => isWithin(root, resolved)) ? resolved : null
}

function parseToolResult(message) {
  const candidates = []
  if (message?.details && typeof message.details === 'object') candidates.push(message.details)
  for (const item of Array.isArray(message?.content) ? message.content : []) {
    const text = typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : null
    if (!text) continue
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object') candidates.push(value)
    } catch {}
  }
  const queue = [...candidates]
  const visited = new Set()
  while (queue.length) {
    const value = queue.shift()
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    if (value.ok === true && safeText(value.reportId)) return value
    for (const key of ['result', 'data', 'details', 'output']) {
      if (value[key] && typeof value[key] === 'object') queue.push(value[key])
    }
  }
  return null
}

function messageTexts(message) {
  const output = []
  if (typeof message?.details === 'string') output.push(message.details)
  if (message?.details && typeof message.details === 'object') {
    for (const key of ['output', 'stdout', 'text']) if (typeof message.details[key] === 'string') output.push(message.details[key])
  }
  for (const item of Array.isArray(message?.content) ? message.content : []) {
    if (typeof item === 'string') output.push(item)
    else if (typeof item?.text === 'string') output.push(item.text)
  }
  return output
}

function pathsFromExecResult(message, roots) {
  const pattern = /\/[^\r\n"'<>]*?\.(?:docx|pdf|xlsx|csv|md|txt|json)/giu
  return [...new Set(messageTexts(message)
    .flatMap((text) => [...text.replace(/\\/g, '/').matchAll(pattern)].map((match) => resolve(match[0].trim())))
    .filter(Boolean))]
}

function resolveExecArtifactPair(message, roots) {
  const referenced = pathsFromExecResult(message, roots)
  const names = new Set(referenced.map((candidate) => basename(candidate)))
  const relocated = []
  for (const root of roots) {
    const pending = [root]
    while (pending.length) {
      const directory = pending.pop()
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name)
        if (entry.isDirectory()) pending.push(entryPath)
        else if (entry.isFile() && names.has(entry.name)) relocated.push(entryPath)
      }
    }
  }
  const candidates = [...new Set([
    ...referenced.filter((candidate) => roots.some((root) => isWithin(root, candidate)) && existsSync(candidate)),
    ...relocated,
  ])]
  const reports = candidates.filter((candidate) => extname(candidate).toLowerCase() !== '.json')
  const matches = []
  for (const auditPath of candidates.filter((candidate) => extname(candidate).toLowerCase() === '.json')) {
    const root = roots.find((candidateRoot) => isWithin(candidateRoot, auditPath))
    const audit = readJson(auditPath)
    if (!root || !safeText(audit?.reportId, 512)) continue
    const filePath = pairedReportPath(auditPath, audit, root)
    if (filePath && reports.includes(filePath)) matches.push({ filePath, auditPath, reportId: audit.reportId })
  }
  return matches.length === 1 ? matches[0] : null
}

function reportToolResults(sessionFile, roots, previousOffset = 0) {
  const output = { results: [], nextOffset: previousOffset }
  if (!sessionFile || !existsSync(sessionFile)) return output
  const size = statSync(sessionFile).size
  const offset = previousOffset >= 0 && previousOffset <= size ? previousOffset : 0
  if (offset === size) return { results: [], nextOffset: size }
  const buffer = Buffer.alloc(size - offset)
  const handle = openSync(sessionFile, 'r')
  try { readSync(handle, buffer, 0, buffer.length, offset) } finally { closeSync(handle) }
  const text = buffer.toString('utf8')
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline < 0) return { results: [], nextOffset: offset }
  const complete = text.slice(0, lastNewline + 1)
  output.nextOffset = offset + Buffer.byteLength(complete, 'utf8')
  for (const row of complete.split(/\r?\n/).filter(Boolean)) {
    let value
    try { value = JSON.parse(row) } catch { continue }
    const message = value?.message
    if (message?.role !== 'toolResult') continue
    if (message?.toolName === 'napm-report-export') {
      const result = parseToolResult(message)
      if (result) output.results.push({ result, evidence: 'official_tool_result', timestamp: safeText(value.timestamp || message.timestamp, 128) })
    } else if (message?.toolName === 'exec') {
      const pair = resolveExecArtifactPair(message, roots)
      if (pair) output.results.push({ result: pair, evidence: 'exec_tool_result', timestamp: safeText(value.timestamp || message.timestamp, 128) })
    }
  }
  return output
}

function parseSessionIdentity(sessionKey, record = {}) {
  const parts = String(sessionKey || '').split(':')
  const parsedChannel = safeText(parts[2], 128)?.toLowerCase()
  const channel = safeText(record.channel || record.lastChannel || parsedChannel, 128)?.toLowerCase()
  if (!channel || !EXTERNAL_CHANNELS.has(channel)) return null
  const actorId = firstText([
    record.channelUserId, record.senderId, record.userId, record.peer?.id, record.peer, parts.slice(4).join(':'),
  ])
  if (!actorId) return null
  const actorName = firstText([
    record.channelUserName, record.senderName, record.userName, record.displayName, record.label,
  ])
  return {
    sourceUserId: `channel:${channel}:${actorId}`,
    sourceChannel: channel,
    sourceChannelUserId: actorId,
    sourceChannelUserName: actorName,
    sourceSessionId: sessionKey,
  }
}

function readWebIdentity(sessionKey, provenanceRoot) {
  const envelope = readJson(join(provenanceRoot, `${sha256(sessionKey)}.json`))
  const envelopeSession = safeText(envelope?.sourceSessionId || envelope?.sessionId)
  const sourceUserId = safeText(envelope?.sourceUserId || envelope?.userId, 512)
  if (!envelope || envelopeSession !== sessionKey || !sourceUserId) return null
  return {
    sourceUserId,
    sourceChannel: safeText(envelope.sourceChannel, 128)?.toLowerCase() || 'web',
    sourceChannelUserId: safeText(envelope.sourceChannelUserId, 512) || sourceUserId,
    sourceChannelUserName: safeText(envelope.sourceChannelUserName || envelope.username, 512),
    sourceSessionId: sessionKey,
    dataSourceId: safeText(envelope.dataSourceId, 512),
  }
}

function resolveIdentity(sessionKey, record, provenanceRoot) {
  if (sessionKey.includes(':webchat-')) return readWebIdentity(sessionKey, provenanceRoot)
  return parseSessionIdentity(sessionKey, record)
}

function atomicCopy(source, destination) {
  if (existsSync(destination)) {
    const sourceHash = sha256(readFileSync(source))
    const destinationHash = sha256(readFileSync(destination))
    if (sourceHash !== destinationHash) throw new Error(`Archive collision: ${basename(destination)}`)
    return
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o2750 })
  const temporary = `${destination}.tmp-${process.pid}`
  copyFileSync(source, temporary)
  chmodSync(temporary, 0o640)
  renameSync(temporary, destination)
}

function archivePair(filePath, auditPath, reportRoot, dryRun = false) {
  if (isWithin(reportRoot, filePath) && isWithin(reportRoot, auditPath)) {
    return {
      storedName: relative(reportRoot, filePath).split(sep).join('/'),
      auditName: relative(reportRoot, auditPath).split(sep).join('/'),
    }
  }
  const pairKey = sha256(readFileSync(filePath)).slice(0, 20)
  const directory = join(reportRoot, '_sidecar', pairKey)
  const destinationFile = join(directory, basename(filePath))
  const destinationAudit = join(directory, basename(auditPath))
  if (!dryRun) {
    atomicCopy(filePath, destinationFile)
    atomicCopy(auditPath, destinationAudit)
  }
  return {
    storedName: relative(reportRoot, destinationFile).split(sep).join('/'),
    auditName: relative(reportRoot, destinationAudit).split(sep).join('/'),
  }
}

function listJsonFiles(root) {
  const output = []
  if (!existsSync(root)) return output
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name)
    if (entry.isDirectory()) output.push(...listJsonFiles(entryPath))
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') output.push(entryPath)
  }
  return output
}

function pairedReportPath(auditPath, audit, root) {
  const candidates = []
  const relativeFilePath = safeText(audit?.relativeFilePath, 4096)
  if (relativeFilePath) {
    const candidate = resolve(root, relativeFilePath)
    if (isWithin(root, candidate)) candidates.push(candidate)
  }
  const fileName = basename(safeText(audit?.fileName || audit?.filePath, 4096) || '')
  if (fileName) candidates.push(join(dirname(auditPath), fileName))
  const stem = auditPath.slice(0, -extname(auditPath).length)
  for (const extension of ['.docx', '.pdf', '.xlsx', '.csv', '.md', '.txt']) candidates.push(`${stem}${extension}`)
  const existing = [...new Set(candidates.map((candidate) => resolve(candidate)))]
    .filter((candidate) => isWithin(root, candidate) && existsSync(candidate) && extname(candidate).toLowerCase() !== '.json')
  return existing.length === 1 ? existing[0] : null
}

function resolveArtifactPair(result, roots, existingEntries) {
  const explicitFile = canonicalArtifactPath(result.filePath, roots)
  const explicitAudit = canonicalArtifactPath(result.auditPath, roots)
  if (explicitFile && explicitAudit && existsSync(explicitFile) && existsSync(explicitAudit)) {
    return { filePath: explicitFile, auditPath: explicitAudit }
  }
  const reportId = safeText(result.reportId, 512)
  if (!reportId) return null
  const existing = [...existingEntries.values()].filter((entry) => entry.reportId === reportId)
  if (existing.length === 1) {
    const filePath = resolve(roots[0], existing[0].storedName)
    const auditPath = resolve(roots[0], existing[0].auditName)
    if (isWithin(roots[0], filePath) && isWithin(roots[0], auditPath) && existsSync(filePath) && existsSync(auditPath)) {
      return { filePath, auditPath }
    }
  }
  const matches = []
  for (const root of roots) {
    for (const auditPath of listJsonFiles(root)) {
      const audit = readJson(auditPath)
      if (safeText(audit?.reportId, 512) !== reportId) continue
      const filePath = pairedReportPath(auditPath, audit, root)
      if (filePath) matches.push({ filePath, auditPath })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

function readExistingEntries(indexPath) {
  const payload = readJson(indexPath)
  if (payload?.schemaVersion !== REPORT_ATTRIBUTION_SCHEMA || !Array.isArray(payload.entries)) return []
  return payload.entries
}

function readWorkerState(statePath) {
  const payload = readJson(statePath)
  return payload?.schemaVersion === 'gaiop.report-attribution-state.v5' && payload.files && typeof payload.files === 'object'
    ? payload.files
    : {}
}

function writeIndex(indexPath, entries) {
  mkdirSync(dirname(indexPath), { recursive: true, mode: 0o2750 })
  const payload = {
    schemaVersion: REPORT_ATTRIBUTION_SCHEMA,
    updatedAt: new Date().toISOString(),
    entries: [...entries.values()].sort((left, right) => left.storedName.localeCompare(right.storedName)),
  }
  const temporary = `${indexPath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  renameSync(temporary, indexPath)
}

function writeWorkerState(statePath, files) {
  const temporary = `${statePath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 'gaiop.report-attribution-state.v5', files }, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 })
  renameSync(temporary, statePath)
}

export function scanReportAttributions(options = {}) {
  const sessionsRoot = resolve(options.sessionsRoot || process.env.GAIOP_GATEWAY_SESSIONS_DIR || DEFAULT_SESSIONS_ROOT)
  const legacyRoot = resolve(options.legacyRoot || process.env.GAIOP_REPORT_LEGACY_DIR || DEFAULT_LEGACY_ROOT)
  const reportRoot = resolve(options.reportRoot || process.env.GAIOP_REPORTS_DIR || DEFAULT_REPORT_ROOT)
  const provenanceRoot = resolve(options.provenanceRoot || process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR || DEFAULT_PROVENANCE_ROOT)
  const attributionRoot = resolve(options.attributionRoot || process.env.GAIOP_REPORT_ATTRIBUTION_DIR || DEFAULT_ATTRIBUTION_ROOT)
  const indexPath = join(attributionRoot, 'index.json')
  const statePath = join(attributionRoot, 'state.json')
  const dryRun = options.dryRun === true
  const sessionIndex = readJson(join(sessionsRoot, 'sessions.json')) || {}
  const entries = new Map(readExistingEntries(indexPath).map((entry) => [entry.storedName, entry]))
  const workerState = readWorkerState(statePath)
  const nextWorkerState = { ...workerState }
  const allowedRoots = [reportRoot, legacyRoot]
  let discovered = 0

  for (const [sessionKey, record] of Object.entries(sessionIndex)) {
    const identity = resolveIdentity(sessionKey, record, provenanceRoot)
    if (!identity) continue
    const sessionFile = safeText(record?.sessionFile, 4096)
    const stateKey = sessionFile ? sha256(sessionFile) : null
    const parsed = reportToolResults(sessionFile, allowedRoots, dryRun ? 0 : Number(workerState[stateKey]?.offset || 0))
    if (stateKey) nextWorkerState[stateKey] = { offset: parsed.nextOffset }
    for (const event of parsed.results) {
      const pair = resolveArtifactPair(event.result, allowedRoots, entries)
      const filePath = pair?.filePath
      const auditPath = pair?.auditPath
      if (!filePath || !auditPath) continue
      if (extname(filePath).toLowerCase() === '.json' || extname(auditPath).toLowerCase() !== '.json') continue
      const audit = readJson(auditPath)
      const reportId = safeText(event.result.reportId || audit?.reportId, 512)
      if (!reportId) continue
      const archived = archivePair(filePath, auditPath, reportRoot, dryRun)
      entries.set(archived.storedName, {
        ...archived,
        reportId,
        sourceSessionId: identity.sourceSessionId,
        sourceUserId: identity.sourceUserId,
        sourceChannel: identity.sourceChannel,
        sourceChannelUserId: identity.sourceChannelUserId || null,
        sourceChannelUserName: identity.sourceChannelUserName || null,
        dataSourceId: identity.dataSourceId || safeText(audit?.dataSourceId || audit?.dataSource?.id, 512),
        evidence: event.evidence,
        toolCompletedAt: event.timestamp,
        fileSha256: sha256(readFileSync(filePath)),
        observedAt: new Date().toISOString(),
      })
      discovered += 1
    }
  }
  if (!dryRun) {
    mkdirSync(attributionRoot, { recursive: true, mode: 0o2750 })
    writeIndex(indexPath, entries)
    writeWorkerState(statePath, nextWorkerState)
  }
  return { indexPath, entries: entries.size, discovered }
}

async function main() {
  const once = process.argv.includes('--once')
  const dryRun = process.argv.includes('--dry-run')
  const interval = Math.max(1000, Number(process.env.GAIOP_REPORT_ATTRIBUTION_INTERVAL_MS || 3000))
  do {
    try {
      const result = scanReportAttributions({ dryRun })
      if (once) process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
    } catch (error) {
      process.stderr.write(`[report-attribution] ${error instanceof Error ? error.message : String(error)}\n`)
      if (once) process.exitCode = 1
    }
    if (once) break
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval))
  } while (true)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
