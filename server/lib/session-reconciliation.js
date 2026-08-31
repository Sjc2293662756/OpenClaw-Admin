import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

export const RECONCILIATION_SCHEMA = 'gaiop.session-reconciliation.v1'
export const PRODUCTION_DATABASE_PATH = '/var/lib/gaiop/admin/wizard.db'
export const OPENCLAW_EXECUTABLE = '/home/netinside/.npm-global/bin/openclaw'

const execFileAsync = promisify(execFileCallback)
const MAX_OPENCLAW_ROWS = 100_000
const MAX_DETAIL_ITEMS = 200
const ACTIVE_ADMIN_TASK_STATUSES = new Set(['active', 'in_progress', 'pending', 'queued', 'running'])

const OPENCLAW_COMMANDS = Object.freeze({
  index: Object.freeze(['sessions', '--agent', 'main', '--json', '--limit', 'all']),
  runtime: Object.freeze([
    'gateway',
    'call',
    'sessions.list',
    '--json',
    '--params',
    JSON.stringify({ limit: MAX_OPENCLAW_ROWS }),
    '--timeout',
    '20000',
  ]),
  missing: Object.freeze(['sessions', 'cleanup', '--agent', 'main', '--dry-run', '--fix-missing']),
})

const REQUIRED_COLUMNS = Object.freeze({
  users: Object.freeze(['id', 'status']),
  workspace_sessions: Object.freeze([
    'session_key',
    'owner_user_id',
    'status',
    'created_at',
    'updated_at',
    'deleted_at',
  ]),
  report_files: Object.freeze([
    'id',
    'source_session_id',
    'source_user_id',
    'status',
    'created_at',
    'updated_at',
  ]),
  report_deliveries: Object.freeze(['report_id', 'status', 'created_at', 'updated_at']),
  session_retention_attachments: Object.freeze([
    'session_key',
    'retention_class',
    'ownership_state',
    'lifecycle_state',
    'registered_at',
    'expires_at',
    'updated_at',
  ]),
  session_retention_records: Object.freeze([
    'session_key',
    'retention_mode',
    'lifecycle_state',
    'owner_kind',
    'owner_ref',
    'last_activity_at',
    'updated_at',
  ]),
  tasks: Object.freeze(['status', 'created_at', 'updated_at']),
})

const BFF_FINGERPRINT_FIELDS = Object.freeze({
  sessions: Object.freeze([
    'session_key', 'owner_user_id', 'status', 'created_at', 'updated_at', 'deleted_at',
    'registered_owner_id', 'owner_status',
  ]),
  reports: Object.freeze(['id', 'source_session_id', 'source_user_id', 'status', 'created_at', 'updated_at']),
  deliveries: Object.freeze(['report_id', 'status', 'created_at', 'updated_at']),
  attachments: Object.freeze([
    'session_key', 'retention_class', 'ownership_state', 'lifecycle_state',
    'registered_at', 'expires_at', 'updated_at',
  ]),
  retention: Object.freeze([
    'session_key', 'retention_mode', 'lifecycle_state', 'owner_kind', 'owner_ref',
    'last_activity_at', 'updated_at',
  ]),
  taskStatuses: Object.freeze(['status', 'count', 'first_created_at', 'last_updated_at']),
})

export class ReconciliationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ReconciliationError'
    this.code = code
  }
}

function fail(code) {
  throw new ReconciliationError(code)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function optionalText(value) {
  const normalized = text(value)
  return normalized || null
}

function integer(value) {
  return Number.isSafeInteger(value) ? value : null
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function timestamp(value) {
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= 0 ? Math.trunc(normalized) : null
}

function isoTimestamp(value) {
  const normalized = timestamp(value)
  if (normalized === null) return null
  try {
    return new Date(normalized).toISOString()
  } catch {
    return null
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function sessionDigest(sessionKey) {
  return sha256(`gaiop-session-reconciliation-v1\0${sessionKey}`).slice(0, 24)
}

function stableFingerprint(namespace, values) {
  return sha256(`${namespace}\0${[...values].sort().join('\n')}`)
}

export function fingerprintBffMetadata(metadata) {
  const values = []
  for (const [collection, fields] of Object.entries(BFF_FINGERPRINT_FIELDS)) {
    const rows = metadata?.[collection]
    if (!Array.isArray(rows)) fail('BFF_METADATA_INVALID')
    for (const row of rows) {
      const normalized = fields.map((field) => {
        const value = row?.[field]
        if (value === null || value === undefined) return null
        if (['string', 'number', 'boolean'].includes(typeof value)) return value
        return String(value)
      })
      values.push(`${collection}\0${JSON.stringify(normalized)}`)
    }
  }
  return stableFingerprint('bff-session-metadata-v1', values)
}

function safeCode(error) {
  if (error instanceof ReconciliationError && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)) {
    return error.code
  }
  return 'RECONCILIATION_FAILED'
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '')
}

function parseJsonOutput(raw, failureCode) {
  const input = String(raw || '').trim()
  if (!input) fail(failureCode)
  try {
    return JSON.parse(input)
  } catch {
    const first = input.indexOf('{')
    const last = input.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(input.slice(first, last + 1))
      } catch {
        fail(failureCode)
      }
    }
    fail(failureCode)
  }
}

