'use strict'

// This runner has a deliberately fixed scope: it never deploys, restarts, or
// cleans up production files. Its sole temporary write is an SQLite copy in an
// existing component-owned restore-test directory.
const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_SQLITE_VERIFY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_SQLITE_VERIFY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_SQLITE_VERIFY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
const verifier = String.raw`
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const [mode, moduleRoot, target, restoreRoot, component, requiredCsv] = process.argv.slice(2)
const fail = (code) => { const error = new Error(code); error.code = code; throw error }
const reason = (error, fallback) => /^[a-z0-9_]{1,80}$/i.test(String(error?.code || '')) ? String(error.code).toLowerCase() : fallback
const controlled = (directory) => {
  const entry = fs.lstatSync(directory)
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('directory_not_controlled')
  return fs.realpathSync(directory)
}
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const parsedName = (name) => {
  const match = new RegExp('^' + component + '-(daily|weekly|monthly)-(\\d{4}-(?:\\d{2}|W\\d{2}|\\d{2}-\\d{2}))\\.sqlite3$').exec(name)
  if (!match) return null
  const period = name.slice((component + '-' + match[1] + '-').length, -8)
  const valid = (match[1] === 'daily' && /^\d{4}-\d{2}-\d{2}$/.test(period))
    || (match[1] === 'weekly' && /^\d{4}-W\d{2}$/.test(period))
    || (match[1] === 'monthly' && /^\d{4}-\d{2}$/.test(period))
  return valid ? { tier: match[1], period } : null
}
const Database = require(moduleRoot)

async function live() {
  const db = new Database(target, { readonly: true, fileMustExist: true })
  try {
    const quick = db.pragma('quick_check', { simple: true })
    const integrity = db.pragma('integrity_check', { simple: true })
    return { ok: quick === 'ok' && integrity === 'ok', quickCheck: quick === 'ok' ? 'ok' : 'failed', integrityCheck: integrity === 'ok' ? 'ok' : 'failed' }
  } finally { db.close() }
}

async function backupSet() {
  const root = controlled(target)
  const temporary = controlled(restoreRoot)
  if (root === temporary || root.startsWith(temporary + path.sep) || temporary.startsWith(root + path.sep)) fail('restore_roots_overlap')
  const files = []
  const failures = []
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const entryKinds = { sqlite3: 0, manifests: 0, other: 0 }
  const entryNames = entries.map((entry) => entry.name).sort()
  for (const entry of entries) {
    if (entry.name.endsWith('.sqlite3')) entryKinds.sqlite3 += 1
    else if (entry.name.endsWith('.manifest.json')) entryKinds.manifests += 1
    else entryKinds.other += 1
    const parsed = parsedName(entry.name)
    if (!parsed || entry.isSymbolicLink() || !entry.isFile()) continue
    const databasePath = path.join(root, entry.name)
    const stat = fs.statSync(databasePath)
    try {
      const manifest = JSON.parse(fs.readFileSync(databasePath.replace(/\.sqlite3$/, '.manifest.json'), 'utf8'))
      const database = new Database(databasePath, { readonly: true, fileMustExist: true })
      let integrity
      try { integrity = database.pragma('integrity_check', { simple: true }) } finally { database.close() }
      if (manifest.policyVersion !== 'gaiop_sqlite_backup.v1' || manifest.component !== component || manifest.tier !== parsed.tier || manifest.period !== parsed.period || manifest.fileName !== entry.name || manifest.sizeBytes !== stat.size || manifest.sha256 !== digest(databasePath) || integrity !== 'ok') fail('manifest_or_integrity_failed')
      files.push({ ...parsed, sizeBytes: stat.size, modifiedAt: new Date(stat.mtimeMs).toISOString() })
    } catch (error) { failures.push(reason(error, 'backup_validation_failed')) }
  }
  const tiers = Object.fromEntries(['daily', 'weekly', 'monthly'].map((tier) => [tier, { files: 0, bytes: 0, latestPeriod: null, latestModifiedAt: null }]))
  for (const file of files) {
    const summary = tiers[file.tier]
    summary.files += 1
    summary.bytes += file.sizeBytes
    if (!summary.latestModifiedAt || file.modifiedAt > summary.latestModifiedAt) {
      summary.latestPeriod = file.period
      summary.latestModifiedAt = file.modifiedAt
    }
  }
  const latest = files.slice().sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0]
  let restore = { ok: false, status: 'not_run', reasonCode: latest ? null : 'no_valid_backup' }
  if (latest) {
    const source = path.join(root, component + '-' + latest.tier + '-' + latest.period + '.sqlite3')
    const destination = path.join(temporary, component + '-restore-verify-' + crypto.randomUUID() + '.sqlite3')
    try {
      const sourceDb = new Database(source, { readonly: true, fileMustExist: true })
      try { await sourceDb.backup(destination) } finally { sourceDb.close() }
      const copy = new Database(destination, { readonly: true, fileMustExist: true })
      try {
        const integrity = copy.pragma('integrity_check', { simple: true })
        const tables = new Set(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => name))
        const keyTables = Object.fromEntries(requiredCsv.split(',').filter(Boolean).map((name) => [name, tables.has(name)
          ? { present: true, columnCount: copy.pragma('table_info(' + JSON.stringify(name) + ')').length }
          : { present: false, columnCount: 0 }]))
        restore = { ok: integrity === 'ok', status: integrity === 'ok' ? 'verified' : 'failed', sourceTier: latest.tier, sourcePeriod: latest.period, sourceSizeBytes: fs.statSync(source).size, integrityCheck: integrity === 'ok' ? 'ok' : 'failed', tableCount: tables.size, keyTables }
      } finally { copy.close() }
    } catch (error) { restore = { ok: false, status: 'failed', reasonCode: reason(error, 'restore_verification_failed') } }
    finally {
      for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(destination + suffix, { force: true }) } catch {} }
    }
  }
  return { ok: failures.length === 0 && restore.ok, directory: { mode: (fs.statSync(root).mode & 0o777).toString(8), restoreMode: (fs.statSync(temporary).mode & 0o777).toString(8), entryCount: entries.length, entryKinds, entryNames }, tiers, invalidBackupCount: failures.length, invalidReasonCodes: [...new Set(failures)], restore }
}

;(async () => {
  try { process.stdout.write(JSON.stringify(mode === 'live' ? await live() : mode === 'backup-set' ? await backupSet() : (() => { fail('mode_invalid') })())) }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, status: 'failed', reasonCode: reason(error, 'verification_failed') })); process.exitCode = 1 }
})()
`

