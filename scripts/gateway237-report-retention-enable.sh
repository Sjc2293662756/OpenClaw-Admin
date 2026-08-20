set -Eeuo pipefail

report_service=gaiop-report-retention-cleanup.service
report_timer=gaiop-report-retention-cleanup.timer
service_file=/etc/systemd/system/gaiop-report-retention-cleanup.service
timer_file=/etc/systemd/system/gaiop-report-retention-cleanup.timer
dropin_dir=/etc/systemd/system/gaiop-report-retention-cleanup.service.d
dropin_file=$dropin_dir/99-gaiop-report-retention-production.conf
policy_file=/etc/gaiop/report-retention.policy
admin_root=/opt/gaiop/admin
admin_db=/var/lib/gaiop/admin/wizard.db
report_root=/var/lib/gaiop/reports
recovery_root=/var/lib/gaiop/report-recovery
backup_root=/var/backups/gaiop/report-retention-enable-$GAIOP_REPORT_RELEASE_ID

timer_state() {
  active=$(systemctl is-active "$1" 2>/dev/null || true)
  enabled=$(systemctl is-enabled "$1" 2>/dev/null || true)
  printf '%s|%s' "$active" "$enabled"
}

http_status() {
  curl -k -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || printf 000
}

normalized_sha() {
  sed 's/\r$//' "$1" | sha256sum | awk '{print $1}'
}

source_permissions() {
  first=1
  printf '['
  for source_path in "$@"; do
    if [ "$first" = 0 ]; then printf ','; fi
    first=0
    printf '{"path":"%s","owner":"%s","mode":"%s"}' \
      "$source_path" "$(stat -c '%U:%G' "$source_path")" "$(stat -c '%a' "$source_path")"
  done
  printf ']'
}

capture_source_modes() {
  : > "$backup_root/source-modes"
  for source_path in "$@"; do
    printf '%s|%s\n' "$source_path" "$(stat -c '%a' "$source_path")" >> "$backup_root/source-modes"
  done
  chmod 0600 "$backup_root/source-modes"
}

restore_source_modes() {
  test -f "$backup_root/source-modes"
  while IFS='|' read -r source_path source_mode; do
    test -e "$source_path"
    test ! -L "$source_path"
    chmod "$source_mode" -- "$source_path"
  done < "$backup_root/source-modes"
}

capture_file() {
  source_path=$1
  label=$2
  if [ -e "$source_path" ] || [ -L "$source_path" ]; then
    test -f "$source_path"
    test ! -L "$source_path"
    cp -a -- "$source_path" "$backup_root/$label"
  else
    : > "$backup_root/$label.absent"
  fi
}

restore_file() {
  target_path=$1
  label=$2
  if [ -f "$backup_root/$label" ]; then
    install -d -o root -g root -m 0755 "$(dirname "$target_path")"
    rm -f -- "$target_path"
    cp -a -- "$backup_root/$label" "$target_path"
  elif [ -f "$backup_root/$label.absent" ]; then
    rm -f -- "$target_path"
  else
    return 1
  fi
}

restore_timer() {
  target_state=$1
  systemctl disable --now "$report_timer" >/dev/null 2>&1 || true
  case "$target_state" in
    active\|enabled) systemctl enable --now "$report_timer" >/dev/null ;;
    inactive\|enabled) systemctl enable "$report_timer" >/dev/null ;;
    active\|disabled) systemctl start "$report_timer" >/dev/null ;;
    inactive\|disabled) ;;
    *) return 1 ;;
  esac
  test "$(timer_state "$report_timer")" = "$target_state"
}

online_backup() {
  source_db=$1
  destination_db=$2
  /usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$source_db" "$destination_db" <<'NODE'
const [modulePath, source, destination] = process.argv.slice(2)
const Database = require(modulePath)
;(async () => {
  const live = new Database(source, { readonly: true, fileMustExist: true })
  try { await live.backup(destination) } finally { live.close() }
  const copy = new Database(destination, { readonly: true, fileMustExist: true })
  try {
    const rows = copy.pragma('integrity_check')
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].integrity_check !== 'ok') process.exit(21)
  } finally { copy.close() }
})().catch(() => process.exit(22))
NODE
  chmod 0600 "$destination_db"
}

source_integrity() {
  /usr/local/bin/node - "$admin_root/node_modules/better-sqlite3" "$admin_db" <<'NODE'
const [modulePath, databasePath] = process.argv.slice(2)
const Database = require(modulePath)
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const rows = db.pragma('integrity_check')
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].integrity_check !== 'ok') process.exit(1)
} finally { db.close() }
NODE
}

inspect_report_state() {
  inspection_now=$1
  runuser -u gaiop -- /usr/local/bin/node - \
    "$admin_root/node_modules/better-sqlite3" "$admin_db" "$report_root" "$recovery_root" \
    "$inspection_now" "$(id -u gaiop)" "$(id -u netinside)" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [modulePath, databasePath, reportRoot, recoveryRoot, nowText, gaiopUidText, netinsideUidText] = process.argv.slice(2)
const Database = require(modulePath)
const now = Number(nowText)
const DAY = 86400000
const cutoff = now - 365 * DAY
const purgeCutoff = now - 7 * DAY
const allowedUids = new Set([Number(gaiopUidText), Number(netinsideUidText)])

function normalizeName(value) {
  const name = String(value || '').trim().replace(/\\/g, '/')
  if (!name || name.startsWith('/') || path.isAbsolute(name)) return null
  const parts = name.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) return null
  return name
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function regularFile(root, registeredName) {
  const name = normalizeName(registeredName)
  if (!name) throw new Error('registered_path_invalid')
  const candidate = path.resolve(root, ...name.split('/'))
  if (!inside(root, candidate)) throw new Error('registered_path_outside_root')
  let current = root
  for (const part of name.split('/')) {
    current = path.resolve(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch { throw new Error('registered_file_missing') }
    if (stat.isSymbolicLink()) throw new Error('registered_path_symlink')
    if (current !== candidate && !stat.isDirectory()) throw new Error('registered_path_parent_invalid')
  }
  const stat = fs.lstatSync(candidate)
  if (!stat.isFile()) throw new Error('registered_path_not_file')
  if (!inside(fs.realpathSync(root), fs.realpathSync(candidate))) throw new Error('registered_path_outside_root')
  return { name, path: candidate, stat }
}

function optionalPath(root, registeredName) {
  const name = normalizeName(registeredName)
  if (!name) throw new Error('registered_path_invalid')
  const candidate = path.resolve(root, ...name.split('/'))
  if (!inside(root, candidate)) throw new Error('registered_path_outside_root')
  let current = root
  const parts = name.split('/')
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.resolve(current, parts[index])
    if (!fs.existsSync(current)) throw new Error('registered_path_parent_missing')
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('registered_path_symlink')
    if (!stat.isDirectory()) throw new Error('registered_path_parent_invalid')
  }
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('registered_path_symlink')
  return { name, path: candidate }
}

function parseObject(file, invalidCode) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalidCode)
    return value
  } catch (error) {
    if (error.message === invalidCode) throw error
    throw new Error(invalidCode)
  }
}