function unwrapSessionsPayload(value, failureCode) {
  let candidate = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate && typeof candidate === 'object' && Array.isArray(candidate.sessions)) return candidate
    const nested = candidate?.payload ?? candidate?.result ?? candidate?.data
    if (!nested || nested === candidate) break
    candidate = nested
  }
  fail(failureCode)
}

function assertCompleteList(payload, rows, failureCode) {
  const totalCount = nonNegativeInteger(payload.totalCount)
  const count = nonNegativeInteger(payload.count)
  if (payload.hasMore === true || totalCount === null || totalCount !== rows.length) fail(failureCode)
  if (count !== null && count !== rows.length) fail(failureCode)
}

export function parseOpenClawIndex(raw) {
  const payload = unwrapSessionsPayload(
    parseJsonOutput(raw, 'OPENCLAW_INDEX_INVALID'),
    'OPENCLAW_INDEX_INVALID',
  )
  assertCompleteList(payload, payload.sessions, 'OPENCLAW_INDEX_INCOMPLETE')

  const sessions = new Map()
  for (const row of payload.sessions) {
    const key = text(row?.key)
    if (!key || sessions.has(key)) fail('OPENCLAW_INDEX_INVALID')
    sessions.set(key, {
      key,
      sessionId: optionalText(row?.sessionId),
      updatedAt: timestamp(row?.updatedAt),
    })
  }

  return {
    sessions,
    totalCount: sessions.size,
    fingerprint: stableFingerprint(
      'openclaw-index-v1',
      Array.from(sessions.values(), (row) => `${row.key}\0${row.sessionId || ''}\0${row.updatedAt ?? ''}`),
    ),
  }
}

export function parseOpenClawRuntime(raw) {
  const payload = unwrapSessionsPayload(
    parseJsonOutput(raw, 'OPENCLAW_RUNTIME_JSON_INVALID'),
    'OPENCLAW_RUNTIME_SCHEMA_INVALID',
  )
  assertCompleteList(payload, payload.sessions, 'OPENCLAW_RUNTIME_INCOMPLETE')

  const sessions = new Map()
  for (const row of payload.sessions) {
    const key = text(row?.key)
    if (!key || sessions.has(key) || typeof row?.hasActiveRun !== 'boolean') {
      fail('OPENCLAW_RUNTIME_SCHEMA_INVALID')
    }
    sessions.set(key, {
      key,
      hasActiveRun: row.hasActiveRun,
      updatedAt: timestamp(row.updatedAt),
    })
  }

  return {
    sessions,
    totalCount: sessions.size,
    fingerprint: stableFingerprint(
      'openclaw-runtime-v1',
      Array.from(sessions.values(), (row) => `${row.key}\0${row.hasActiveRun}\0${row.updatedAt ?? ''}`),
    ),
  }
}

function cleanupTokenMatches(token, key) {
  if (token === key) return true
  if (!token.includes('...')) return false
  const [prefix, suffix, ...rest] = token.split('...')
  return rest.length === 0 && prefix.length === 16 && suffix.length === 6
    && key.startsWith(prefix) && key.endsWith(suffix)
}