const remoteScript = `${String.raw`set -euo pipefail
phase=prepare_verifier
trap 'printf "ERROR_PHASE=%s\\n" "$phase"' ERR
verifier=$(mktemp /run/gaiop-sqlite-backup-verify.XXXXXX)
cleanup() { rm -f -- "$verifier"; }
trap cleanup EXIT
base64 -d > "$verifier" <<'GAIOP_SQLITE_VERIFIER'
`}${Buffer.from(verifier, 'utf8').toString('base64')}${String.raw`
GAIOP_SQLITE_VERIFIER
chmod 0755 "$verifier"
timer_summary() { active=$(systemctl is-active "$1" 2>/dev/null || true); enabled=$(systemctl is-enabled "$1" 2>/dev/null || true); triggered=$(systemctl show "$1" -p LastTriggerUSec --value 2>/dev/null || true); printf '%s|%s|%s' "$active" "$enabled" "$triggered"; }
service_receipt() { systemctl show "$1" -p Result -p ExecMainStartTimestamp -p ExecMainExitTimestamp -p ExecMainStatus --value 2>/dev/null | paste -sd '|' -; }
disk_summary() { df -Pk "$1" | awk 'NR == 2 { printf "%s|%s", $4, $5 }'; }
switches() { /usr/local/bin/node --env-file="$1" -e "const enabled=(v)=>String(v||'').trim().toLowerCase()==='true'; console.log(JSON.stringify({createEnabled:enabled(process.env['$2']),cleanupEnabled:enabled(process.env['$3'])}))"; }
admin_root=/opt/gaiop/admin
phase=discover_upgrade
upgrade_root=$(systemctl show gaiop-upgrade.service -p WorkingDirectory --value 2>/dev/null || true)
case "$upgrade_root" in /opt/gaiop/*|/opt/gaiop-*) ;; *) exit 41 ;; esac
upgrade_db=unknown
for candidate in /var/lib/gaiop-upgrade/upgrade.db /var/lib/gaiop-upgrade/napm-upgrade.db /var/lib/gaiop/upgrade/upgrade.db /var/lib/gaiop/upgrade/napm-upgrade.db; do if [ -f "$candidate" ]; then upgrade_db="$candidate"; break; fi; done
upgrade_backup_root=unknown
for candidate in /var/lib/gaiop-upgrade/sqlite-backups/v1 /var/lib/gaiop/upgrade/sqlite-backups/v1; do if [ -d "$candidate" ]; then upgrade_backup_root="$candidate"; break; fi; done
test "$upgrade_db" != unknown
test "$upgrade_backup_root" != unknown
upgrade_restore_root="$(dirname "$(dirname "$upgrade_backup_root")")/sqlite-restore-tests"
phase=check_live_databases
admin_live=$(/usr/local/bin/node "$verifier" live "$admin_root/node_modules/better-sqlite3" /var/lib/gaiop/admin/wizard.db x admin x)
upgrade_live=$(/usr/local/bin/node "$verifier" live "$upgrade_root/node_modules/better-sqlite3" "$upgrade_db" x upgrade x)
phase=verify_admin_backup_set
admin_set=$(runuser -u gaiop -- /usr/local/bin/node "$verifier" backup-set "$admin_root/node_modules/better-sqlite3" /var/lib/gaiop/admin/sqlite-backups/v1 /var/lib/gaiop/admin/sqlite-restore-tests admin users,workspace_sessions,report_files)
phase=verify_upgrade_backup_set
upgrade_set=$(/usr/local/bin/node "$verifier" backup-set "$upgrade_root/node_modules/better-sqlite3" "$upgrade_backup_root" "$upgrade_restore_root" upgrade upgrade_tasks,backups,components)
phase=emit_summary
printf 'CHECKED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'ADMIN_TIMER=%s\n' "$(timer_summary gaiop-admin-sqlite-backup.timer)"
printf 'UPGRADE_TIMER=%s\n' "$(timer_summary gaiop-upgrade-sqlite-backup.timer)"
printf 'ADMIN_SERVICE_RECEIPT=%s\n' "$(service_receipt gaiop-admin-sqlite-backup.service)"
printf 'UPGRADE_SERVICE_RECEIPT=%s\n' "$(service_receipt gaiop-upgrade-sqlite-backup.service)"
printf 'ADMIN_SWITCHES_B64=%s\n' "$(switches /etc/gaiop/admin.env GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED | base64 -w 0)"
printf 'UPGRADE_SWITCHES_B64=%s\n' "$(switches /etc/gaiop/upgrade.env GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED | base64 -w 0)"
printf 'ADMIN_LIVE_B64=%s\n' "$(printf '%s' "$admin_live" | base64 -w 0)"
printf 'UPGRADE_LIVE_B64=%s\n' "$(printf '%s' "$upgrade_live" | base64 -w 0)"
printf 'ADMIN_BACKUP_SET_B64=%s\n' "$(printf '%s' "$admin_set" | base64 -w 0)"
printf 'UPGRADE_BACKUP_SET_B64=%s\n' "$(printf '%s' "$upgrade_set" | base64 -w 0)"
printf 'ADMIN_DISK=%s\n' "$(disk_summary /var/lib/gaiop/admin)"
printf 'UPGRADE_DISK=%s\n' "$(disk_summary "$upgrade_backup_root")"
`}`

function run(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

function valuesFrom(output) {
  return Object.fromEntries(String(output || '').split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf('=')
    return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : []
  }))
}
function parseJson(value) { try { return JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8')) } catch { return null } }
function timer(value) { const [active = 'unknown', enabled = 'unknown', lastTriggerAt = null] = String(value || '').split('|'); return { active, enabled, lastTriggerAt: lastTriggerAt || null } }
function receipt(value) { const [result = 'unknown', startedAt = null, completedAt = null, exitStatus = 'unknown'] = String(value || '').split('|'); return { result, exitStatus, startedAt: startedAt || null, completedAt: completedAt || null } }
function disk(value) { const [availableKiB = null, usePercent = null] = String(value || '').split('|'); return { availableKiB: Number(availableKiB) || null, usePercent: usePercent || null } }
function summarize(output, completed) {
  const values = valuesFrom(output)
  const component = (name) => ({ timer: timer(values[`${name}_TIMER`]), lastServiceReceipt: receipt(values[`${name}_SERVICE_RECEIPT`]), switches: parseJson(values[`${name}_SWITCHES_B64`]), liveDatabase: parseJson(values[`${name}_LIVE_B64`]), backupSet: parseJson(values[`${name}_BACKUP_SET_B64`]), disk: disk(values[`${name}_DISK`]) })
  return { completed, errorCode: completed ? null : `SQLITE_VERIFY_REMOTE_${String(values.ERROR_PHASE || 'FAILED').toUpperCase()}`, mode: 'sqlite-backup-recovery-verify', checkedAt: values.CHECKED_AT || null, admin: component('ADMIN'), upgrade: component('UPGRADE') }
}

module.exports = { __test__: { disk, receipt, summarize, timer, valuesFrom } }

if (require.main === module) {
  if (!connection.host || !connection.username || !connection.password) {
    throw new Error('The controlled SQLite verification connection is incomplete.')
  }
  const client = new Client()
  let finished = false
  const timeout = setTimeout(() => {
    if (!finished) { finished = true; process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'SQLITE_VERIFY_TIMEOUT' })}\n`); client.end(); process.exitCode = 1 }
  }, 120_000)
  client.on('ready', async () => {
    const remote = await run(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(summarize(remote.output, remote.ok))}\n`)
    client.end()
    if (!remote.ok) process.exitCode = 1
  })
  client.on('error', () => {
    if (!finished) { finished = true; clearTimeout(timeout); process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'SQLITE_VERIFY_SSH_FAILED' })}\n`); process.exitCode = 1 }
  })
  client.connect(connection)
}