function auditMatches(row, audit, auditName) {
  if (String(audit.reportId || '').trim() !== row.id) return false
  const declaredAudit = normalizeName(audit.relativeAuditPath)
  if (declaredAudit && declaredAudit !== auditName) return false
  const declaredFile = normalizeName(audit.relativeFilePath)
  if (declaredFile) return declaredFile === row.stored_name
  const legacyName = String(audit.fileName || audit.filePath || '').trim().replace(/\\/g, '/').split('/').pop()
  return Boolean(legacyName && (path.posix.dirname(row.stored_name) + '/' + legacyName).replace(/^\.\//, '') === row.stored_name)
}

function walk(root) {
  const files = []
  const directories = []
  const symlinks = []
  function visit(current, relativeRoot) {
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const relativeName = relativeRoot ? relativeRoot + '/' + child.name : child.name
      const full = path.join(current, child.name)
      const stat = fs.lstatSync(full)
      if (child.isSymbolicLink()) {
        symlinks.push({ name: relativeName, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), uid: stat.uid, gid: stat.gid })
      } else if (child.isDirectory()) {
        directories.push(relativeName)
        visit(full, relativeName)
      } else if (child.isFile()) {
        files.push({ name: relativeName, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), uid: stat.uid, gid: stat.gid })
      } else {
        symlinks.push({ name: relativeName, type: 'non_regular', size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), uid: stat.uid, gid: stat.gid })
      }
    }
  }
  visit(root, '')
  files.sort((left, right) => left.name.localeCompare(right.name))
  directories.sort()
  symlinks.sort((left, right) => left.name.localeCompare(right.name))
  return { files, directories, symlinks }
}