export function parseMissingTranscriptDryRun(raw, indexSessions) {
  const output = stripAnsi(raw)
  const countMatch = output.match(/Would prune missing transcripts:\s*(\d+)/i)
  if (!countMatch) fail('OPENCLAW_MISSING_DRY_RUN_INVALID')
  const reportedCount = Number(countMatch[1])
  if (!Number.isSafeInteger(reportedCount) || reportedCount < 0) {
    fail('OPENCLAW_MISSING_DRY_RUN_INVALID')
  }

  const tokens = []
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^prune-missing\s+(\S+)/i)
    if (match) tokens.push(match[1])
  }
  if (tokens.length !== reportedCount) fail('OPENCLAW_MISSING_DRY_RUN_INVALID')

  const missing = new Set()
  for (const token of tokens) {
    const matches = Array.from(indexSessions.keys()).filter((key) => cleanupTokenMatches(token, key))
    if (matches.length !== 1 || missing.has(matches[0])) fail('OPENCLAW_MISSING_KEY_AMBIGUOUS')
    missing.add(matches[0])
  }

  return {
    missing,
    count: missing.size,
    fingerprint: stableFingerprint('openclaw-missing-v1', missing),
  }
}

async function defaultOpenClawExecutor(executable, args, options) {
  return execFileAsync(executable, args, options)
}

function runtimeDirectory(environment) {
  const value = text(environment?.XDG_RUNTIME_DIR)
  if (!/^\/run\/user\/\d+$/.test(value)) fail('OPENCLAW_RUNTIME_DIRECTORY_MISSING')
  return value
}

function classifyOpenClawCommandFailure(kind, error) {
  if (error instanceof ReconciliationError) return error.code
  if (kind !== 'runtime') return `OPENCLAW_${kind.toUpperCase()}_FAILED`
  const stderr = String(error?.stderr || '')
  const message = String(error?.message || '')
  const diagnostic = `${stderr}\n${message}`
  if (error?.code === 'ETIMEDOUT' || error?.killed === true || error?.signal === 'SIGTERM'
    || /timed?\s*out|timeout/i.test(diagnostic)) return 'OPENCLAW_RUNTIME_TIMEOUT'
  if (/connection\s+refused|ECONNREFUSED|gateway\s+(?:is\s+)?not\s+running|gateway\s+unavailable/i.test(diagnostic)) {
    return 'OPENCLAW_RUNTIME_GATEWAY_UNAVAILABLE'
  }
  if (error?.code === 'ENOENT') return 'OPENCLAW_RUNTIME_EXECUTABLE_UNAVAILABLE'
  if (Number.isInteger(error?.code)) return 'OPENCLAW_RUNTIME_NONZERO_EXIT'
  return 'OPENCLAW_RUNTIME_EXECUTION_FAILED'
}

export async function runFixedOpenClawCommand(
  kind,
  executor = defaultOpenClawExecutor,
  environment = process.env,
) {
  const args = OPENCLAW_COMMANDS[kind]
  if (!args) fail('OPENCLAW_COMMAND_NOT_ALLOWED')
  const xdgRuntimeDirectory = runtimeDirectory(environment)
  try {
    const result = await executor(OPENCLAW_EXECUTABLE, [...args], {
      cwd: '/opt/gaiop/admin',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        HOME: '/home/netinside',
        USER: 'netinside',
        LOGNAME: 'netinside',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PATH: '/home/netinside/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
        XDG_RUNTIME_DIR: xdgRuntimeDirectory,
      },
    })
    return String(result?.stdout || '')
  } catch (error) {
    fail(classifyOpenClawCommandFailure(kind, error))
  }
}

export async function readOpenClawSnapshot(commandRunner = runFixedOpenClawCommand) {
  const [indexRaw, runtimeRaw, missingRaw] = await Promise.all([
    commandRunner('index'),
    commandRunner('runtime'),
    commandRunner('missing'),
  ])
  const index = parseOpenClawIndex(indexRaw)
  const runtime = parseOpenClawRuntime(runtimeRaw)
  const missing = parseMissingTranscriptDryRun(missingRaw, index.sessions)
  return {
    index,
    runtime,
    missing,
    fingerprint: stableFingerprint('openclaw-snapshot-v1', [
      index.fingerprint,
      runtime.fingerprint,
      missing.fingerprint,
    ]),
  }
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => text(row.name)).filter(Boolean))
}

function assertSchema(db) {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = tableColumns(db, table)
    if (columns.size === 0 || required.some((column) => !columns.has(column))) {
      fail('SQLITE_SCHEMA_UNSUPPORTED')
    }
  }
}

