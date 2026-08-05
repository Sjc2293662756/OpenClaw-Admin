'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-attribution verification context is incomplete.')
}

const script = String.raw`set -euo pipefail
uid=$(id -u netinside)
runtime="/run/user/$uid"
userctl() {
  sudo -u netinside env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user "$@"
}

sudo -u gaiop env GAIOP_REPORTS_DIR=/var/lib/gaiop/reports GAIOP_REPORT_ATTRIBUTION_INDEX_PATH=/var/lib/gaiop/report-attribution/index.json /usr/local/bin/node --input-type=module - <<'NODE'
import Database from '/opt/gaiop/admin/node_modules/better-sqlite3/lib/index.js'
import fs from 'node:fs'
const { __test__ } = await import('/opt/gaiop/admin/server/routes/reports.js')
const db = new Database('/var/lib/gaiop/admin/wizard.db')
try {
  __test__.syncGeneratedReports(db)
  const index = JSON.parse(fs.readFileSync('/var/lib/gaiop/report-attribution/index.json', 'utf8'))
  const select = db.prepare('SELECT source_session_id, source_user_id, source_channel FROM report_files WHERE id = ?')
  const summary = { total: 0, sessions: 0, users: 0, channels: 0, webchat: 0, wecom: 0 }
  for (const entry of index.entries || []) {
    const row = select.get(entry.reportId)
    if (!row) continue
    summary.total += 1
    if (row.source_session_id) summary.sessions += 1
    if (row.source_user_id) summary.users += 1
    if (row.source_channel) summary.channels += 1
    if (row.source_channel === 'web' || row.source_channel === 'webchat') summary.webchat += 1
    if (row.source_channel === 'wecom') summary.wecom += 1
  }
  for (const [key, value] of Object.entries(summary)) process.stdout.write('DB_' + key.toUpperCase() + '=' + Number(value || 0) + '\n')
  const target = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN source_user_id IS NOT NULL AND source_channel IS NOT NULL THEN 1 ELSE 0 END) AS complete FROM report_files WHERE source_session_id = ?')
  const web = target.get('agent:main:main:dm:webchat-3afb3e9266714554a83c3547fa85e749')
  const wecom = target.get('agent:main:wecom:direct:yangs')
  process.stdout.write('TARGET_WEB_REGISTERED=' + Number(web.total || 0) + '\n')
  process.stdout.write('TARGET_WEB_COMPLETE=' + Number(web.complete || 0) + '\n')
  process.stdout.write('TARGET_WECOM_REGISTERED=' + Number(wecom.total || 0) + '\n')
  process.stdout.write('TARGET_WECOM_COMPLETE=' + Number(wecom.complete || 0) + '\n')
} finally { db.close() }
NODE

/usr/local/bin/node - /var/lib/gaiop/report-attribution/index.json <<'NODE'
const fs = require('fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const age = Date.now() - Date.parse(value.updatedAt)
process.stdout.write('INDEX_SCHEMA=' + String(value.schemaVersion === 'gaiop.report-attribution.v1') + '\n')
process.stdout.write('INDEX_ENTRIES=' + Number(value.entries?.length || 0) + '\n')
process.stdout.write('INDEX_FRESH=' + String(Number.isFinite(age) && age >= -60000 && age <= 120000) + '\n')
NODE

sudo -u netinside /usr/local/bin/node - <<'NODE'
const fs = require('fs')
const crypto = require('crypto')
const path = require('path')
const root = '/home/netinside/.openclaw/agents/main/sessions'
const provenanceRoot = '/var/lib/gaiop/runtime/report-provenance'
const sessions = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'))
const targets = {
  WEB: 'agent:main:main:dm:webchat-3afb3e9266714554a83c3547fa85e749',
  WECOM: 'agent:main:wecom:direct:yangs',
}
function findResult(message) {
  const queue = []
  if (message && typeof message.details === 'object') queue.push(message.details)
  for (const item of Array.isArray(message?.content) ? message.content : []) {
    if (typeof item?.text !== 'string') continue
    try { queue.push(JSON.parse(item.text)) } catch {}
  }
  const seen = new Set()
  while (queue.length) {
    const value = queue.shift()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    if (value.ok === true && typeof value.filePath === 'string' && typeof value.auditPath === 'string') return true
    for (const key of ['result', 'data', 'details', 'output']) if (value[key] && typeof value[key] === 'object') queue.push(value[key])
  }
  return false
}
for (const [label, key] of Object.entries(targets)) {
  const record = sessions[key]
  let official = 0
  let publicResult = 0
  let successReply = 0
  let docxReply = 0
  let failed = 0
  let exec = 0
  let execReportPath = 0
  let execAuditPath = 0
  let execExistingReport = 0
  let execExistingAudit = 0
  let execAuditReportId = 0
  let execAuditFileReference = 0
  if (record?.sessionFile && fs.existsSync(record.sessionFile)) {
    for (const line of fs.readFileSync(record.sessionFile, 'utf8').split(/\r?\n/)) {
      let value
      try { value = JSON.parse(line) } catch { continue }
      const message = value?.message
      if (message?.role !== 'toolResult') continue
      if (message.toolName === 'napm-report-export') {
        const replyText = (Array.isArray(message.content) ? message.content : [])
          .map((item) => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '')
          .join('\n')
        if (replyText.includes('Word 报告已生成：')) successReply++
        if (/\.docx(?:\s|$)/i.test(replyText)) docxReply++
        const candidates = []
        if (message.details && typeof message.details === 'object') candidates.push(message.details)
        for (const item of Array.isArray(message.content) ? message.content : []) {
          const text = typeof item === 'string' ? item : item?.text
          if (typeof text !== 'string') continue
          try { candidates.push(JSON.parse(text)) } catch {}
        }
        if (candidates.some((item) => item?.ok === true && typeof item?.reportId === 'string')) publicResult++
        findResult(message) ? official++ : failed++
      }
      if (message.toolName === 'exec') {
        exec++
        const text = (Array.isArray(message.content) ? message.content : [])
          .map((item) => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '')
          .join('\n')
        if (/\.(?:docx|pdf|xlsx|csv|md|txt)(?:[\s"']|$)/i.test(text)) execReportPath++
        if (/\.json(?:[\s"']|$)/i.test(text)) execAuditPath++
        const paths = [...text.matchAll(/(?:\/var\/lib\/gaiop\/reports|\/home\/netinside\/\.openclaw\/workspace\/skills\/openclaw-napm-report\/output)[\s\S]*?\.(?:docx|pdf|xlsx|csv|md|txt|json)/gu)]
          .map((match) => match[0].trim())
        for (const candidate of new Set(paths)) {
          if (!fs.existsSync(candidate)) continue
          if (candidate.endsWith('.json')) {
            execExistingAudit++
            try {
              const audit = JSON.parse(fs.readFileSync(candidate, 'utf8'))
              if (audit?.reportId) execAuditReportId++
              if (audit?.fileName || audit?.filePath || audit?.relativeFilePath) execAuditFileReference++
            } catch {}
          } else execExistingReport++
        }
      }
    }
  }
  const externalActor = Boolean(record?.channelUserId || record?.senderId || record?.userId || record?.peer?.id || record?.peer || key.split(':').slice(4).join(':'))
  const snapshot = path.join(provenanceRoot, crypto.createHash('sha256').update(key).digest('hex') + '.json')
  console.log('TARGET_' + label + '_RECORD=' + String(Boolean(record)))
  console.log('TARGET_' + label + '_TRANSCRIPT=' + String(Boolean(record?.sessionFile && fs.existsSync(record.sessionFile))))
  console.log('TARGET_' + label + '_OFFICIAL=' + official)
  console.log('TARGET_' + label + '_PUBLIC=' + publicResult)
  console.log('TARGET_' + label + '_SUCCESS_REPLY=' + successReply)
  console.log('TARGET_' + label + '_DOCX_REPLY=' + docxReply)
  console.log('TARGET_' + label + '_FAILED=' + failed)
  console.log('TARGET_' + label + '_EXEC=' + exec)
  console.log('TARGET_' + label + '_EXEC_REPORT=' + execReportPath)
  console.log('TARGET_' + label + '_EXEC_AUDIT=' + execAuditPath)
  console.log('TARGET_' + label + '_EXEC_EXISTING_REPORT=' + execExistingReport)
  console.log('TARGET_' + label + '_EXEC_EXISTING_AUDIT=' + execExistingAudit)
  console.log('TARGET_' + label + '_EXEC_AUDIT_REPORT_ID=' + execAuditReportId)
  console.log('TARGET_' + label + '_EXEC_AUDIT_FILE_REFERENCE=' + execAuditFileReference)
  console.log('TARGET_' + label + '_IDENTITY=' + String(label === 'WEB' ? fs.existsSync(snapshot) : externalActor))
}
NODE

printf 'ADMIN_ACTIVE='; systemctl is-active gaiop-admin.service
printf 'SIDECAR_ACTIVE='; userctl is-active gaiop-report-attribution.service
printf 'SIDECAR_ENABLED='; userctl is-enabled gaiop-report-attribution.service
printf 'SIDECAR_LISTENERS='; ss -lntup 2>/dev/null | grep -c 'report-attribution' || true
printf 'AUTO_REFRESH='; grep -Fq '5000' /opt/gaiop/admin/dist/assets/FilesPage-*.js && echo present || echo missing
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const values = Object.create(null)
    for (const line of result.output.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=([a-z0-9-]+)$/i)
      if (match) values[match[1]] = match[2]
    }
    const payload = {
      completed: result.ok,
      adminActive: values.ADMIN_ACTIVE,
      sidecarActive: values.SIDECAR_ACTIVE,
      sidecarEnabled: values.SIDECAR_ENABLED,
      sidecarListeners: Number(values.SIDECAR_LISTENERS || 0),
      indexSchema: values.INDEX_SCHEMA === 'true',
      indexFresh: values.INDEX_FRESH === 'true',
      indexEntries: Number(values.INDEX_ENTRIES || 0),
      registered: Number(values.DB_TOTAL || 0),
      withSession: Number(values.DB_SESSIONS || 0),
      withUser: Number(values.DB_USERS || 0),
      withChannel: Number(values.DB_CHANNELS || 0),
      webchat: Number(values.DB_WEBCHAT || 0),
      wecom: Number(values.DB_WECOM || 0),
      autoRefresh: values.AUTO_REFRESH === 'present',
      targets: {
        web: {
          record: values.TARGET_WEB_RECORD === 'true', transcript: values.TARGET_WEB_TRANSCRIPT === 'true',
          official: Number(values.TARGET_WEB_OFFICIAL || 0), failed: Number(values.TARGET_WEB_FAILED || 0),
          publicResult: Number(values.TARGET_WEB_PUBLIC || 0),
          successReply: Number(values.TARGET_WEB_SUCCESS_REPLY || 0), docxReply: Number(values.TARGET_WEB_DOCX_REPLY || 0),
          exec: Number(values.TARGET_WEB_EXEC || 0), identity: values.TARGET_WEB_IDENTITY === 'true',
          execReport: Number(values.TARGET_WEB_EXEC_REPORT || 0), execAudit: Number(values.TARGET_WEB_EXEC_AUDIT || 0),
          registered: Number(values.TARGET_WEB_REGISTERED || 0), complete: Number(values.TARGET_WEB_COMPLETE || 0),
          existingReport: Number(values.TARGET_WEB_EXEC_EXISTING_REPORT || 0), existingAudit: Number(values.TARGET_WEB_EXEC_EXISTING_AUDIT || 0),
          auditReportId: Number(values.TARGET_WEB_EXEC_AUDIT_REPORT_ID || 0), auditFileReference: Number(values.TARGET_WEB_EXEC_AUDIT_FILE_REFERENCE || 0),
        },
        wecom: {
          record: values.TARGET_WECOM_RECORD === 'true', transcript: values.TARGET_WECOM_TRANSCRIPT === 'true',
          official: Number(values.TARGET_WECOM_OFFICIAL || 0), failed: Number(values.TARGET_WECOM_FAILED || 0),
          publicResult: Number(values.TARGET_WECOM_PUBLIC || 0),
          successReply: Number(values.TARGET_WECOM_SUCCESS_REPLY || 0), docxReply: Number(values.TARGET_WECOM_DOCX_REPLY || 0),
          exec: Number(values.TARGET_WECOM_EXEC || 0), identity: values.TARGET_WECOM_IDENTITY === 'true',
          execReport: Number(values.TARGET_WECOM_EXEC_REPORT || 0), execAudit: Number(values.TARGET_WECOM_EXEC_AUDIT || 0),
          registered: Number(values.TARGET_WECOM_REGISTERED || 0), complete: Number(values.TARGET_WECOM_COMPLETE || 0),
          existingReport: Number(values.TARGET_WECOM_EXEC_EXISTING_REPORT || 0), existingAudit: Number(values.TARGET_WECOM_EXEC_EXISTING_AUDIT || 0),
          auditReportId: Number(values.TARGET_WECOM_EXEC_AUDIT_REPORT_ID || 0), auditFileReference: Number(values.TARGET_WECOM_EXEC_AUDIT_FILE_REFERENCE || 0),
        },
      },
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