function ownershipReason(stat) {
  if (!allowedUids.has(stat.uid)) return 'artifact_owner_invalid'
  if ((stat.mode & 0o002) !== 0) return 'artifact_world_writable'
  return null
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true })
try {
  const integrityRows = db.pragma('integrity_check')
  if (!Array.isArray(integrityRows) || integrityRows.length !== 1 || integrityRows[0].integrity_check !== 'ok') {
    throw new Error('database_integrity_failed')
  }
  const reportRootStat = fs.lstatSync(reportRoot)
  const recoveryRootStat = fs.lstatSync(recoveryRoot)
  if (!reportRootStat.isDirectory() || reportRootStat.isSymbolicLink()) throw new Error('report_root_invalid')
  if (!recoveryRootStat.isDirectory() || recoveryRootStat.isSymbolicLink()) throw new Error('recovery_root_invalid')

  const rows = db.prepare(`
    SELECT id, stored_name, audit_name, original_name, report_type, size, created_at,
           long_term_keep, retention_state, quarantined_at, retention_error_code, retention_updated_at
    FROM report_files ORDER BY created_at, id
  `).all()
  const deliveries = db.prepare('SELECT id, report_id, event_name FROM report_deliveries ORDER BY report_id, id').all()
  const artifacts = db.prepare('SELECT * FROM report_retention_artifacts ORDER BY report_id, id').all()
  const deliveriesByReport = new Map()
  const artifactsByReport = new Map()
  for (const item of deliveries) {
    if (!deliveriesByReport.has(item.report_id)) deliveriesByReport.set(item.report_id, [])
    deliveriesByReport.get(item.report_id).push(item)
  }
  for (const item of artifacts) {
    if (!artifactsByReport.has(item.report_id)) artifactsByReport.set(item.report_id, [])
    artifactsByReport.get(item.report_id).push(item)
  }

  const reportTree = walk(reportRoot)
  const recoveryTree = walk(recoveryRoot)
  const registeredReportFiles = new Set()
  for (const row of rows) {
    const stored = normalizeName(row.stored_name)
    const audit = normalizeName(row.audit_name)
    if (stored) registeredReportFiles.add(stored)
    if (audit) registeredReportFiles.add(audit)
  }
  for (const delivery of deliveries) {
    const event = normalizeName(delivery.event_name)
    if (event) registeredReportFiles.add(event)
  }
  const registeredRecoveryFiles = new Set(artifacts.map((item) => normalizeName(item.recovery_name)).filter(Boolean))
  const registeredRecoveryDirectories = new Set(Array.from(registeredRecoveryFiles, (name) => name.split('/')[0]))
  const protectedUnknownReports = reportTree.files.filter((item) => !registeredReportFiles.has(item.name))
  const unknownRecoveryFiles = recoveryTree.files.filter((item) => !registeredRecoveryFiles.has(item.name))
  const unknownRecoveryDirectories = recoveryTree.directories.filter((name) => !registeredRecoveryDirectories.has(name))
  const gatingAnomalies = []
  for (const item of reportTree.symlinks) gatingAnomalies.push({ scope: 'report_root', code: 'symbolic_or_non_regular_entry', name: item.name })
  for (const item of recoveryTree.symlinks) gatingAnomalies.push({ scope: 'recovery_root', code: 'symbolic_or_non_regular_entry', name: item.name })
  for (const item of unknownRecoveryFiles) gatingAnomalies.push({ scope: 'recovery_root', code: 'unknown_recovery_file', name: item.name })
  for (const name of unknownRecoveryDirectories) gatingAnomalies.push({ scope: 'recovery_root', code: 'unknown_recovery_directory', name })

  const candidates365 = []
  const candidateAnomalies = []
  for (const row of rows.filter((item) => ['active', 'quarantine_pending', 'quarantine_error'].includes(item.retention_state) && Number(item.long_term_keep) === 0 && Number(item.created_at) < cutoff)) {
    const reasons = []
    const descriptions = []
    try {
      if ((artifactsByReport.get(row.id) || []).length) throw new Error('existing_quarantine_plan_requires_manual_review')
      const extension = path.extname(row.stored_name || '').toLowerCase()
      if (!['.docx', '.pdf'].includes(extension)) throw new Error('report_type_not_managed')
      const createdAt = Number(row.created_at)
      if (!Number.isFinite(createdAt) || createdAt <= 0) throw new Error('database_time_invalid')
      const report = regularFile(reportRoot, row.stored_name)
      if (!Number.isFinite(report.stat.mtimeMs) || report.stat.mtimeMs <= 0) throw new Error('file_time_invalid')
      if (report.stat.mtimeMs >= cutoff) throw new Error('file_not_expired')
      if (!Number.isFinite(Number(row.size)) || Number(row.size) !== report.stat.size) throw new Error('report_size_mismatch')
      const reportOwnerReason = ownershipReason(report.stat)
      if (reportOwnerReason) throw new Error(reportOwnerReason)
      descriptions.push({ kind: 'report', name: report.name, size: report.stat.size, mtimeMs: Math.trunc(report.stat.mtimeMs) })

      const auditName = normalizeName(row.audit_name)
      if (!auditName || path.extname(auditName).toLowerCase() !== '.json') throw new Error('audit_registration_invalid')
      const auditFile = regularFile(reportRoot, auditName)
      const auditOwnerReason = ownershipReason(auditFile.stat)
      if (auditOwnerReason) throw new Error(auditOwnerReason)
      if (!auditMatches(row, parseObject(auditFile.path, 'audit_json_invalid'), auditName)) throw new Error('audit_pair_mismatch')
      descriptions.push({ kind: 'audit', name: auditFile.name, size: auditFile.stat.size, mtimeMs: Math.trunc(auditFile.stat.mtimeMs) })

      for (const delivery of deliveriesByReport.get(row.id) || []) {
        const eventName = normalizeName(delivery.event_name)
        if (!eventName || !eventName.startsWith('.delivery-events/') || path.extname(eventName).toLowerCase() !== '.json') {
          throw new Error('delivery_registration_invalid')
        }
        const eventFile = regularFile(reportRoot, eventName)
        const eventOwnerReason = ownershipReason(eventFile.stat)
        if (eventOwnerReason) throw new Error(eventOwnerReason)
        const event = parseObject(eventFile.path, 'delivery_json_invalid')
        if (event.schemaVersion !== 'gaiop.report-delivery.v1' || event.eventType !== 'report_delivery'
          || String(event.reportId || '').trim() !== row.id || String(event.attemptId || '').trim() !== delivery.id) {
          throw new Error('delivery_pair_mismatch')
        }
        descriptions.push({ kind: 'delivery', name: eventFile.name, size: eventFile.stat.size, mtimeMs: Math.trunc(eventFile.stat.mtimeMs) })
      }
      if (new Set(descriptions.map((item) => item.name)).size !== descriptions.length) throw new Error('artifact_registration_duplicate')
    } catch (error) {
      reasons.push(String(error.message || 'candidate_validation_failed'))
    }
    const summary = {
      id: row.id,
      storedName: row.stored_name,
      createdAt: Number(row.created_at),
      retentionState: row.retention_state,
      artifactCount: descriptions.length,
      bytes: descriptions.reduce((sum, item) => sum + Number(item.size || 0), 0),
      status: reasons.length ? 'protected' : 'eligible',
      reasons,
      artifacts: descriptions,
    }
    candidates365.push(summary)
    if (reasons.length) candidateAnomalies.push({ id: row.id, reasons })
  }

  const recovery = []
  const permanentDeleteCandidates = []
  for (const row of rows.filter((item) => ['quarantined', 'restore_error', 'delete_error'].includes(item.retention_state))) {
    const reasons = []
    const plan = artifactsByReport.get(row.id) || []
    if (!plan.length) reasons.push('recovery_plan_missing')
    for (const artifact of plan) {
      try {
        const original = optionalPath(reportRoot, artifact.source_name)
        if (fs.existsSync(original.path)) throw new Error('artifact_present_in_report_root')
        if (artifact.state === 'deleted') {
          const deletedPath = optionalPath(recoveryRoot, artifact.recovery_name)
          if (fs.existsSync(deletedPath.path)) throw new Error('deleted_artifact_still_present')
          continue
        }
        const recovered = regularFile(recoveryRoot, artifact.recovery_name)
        if (Number(artifact.size) !== recovered.stat.size) throw new Error('recovery_artifact_mismatch')
        const ownerReason = ownershipReason(recovered.stat)
        if (ownerReason) throw new Error(ownerReason)
      } catch (error) {
        reasons.push(String(error.message || 'recovery_validation_failed'))
      }
    }
    const item = {
      id: row.id,
      retentionState: row.retention_state,
      quarantinedAt: Number(row.quarantined_at) || null,
      recoverableUntil: Number(row.quarantined_at) ? Number(row.quarantined_at) + 7 * DAY : null,
      artifactCount: plan.length,
      bytes: plan.reduce((sum, artifact) => sum + Number(artifact.size || 0), 0),
      reasons: Array.from(new Set(reasons)).sort(),
    }
    recovery.push(item)
    if (item.reasons.length) gatingAnomalies.push({ scope: 'recovery_report', code: 'recovery_group_invalid', id: row.id, reasons: item.reasons })
    if (Number(row.long_term_keep) === 0 && ['quarantined', 'delete_error'].includes(row.retention_state)
      && Number.isFinite(Number(row.quarantined_at)) && Number(row.quarantined_at) < purgeCutoff) {
      permanentDeleteCandidates.push(item)
    }
  }

  const reportIds = new Set(rows.map((row) => row.id))
  for (const artifact of artifacts) {
    if (!reportIds.has(artifact.report_id)) gatingAnomalies.push({ scope: 'recovery_root', code: 'orphan_recovery_artifact', id: artifact.report_id })
  }

  const longTermKeep = rows.filter((row) => Number(row.long_term_keep) === 1).map((row) => ({
    id: row.id,
    storedName: row.stored_name,
    createdAt: Number(row.created_at),
    retentionState: row.retention_state,
  }))
  const counts = {}
  for (const table of ['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs', 'report_retention_artifacts', 'report_retention_audits']) {
    counts[table] = Number(db.prepare('SELECT COUNT(*) AS count FROM "' + table + '"').get().count)
  }
  const stateCounts = Object.fromEntries(db.prepare('SELECT retention_state AS state, COUNT(*) AS count FROM report_files GROUP BY retention_state ORDER BY retention_state').all().map((row) => [row.state, Number(row.count)]))
  const total = (files) => ({ fileCount: files.length, bytes: files.reduce((sum, item) => sum + Number(item.size || 0), 0) })
  process.stdout.write(JSON.stringify({
    checkedAt: new Date(now).toISOString(),
    retentionDays: 365,
    recoveryDays: 7,
    cutoffTime: new Date(cutoff).toISOString(),
    purgeCutoffTime: new Date(purgeCutoff).toISOString(),
    database: { integrity: 'ok', counts, retentionStates: stateCounts },
    roots: {
      reports: { path: reportRoot, uid: reportRootStat.uid, gid: reportRootStat.gid, mode: reportRootStat.mode & 0o777, ...total(reportTree.files) },
      recovery: { path: recoveryRoot, uid: recoveryRootStat.uid, gid: recoveryRootStat.gid, mode: recoveryRootStat.mode & 0o777, ...total(recoveryTree.files) },
    },
    candidates365,
    candidateAnomalies,
    longTermKeep,
    recovery,
    permanentDeleteCandidates,
    protectedUnknownReports,
    unknownRecoveryFiles,
    unknownRecoveryDirectories,
    gatingAnomalies,
  }))
} finally {
  db.close()
}
NODE
}