export function openReadonlyDatabase(databasePath, DatabaseClass) {
  if (databasePath !== PRODUCTION_DATABASE_PATH && !DatabaseClass?.allowTestDatabasePath) {
    fail('SQLITE_PATH_NOT_ALLOWED')
  }
  let db
  try {
    db = new DatabaseClass(databasePath, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    db.pragma('temp_store = MEMORY')
    if (Number(db.pragma('query_only', { simple: true })) !== 1) fail('SQLITE_QUERY_ONLY_UNCONFIRMED')
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // The connection never becomes part of the reconciliation path.
    }
    if (error instanceof ReconciliationError) throw error
    fail('SQLITE_READONLY_OPEN_FAILED')
  }
}

export function readSqliteDataVersion(db) {
  const value = Number(db.pragma('data_version', { simple: true }))
  if (!Number.isSafeInteger(value) || value < 0) fail('SQLITE_DATA_VERSION_INVALID')
  return value
}

export function readSqliteTotalChanges(db) {
  const row = db.prepare('SELECT total_changes() AS value').get()
  const value = Number(row?.value)
  if (!Number.isSafeInteger(value) || value < 0) fail('SQLITE_TOTAL_CHANGES_INVALID')
  return value
}

export function readBffMetadata(db) {
  assertSchema(db)
  return {
    sessions: db.prepare(`
      SELECT
        ws.session_key,
        ws.owner_user_id,
        ws.status,
        ws.created_at,
        ws.updated_at,
        ws.deleted_at,
        u.id AS registered_owner_id,
        u.status AS owner_status
      FROM workspace_sessions AS ws
      LEFT JOIN users AS u ON u.id = ws.owner_user_id
    `).all(),
    reports: db.prepare(`
      SELECT id, source_session_id, source_user_id, status, created_at, updated_at
      FROM report_files
    `).all(),
    deliveries: db.prepare(`
      SELECT report_id, status, created_at, updated_at
      FROM report_deliveries
    `).all(),
    attachments: db.prepare(`
      SELECT
        session_key,
        retention_class,
        ownership_state,
        lifecycle_state,
        registered_at,
        expires_at,
        updated_at
      FROM session_retention_attachments
    `).all(),
    retention: db.prepare(`
      SELECT
        session_key,
        retention_mode,
        lifecycle_state,
        owner_kind,
        owner_ref,
        last_activity_at,
        updated_at
      FROM session_retention_records
    `).all(),
    taskStatuses: db.prepare(`
      SELECT status, COUNT(*) AS count, MIN(created_at) AS first_created_at, MAX(updated_at) AS last_updated_at
      FROM tasks
      GROUP BY status
    `).all(),
  }
}

function groupCount(rows, keySelector) {
  const groups = new Map()
  for (const row of rows) {
    const key = keySelector(row)
    if (!key) continue
    groups.set(key, (groups.get(key) || 0) + 1)
  }
  return groups
}

function mapUnique(rows, keySelector, failureCode) {
  const result = new Map()
  for (const row of rows) {
    const key = keySelector(row)
    if (!key || result.has(key)) fail(failureCode)
    result.set(key, row)
  }
  return result
}

function lastObservedAt(...values) {
  const valid = values.map(timestamp).filter((value) => value !== null)
  return valid.length > 0 ? Math.max(...valid) : null
}

