import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  OPENCLAW_EXECUTABLE,
  ReconciliationError,
  parseMissingTranscriptDryRun,
  parseOpenClawIndex,
  runFixedOpenClawCommand,
  runSessionReconciliation,
} from './session-reconciliation.js'

function createTestDatabaseClass(onOpen = () => {}) {
  function TestDatabase(databasePath, options) {
    onOpen(databasePath, options)
    return new Database(databasePath, options)
  }
  TestDatabase.allowTestDatabasePath = true
  return TestDatabase
}

function createFixtureDatabase(databasePath) {
  const db = new Database(databasePath)
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      status TEXT
    );
    CREATE TABLE workspace_sessions (
      session_key TEXT PRIMARY KEY,
      owner_user_id TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      deleted_at INTEGER
    );
    CREATE TABLE report_files (
      id TEXT PRIMARY KEY,
      source_session_id TEXT,
      source_user_id TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE report_deliveries (
      report_id TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE session_retention_attachments (
      session_key TEXT,
      retention_class TEXT,
      ownership_state TEXT,
      lifecycle_state TEXT,
      registered_at INTEGER,
      expires_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE session_retention_records (
      session_key TEXT PRIMARY KEY,
      retention_mode TEXT,
      lifecycle_state TEXT,
      owner_kind TEXT,
      owner_ref TEXT,
      last_activity_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE tasks (
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `)

  db.prepare('INSERT INTO users (id, status) VALUES (?, ?)').run('user-active', 'active')
  const insertSession = db.prepare(`
    INSERT INTO workspace_sessions
      (session_key, owner_user_id, status, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const now = 1_800_000_000_000
  insertSession.run('session-normal', 'user-active', 'active', now - 6000, now - 5000, null)
  insertSession.run('session-bff-only', 'user-active', 'active', now - 6000, now - 4000, null)
  insertSession.run('session-missing', 'user-active', 'active', now - 6000, now - 3000, null)
  insertSession.run('session-referenced', 'user-active', 'active', now - 6000, now - 2000, null)
  insertSession.run('session-owner-unknown', 'user-absent', 'active', now - 6000, now - 1000, null)
  insertSession.run('session-deleted-present', 'user-active', 'deleted', now - 6000, now, now)

  const insertReport = db.prepare(`
    INSERT INTO report_files
      (id, source_session_id, source_user_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  insertReport.run('report-referenced', 'session-referenced', 'user-active', 'ready', now, now)
  insertReport.run('report-missing', 'session-missing', 'user-active', 'ready', now, now)
  insertReport.run('report-history', 'session-history-only', null, 'ready', now, now)
  insertReport.run('report-without-source', null, null, 'ready', now, now)
  db.prepare('INSERT INTO report_deliveries (report_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('report-referenced', 'confirmed', now, now)
  db.prepare('INSERT INTO report_deliveries (report_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('report-without-source', 'prepared', now, now)
  db.prepare(`
    INSERT INTO session_retention_attachments
      (session_key, retention_class, ownership_state, lifecycle_state, registered_at, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('session-referenced', 'follow_session', 'verified', 'active', now, null, now)
  db.prepare(`
    INSERT INTO session_retention_records
      (session_key, retention_mode, lifecycle_state, owner_kind, owner_ref, last_activity_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('session-referenced', 'standard', 'active', 'workspace_user', 'user-active', now, now)
  db.prepare('INSERT INTO tasks (status, created_at, updated_at) VALUES (?, ?, ?)').run('pending', now, now)
  db.prepare('INSERT INTO tasks (status, created_at, updated_at) VALUES (?, ?, ?)').run('completed', now, now)
  db.close()
}

function indexOutput(sessions) {
  return JSON.stringify({
    count: sessions.length,
    totalCount: sessions.length,
    limitApplied: null,
    hasMore: false,
    sessions,
  })
}

function runtimeOutput(sessions) {
  return JSON.stringify({
    count: sessions.length,
    totalCount: sessions.length,
    limitApplied: 100000,
    hasMore: false,
    sessions,
  })
}

function cleanupToken(key) {
  return key.length > 26 ? `${key.slice(0, 16)}...${key.slice(-6)}` : key
}

function missingOutput(keys) {
  const rows = keys.map((key) => `prune-missing ${cleanupToken(key)} 1m model missing`).join('\n')
  return [
    'Maintenance mode: warn',
    `Would prune missing transcripts: ${keys.length}`,
    rows,
  ].filter(Boolean).join('\n')
}

function baseOpenClawRows() {
  const keys = [
    'session-normal',
    'session-openclaw-only',
    'session-missing',
    'session-referenced',
    'session-owner-unknown',
    'session-deleted-present',
  ]
  return {
    index: keys.map((key, index) => ({ key, sessionId: `opaque-${index}`, updatedAt: 1_800_000_000_000 + index })),
    runtime: keys.map((key, index) => ({
      key,
      updatedAt: 1_800_000_000_000 + index,
      hasActiveRun: key === 'session-referenced',
    })),
    missing: ['session-missing'],
  }
}

function stableCommandRunner(rows = baseOpenClawRows()) {
  return async (kind) => {
    if (kind === 'index') return indexOutput(rows.index)
    if (kind === 'runtime') return runtimeOutput(rows.runtime)
    if (kind === 'missing') return missingOutput(rows.missing)
    throw new ReconciliationError('OPENCLAW_COMMAND_NOT_ALLOWED')
  }
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function withFixture(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-session-reconciliation-'))
  const databasePath = join(directory, 'wizard.db')
  createFixtureDatabase(databasePath)
  return Promise.resolve(callback({ directory, databasePath })).finally(() => {
    rmSync(directory, { recursive: true, force: true })
  })
}

test('reconciles normal, one-sided, missing, referenced, unknown ownership and active-run metadata', () => withFixture(async ({ databasePath }) => {
  const openCalls = []
  const result = await runSessionReconciliation({
    DatabaseClass: createTestDatabaseClass((path, options) => openCalls.push({ path, options })),
    databasePath,
    commandRunner: stableCommandRunner(),
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(openCalls, [{
    path: databasePath,
    options: { readonly: true, fileMustExist: true },
  }])
  assert.deepEqual(result.totals, {
    openclawIndex: 6,
    openclawRuntimeRows: 6,
    bffWorkspaceSessions: 6,
    bffWorkspaceSessionsActive: 5,
    bffWorkspaceSessionsDeleted: 1,
    overlap: 5,
    indexedTranscriptMissing: 1,
  })
  assert.equal(result.categories.both_present_normal.count, 2)
  assert.equal(result.categories.openclaw_present_bff_unregistered.count, 1)
  assert.equal(result.categories.bff_present_openclaw_absent.count, 1)
  assert.equal(result.categories.indexed_transcript_missing.count, 1)
  assert.equal(result.categories.referenced.count, 3)
  assert.equal(result.categories.reference_or_retention_only.count, 1)
  assert.equal(result.categories.ownership_or_status_unknown.count, 6)
  assert.equal(result.references.reports.totalRows, 4)
  assert.equal(result.references.reports.withSourceSession, 3)
  assert.equal(result.references.reports.sourceRowsOutsideCurrentOpenClawIndex, 1)
  assert.equal(result.references.reports.sourceRowsOutsideBothIndexes, 1)
  assert.equal(result.references.reports.sourceRowsForCurrentMissingTranscripts, 1)
  assert.equal(result.references.attachments.totalRows, 1)
  assert.equal(result.references.channelDeliveries.rowsLinkedThroughReportSource, 1)
  assert.equal(result.references.channelDeliveries.rowsWithoutSessionSource, 1)
  assert.equal(result.references.activeTasks.openclawActiveRuns, 1)
  assert.equal(result.references.activeTasks.adminActiveTaskRowsWithoutSessionRelation, 1)
  assert.equal(result.references.activeTasks.adminSessionRelationStatus, 'unknown')
  assert.equal(result.changeAssessment.priorMissingTranscriptCause, 'unknown')
  assert.equal(result.safety.sqliteTotalChanges, 0)
  assert.equal(result.safety.mutationActionsAvailable, false)

  const serialized = JSON.stringify(result)
  for (const sensitive of [
    'session-normal',
    'session-openclaw-only',
    'session-history-only',
    'user-active',
    'report-referenced',
  ]) assert.equal(serialized.includes(sensitive), false)
}))

test('maps the OpenClaw truncated cleanup token without reading transcripts', () => {
  const key = 'agent:main:channel:peer:1234567890abcdef'
  const index = parseOpenClawIndex(indexOutput([{ key, sessionId: 'opaque', updatedAt: 1 }]))
  const parsed = parseMissingTranscriptDryRun(missingOutput([key]), index.sessions)
  assert.deepEqual([...parsed.missing], [key])
})

test('returns unknown when OpenClaw metadata drifts between the two snapshots', () => withFixture(async ({ databasePath }) => {
  const rows = baseOpenClawRows()
  let indexCalls = 0
  const runner = async (kind) => {
    if (kind === 'index') {
      indexCalls += 1
      const current = indexCalls === 1
        ? rows.index
        : rows.index.map((row, index) => index === 0 ? { ...row, updatedAt: row.updatedAt + 1 } : row)
      return indexOutput(current)
    }
    if (kind === 'runtime') return runtimeOutput(rows.runtime)
    return missingOutput(rows.missing)
  }
  const result = await runSessionReconciliation({
    DatabaseClass: createTestDatabaseClass(),
    databasePath,
    commandRunner: runner,
  })
  assert.equal(result.status, 'unknown')
  assert.deepEqual(result.reasonCodes, ['DATA_DRIFT'])
  assert.equal(result.safety.openclawSnapshotStable, false)
  assert.equal('totals' in result, false)
}))

test('returns unknown when SQLite data_version changes through an external writer', () => withFixture(async ({ databasePath }) => {
  const rows = baseOpenClawRows()
  let mutated = false
  const runner = async (kind) => {
    if (!mutated) {
      mutated = true
      const writer = new Database(databasePath)
      writer.prepare('UPDATE workspace_sessions SET updated_at = updated_at + 1 WHERE session_key = ?')
        .run('session-normal')
      writer.close()
    }
    if (kind === 'index') return indexOutput(rows.index)
    if (kind === 'runtime') return runtimeOutput(rows.runtime)
    return missingOutput(rows.missing)
  }
  const result = await runSessionReconciliation({
    DatabaseClass: createTestDatabaseClass(),
    databasePath,
    commandRunner: runner,
  })
  assert.equal(result.status, 'unknown')
  assert.deepEqual(result.reasonCodes, ['DATA_DRIFT'])
  assert.equal(result.safety.sqliteDataVersionStable, false)
  assert.equal(result.safety.sqliteTotalChanges, 0)
}))

test('returns unknown instead of historical data when an OpenClaw interface fails', () => withFixture(async ({ databasePath }) => {
  const rows = baseOpenClawRows()
  const result = await runSessionReconciliation({
    DatabaseClass: createTestDatabaseClass(),
    databasePath,
    commandRunner: async (kind) => {
      if (kind === 'runtime') throw new ReconciliationError('OPENCLAW_RUNTIME_FAILED')
      if (kind === 'index') return indexOutput(rows.index)
      return missingOutput(rows.missing)
    },
  })
  assert.equal(result.status, 'unknown')
  assert.deepEqual(result.reasonCodes, ['OPENCLAW_RUNTIME_FAILED'])
  assert.equal('categories' in result, false)
}))

test('keeps the SQLite database byte-for-byte unchanged with zero connection writes', () => withFixture(async ({ databasePath }) => {
  const beforeHash = fileHash(databasePath)
  const beforeMtime = statSync(databasePath).mtimeMs
  const result = await runSessionReconciliation({
    DatabaseClass: createTestDatabaseClass(),
    databasePath,
    commandRunner: stableCommandRunner(),
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.safety.sqliteReadonly, true)
  assert.equal(result.safety.sqliteQueryOnly, true)
  assert.equal(result.safety.sqliteTotalChanges, 0)
  assert.equal(fileHash(databasePath), beforeHash)
  assert.equal(statSync(databasePath).mtimeMs, beforeMtime)
}))

test('uses only the fixed OpenClaw executable and fixed read-only command definitions', async () => {
  const calls = []
  await runFixedOpenClawCommand('index', async (executable, args, options) => {
    calls.push({ executable, args, options })
    return { stdout: indexOutput([]) }
  })
  assert.equal(calls[0].executable, OPENCLAW_EXECUTABLE)
  assert.deepEqual(calls[0].args, ['sessions', '--agent', 'main', '--json', '--limit', 'all'])
  assert.equal(calls[0].options.cwd, '/opt/gaiop/admin')
  await assert.rejects(
    () => runFixedOpenClawCommand('arbitrary', async () => ({ stdout: '' })),
    (error) => error?.code === 'OPENCLAW_COMMAND_NOT_ALLOWED',
  )
})
