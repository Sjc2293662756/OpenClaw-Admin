'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled legacy-report migration preflight connection context is incomplete.')
}

// The remote side returns counts only: report names, titles, audit bodies and
// any connection material stay on the server.
const script = String.raw`set -euo pipefail
legacy_root='/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output'
formal_root='/var/lib/gaiop/reports'
test -d "$legacy_root"
test -d "$formal_root"
node - "$legacy_root" "$formal_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const legacyRoot = process.argv[2];
const formalRoot = process.argv[3];
const extensions = ['.docx', '.pdf', '.xlsx', '.csv', '.md', '.txt'];
const values = { auditFiles: 0, pairedCandidates: 0, malformedAudits: 0, unsupportedPairs: 0, destinationCollisions: 0, alreadyMigrated: 0 };
function walk(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(item));
    else if (entry.isFile()) result.push(item);
  }
  return result;
}
function segment(value, fallback) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..' || /[\\/\x00-\x1f]/.test(text)) return fallback;
  return text.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || fallback;
}
for (const auditPath of walk(legacyRoot).filter((item) => path.extname(item).toLowerCase() === '.json')) {
  values.auditFiles += 1;
  let audit;
  try { audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch { values.malformedAudits += 1; continue; }
  const stem = auditPath.slice(0, -5);
  const reportPath = extensions.map((extension) => stem + extension).find((item) => fs.existsSync(item));
  if (!reportPath) { values.unsupportedPairs += 1; continue; }
  values.pairedCandidates += 1;
  const fingerprint = crypto.createHash('sha256').update(path.relative(legacyRoot, auditPath)).digest('hex').slice(0, 24);
  const reportType = segment(audit.reportType, 'legacy_report');
  const extension = path.extname(reportPath).toLowerCase();
  const storedName = '_unattributed/' + reportType + '/legacy-' + fingerprint + extension;
  const auditName = storedName.slice(0, -extension.length) + '.json';
  const existingAudit = path.join(formalRoot, ...auditName.split('/'));
  if (fs.existsSync(existingAudit)) {
    try {
      const current = JSON.parse(fs.readFileSync(existingAudit, 'utf8'));
      if (current.legacySourceFingerprint === fingerprint) values.alreadyMigrated += 1;
      else values.destinationCollisions += 1;
    } catch { values.destinationCollisions += 1; }
  }
}
for (const [key, value] of Object.entries(values)) console.log(key + '=' + value);
NODE
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function parse(output) {
  const values = Object.create(null)
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z]+)=([0-9]+)$/)
    if (match) values[match[1]] = Number(match[2])
  }
  return {
    auditFiles: values.auditFiles ?? 0,
    pairedCandidates: values.pairedCandidates ?? 0,
    malformedAudits: values.malformedAudits ?? 0,
    unsupportedPairs: values.unsupportedPairs ?? 0,
    destinationCollisions: values.destinationCollisions ?? 0,
    alreadyMigrated: values.alreadyMigrated ?? 0,
  }
}

const client = new Client()
let complete = false
const timeout = setTimeout(() => {
  if (!complete) process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'LEGACY_REPORT_PREFLIGHT_TIMEOUT' })}\n`)
  complete = true
  client.end()
  process.exitCode = 1
}, 60_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    complete = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ ok: result.ok, ...(result.ok ? { preflight: parse(result.output) } : { errorCode: 'LEGACY_REPORT_PREFLIGHT_FAILED' }) })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => {
  if (complete) return
  complete = true
  clearTimeout(timeout)
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'LEGACY_REPORT_PREFLIGHT_CONNECTION_FAILED' })}\n`)
  process.exitCode = 1
})
client.connect(connection)