inventory_gate() {
  /usr/local/bin/node -e "const v=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));const eligible=v.candidates365.filter(x=>x.status==='eligible').length;process.stdout.write([v.permanentDeleteCandidates.length,v.candidateAnomalies.length+v.gatingAnomalies.length,eligible].join('|'))" "$1"
}

journal_cursor() {
  journalctl --sync
  journalctl --quiet --no-pager -n 0 --show-cursor | sed -n 's/^-- cursor: //p'
}

run_report_service() {
  expected_status=$1
  output_file=$2
  cursor=$(journal_cursor)
  test -n "$cursor"
  systemctl reset-failed "$report_service" >/dev/null 2>&1 || true
  systemctl start "$report_service"
  test "$(systemctl show "$report_service" -p Result --value)" = success
  journalctl --sync
  journalctl --quiet --after-cursor="$cursor" -u "$report_service" -o cat --no-pager > "$work_root/report-service.log"
  /usr/local/bin/node - "$work_root/report-service.log" "$expected_status" "$output_file" <<'NODE'
const fs = require('node:fs')
const [logFile, expectedStatus, outputFile] = process.argv.slice(2)
let selected = null
for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  try {
    const value = JSON.parse(line)
    if (value && value.policyVersion === 'gaiop_report_retention.v1') selected = value
  } catch {}
}
if (!selected || selected.status !== expectedStatus) process.exit(1)
if (expectedStatus === 'completed') {
  if (Number(selected.quarantine?.failed || 0) !== 0 || Number(selected.permanentDelete?.success || 0) !== 0
    || Number(selected.permanentDelete?.failed || 0) !== 0) process.exit(2)
}
fs.writeFileSync(outputFile, JSON.stringify(selected))
NODE
}

validate_transition() {
  before_b64=$1
  after_b64=$2
  result_file=$3
  limit=$4
  output_file=$5
  /usr/local/bin/node - "$before_b64" "$after_b64" "$result_file" "$limit" "$output_file" <<'NODE'
const fs = require('node:fs')
const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
const [beforeText, afterText, resultFile, limitText, outputFile] = process.argv.slice(2)
const before = decode(beforeText)
const after = decode(afterText)
const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
const expected = before.candidates365.filter((item) => item.status === 'eligible').slice(0, Number(limitText))
if (result.status !== 'completed' || result.quarantine.success !== expected.length || result.quarantine.failed !== 0
  || result.permanentDelete.success !== 0 || result.permanentDelete.failed !== 0) process.exit(31)
for (const table of ['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']) {
  if (before.database.counts[table] !== after.database.counts[table]) process.exit(32)
}
const artifactCount = expected.reduce((sum, item) => sum + item.artifactCount, 0)
const bytes = expected.reduce((sum, item) => sum + item.bytes, 0)
if (before.roots.reports.fileCount - after.roots.reports.fileCount !== artifactCount
  || after.roots.recovery.fileCount - before.roots.recovery.fileCount !== artifactCount
  || before.roots.reports.bytes - after.roots.reports.bytes !== bytes
  || after.roots.recovery.bytes - before.roots.recovery.bytes !== bytes) process.exit(33)
if (after.database.counts.report_retention_artifacts - before.database.counts.report_retention_artifacts !== artifactCount
  || after.database.counts.report_retention_audits - before.database.counts.report_retention_audits !== expected.length) process.exit(34)
const recoveredIds = new Set(after.recovery.map((item) => item.id))
if (expected.some((item) => !recoveredIds.has(item.id))) process.exit(35)
if (after.candidateAnomalies.length || after.gatingAnomalies.length || after.permanentDeleteCandidates.length) process.exit(36)
fs.writeFileSync(outputFile, JSON.stringify({ handled: expected.map((item) => item.id), artifactCount, bytes }))
NODE
}

validate_timer_runs() {
  cursor=$1
  output_file=$2
  journalctl --sync
  journalctl --quiet --after-cursor="$cursor" -u "$report_service" -o cat --no-pager > "$work_root/report-timer-runs.log"
  /usr/local/bin/node - "$work_root/report-timer-runs.log" "$output_file" <<'NODE'
const fs = require('node:fs')
const [logFile, outputFile] = process.argv.slice(2)
const records = []
for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
  try {
    const value = JSON.parse(line)
    if (value && value.policyVersion === 'gaiop_report_retention.v1') records.push(value)
  } catch {}
}
if (records.some((value) => value.status !== 'completed' || Number(value.quarantine?.failed || 0) !== 0
  || Number(value.permanentDelete?.success || 0) !== 0 || Number(value.permanentDelete?.failed || 0) !== 0)) process.exit(1)
fs.writeFileSync(outputFile, JSON.stringify(records))
NODE
}

