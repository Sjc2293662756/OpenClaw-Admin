'use strict'

const { Client } = require('ssh2')

const sessionKey = String(process.env.GAIOP_REPORT_REPAIR_SESSION_KEY || '').trim()
const reportId = String(process.env.GAIOP_REPORT_REPAIR_REPORT_ID || '').trim()
const sourceMessageId = String(process.env.GAIOP_REPORT_REPAIR_SOURCE_MESSAGE_ID || '').trim()
const releaseId = String(process.env.GAIOP_REPORT_REPAIR_RELEASE_ID || '').trim()
const connection = {
  host: String(process.env.GAIOP_REPORT_REPAIR_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_REPAIR_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_REPAIR_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^agent:main:main:dm:webchat-[a-f0-9]{32}$/.test(sessionKey)
  || !reportId || reportId.length > 200 || /[\\/\r\n\0]/u.test(reportId)
  || !/^[a-f0-9-]{36}$/.test(sourceMessageId)
  || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report source repair inputs are incomplete.')
}

const encoded = (value) => Buffer.from(value, 'utf8').toString('base64')
const remoteScript = String.raw`set -euo pipefail
backup_root='/var/backups/gaiop/webchat-report-source-${releaseId}'
test ! -e "$backup_root"
install -d -m 0700 -o root -g root "$backup_root"
tar -czf "$backup_root/admin-code-config.tgz" \
  /opt/gaiop/admin/dist /opt/gaiop/admin/server /opt/gaiop/admin/package.json /opt/gaiop/admin/package-lock.json \
  /etc/systemd/system/gaiop-admin.service /etc/gaiop/admin.env 2>/dev/null
chmod 0600 "$backup_root/admin-code-config.tgz"
GAIOP_REPAIR_SESSION_B64='${encoded(sessionKey)}' \
GAIOP_REPAIR_REPORT_B64='${encoded(reportId)}' \
GAIOP_REPAIR_MESSAGE_B64='${encoded(sourceMessageId)}' \
node - "$backup_root" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const decode = (name) => Buffer.from(String(process.env[name] || ''), 'base64').toString('utf8')
const sessionKey = decode('GAIOP_REPAIR_SESSION_B64')
const reportId = decode('GAIOP_REPAIR_REPORT_B64')
const sourceMessageId = decode('GAIOP_REPAIR_MESSAGE_B64')
const backupRoot = process.argv[2]
const databasePath = '/var/lib/gaiop/admin/wizard.db'
const reportRoot = path.resolve('/var/lib/gaiop/reports')
const sessionsRoot = path.resolve('/home/netinside/.openclaw/agents/main/sessions')
const pluginAuditPath = '/home/netinside/.openclaw/logs/audit.log'

function regularFile(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('regular-file-gate')
  return stat
}
function reportPath(relative) {
  const value = String(relative || '').replace(/\\/gu, '/')
  if (!value || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('report-path-gate')
  }
  const resolved = path.resolve(reportRoot, ...value.split('/'))
  if (!resolved.startsWith(reportRoot + path.sep)) throw new Error('report-root-gate')
  return resolved
}
function jsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}
function tableCounts(db) {
  return Object.fromEntries(['users', 'workspace_sessions', 'report_files', 'report_deliveries', 'audit_logs']
    .map((table) => [table, Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count)]))
}

;(async () => {
  const db = new Database(databasePath)
  let auditPath
  let auditBackupPath
  let originalAudit
  let row
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('database-integrity-gate')
    const beforeCounts = tableCounts(db)
    const workspace = db.prepare(
      'SELECT ws.owner_user_id, ws.status, u.status AS user_status FROM workspace_sessions ws ' +
      'JOIN users u ON u.id = ws.owner_user_id WHERE ws.session_key = ?'
    ).get(sessionKey)
    if (!workspace || workspace.status !== 'active' || workspace.user_status !== 'active' || !workspace.owner_user_id) {
      throw new Error('workspace-owner-gate')
    }
    row = db.prepare('SELECT * FROM report_files WHERE id = ?').get(reportId)
    if (!row || row.status !== 'ready' || row.source_user_id || row.source_session_id || row.source_message_id) {
      throw new Error('report-row-gate')
    }

    const filePath = reportPath(row.stored_name)
    auditPath = reportPath(row.audit_name)
    const fileStat = regularFile(filePath)
    const auditStat = regularFile(auditPath)
    if (Number(row.size) !== fileStat.size) throw new Error('report-size-gate')
    originalAudit = fs.readFileSync(auditPath)
    const audit = JSON.parse(originalAudit.toString('utf8'))
    if (String(audit.reportId || '') !== reportId
      || audit.sourceUserId || audit.sourceSessionId || audit.sourceMessageId) {
      throw new Error('report-audit-gate')
    }

    const pluginEvents = jsonLines(pluginAuditPath)
    const completed = pluginEvents.filter((event) =>
      event.event === 'napm_automatic_inspection_completed'
      && String(event.conversationKey || '') === 'session:' + sessionKey
      && String(event.reportId || '') === reportId)
    if (completed.length !== 1 || !completed[0].turnId) throw new Error('completed-event-gate')
    const turnId = String(completed[0].turnId)
    const started = pluginEvents.filter((event) =>
      event.event === 'napm_automatic_inspection_started'
      && String(event.conversationKey || '') === 'session:' + sessionKey
      && String(event.turnId || '') === turnId)
    const dispatched = pluginEvents.filter((event) =>
      event.event === 'napm_inspection_report_dispatched'
      && String(event.conversationKey || '') === 'session:' + sessionKey
      && String(event.sessionKey || '') === sessionKey
      && String(event.turnId || '') === turnId
      && String(event.runId || ''))
    if (started.length !== 1 || dispatched.length !== 1) throw new Error('turn-envelope-gate')

    const sessionIndex = JSON.parse(fs.readFileSync(path.join(sessionsRoot, 'sessions.json'), 'utf8'))
    const sessionFile = path.resolve(String(sessionIndex[sessionKey]?.sessionFile || ''))
    if (!sessionFile.startsWith(sessionsRoot + path.sep)) throw new Error('transcript-path-gate')
    regularFile(sessionFile)
    const transcript = jsonLines(sessionFile)
    const sourceMatches = transcript.filter((entry) =>
      String(entry.id || entry.message?.id || '') === sourceMessageId
      && String(entry.message?.role || '') === 'assistant')
    if (sourceMatches.length !== 1) throw new Error('source-message-id-gate')
    const content = Array.isArray(sourceMatches[0].message?.content) ? sourceMatches[0].message.content : []
    const text = content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join(' ').trim()
    if (!/(?:报告(?:文件)?(?:已经|已)?生成|格式\s*[:：]\s*(?:docx|word)|完整报告|完整巡检报告)/iu.test(text)) {
      throw new Error('completion-message-gate')
    }
    const sourceMessagePreview = text
      .replace(/MEDIA:(?:[^\s\n]*[\\/])?([^\\/\s?#]+\.docx)(?:[?#][^\s\n]*)?/giu, '$1')
      .replace(/\s+/gu, ' ').trim().slice(0, 1000)
    if (!sourceMessagePreview || /\/var\/lib\/gaiop|MEDIA:/u.test(sourceMessagePreview)) {
      throw new Error('safe-preview-gate')
    }
    const sourcePromptPreview = String(started[0].prompt || '').replace(/\s+/gu, ' ').trim().slice(0, 300)
    if (!sourcePromptPreview) throw new Error('source-prompt-gate')

    const databaseBackup = path.join(backupRoot, 'wizard.db')
    await db.backup(databaseBackup)
    const backupDb = new Database(databaseBackup, { readonly: true, fileMustExist: true })
    if (backupDb.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup-integrity-gate')
    backupDb.close()
    fs.chmodSync(databaseBackup, 0o600)
    auditBackupPath = path.join(backupRoot, path.basename(auditPath))
    fs.writeFileSync(auditBackupPath, originalAudit, { mode: 0o600 })

    const repairedAudit = {
      ...audit,
      sourceChannel: 'webchat',
      sourceUserId: String(workspace.owner_user_id),
      sourceSessionId: sessionKey,
      sourceMessageId,
      sourceMessagePreview,
      sourcePromptPreview,
      sourceTurnId: turnId,
    }
    const temporaryAudit = auditPath + '.repair-' + process.pid
    fs.writeFileSync(temporaryAudit, JSON.stringify(repairedAudit, null, 2) + '\n', { mode: auditStat.mode & 0o777 })
    fs.chownSync(temporaryAudit, auditStat.uid, auditStat.gid)
    fs.renameSync(temporaryAudit, auditPath)

    try {
      db.transaction(() => {
        const updated = db.prepare(
          'UPDATE report_files SET source_user_id = ?, source_session_id = ?, source_message_id = ?, ' +
          'source_message_preview = ?, source_channel = ?, updated_at = ? ' +
          'WHERE id = ? AND source_user_id IS NULL AND source_session_id IS NULL AND source_message_id IS NULL'
        ).run(String(workspace.owner_user_id), sessionKey, sourceMessageId, sourceMessagePreview, 'webchat', Date.now(), reportId)
        if (updated.changes !== 1) throw new Error('report-update-gate')
        const verified = db.prepare('SELECT * FROM report_files WHERE id = ?').get(reportId)
        if (verified.source_user_id !== String(workspace.owner_user_id)
          || verified.source_session_id !== sessionKey
          || verified.source_message_id !== sourceMessageId) throw new Error('report-verify-gate')
      })()
    } catch (error) {
      fs.writeFileSync(auditPath, originalAudit, { mode: auditStat.mode & 0o777 })
      fs.chownSync(auditPath, auditStat.uid, auditStat.gid)
      throw error
    }

    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('post-integrity-gate')
    const afterCounts = tableCounts(db)
    if (JSON.stringify(beforeCounts) !== JSON.stringify(afterCounts)) throw new Error('business-count-gate')
    process.stdout.write(JSON.stringify({
      completed: true,
      status: 'repaired',
      reportId,
      sourceSessionId: sessionKey,
      sourceMessageId,
      rollbackPoint: backupRoot,
      dbIntegrity: 'ok',
      countsUnchanged: true,
    }))
  } finally {
    db.close()
  }
})().catch(() => {
  process.stdout.write(JSON.stringify({ completed: false, status: 'repair-gate-failed' }))
  process.exitCode = 1
})
NODE
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => {
        try {
          const result = JSON.parse(output)
          if (code === 0 && result?.completed) return resolve(result)
        } catch {}
        reject(new Error(`remote exit ${code}`))
      })
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"status":"timeout"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 120_000)
client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    client.end()
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"completed":false,"status":"failed"}\n')
    client.end()
    process.exitCode = 1
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"completed":false,"status":"connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
