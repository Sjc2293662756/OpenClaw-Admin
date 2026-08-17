import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat, statfs } from 'node:fs/promises'
import { isAbsolute, normalize, parse } from 'node:path'

export const STORAGE_WATERMARK_POLICY_VERSION = 'gaiop_storage_watermark.v1'
export const STORAGE_WATERMARK_CONFIG_VERSION = 'gaiop_storage_watermark_roots.v1'
export const STORAGE_WATERMARK_THRESHOLDS = Object.freeze({ warning: 75, cleanupRequired: 80, emergency: 90 })
export const STORAGE_WATERMARK_REMINDER_MINUTES = 360

const STATE_LEVEL = Object.freeze({ normal: 0, warning: 1, cleanup_required: 2, emergency: 3 })
const MAX_MANAGED_ROOTS = 64
const MAX_RECENT_EVENTS = 100

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safePositiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, minimum), maximum)
}

function safeReasonCode(value, fallback = 'check_failed') {
  const reason = String(value || '').trim().toLowerCase()
  return /^[a-z0-9_]{1,80}$/.test(reason) ? reason : fallback
}

function stableHash(namespace, value) {
  return createHash('sha256').update(`${namespace}:${String(value)}`, 'utf8').digest('hex').slice(0, 20)
}

function filesystemId(device) {
  return `fs-${stableHash('gaiop-storage-device', device)}`
}

function targetId(label) {
  return `target-${stableHash('gaiop-storage-target', label)}`
}

function unresolvedFilesystemId(label) {
  return `fs-unresolved-${stableHash('gaiop-storage-unresolved', label)}`
}

function normalizeManagedRoot(value) {
  const row = asRecord(value)
  const label = typeof row.label === 'string' ? row.label.trim() : ''
  const rootPath = typeof row.path === 'string' ? normalize(row.path.trim()) : ''
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(label)) throw new Error('managed_root_label_invalid')
  if (!rootPath || !isAbsolute(rootPath)) throw new Error('managed_root_path_invalid')
  const parsedPath = parse(rootPath)
  if (rootPath === parsedPath.root) throw new Error('managed_root_path_too_broad')
  return { label, path: rootPath, targetId: targetId(label) }
}

export function validateManagedRootConfig(value) {
  const row = asRecord(value)
  if (row.version !== STORAGE_WATERMARK_CONFIG_VERSION) throw new Error('managed_root_config_version_invalid')
  if (!Array.isArray(row.managedRoots) || row.managedRoots.length === 0 || row.managedRoots.length > MAX_MANAGED_ROOTS) {
    throw new Error('managed_roots_invalid')
  }
  const roots = row.managedRoots.map(normalizeManagedRoot)
  if (new Set(roots.map((item) => item.label)).size !== roots.length) throw new Error('managed_root_label_duplicate')
  if (new Set(roots.map((item) => item.path)).size !== roots.length) throw new Error('managed_root_path_duplicate')
  return roots
}

