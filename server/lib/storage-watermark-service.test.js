import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  acquireStorageWatermarkLock,
  calculateUsage,
  classifyUsage,
  inspectManagedRoots,
  listStorageWatermarkOverview,
  migrateStorageWatermarkTables,
  runStorageWatermarkCycle,
  validateManagedRootConfig,
} from './storage-watermark-service.js'

function createDb() {
  const db = new Database(':memory:')
  migrateStorageWatermarkTables(db)
  return db
}

function roots(items = [
  { label: 'admin_state', path: '/var/lib/gaiop/admin' },
]) {
  return validateManagedRootConfig({
    version: 'gaiop_storage_watermark_roots.v1',
    managedRoots: items,
  })
}

function space(used, total = 10_000) {
  const free = total - used
  return { blocks: BigInt(total), bfree: BigInt(free), bavail: BigInt(free) }
}

function directoryStat(device) {
  return { dev: BigInt(device), isDirectory: () => true }
}

test('classifies every fixed raw boundary without rounded threshold decisions', () => {
  const cases = [
    [7_499, 'normal'],
    [7_500, 'warning'],
    [7_999, 'warning'],
    [8_000, 'cleanup_required'],
    [8_999, 'cleanup_required'],
    [9_000, 'emergency'],
  ]
  for (const [used, expected] of cases) {
    assert.equal(classifyUsage(calculateUsage(space(used))), expected)
  }
})

test('groups multiple managed roots on the same device into one filesystem status', async () => {
  const configured = roots([
    { label: 'admin_state', path: '/var/lib/gaiop/admin' },
    { label: 'formal_reports', path: '/var/lib/gaiop/reports' },
  ])
  let statCalls = 0
  let statfsCalls = 0
  const result = await inspectManagedRoots(configured, {
    now: 1,
    statRoot: async () => { statCalls += 1; return directoryStat(41) },
    statFilesystem: async () => { statfsCalls += 1; return space(7_600) },
  })
  assert.equal(statCalls, 2)
  assert.equal(statfsCalls, 2)
  assert.equal(result.length, 1)
  assert.equal(result[0].state, 'warning')
  assert.deepEqual(result[0].roots.map((item) => item.label), ['admin_state', 'formal_reports'])
  assert.match(result[0].filesystemId, /^fs-[a-f0-9]{20}$/)
})

test('keeps different devices separate instead of using a host-wide maximum', async () => {
  const configured = roots([
    { label: 'admin_state', path: '/var/lib/gaiop/admin' },
    { label: 'upgrade_rollback', path: '/var/backups/gaiop/upgrade' },
  ])
  const byPath = new Map([
    [configured[0].path, { device: 1, usage: space(7_000) }],
    [configured[1].path, { device: 2, usage: space(9_100) }],
  ])
  const result = await inspectManagedRoots(configured, {
    statRoot: async (path) => directoryStat(byPath.get(path).device),
    statFilesystem: async (path) => byPath.get(path).usage,
  })
  assert.equal(result.length, 2)
  assert.deepEqual(result.map((item) => item.state).sort(), ['emergency', 'normal'])
})