function summarizeReasonCodes(records) {
  const counts = {}
  for (const record of records) {
    for (const reason of record.reasons) counts[reason] = (counts[reason] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function publicItem(record) {
  return {
    sessionDigest: record.digest,
    reasonCodes: [...record.reasons].sort(),
    state: record.state,
    references: record.references,
    lastObservedAt: isoTimestamp(record.lastObservedAt),
  }
}

function summarizeCategory(name, records, includeItems = true) {
  const ordered = [...records].sort((left, right) => left.digest.localeCompare(right.digest))
  const items = includeItems ? ordered.slice(0, MAX_DETAIL_ITEMS).map(publicItem) : []
  return {
    count: ordered.length,
    fingerprint: stableFingerprint(`category-${name}-v1`, ordered.map((record) => record.digest)),
    reasonCounts: summarizeReasonCodes(ordered),
    detailsIncluded: items.length,
    detailsTruncated: ordered.length > items.length,
    items,
  }
}

function normalizeBffStatus(value) {
  const status = text(value).toLowerCase()
  return status === 'active' || status === 'deleted' ? status : 'unknown'
}

function normalizeRetentionStatus(value) {
  const status = text(value).toLowerCase()
  return ['active', 'pending_delete', 'deleted'].includes(status) ? status : 'unknown'
}

function retentionStatusMismatch(bffStatus, retentionStatus) {
  if (retentionStatus === 'unknown') return true
  if (bffStatus === 'deleted') return retentionStatus !== 'deleted'
  if (bffStatus === 'active') return retentionStatus === 'deleted'
  return true
}

function countActiveAdminTasks(taskStatuses) {
  let count = 0
  let terminalCount = 0
  let unknownCount = 0
  for (const row of taskStatuses) {
    const status = text(row?.status).toLowerCase() || 'unknown'
    const rowCount = nonNegativeInteger(Number(row?.count))
    if (rowCount === null) fail('BFF_TASK_STATUS_INVALID')
    if (ACTIVE_ADMIN_TASK_STATUSES.has(status)) count += rowCount
    else if (['completed', 'failed', 'cancelled', 'archived'].includes(status)) terminalCount += rowCount
    else unknownCount += rowCount
  }
  return { count, terminalCount, unknownCount }
}

export function reconcileSessionMetadata(bff, openclaw) {
  const bffSessions = mapUnique(bff.sessions, (row) => text(row?.session_key), 'BFF_SESSION_METADATA_INVALID')
  const retention = mapUnique(bff.retention, (row) => text(row?.session_key), 'BFF_RETENTION_METADATA_INVALID')
  const reportById = mapUnique(bff.reports, (row) => text(row?.id), 'BFF_REPORT_METADATA_INVALID')
  const reportsBySession = groupCount(bff.reports, (row) => text(row?.source_session_id))
  const attachmentsBySession = groupCount(bff.attachments, (row) => text(row?.session_key))

  const deliveriesBySession = new Map()
  let deliveriesWithoutSessionSource = 0
  for (const delivery of bff.deliveries) {
    const report = reportById.get(text(delivery?.report_id))
    const key = text(report?.source_session_id)
    if (!key) {
      deliveriesWithoutSessionSource += 1
      continue
    }
    deliveriesBySession.set(key, (deliveriesBySession.get(key) || 0) + 1)
  }

  const reportOwners = new Map()
  for (const report of bff.reports) {
    const key = text(report?.source_session_id)
    const owner = text(report?.source_user_id)
    if (!key || !owner) continue
    if (!reportOwners.has(key)) reportOwners.set(key, new Set())
    reportOwners.get(key).add(owner)
  }

  const allKeys = new Set([
    ...bffSessions.keys(),
    ...openclaw.index.sessions.keys(),
    ...openclaw.runtime.sessions.keys(),
    ...retention.keys(),
    ...reportsBySession.keys(),
    ...attachmentsBySession.keys(),
    ...deliveriesBySession.keys(),
  ])

  const records = []
  for (const key of allKeys) {
    const bffRow = bffSessions.get(key)
    const indexRow = openclaw.index.sessions.get(key)
    const runtimeRow = openclaw.runtime.sessions.get(key)
    const retentionRow = retention.get(key)
    const bffStatus = bffRow ? normalizeBffStatus(bffRow.status) : 'absent'
    const retentionStatus = retentionRow ? normalizeRetentionStatus(retentionRow.lifecycle_state) : 'absent'
    const transcriptState = indexRow
      ? (openclaw.missing.missing.has(key) ? 'missing' : (indexRow.sessionId ? 'present' : 'unknown'))
      : 'not_indexed'
    const reports = reportsBySession.get(key) || 0
    const attachments = attachmentsBySession.get(key) || 0
    const deliveries = deliveriesBySession.get(key) || 0
    const activeRuns = runtimeRow?.hasActiveRun === true ? 1 : 0
    const reasons = new Set()

    if (bffRow && indexRow) reasons.add('BOTH_PRESENT')
    else if (indexRow) reasons.add('OPENCLAW_ONLY')
    else if (bffRow) reasons.add('BFF_ONLY')
    else reasons.add('REFERENCE_OR_RETENTION_ONLY')

    if (transcriptState === 'missing') reasons.add('TRANSCRIPT_MISSING')
    else if (transcriptState === 'unknown') reasons.add('TRANSCRIPT_STATUS_UNKNOWN')
    if (reports > 0) reasons.add('REPORT_REFERENCE')
    if (attachments > 0) reasons.add('ATTACHMENT_REFERENCE')
    if (deliveries > 0) reasons.add('DELIVERY_REFERENCE')
    if (activeRuns > 0) reasons.add('ACTIVE_OPENCLAW_RUN')
    if (retentionRow && !bffRow && !indexRow) reasons.add('RETENTION_ONLY')

    let ownerState = 'unknown'
    if (bffRow) {
      const owner = text(bffRow.owner_user_id)
      const registeredOwner = text(bffRow.registered_owner_id)
      const ownerStatus = text(bffRow.owner_status).toLowerCase()
      if (!owner || !registeredOwner || owner !== registeredOwner) {
        reasons.add('OWNER_USER_MISSING')
      } else if (ownerStatus !== 'active') {
        reasons.add('OWNER_USER_INACTIVE_OR_UNKNOWN')
      } else {
        ownerState = 'confirmed'
      }
      const sourceOwners = reportOwners.get(key)
      if (sourceOwners && [...sourceOwners].some((sourceOwner) => sourceOwner !== owner)) {
        ownerState = 'unknown'
        reasons.add('REPORT_OWNER_MISMATCH')
      }
      if (retentionRow) {
        if (text(retentionRow.owner_kind) !== 'workspace_user') {
          ownerState = 'unknown'
          reasons.add('RETENTION_OWNER_KIND_MISMATCH')
        } else if (text(retentionRow.owner_ref) !== owner) {
          ownerState = 'unknown'
          reasons.add('RETENTION_OWNER_MISMATCH')
        }
      }
    } else {
      reasons.add('BFF_OWNER_NOT_REGISTERED')
    }

    let statusState = 'confirmed'
    if (bffStatus === 'unknown') {
      statusState = 'unknown'
      reasons.add('BFF_STATUS_UNKNOWN')
    }
    if (bffStatus === 'deleted' && indexRow) {
      statusState = 'unknown'
      reasons.add('BFF_DELETED_OPENCLAW_PRESENT')
    }
    if (indexRow && !runtimeRow) {
      statusState = 'unknown'
      reasons.add('OPENCLAW_RUNTIME_STATUS_UNAVAILABLE')
    }
    if (retentionRow && bffRow && retentionStatusMismatch(bffStatus, retentionStatus)) {
      statusState = 'unknown'
      reasons.add('RETENTION_STATUS_MISMATCH')
    }
    if (!bffRow || !indexRow || transcriptState === 'missing' || transcriptState === 'unknown') {
      statusState = 'unknown'
    }

    const record = {
      key,
      digest: sessionDigest(key),
      reasons,
      state: {
        bff: bffStatus,
        openclaw: indexRow ? 'present' : 'absent',
        transcript: transcriptState,
        owner: ownerState,
        status: statusState,
      },
      references: { reports, attachments, deliveries, activeRuns },
      lastObservedAt: lastObservedAt(
        bffRow?.updated_at,
        indexRow?.updatedAt,
        runtimeRow?.updatedAt,
        retentionRow?.updated_at,
      ),
    }
    record.normal = Boolean(
      bffRow
      && indexRow
      && bffStatus === 'active'
      && transcriptState === 'present'
      && ownerState === 'confirmed'
      && statusState === 'confirmed',
    )
    records.push(record)
  }

  const bothPresentNormal = records.filter((record) => record.normal)
  const openclawOnly = records.filter((record) => record.reasons.has('OPENCLAW_ONLY'))
  const bffOnly = records.filter((record) => record.reasons.has('BFF_ONLY'))
  const transcriptMissing = records.filter((record) => record.reasons.has('TRANSCRIPT_MISSING'))
  const referenced = records.filter((record) => Object.values(record.references).some((count) => count > 0))
  const ownershipOrStatusUnknown = records.filter(
    (record) => record.state.owner === 'unknown' || record.state.status === 'unknown',
  )
  const referenceOnly = records.filter((record) => record.reasons.has('REFERENCE_OR_RETENTION_ONLY'))
  const activeTasks = countActiveAdminTasks(bff.taskStatuses)
  const reportsWithSource = bff.reports.filter((row) => text(row?.source_session_id)).length
  const reportsWithoutSource = bff.reports.length - reportsWithSource
  const reportSourcesOutsideIndex = bff.reports.filter(
    (row) => text(row?.source_session_id) && !openclaw.index.sessions.has(text(row.source_session_id)),
  ).length
  const reportSourcesOutsideBoth = bff.reports.filter((row) => {
    const key = text(row?.source_session_id)
    return key && !openclaw.index.sessions.has(key) && !bffSessions.has(key)
  }).length
  const missingTranscriptReportSources = transcriptMissing.reduce(
    (total, record) => total + record.references.reports,
    0,
  )

  return {
    schema: RECONCILIATION_SCHEMA,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    totals: {
      openclawIndex: openclaw.index.sessions.size,
      openclawRuntimeRows: openclaw.runtime.sessions.size,
      bffWorkspaceSessions: bffSessions.size,
      bffWorkspaceSessionsActive: [...bffSessions.values()].filter((row) => normalizeBffStatus(row.status) === 'active').length,
      bffWorkspaceSessionsDeleted: [...bffSessions.values()].filter((row) => normalizeBffStatus(row.status) === 'deleted').length,
      overlap: records.filter((record) => record.reasons.has('BOTH_PRESENT')).length,
      indexedTranscriptMissing: transcriptMissing.length,
    },
    categories: {
      both_present_normal: summarizeCategory('both-present-normal', bothPresentNormal, false),
      openclaw_present_bff_unregistered: summarizeCategory('openclaw-only', openclawOnly),
      bff_present_openclaw_absent: summarizeCategory('bff-only', bffOnly),
      indexed_transcript_missing: summarizeCategory('transcript-missing', transcriptMissing),
      referenced: summarizeCategory('referenced', referenced),
      ownership_or_status_unknown: summarizeCategory('ownership-or-status-unknown', ownershipOrStatusUnknown),
      reference_or_retention_only: summarizeCategory('reference-or-retention-only', referenceOnly),
    },
    references: {
      reports: {
        totalRows: bff.reports.length,
        withSourceSession: reportsWithSource,
        withoutSourceSession: reportsWithoutSource,
        uniqueSourceSessions: reportsBySession.size,
        sourceRowsOutsideCurrentOpenClawIndex: reportSourcesOutsideIndex,
        sourceRowsOutsideBothIndexes: reportSourcesOutsideBoth,
        sourceRowsForCurrentMissingTranscripts: missingTranscriptReportSources,
      },
      attachments: {
        totalRows: bff.attachments.length,
        uniqueSessions: attachmentsBySession.size,
        ownershipUnverifiedRows: bff.attachments.filter((row) => text(row?.ownership_state) !== 'verified').length,
      },
      channelDeliveries: {
        totalRows: bff.deliveries.length,
        rowsLinkedThroughReportSource: bff.deliveries.length - deliveriesWithoutSessionSource,
        rowsWithoutSessionSource: deliveriesWithoutSessionSource,
        fileLevelMatchStatus: 'unknown',
        reasonCode: 'CHANNEL_COPY_FILE_RELATION_NOT_REGISTERED',
      },
      activeTasks: {
        openclawActiveRuns: [...openclaw.runtime.sessions.values()].filter((row) => row.hasActiveRun).length,
        adminActiveTaskRowsWithoutSessionRelation: activeTasks.count,
        adminTerminalTaskRowsWithoutSessionRelation: activeTasks.terminalCount,
        adminUnknownStatusTaskRowsWithoutSessionRelation: activeTasks.unknownCount,
        adminSessionRelationStatus: 'unknown',
        reasonCode: 'ADMIN_TASK_SESSION_RELATION_ABSENT',
      },
    },
    changeAssessment: {
      priorMissingTranscriptCause: 'unknown',
      priorReportReferenceChangeCause: 'unknown',
      reasonCodes: ['PRIOR_SNAPSHOT_IDENTITIES_AND_EVENTS_UNAVAILABLE'],
    },
    limitations: [
      'NO_SESSION_BODY_READ',
      'NO_REPORT_BODY_READ',
      'NO_ATTACHMENT_CONTENT_READ',
      'NO_OPENCLAW_FILE_SCAN',
      'ADMIN_TASK_SESSION_RELATION_ABSENT',
      'CHANNEL_COPY_FILE_RELATION_NOT_REGISTERED',
    ],
  }
}

function unknownResult(reasonCode, safety = {}) {
  return {
    schema: RECONCILIATION_SCHEMA,
    status: 'unknown',
    generatedAt: new Date().toISOString(),
    reasonCodes: [reasonCode],
    safety: {
      sqliteReadonly: safety.sqliteReadonly === true,
      sqliteQueryOnly: safety.sqliteQueryOnly === true,
      sqliteTotalChanges: nonNegativeInteger(safety.sqliteTotalChanges),
      sqliteDataVersionStable: safety.sqliteDataVersionStable === true,
      sqliteExternalActivityObserved: safety.sqliteExternalActivityObserved === true,
      bffMetadataStable: safety.bffMetadataStable === true,
      openclawSnapshotStable: safety.openclawSnapshotStable === true,
      fixedOpenClawInterfaces: true,
    },
  }
}

export async function runSessionReconciliation({
  DatabaseClass,
  databasePath = PRODUCTION_DATABASE_PATH,
  commandRunner = runFixedOpenClawCommand,
} = {}) {
  if (typeof DatabaseClass !== 'function') return unknownResult('SQLITE_DRIVER_UNAVAILABLE')
  let db
  const safety = {
    sqliteReadonly: false,
    sqliteQueryOnly: false,
    sqliteTotalChanges: null,
    sqliteDataVersionStable: false,
    sqliteExternalActivityObserved: false,
    bffMetadataStable: false,
    openclawSnapshotStable: false,
  }
  try {
    db = openReadonlyDatabase(databasePath, DatabaseClass)
    safety.sqliteReadonly = true
    safety.sqliteQueryOnly = Number(db.pragma('query_only', { simple: true })) === 1
    const versionBefore = readSqliteDataVersion(db)
    const changesBefore = readSqliteTotalChanges(db)
    const bffBefore = readBffMetadata(db)
    const bffFingerprintBefore = fingerprintBffMetadata(bffBefore)
    const openclawBefore = await readOpenClawSnapshot(commandRunner)
    const openclawAfter = await readOpenClawSnapshot(commandRunner)
    const bffAfter = readBffMetadata(db)
    const bffFingerprintAfter = fingerprintBffMetadata(bffAfter)
    const versionAfter = readSqliteDataVersion(db)
    const changesAfter = readSqliteTotalChanges(db)
    safety.sqliteTotalChanges = changesAfter
    safety.sqliteDataVersionStable = versionBefore === versionAfter
    safety.sqliteExternalActivityObserved = versionBefore !== versionAfter
    safety.bffMetadataStable = bffFingerprintBefore === bffFingerprintAfter
    safety.openclawSnapshotStable = openclawBefore.fingerprint === openclawAfter.fingerprint

    if (changesBefore !== 0 || changesAfter !== 0) return unknownResult('SQLITE_WRITE_DETECTED', safety)
    if (!safety.bffMetadataStable || !safety.openclawSnapshotStable) {
      return unknownResult('DATA_DRIFT', safety)
    }

    const result = reconcileSessionMetadata(bffAfter, openclawAfter)
    result.safety = {
      sqliteReadonly: true,
      sqliteQueryOnly: true,
      sqliteTotalChanges: changesAfter,
      sqliteDataVersionStable: safety.sqliteDataVersionStable,
      sqliteExternalActivityObserved: safety.sqliteExternalActivityObserved,
      bffMetadataStable: true,
      openclawSnapshotStable: true,
      bffMetadataFingerprint: bffFingerprintAfter,
      openclawSnapshotFingerprint: openclawAfter.fingerprint,
      fixedOpenClawInterfaces: true,
      mutationActionsAvailable: false,
    }
    return result
  } catch (error) {
    return unknownResult(safeCode(error), safety)
  } finally {
    try {
      db?.close()
    } catch {
      // Closing a read-only connection must not replace the primary result.
    }
  }
}

export const sessionReconciliationContract = Object.freeze({
  databasePath: PRODUCTION_DATABASE_PATH,
  sqliteOpenOptions: Object.freeze({ readonly: true, fileMustExist: true }),
  openclawExecutable: OPENCLAW_EXECUTABLE,
  openclawCommands: OPENCLAW_COMMANDS,
  outputSchema: RECONCILIATION_SCHEMA,
})