export async function loadManagedRootConfig(configPath, read = readFile) {
  const path = String(configPath || '').trim()
  if (!path || !isAbsolute(path)) throw new Error('managed_root_config_path_invalid')
  let parsed
  try {
    parsed = JSON.parse(await read(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('managed_root_config_json_invalid')
    throw new Error('managed_root_config_unreadable')
  }
  return validateManagedRootConfig(parsed)
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw new Error('statfs_value_invalid')
}

export function calculateUsage(space) {
  const blocks = toBigInt(space?.blocks)
  const freeBlocks = toBigInt(space?.bfree)
  const availableBlocks = toBigInt(space?.bavail)
  if (blocks <= 0n || freeBlocks < 0n || availableBlocks < 0n || freeBlocks > blocks) {
    throw new Error('statfs_value_invalid')
  }
  const usedBlocks = blocks - freeBlocks
  const denominator = usedBlocks + availableBlocks
  if (denominator <= 0n) throw new Error('statfs_value_invalid')
  return { usedBlocks, availableBlocks, denominator }
}

export function classifyUsage({ usedBlocks, denominator }) {
  const used = toBigInt(usedBlocks)
  const total = toBigInt(denominator)
  if (used < 0n || total <= 0n || used > total) throw new Error('usage_ratio_invalid')
  if (used * 100n >= total * 90n) return 'emergency'
  if (used * 100n >= total * 80n) return 'cleanup_required'
  if (used * 100n >= total * 75n) return 'warning'
  return 'normal'
}

function usagePercent({ usedBlocks, denominator }) {
  const scaled = (usedBlocks * 1_000_000n) / denominator
  return Number(scaled) / 10_000
}

function thresholdForState(state) {
  if (state === 'emergency') return STORAGE_WATERMARK_THRESHOLDS.emergency
  if (state === 'cleanup_required') return STORAGE_WATERMARK_THRESHOLDS.cleanupRequired
  return STORAGE_WATERMARK_THRESHOLDS.warning
}

function reasonForState(state) {
  if (state === 'emergency') return 'emergency_threshold_reached'
  if (state === 'cleanup_required') return 'cleanup_required_threshold_reached'
  if (state === 'warning') return 'warning_threshold_reached'
  return 'usage_normal'
}

function failureReason(error, stage) {
  const code = String(error?.code || '').toUpperCase()
  if (stage === 'stat') {
    if (code === 'ENOENT') return 'managed_root_not_found'
    if (code === 'EACCES' || code === 'EPERM') return 'managed_root_permission_denied'
    return 'managed_root_stat_failed'
  }
  return 'managed_root_statfs_failed'
}

function isHigherUsage(left, right) {
  return left.usage.usedBlocks * right.usage.denominator > right.usage.usedBlocks * left.usage.denominator
}

export function readStorageWatermarkTargetMappings(db) {
  const mappings = new Map()
  for (const row of db.prepare('SELECT target_id, filesystem_id FROM storage_watermark_targets').all()) {
    mappings.set(row.target_id, row.filesystem_id)
  }
  return mappings
}

export async function inspectManagedRoots(roots, {
  statRoot = stat,
  statFilesystem = statfs,
  previousMappings = new Map(),
  now = Date.now(),
} = {}) {
  const observations = []
  for (const root of [...roots].sort((left, right) => left.label.localeCompare(right.label))) {
    let rootStat
    try {
      rootStat = await statRoot(root.path, { bigint: true })
      if (!rootStat?.isDirectory?.()) throw Object.assign(new Error('not_directory'), { code: 'ENOTDIR' })
    } catch (error) {
      observations.push({
        ...root,
        filesystemId: previousMappings.get(root.targetId) || unresolvedFilesystemId(root.label),
        detectionSuccess: false,
        reasonCode: failureReason(error, 'stat'),
      })
      continue
    }

    const detectedFilesystemId = filesystemId(rootStat.dev)
    try {
      const space = await statFilesystem(root.path, { bigint: true })
      observations.push({
        ...root,
        filesystemId: detectedFilesystemId,
        detectionSuccess: true,
        reasonCode: null,
        usage: calculateUsage(space),
      })
    } catch (error) {
      observations.push({
        ...root,
        filesystemId: detectedFilesystemId,
        detectionSuccess: false,
        reasonCode: failureReason(error, 'statfs'),
      })
    }
  }

  const grouped = new Map()
  for (const observation of observations) {
    if (!grouped.has(observation.filesystemId)) grouped.set(observation.filesystemId, [])
    grouped.get(observation.filesystemId).push(observation)
  }

  return [...grouped.entries()].map(([id, members]) => {
    const failed = members.filter((item) => !item.detectionSuccess)
    const rootsForStatus = members.map((item) => ({ targetId: item.targetId, label: item.label }))
    if (failed.length > 0) {
      return {
        filesystemId: id,
        state: 'unknown',
        detectionSuccess: false,
        usagePercent: null,
        thresholdPercent: null,
        checkedAt: now,
        reasonCode: safeReasonCode(failed[0].reasonCode),
        roots: rootsForStatus,
      }
    }
    let highest = members[0]
    for (const member of members.slice(1)) {
      if (isHigherUsage(member, highest)) highest = member
    }
    const state = classifyUsage(highest.usage)
    return {
      filesystemId: id,
      state,
      detectionSuccess: true,
      usagePercent: usagePercent(highest.usage),
      thresholdPercent: thresholdForState(state),
      checkedAt: now,
      reasonCode: reasonForState(state),
      roots: rootsForStatus,
    }
  }).sort((left, right) => left.filesystemId.localeCompare(right.filesystemId))
}

export function migrateStorageWatermarkTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_watermark_status (
      filesystem_id TEXT PRIMARY KEY,
      policy_version TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('normal', 'warning', 'cleanup_required', 'emergency', 'unknown')),
      detection_success INTEGER NOT NULL CHECK (detection_success IN (0, 1)),
      usage_percent REAL,
      threshold_percent REAL,
      reason_code TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      managed_root_labels TEXT NOT NULL,
      last_event_at INTEGER,
      is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_storage_watermark_status_current
      ON storage_watermark_status(is_current, state, filesystem_id);

    CREATE TABLE IF NOT EXISTS storage_watermark_targets (
      target_id TEXT PRIMARY KEY,
      managed_root_label TEXT NOT NULL,
      filesystem_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_watermark_events (
      policy_version TEXT NOT NULL,
      filesystem_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('normal', 'warning', 'cleanup_required', 'emergency', 'unknown')),
      usage_percent REAL,
      threshold_percent REAL,
      utc_time TEXT NOT NULL,
      detection_success INTEGER NOT NULL CHECK (detection_success IN (0, 1)),
      reason_code TEXT NOT NULL,
      PRIMARY KEY (filesystem_id, utc_time, reason_code)
    );
    CREATE INDEX IF NOT EXISTS idx_storage_watermark_events_time
      ON storage_watermark_events(utc_time DESC, filesystem_id);

    CREATE TABLE IF NOT EXISTS storage_watermark_lock (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      owner_pid INTEGER,
      owner_token TEXT,
      acquired_at INTEGER,
      released_at INTEGER
    );
    INSERT OR IGNORE INTO storage_watermark_lock (singleton_id) VALUES (1);
  `)
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function acquireStorageWatermarkLock(db, {
  pid = process.pid,
  now = Date.now(),
  ownerToken = randomUUID(),
  isProcessAlive = defaultProcessAlive,
} = {}) {
  const acquire = db.transaction(() => {
    const row = db.prepare('SELECT owner_pid, owner_token FROM storage_watermark_lock WHERE singleton_id = 1').get()
    if (row?.owner_token && isProcessAlive(Number(row.owner_pid))) {
      return { acquired: false, staleRecovered: false }
    }
    const staleRecovered = Boolean(row?.owner_token)
    db.prepare(`
      UPDATE storage_watermark_lock
      SET owner_pid = ?, owner_token = ?, acquired_at = ?, released_at = NULL
      WHERE singleton_id = 1
    `).run(pid, ownerToken, now)
    return { acquired: true, staleRecovered }
  })
  const result = acquire()
  if (!result.acquired) return { ...result, release: null }
  return {
    ...result,
    release: () => db.prepare(`
      UPDATE storage_watermark_lock
      SET owner_pid = NULL, owner_token = NULL, released_at = ?
      WHERE singleton_id = 1 AND owner_token = ?
    `).run(Date.now(), ownerToken),
  }
}

function parseLabels(value) {
  try {
    const labels = JSON.parse(String(value || '[]'))
    return Array.isArray(labels) ? labels.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function previousForResult(result, previousRows) {
  const exact = previousRows.find((row) => row.filesystem_id === result.filesystemId)
  if (exact) return exact
  const labels = new Set(result.roots.map((root) => root.label))
  return previousRows.find((row) => parseLabels(row.managed_root_labels).some((label) => labels.has(label))) || null
}

function shouldEmitEvent(previous, current, reminderMs) {
  if (!previous) return !current.detectionSuccess || STATE_LEVEL[current.state] > 0
  const previousSuccess = previous.detection_success === 1
  if (previousSuccess !== current.detectionSuccess) return true
  if (!current.detectionSuccess) return current.checkedAt - Number(previous.last_event_at || 0) >= reminderMs
  const previousLevel = STATE_LEVEL[previous.state] ?? 0
  const currentLevel = STATE_LEVEL[current.state] ?? 0
  if (previousLevel !== currentLevel) return true
  return currentLevel > 0 && current.checkedAt - Number(previous.last_event_at || 0) >= reminderMs
}

export function persistStorageWatermarkResults(db, results, {
  reminderMinutes = STORAGE_WATERMARK_REMINDER_MINUTES,
} = {}) {
  const reminderMs = safePositiveInteger(reminderMinutes, STORAGE_WATERMARK_REMINDER_MINUTES, 5, 10_080) * 60_000
  const previousRows = db.prepare('SELECT * FROM storage_watermark_status WHERE is_current = 1').all()
  const events = []
  const transaction = db.transaction(() => {
    db.prepare('UPDATE storage_watermark_status SET is_current = 0 WHERE is_current = 1').run()
    for (const result of results) {
      const previous = previousForResult(result, previousRows)
      const emitEvent = shouldEmitEvent(previous, result, reminderMs)
      const lastEventAt = emitEvent ? result.checkedAt : (previous?.last_event_at || null)
      const labels = [...new Set(result.roots.map((root) => root.label))].sort()
      for (const root of result.roots) {
        db.prepare(`
          INSERT INTO storage_watermark_targets (target_id, managed_root_label, filesystem_id, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(target_id) DO UPDATE SET
            managed_root_label = excluded.managed_root_label,
            filesystem_id = excluded.filesystem_id,
            updated_at = excluded.updated_at
        `).run(root.targetId, root.label, result.filesystemId, result.checkedAt)
      }
      db.prepare(`
        INSERT INTO storage_watermark_status (
          filesystem_id, policy_version, state, detection_success, usage_percent,
          threshold_percent, reason_code, checked_at, managed_root_labels, last_event_at, is_current
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(filesystem_id) DO UPDATE SET
          policy_version = excluded.policy_version,
          state = excluded.state,
          detection_success = excluded.detection_success,
          usage_percent = excluded.usage_percent,
          threshold_percent = excluded.threshold_percent,
          reason_code = excluded.reason_code,
          checked_at = excluded.checked_at,
          managed_root_labels = excluded.managed_root_labels,
          last_event_at = excluded.last_event_at,
          is_current = 1
      `).run(
        result.filesystemId, STORAGE_WATERMARK_POLICY_VERSION, result.state,
        result.detectionSuccess ? 1 : 0, result.usagePercent, result.thresholdPercent,
        safeReasonCode(result.reasonCode), result.checkedAt, JSON.stringify(labels), lastEventAt,
      )
      if (emitEvent) {
        const event = {
          policyVersion: STORAGE_WATERMARK_POLICY_VERSION,
          filesystemId: result.filesystemId,
          state: result.state,
          usagePercent: result.usagePercent,
          thresholdPercent: result.thresholdPercent,
          utcTime: new Date(result.checkedAt).toISOString(),
          detectionSuccess: result.detectionSuccess,
          reasonCode: safeReasonCode(result.reasonCode),
        }
        db.prepare(`
          INSERT OR IGNORE INTO storage_watermark_events (
            policy_version, filesystem_id, state, usage_percent, threshold_percent,
            utc_time, detection_success, reason_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          event.policyVersion, event.filesystemId, event.state, event.usagePercent,
          event.thresholdPercent, event.utcTime, event.detectionSuccess ? 1 : 0, event.reasonCode,
        )
        events.push(event)
      }
    }
  })
  transaction()
  return events
}