validate_total_change() {
  before_b64=$1
  after_b64=$2
  output_file=$3
  /usr/local/bin/node - "$before_b64" "$after_b64" "$output_file" <<'NODE'
const fs = require('node:fs')
const decode = (value) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
const [beforeText, afterText, outputFile] = process.argv.slice(2)
const before = decode(beforeText)
const after = decode(afterText)
for (const table of ['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']) {
  if (before.database.counts[table] !== after.database.counts[table]) process.exit(41)
}

const beforeRecovery = new Set(before.recovery.map((item) => item.id))
const moved = after.recovery.filter((item) => !beforeRecovery.has(item.id))
const eligible = new Map(before.candidates365.filter((item) => item.status === 'eligible').map((item) => [item.id, item]))
if (moved.some((item) => !eligible.has(item.id))) process.exit(42)
const artifactCount = moved.reduce((sum, item) => sum + eligible.get(item.id).artifactCount, 0)
const bytes = moved.reduce((sum, item) => sum + eligible.get(item.id).bytes, 0)
if (before.roots.reports.fileCount - after.roots.reports.fileCount !== artifactCount
  || after.roots.recovery.fileCount - before.roots.recovery.fileCount !== artifactCount
  || before.roots.reports.bytes - after.roots.reports.bytes !== bytes
  || after.roots.recovery.bytes - before.roots.recovery.bytes !== bytes) process.exit(43)
if (after.database.counts.report_retention_artifacts - before.database.counts.report_retention_artifacts !== artifactCount
  || after.database.counts.report_retention_audits - before.database.counts.report_retention_audits !== moved.length) process.exit(44)
if (after.candidateAnomalies.length || after.gatingAnomalies.length || after.permanentDeleteCandidates.length) process.exit(45)
fs.writeFileSync(outputFile, JSON.stringify({
  quarantinedReportIds: moved.map((item) => item.id),
  reportGroups: moved.length,
  artifactCount,
  bytes,
  reportFileCountBefore: before.roots.reports.fileCount,
  reportFileCountAfter: after.roots.reports.fileCount,
  recoveryFileCountBefore: before.roots.recovery.fileCount,
  recoveryFileCountAfter: after.roots.recovery.fileCount,
  reportBytesBefore: before.roots.reports.bytes,
  reportBytesAfter: after.roots.reports.bytes,
  recoveryBytesBefore: before.roots.recovery.bytes,
  recoveryBytesAfter: after.roots.recovery.bytes,
}))
NODE
}

path_summary() {
  /usr/local/bin/node - "$admin_db" "$report_root" "$recovery_root" <<'NODE' | base64 -w 0
const fs = require('node:fs')
const values = process.argv.slice(2).map((path) => {
  const stat = fs.lstatSync(path)
  return {
    path,
    realPath: fs.realpathSync(path),
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o777,
    device: String(stat.dev),
  }
})
process.stdout.write(JSON.stringify(values))
NODE
}

write_policy() {
  max_items=$1
  auto_process=$2
  cat > "$work_root/report-retention.policy" <<POLICY
GAIOP_ADMIN_DATA_DIR=/var/lib/gaiop/admin
GAIOP_REPORTS_DIR=/var/lib/gaiop/reports
GAIOP_REPORT_RECOVERY_DIR=/var/lib/gaiop/report-recovery
GAIOP_REPORT_RETENTION_LOCK_PATH=/run/gaiop-report-retention/retention.lock
GAIOP_REPORT_RETENTION_MAX_ITEMS=$max_items
GAIOP_REPORT_RETENTION_AUTO_PROCESS=$auto_process
POLICY
  install -o root -g gaiop -m 0640 "$work_root/report-retention.policy" "$policy_file"
  /usr/local/bin/node - "$policy_file" "$max_items" "$auto_process" <<'NODE'
const fs = require('node:fs')
const [file, maxItems, autoProcess] = process.argv.slice(2)
const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
const expected = [
  'GAIOP_ADMIN_DATA_DIR=/var/lib/gaiop/admin',
  'GAIOP_REPORTS_DIR=/var/lib/gaiop/reports',
  'GAIOP_REPORT_RECOVERY_DIR=/var/lib/gaiop/report-recovery',
  'GAIOP_REPORT_RETENTION_LOCK_PATH=/run/gaiop-report-retention/retention.lock',
  'GAIOP_REPORT_RETENTION_MAX_ITEMS=' + maxItems,
  'GAIOP_REPORT_RETENTION_AUTO_PROCESS=' + autoProcess,
]
if (JSON.stringify(lines) !== JSON.stringify(expected)) process.exit(1)
NODE
}

wait_for_report_service() {
  for _ in $(seq 1 120); do
    state=$(systemctl is-active "$report_service" 2>/dev/null || true)
    case "$state" in
      active|activating) sleep 1 ;;
      inactive) return 0 ;;
      *) return 1 ;;
    esac
  done
  return 1
}

rollback_enable() {
  set +e
  systemctl disable --now "$report_timer" >/dev/null 2>&1
  systemctl stop "$report_service" >/dev/null 2>&1
  rollback_ok=1
  restore_file "$service_file" report.service || rollback_ok=0
  restore_file "$timer_file" report.timer || rollback_ok=0
  restore_file "$dropin_file" report.dropin || rollback_ok=0
  restore_file "$policy_file" report.policy || rollback_ok=0
  restore_source_modes || rollback_ok=0
  rmdir "$dropin_dir" >/dev/null 2>&1 || true
  systemctl daemon-reload || rollback_ok=0
  original_state=$(cat "$backup_root/report.timer-state" 2>/dev/null || true)
  restore_timer "$original_state" || rollback_ok=0
  if [ "$rollback_ok" = 1 ]; then
    rollback_complete=1
  fi
  set -e
}

finish_enable() {
  rc=$?
  if [ "$completed" != 1 ]; then
    if [ "$backup_captured" = 1 ]; then rollback_enable; else rollback_complete=1; fi
    printf 'FAILED_PHASE=%s\n' "$phase"
    printf 'FAILED_STATUS=%s\n' "$rc"
    if [ -n "${failure_detail_b64:-}" ]; then printf 'FAILED_DETAIL_B64=%s\n' "$failure_detail_b64"; fi
    if [ -n "${source_permissions_b64:-}" ]; then printf 'SOURCE_PERMISSIONS_B64=%s\n' "$source_permissions_b64"; fi
    if [ "$backup_captured" = 1 ]; then
      source_permissions_after_b64=$(source_permissions "${trusted_sources[@]}" | base64 -w 0)
      printf 'SOURCE_PERMISSIONS_AFTER_B64=%s\n' "$source_permissions_after_b64"
    fi
    printf 'ROLLBACK_COMPLETE=%s\n' "$rollback_complete"
    printf 'BACKUP_ROOT=%s\n' "$backup_root"
    printf 'BACKUP_EVIDENCE_PRESERVED=%s\n' "$backup_captured"
  fi
  rm -rf -- "$work_root"
  exit "$rc"
}