test('reports missing, permission and statfs failures without parent fallback', async () => {
  const configured = roots([
    { label: 'missing_root', path: '/var/lib/gaiop/missing' },
    { label: 'private_root', path: '/var/lib/gaiop/private' },
    { label: 'statfs_root', path: '/var/lib/gaiop/statfs' },
  ])
  const visited = []
  const result = await inspectManagedRoots(configured, {
    statRoot: async (path) => {
      visited.push(['stat', path])
      if (path.endsWith('missing')) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      if (path.endsWith('private')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return directoryStat(3)
    },
    statFilesystem: async (path) => {
      visited.push(['statfs', path])
      throw Object.assign(new Error('io'), { code: 'EIO' })
    },
  })
  assert.deepEqual(result.map((item) => item.reasonCode).sort(), [
    'managed_root_not_found',
    'managed_root_permission_denied',
    'managed_root_statfs_failed',
  ])
  assert.equal(result.filter((item) => item.filesystemId.startsWith('fs-unresolved-')).length, 2)
  assert.equal(result.filter((item) => /^fs-[a-f0-9]{20}$/.test(item.filesystemId)).length, 1)
  assert.equal(visited.length, 4)
  assert.equal(visited.some(([, path]) => path === '/var' || path === '\\var'), false)
})

test('persists transitions and suppresses repeats across process-style restarts', async () => {
  const db = createDb()
  const configured = roots()
  const base = Date.UTC(2026, 7, 17, 0, 0, 0)
  let currentSpace = space(7_500)
  const run = (now) => runStorageWatermarkCycle({
    db,
    roots: configured,
    now,
    reminderMinutes: 360,
    statRoot: async () => directoryStat(10),
    statFilesystem: async () => currentSpace,
  })

  assert.equal((await run(base)).emittedEvents.length, 1)
  assert.equal((await run(base + 5 * 60_000)).emittedEvents.length, 0)
  assert.equal(listStorageWatermarkOverview(db).recentAlerts.length, 1)

  currentSpace = space(8_000)
  assert.equal((await run(base + 10 * 60_000)).emittedEvents.length, 1)
  currentSpace = space(7_499)
  assert.equal((await run(base + 15 * 60_000)).emittedEvents.length, 1)
  currentSpace = space(7_500)
  assert.equal((await run(base + 20 * 60_000)).emittedEvents.length, 1)
  assert.equal((await run(base + 379 * 60_000)).emittedEvents.length, 0)
  assert.equal((await run(base + 380 * 60_000)).emittedEvents.length, 1)

  const overview = listStorageWatermarkOverview(db)
  assert.equal(overview.statuses.length, 1)
  assert.equal(overview.statuses[0].state, 'warning')
  assert.equal(overview.recentAlerts.length, 5)
  db.close()
})

test('persists check failures and emits one recovery after restart', async () => {
  const db = createDb()
  const configured = roots()
  const base = Date.UTC(2026, 7, 17, 0, 0, 0)
  let failed = true
  const run = (now) => runStorageWatermarkCycle({
    db,
    roots: configured,
    now,
    statRoot: async () => {
      if (failed) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return directoryStat(22)
    },
    statFilesystem: async () => space(7_000),
  })
  assert.equal((await run(base)).emittedEvents.length, 1)
  assert.equal((await run(base + 5 * 60_000)).emittedEvents.length, 0)
  failed = false
  assert.equal((await run(base + 10 * 60_000)).emittedEvents.length, 1)
  const alerts = listStorageWatermarkOverview(db).recentAlerts
  assert.equal(alerts[0].reasonCode, 'usage_normal')
  assert.equal(alerts[0].detectionSuccess, true)
  db.close()
})

test('enforces one instance and safely takes over a dead-pid lease without deleting it', () => {
  const db = createDb()
  const first = acquireStorageWatermarkLock(db, { pid: 101, ownerToken: 'first', isProcessAlive: () => true })
  assert.equal(first.acquired, true)
  const held = acquireStorageWatermarkLock(db, { pid: 202, ownerToken: 'second', isProcessAlive: () => true })
  assert.equal(held.acquired, false)
  const recovered = acquireStorageWatermarkLock(db, { pid: 303, ownerToken: 'third', isProcessAlive: () => false })
  assert.equal(recovered.acquired, true)
  assert.equal(recovered.staleRecovered, true)
  recovered.release()
  const lock = db.prepare('SELECT owner_pid, owner_token, released_at FROM storage_watermark_lock WHERE singleton_id = 1').get()
  assert.equal(lock.owner_pid, null)
  assert.equal(lock.owner_token, null)
  assert.equal(Number.isInteger(lock.released_at), true)
  db.close()
})

test('monitor sources contain no file deletion, directory traversal, cleaner call or command execution', () => {
  const service = readFileSync(new URL('./storage-watermark-service.js', import.meta.url), 'utf8')
  const entrypoint = readFileSync(new URL('../storage-watermark-monitor.js', import.meta.url), 'utf8')
  const source = `${service}\n${entrypoint}`
  assert.doesNotMatch(source, /\b(?:unlink|rmSync|rmdir|readdir|opendir|execSync|execFile|spawn)\b/)
  assert.doesNotMatch(source, /runAdminRetentionCleanup|cleanupExpired|retention-cleaner|sessions\.delete/)
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i)
  assert.doesNotMatch(entrypoint, /from ['"]\.\/database\.js['"]/)
  assert.match(entrypoint, /fileMustExist:\s*true/)
  assert.match(entrypoint, /migrateStorageWatermarkTables\(db\)/)
  assert.match(service, /statRoot\(root\.path/)
  assert.match(service, /statFilesystem\(root\.path/)
})

test('standalone monitor migrates only its own tables in an existing Admin database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-watermark-entrypoint-'))
  const dataDirectory = join(directory, 'data')
  const managedRoot = join(directory, 'managed-root')
  const configPath = join(directory, 'managed-roots.json')
  mkdirSync(dataDirectory)
  mkdirSync(managedRoot)
  new Database(join(dataDirectory, 'wizard.db')).close()
  writeFileSync(configPath, JSON.stringify({
    version: 'gaiop_storage_watermark_roots.v1',
    managedRoots: [{ label: 'admin_state', path: managedRoot }],
  }))

  try {
    const monitorPath = fileURLToPath(new URL('../storage-watermark-monitor.js', import.meta.url))
    const result = spawnSync(process.execPath, [monitorPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GAIOP_ADMIN_DATA_DIR: dataDirectory,
        GAIOP_STORAGE_WATERMARK_CONFIG: configPath,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).completed, true)

    const db = new Database(join(dataDirectory, 'wizard.db'), { readonly: true })
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name)
    assert.deepEqual(tables, [
      'storage_watermark_events',
      'storage_watermark_lock',
      'storage_watermark_status',
      'storage_watermark_targets',
    ])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_watermark_status').get().count, 1)
    db.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