export async function runStorageWatermarkCycle({
  db,
  roots,
  now = Date.now(),
  reminderMinutes = STORAGE_WATERMARK_REMINDER_MINUTES,
  statRoot = stat,
  statFilesystem = statfs,
  pid = process.pid,
  isProcessAlive = defaultProcessAlive,
} = {}) {
  if (!db) throw new Error('database_required')
  const lock = acquireStorageWatermarkLock(db, { pid, now, isProcessAlive })
  if (!lock.acquired) {
    return { acquired: false, staleLockRecovered: false, checkedFilesystems: 0, emittedEvents: [] }
  }
  try {
    const mappings = readStorageWatermarkTargetMappings(db)
    const results = await inspectManagedRoots(roots, { statRoot, statFilesystem, previousMappings: mappings, now })
    const emittedEvents = persistStorageWatermarkResults(db, results, { reminderMinutes })
    return {
      acquired: true,
      staleLockRecovered: lock.staleRecovered,
      checkedFilesystems: results.length,
      failedFilesystems: results.filter((result) => !result.detectionSuccess).length,
      emittedEvents,
    }
  } finally {
    lock.release()
  }
}

function statusProjection(row) {
  return {
    filesystemId: row.filesystem_id,
    state: row.state,
    usagePercent: row.usage_percent,
    thresholdPercent: row.threshold_percent,
    checkedAt: new Date(row.checked_at).toISOString(),
    detectionSuccess: row.detection_success === 1,
    reasonCode: row.reason_code,
    managedRootLabels: parseLabels(row.managed_root_labels),
  }
}