postcheck_rollback() {
  test "$(id -u)" = 0
  test -d "$backup_root"
  test ! -L "$backup_root"
  test "$(sha256sum "$service_file" | awk '{print $1}')" = "$GAIOP_REPORT_CURRENT_SERVICE_SHA256"
  test "$(sha256sum "$timer_file" | awk '{print $1}')" = "$GAIOP_REPORT_CURRENT_TIMER_SHA256"
  test "$(sha256sum "$dropin_file" | awk '{print $1}')" = "$GAIOP_REPORT_CURRENT_DROPIN_SHA256"
  test "$(sha256sum "$policy_file" | awk '{print $1}')" = "$GAIOP_REPORT_CURRENT_POLICY_SHA256"
  systemctl disable --now "$report_timer" >/dev/null 2>&1 || true
  systemctl stop "$report_service" >/dev/null 2>&1 || true
  restore_file "$service_file" report.service
  restore_file "$timer_file" report.timer
  restore_file "$dropin_file" report.dropin
  restore_file "$policy_file" report.policy
  restore_source_modes
  rmdir "$dropin_dir" >/dev/null 2>&1 || true
  systemctl daemon-reload
  restore_timer "$(cat "$backup_root/report.timer-state")"
  printf 'POSTCHECK_ROLLBACK_COMPLETE=1\n'
  printf 'BACKUP_EVIDENCE_PRESERVED=1\n'
  printf 'BACKUP_ROOT=%s\n' "$backup_root"
  printf 'REPORT_TIMER=%s\n' "$(timer_state "$report_timer")"
  printf 'ADMIN_HEALTH=%s\n' "$(http_status http://127.0.0.1:3000/api/health)"
  return 0
}

