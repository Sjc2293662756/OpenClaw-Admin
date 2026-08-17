import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (relativePath) => readFileSync(path.join(repositoryRoot, relativePath), 'utf8')

function parseEnvironmentExample(source) {
  const values = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    assert.notEqual(separator, -1, `invalid environment line: ${line}`)
    const key = line.slice(0, separator)
    assert.equal(values.has(key), false, `duplicate environment key: ${key}`)
    values.set(key, line.slice(separator + 1))
  }
  return values
}

test('all Admin retention mutation switches remain explicitly disabled', () => {
  const environment = parseEnvironmentExample(read('deploy/iso/env/admin.env.example'))
  const disabled = [
    'GAIOP_ADMIN_RETENTION_AUTO_DELETE',
    'GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED',
    'GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED',
    'GAIOP_REPORT_RETENTION_AUTO_PROCESS',
    'GAIOP_SESSION_RETENTION_AUTO_MARK',
    'GAIOP_SESSION_RETENTION_AUTO_DELETE',
  ]
  for (const key of disabled) assert.equal(environment.get(key), 'false', key)
})

test('retention routes and migrations each have one non-overlapping registration', () => {
  const indexSource = read('server/index.js')
  const databaseSource = read('server/database.js')
  const routes = [
    "app.use('/api/reports'",
    "app.use('/api/session-retention'",
    "app.use('/api/system/storage-watermarks'",
  ]
  for (const route of routes) assert.equal(indexSource.split(route).length - 1, 1, route)

  const migrations = [
    'migrateReportRetention(db)',
    'migrateSessionRetentionTables(db)',
    'migrateStorageWatermarkTables(db)',
  ]
  for (const migration of migrations) assert.equal(databaseSource.split(migration).length - 1, 1, migration)
})

test('every Admin retention service, timer and runtime script is uniquely packaged', () => {
  const releaseManifest = read('deploy/iso/release-manifest.example.yaml')
  const units = [
    ['gaiop-admin-retention-cleanup', 'server/admin-retention-cleanup.js'],
    ['gaiop-report-retention-cleanup', 'server/report-retention-cleanup.js'],
    ['gaiop-admin-session-retention', 'server/session-retention-cleanup.js'],
    ['gaiop-admin-sqlite-backup', 'server/sqlite-backup.js'],
    ['gaiop-storage-watermark-monitor', 'server/storage-watermark-monitor.js'],
  ]
  const execTargets = new Set()
  for (const [name, script] of units) {
    const servicePath = `deploy/systemd/${name}.service`
    const timerPath = `deploy/systemd/${name}.timer`
    assert.equal(existsSync(path.join(repositoryRoot, servicePath)), true, servicePath)
    assert.equal(existsSync(path.join(repositoryRoot, timerPath)), true, timerPath)
    assert.equal(existsSync(path.join(repositoryRoot, script)), true, script)

    const service = read(servicePath)
    const timer = read(timerPath)
    const execMatch = service.match(/^ExecStart=\/usr\/local\/bin\/node \/opt\/gaiop\/admin\/(.+)$/m)
    assert.ok(execMatch, `${servicePath} must have a fixed Node entry point`)
    assert.equal(execMatch[1], script)
    assert.equal(execTargets.has(execMatch[1]), false, `duplicate ExecStart: ${execMatch[1]}`)
    execTargets.add(execMatch[1])
    assert.match(timer, new RegExp(`^Unit=${name}\\.service$`, 'm'))
    assert.match(timer, /^Persistent=true$/m)
    assert.match(releaseManifest, new RegExp(`- ${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(releaseManifest, new RegExp(`source: GAIOP-Admin/deploy/systemd/${name}\\.service$`, 'm'))
    assert.match(releaseManifest, new RegExp(`source: GAIOP-Admin/deploy/systemd/${name}\\.timer$`, 'm'))
  }

  assert.match(releaseManifest, /^      - server\/sqlite-restore-test\.js$/m)
  assert.match(releaseManifest, /^      - deploy\/iso\/storage-watermark\/managed-roots\.json$/m)
})