function eventProjection(row) {
  return {
    policyVersion: row.policy_version,
    filesystemId: row.filesystem_id,
    state: row.state,
    usagePercent: row.usage_percent,
    thresholdPercent: row.threshold_percent,
    utcTime: row.utc_time,
    detectionSuccess: row.detection_success === 1,
    reasonCode: row.reason_code,
  }
}

export function listStorageWatermarkOverview(db, { eventLimit = 20 } = {}) {
  const limit = safePositiveInteger(eventLimit, 20, 1, MAX_RECENT_EVENTS)
  return {
    policyVersion: STORAGE_WATERMARK_POLICY_VERSION,
    thresholds: { ...STORAGE_WATERMARK_THRESHOLDS },
    statuses: db.prepare(`
      SELECT * FROM storage_watermark_status
      WHERE is_current = 1
      ORDER BY detection_success ASC, usage_percent DESC, filesystem_id ASC
    `).all().map(statusProjection),
    recentAlerts: db.prepare(`
      SELECT policy_version, filesystem_id, state, usage_percent, threshold_percent,
             utc_time, detection_success, reason_code
      FROM storage_watermark_events
      ORDER BY utc_time DESC, filesystem_id ASC
      LIMIT ?
    `).all(limit).map(eventProjection),
  }
}

export const __test__ = {
  STATE_LEVEL,
  failureReason,
  filesystemId,
  reasonForState,
  safePositiveInteger,
  shouldEmitEvent,
  targetId,
  thresholdForState,
  unresolvedFilesystemId,
  usagePercent,
}