enable_report_retention() {
  test "$(id -u)" = 0
  work_root=$(mktemp -d /run/gaiop-report-retention-enable.XXXXXX)
  phase=preflight
  completed=0
  backup_captured=0
  rollback_complete=0
  failure_detail_b64=''
  source_permissions_b64=''
  source_permissions_after_b64=''
  trap finish_enable EXIT
  trap 'phase=$phase"_line_"$LINENO' ERR

  phase=preflight_timer_state
  test "$(timer_state "$report_timer")" = 'inactive|disabled'
  phase=preflight_services
  test "$(systemctl is-active gaiop-admin.service)" = active
  test "$(systemctl is-active gaiop-upgrade.service)" = active
  test "$(systemctl is-active caddy.service)" = active
  gateway_uid=$(id -u netinside)
  test "$(runuser -u netinside -- env XDG_RUNTIME_DIR=/run/user/$gateway_uid systemctl --user is-active openclaw-gateway.service)" = active
  phase=preflight_database
  test -f "$admin_db"
  test ! -L "$admin_db"
  phase=preflight_paths
  test -d "$report_root"
  test ! -L "$report_root"
  test -d "$recovery_root"
  test ! -L "$recovery_root"
  test "$(realpath -e "$report_root")" != "$(realpath -e "$recovery_root")"
  case "$(realpath -e "$recovery_root")/" in "$(realpath -e "$report_root")/"*) phase=preflight_recovery_inside_reports; exit 61 ;; esac
  case "$(realpath -e "$report_root")/" in "$(realpath -e "$recovery_root")/"*) phase=preflight_reports_inside_recovery; exit 62 ;; esac
  test "$(stat -c '%d' "$report_root")" = "$(stat -c '%d' "$recovery_root")"
  phase=preflight_ownership
  test "$(stat -c '%U:%G' "$report_root")" = 'gaiop:gaiop'
  test "$(stat -c '%U:%G' "$recovery_root")" = 'gaiop:gaiop'
  runuser -u gaiop -- test -r "$report_root"
  runuser -u gaiop -- test -w "$report_root"
  runuser -u gaiop -- test -x "$report_root"
  runuser -u gaiop -- test -r "$recovery_root"
  runuser -u gaiop -- test -w "$recovery_root"
  runuser -u gaiop -- test -x "$recovery_root"
  phase=preflight_permissions
  report_root_mode=$(stat -c '%a' "$report_root")
  recovery_root_mode=$(stat -c '%a' "$recovery_root")
  if (( (8#$report_root_mode & 0002) != 0 )); then phase=preflight_reports_world_writable; exit 63; fi
  if (( (8#$recovery_root_mode & 0002) != 0 )); then phase=preflight_recovery_world_writable; exit 64; fi

  phase=preflight_sources
  trusted_sources=( \
    "$admin_root" "$admin_root/server" "$admin_root/server/lib" "$admin_root/package.json" \
    "$admin_root/server/admin-retention-cleaner.js" "$admin_root/server/database.js" \
    "$admin_root/server/report-retention-cleanup.js" "$admin_root/server/report-retention-service.js" \
    "$admin_root/server/lib/report-retention-schema.js" "$admin_root/server/lib/report-storage-path.js" )
  for trusted in "${trusted_sources[@]}"; do
    test -e "$trusted"
    test ! -L "$trusted"
  done
  source_permissions_b64=$(source_permissions "${trusted_sources[@]}" | base64 -w 0)
  for trusted in "${trusted_sources[@]}"; do
    trusted_owner=$(stat -c '%U:%G' "$trusted")
    if [ "$trusted_owner" != 'gaiop:gaiop' ] && [ "$trusted_owner" != 'root:root' ]; then
      phase=preflight_source_owner
      failure_detail_b64=$(printf '{"path":"%s","owner":"%s","mode":"%s"}' "$trusted" "$trusted_owner" "$(stat -c '%a' "$trusted")" | base64 -w 0)
      exit 65
    fi
  done
  test "$(normalized_sha "$admin_root/server/admin-retention-cleaner.js")" = "$GAIOP_REPORT_EXPECTED_ADMIN_CLEANER_SHA256"
  test "$(normalized_sha "$admin_root/server/database.js")" = "$GAIOP_REPORT_EXPECTED_DATABASE_SHA256"
  test "$(normalized_sha "$admin_root/server/report-retention-cleanup.js")" = "$GAIOP_REPORT_EXPECTED_CLEANUP_SHA256"
  test "$(normalized_sha "$admin_root/server/report-retention-service.js")" = "$GAIOP_REPORT_EXPECTED_SERVICE_LOGIC_SHA256"
  test "$(normalized_sha "$admin_root/server/lib/report-retention-schema.js")" = "$GAIOP_REPORT_EXPECTED_SCHEMA_SHA256"
  test "$(normalized_sha "$admin_root/server/lib/report-storage-path.js")" = "$GAIOP_REPORT_EXPECTED_STORAGE_PATH_SHA256"
  source_integrity

  phase=inventory
  initial_now=$(date +%s%3N)
  initial_inspection_b64=$(inspect_report_state "$initial_now" | base64 -w 0)
  IFS='|' read -r permanent_count anomaly_count eligible_count <<EOF
$(inventory_gate "$initial_inspection_b64")
EOF
  printf 'INITIAL_INSPECTION_B64=%s\n' "$initial_inspection_b64"
  printf 'PERMANENT_DELETE_COUNT=%s\n' "$permanent_count"
  printf 'ANOMALY_COUNT=%s\n' "$anomaly_count"
  printf 'ELIGIBLE_COUNT=%s\n' "$eligible_count"
  if [ "$permanent_count" -ne 0 ]; then phase=permanent_delete_confirmation_required; exit 81; fi
  if [ "$anomaly_count" -ne 0 ]; then phase=report_retention_anomaly_gate; exit 82; fi

  admin_pid_before=$(systemctl show gaiop-admin.service -p MainPID --value)
  upgrade_pid_before=$(systemctl show gaiop-upgrade.service -p MainPID --value)
  caddy_pid_before=$(systemctl show caddy.service -p MainPID --value)
  gateway_pid_before=$(runuser -u netinside -- env XDG_RUNTIME_DIR=/run/user/$gateway_uid systemctl --user show openclaw-gateway.service -p MainPID --value)

  phase=capture
  install -d -o root -g root -m 0700 "$backup_root"
  capture_file "$service_file" report.service
  capture_file "$timer_file" report.timer
  capture_file "$dropin_file" report.dropin
  capture_file "$policy_file" report.policy
  capture_source_modes "${trusted_sources[@]}"
  timer_state "$report_timer" > "$backup_root/report.timer-state"
  backup_captured=1

  phase=database_safety_backup
  online_backup "$admin_db" "$backup_root/wizard.db.before-enable"
  source_integrity
  printf 'ok\n' > "$backup_root/wizard.db.before-enable.integrity"
  chmod 0600 "$backup_root/wizard.db.before-enable.integrity"

  phase=harden_source_permissions
  chmod go-w -- "${trusted_sources[@]}"
  for trusted in "${trusted_sources[@]}"; do
    trusted_mode=$(stat -c '%a' "$trusted")
    if (( (8#$trusted_mode & 0022) != 0 )); then exit 65; fi
  done
  source_permissions_after_b64=$(source_permissions "${trusted_sources[@]}" | base64 -w 0)

  phase=install_controlled_configuration
  printf '%s' "$GAIOP_REPORT_SERVICE_TEMPLATE_B64" | base64 -d > "$work_root/report.service"
  printf '%s' "$GAIOP_REPORT_TIMER_TEMPLATE_B64" | base64 -d > "$work_root/report.timer"
  test "$(normalized_sha "$work_root/report.service")" = "$GAIOP_REPORT_EXPECTED_SERVICE_TEMPLATE_SHA256"
  test "$(normalized_sha "$work_root/report.timer")" = "$GAIOP_REPORT_EXPECTED_TIMER_TEMPLATE_SHA256"
  install -o root -g root -m 0644 "$work_root/report.service" "$service_file"
  install -o root -g root -m 0644 "$work_root/report.timer" "$timer_file"
  install -d -o root -g root -m 0755 "$dropin_dir"
  cat > "$work_root/report.dropin" <<'DROPIN'
[Service]
EnvironmentFile=
EnvironmentFile=/etc/gaiop/report-retention.policy
InaccessiblePaths=-/etc/gaiop/admin.env
DROPIN
  install -o root -g root -m 0644 "$work_root/report.dropin" "$dropin_file"
  write_policy 1 false
  systemctl daemon-reload
  systemd-analyze verify "$service_file" "$timer_file"
  test "$(systemctl show "$report_service" -p User --value)" = gaiop
  test "$(systemctl show "$report_service" -p Group --value)" = gaiop
  test "$(systemctl show "$report_service" -p WorkingDirectory --value)" = "$admin_root"
  test "$(systemctl show "$report_service" -p ReadWritePaths --value)" = '/var/lib/gaiop/admin /var/lib/gaiop/reports /var/lib/gaiop/report-recovery /run/gaiop-report-retention'
  effective_environment_files=$(systemctl show "$report_service" -p EnvironmentFiles --value)
  printf '%s\n' "$effective_environment_files" | grep -F -- "$policy_file" >/dev/null
  if printf '%s\n' "$effective_environment_files" | grep -F -- '/etc/gaiop/admin.env' >/dev/null; then exit 66; fi
  systemctl show "$report_service" -p ExecStart --value | grep -F -- "/usr/local/bin/node $admin_root/server/report-retention-cleanup.js" >/dev/null
  test "$(timer_state "$report_timer")" = 'inactive|disabled'

  phase=closed_one_shot
  disabled_before_b64=$(inspect_report_state "$initial_now" | base64 -w 0)
  run_report_service auto_process_disabled "$work_root/closed.json"
  disabled_after_b64=$(inspect_report_state "$initial_now" | base64 -w 0)
  test "$disabled_before_b64" = "$disabled_after_b64"

  phase=batch_one
  write_policy 1 true
  batch_before_b64=$(inspect_report_state "$(date +%s%3N)" | base64 -w 0)
  run_report_service completed "$work_root/batch-one.json"
  batch_after_b64=$(inspect_report_state "$(date +%s%3N)" | base64 -w 0)
  validate_transition "$batch_before_b64" "$batch_after_b64" "$work_root/batch-one.json" 1 "$work_root/batch-one-change.json"

  phase=enable_timer
  write_policy 50 true
  timer_cursor=$(journal_cursor)
  systemctl enable --now "$report_timer" >/dev/null
  wait_for_report_service
  validate_timer_runs "$timer_cursor" "$work_root/timer-runs.json"
  test "$(timer_state "$report_timer")" = 'active|enabled'

  phase=formal_manual_one_shot
  manual_before_b64=$(inspect_report_state "$(date +%s%3N)" | base64 -w 0)
  run_report_service completed "$work_root/manual.json"
  manual_after_b64=$(inspect_report_state "$(date +%s%3N)" | base64 -w 0)
  validate_transition "$manual_before_b64" "$manual_after_b64" "$work_root/manual.json" 50 "$work_root/manual-change.json"

  phase=final_validation
  final_inspection_b64=$(inspect_report_state "$(date +%s%3N)" | base64 -w 0)
  validate_total_change "$initial_inspection_b64" "$final_inspection_b64" "$work_root/total-change.json"
  source_integrity
  test "$(timer_state gaiop-admin-retention-cleanup.timer)" = 'active|enabled'
  test "$(timer_state gaiop-upgrade-retention-cleanup.timer)" = 'active|enabled'
  test "$(timer_state gaiop-storage-watermark-monitor.timer)" = 'active|enabled'
  test "$(timer_state gaiop-admin-sqlite-backup.timer)" = 'active|enabled'
  test "$(timer_state gaiop-upgrade-sqlite-backup.timer)" = 'active|enabled'
  test "$(timer_state gaiop-admin-session-retention.timer)" = 'inactive|disabled'
  grep -Fx 'GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false' /etc/gaiop/admin-sqlite-backup.policy >/dev/null
  grep -Fx 'GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED=false' /etc/gaiop/upgrade-sqlite-backup.policy >/dev/null
  test "$(systemctl is-active gaiop-admin.service)" = active
  test "$(systemctl is-active gaiop-upgrade.service)" = active
  test "$(systemctl is-active caddy.service)" = active
  test "$(runuser -u netinside -- env XDG_RUNTIME_DIR=/run/user/$gateway_uid systemctl --user is-active openclaw-gateway.service)" = active
  test "$(systemctl show gaiop-admin.service -p MainPID --value)" = "$admin_pid_before"
  test "$(systemctl show gaiop-upgrade.service -p MainPID --value)" = "$upgrade_pid_before"
  test "$(systemctl show caddy.service -p MainPID --value)" = "$caddy_pid_before"
  test "$(runuser -u netinside -- env XDG_RUNTIME_DIR=/run/user/$gateway_uid systemctl --user show openclaw-gateway.service -p MainPID --value)" = "$gateway_pid_before"
  test "$(ss -ltnH 'sport = :3000' | awk '{print $4}' | head -n 1)" = '127.0.0.1:3000'
  test "$(http_status http://127.0.0.1:3000/api/health)" = 200
  test "$(http_status http://127.0.0.1:18789/health)" = 200
  test "$(http_status http://127.0.0.1:18900/health)" = 200
  test "$(http_status http://127.0.0.1:18900/api/overview)" = 401
  test "$(http_status https://127.0.0.1/)" = 200
  test "$(systemctl show "$report_service" -p Result --value)" = success
  test "$(systemctl is-active "$report_service" 2>/dev/null || true)" = inactive
  next_trigger=$(systemctl show "$report_timer" -p NextElapseUSecRealtime --value)
  test -n "$next_trigger"

  printf 'RELEASE_ID=%s\n' "$GAIOP_REPORT_RELEASE_ID"
  printf 'BACKUP_ROOT=%s\n' "$backup_root"
  printf 'DATABASE_BACKUP_INTEGRITY=ok\n'
  printf 'NATIVE_SYSTEMD_VERIFY=ok\n'
  printf 'PATHS_B64=%s\n' "$(path_summary)"
  printf 'SOURCE_PERMISSIONS_B64=%s\n' "$source_permissions_b64"
  printf 'SOURCE_PERMISSIONS_AFTER_B64=%s\n' "$source_permissions_after_b64"
  printf 'INITIAL_INSPECTION_B64=%s\n' "$initial_inspection_b64"
  printf 'FINAL_INSPECTION_B64=%s\n' "$final_inspection_b64"
  printf 'CLOSED_RUN_B64=%s\n' "$(base64 -w 0 "$work_root/closed.json")"
  printf 'BATCH_ONE_RUN_B64=%s\n' "$(base64 -w 0 "$work_root/batch-one.json")"
  printf 'BATCH_ONE_CHANGE_B64=%s\n' "$(base64 -w 0 "$work_root/batch-one-change.json")"
  printf 'TIMER_RUNS_B64=%s\n' "$(base64 -w 0 "$work_root/timer-runs.json")"
  printf 'MANUAL_RUN_B64=%s\n' "$(base64 -w 0 "$work_root/manual.json")"
  printf 'MANUAL_CHANGE_B64=%s\n' "$(base64 -w 0 "$work_root/manual-change.json")"
  printf 'TOTAL_CHANGE_B64=%s\n' "$(base64 -w 0 "$work_root/total-change.json")"
  printf 'REPORT_TIMER=%s\n' "$(timer_state "$report_timer")"
  printf 'REPORT_NEXT=%s\n' "$next_trigger"
  printf 'ADMIN_RETENTION_TIMER=%s\n' "$(timer_state gaiop-admin-retention-cleanup.timer)"
  printf 'UPGRADE_RETENTION_TIMER=%s\n' "$(timer_state gaiop-upgrade-retention-cleanup.timer)"
  printf 'WATERMARK_TIMER=%s\n' "$(timer_state gaiop-storage-watermark-monitor.timer)"
  printf 'ADMIN_SQLITE_TIMER=%s\n' "$(timer_state gaiop-admin-sqlite-backup.timer)"
  printf 'UPGRADE_SQLITE_TIMER=%s\n' "$(timer_state gaiop-upgrade-sqlite-backup.timer)"
  printf 'SESSION_TIMER=%s\n' "$(timer_state gaiop-admin-session-retention.timer)"
  printf 'SQLITE_CLEANUP=disabled\n'
  printf 'ADMIN_HEALTH=%s\n' "$(http_status http://127.0.0.1:3000/api/health)"
  printf 'UPGRADE_HEALTH=%s\n' "$(http_status http://127.0.0.1:18900/health)"
  printf 'UPGRADE_UNAUTHENTICATED=%s\n' "$(http_status http://127.0.0.1:18900/api/overview)"
  printf 'GATEWAY_HEALTH=%s\n' "$(http_status http://127.0.0.1:18789/health)"
  printf 'HTTPS_LOOPBACK=%s\n' "$(http_status https://127.0.0.1/)"
  printf 'ADMIN_LISTENER=%s\n' "$(ss -ltnH 'sport = :3000' | awk '{print $4}' | head -n 1)"
  printf 'PIDS_UNCHANGED=1\n'
  printf 'REPORT_SERVICE_SHA256=%s\n' "$(sha256sum "$service_file" | awk '{print $1}')"
  printf 'REPORT_TIMER_SHA256=%s\n' "$(sha256sum "$timer_file" | awk '{print $1}')"
  printf 'REPORT_DROPIN_SHA256=%s\n' "$(sha256sum "$dropin_file" | awk '{print $1}')"
  printf 'REPORT_POLICY_SHA256=%s\n' "$(sha256sum "$policy_file" | awk '{print $1}')"
  completed=1
  printf 'REPORT_RETENTION_ENABLE_COMPLETE=1\n'
}

case "$GAIOP_REPORT_RELEASE_ACTION" in
  enable) enable_report_retention ;;
  postcheck-rollback) postcheck_rollback ;;
  *) exit 90 ;;
esac
