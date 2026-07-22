'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_LEGACY_REPORT_MIGRATION_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled legacy-report migration inputs are incomplete.')
}

function migrationScript() {
  return String.raw`set -euo pipefail
release_id='${releaseId}'
legacy_root='/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output'
formal_root='/var/lib/gaiop/reports'
backup_root="/var/backups/gaiop/report-legacy-migration-$release_id"
stage_root="/tmp/gaiop-report-legacy-migration-$release_id"
plan_file="$stage_root/plan.json"
acl_backup="$backup_root/formal-reports-recursive.acl"
committed=0
phase='PRECHECK'
mark_phase() { phase="$1"; printf 'PHASE_%s\n' "$phase"; }

rollback() {
  status=$?
  if [ "$committed" -eq 0 ]; then
    if [ -f "$plan_file" ]; then
      node - "$plan_file" "$formal_root" <<'NODE' || true
const fs = require('node:fs'); const path = require('node:path');
try {
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const root = path.resolve(process.argv[3]);
  for (const item of plan) for (const name of [item.storedName, item.auditName]) {
    const target = path.resolve(root, ...String(name).split('/'));
    if (target.startsWith(root + path.sep)) fs.rmSync(target, { force: true });
  }
} catch {}
NODE
    fi
    if [ -f "$acl_backup" ]; then setfacl --restore="$acl_backup" || true; fi
    rm -rf -- "$stage_root"
  fi
  printf 'FAILED_PHASE=%s\n' "$phase"
  exit "$status"
}
trap rollback ERR

mark_phase 'PRECHECK'
test -d "$legacy_root"
test -d "$formal_root"
command -v setfacl >/dev/null
command -v getfacl >/dev/null
if [ -e "$backup_root" ] || [ -e "$stage_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 41; fi
install -d -m 0700 "$backup_root" "$stage_root"
getfacl -R -p "$formal_root" > "$acl_backup"
printf 'BACKUP_CREATED\n'

mark_phase 'PLAN'
node - "$legacy_root" "$formal_root" "$plan_file" "$release_id" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const legacyRoot = path.resolve(process.argv[2]);
const formalRoot = path.resolve(process.argv[3]);
const planFile = process.argv[4];
const releaseId = process.argv[5];
const extensions = ['.docx', '.pdf', '.xlsx', '.csv', '.md', '.txt'];
function walk(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(item)); else if (entry.isFile()) result.push(item);
  }
  return result;
}
function segment(value, fallback) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..' || /[\\/\x00-\x1f]/.test(text)) return fallback;
  return text.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || fallback;
}
function safeTitle(value, fallback) {
  const text = String(value || '').trim().replace(/[\x00-\x1f]/g, ' ');
  return text ? text.slice(0, 240) : fallback;
}
const plan = [];
for (const auditPath of walk(legacyRoot).filter((item) => path.extname(item).toLowerCase() === '.json')) {
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  const stem = auditPath.slice(0, -5);
  const reportPath = extensions.map((extension) => stem + extension).find((item) => fs.existsSync(item));
  if (!reportPath) throw new Error('legacy pair changed after preflight');
  const fingerprint = crypto.createHash('sha256').update(path.relative(legacyRoot, auditPath)).digest('hex').slice(0, 24);
  const reportType = segment(audit.reportType, 'legacy_report');
  const extension = path.extname(reportPath).toLowerCase();
  const storedName = '_unattributed/' + reportType + '/legacy-' + fingerprint + extension;
  const auditName = storedName.slice(0, -extension.length) + '.json';
  const reportDestination = path.resolve(formalRoot, ...storedName.split('/'));
  const auditDestination = path.resolve(formalRoot, ...auditName.split('/'));
  if (!reportDestination.startsWith(formalRoot + path.sep) || !auditDestination.startsWith(formalRoot + path.sep)) throw new Error('unsafe destination');
  if (fs.existsSync(reportDestination) || fs.existsSync(auditDestination)) throw new Error('destination collision');
  const generatedAt = Number.isFinite(Date.parse(audit.generatedAt || '')) ? new Date(audit.generatedAt).toISOString() : new Date(fs.statSync(auditPath).mtimeMs).toISOString();
  plan.push({
    sourceReport: reportPath,
    storedName,
    auditName,
    reportId: 'legacy-' + fingerprint,
    reportType,
    title: safeTitle(audit.title, '历史归档报告 ' + fingerprint),
    generatedAt,
    legacySourceFingerprint: fingerprint,
    migrationReleaseId: releaseId,
  });
}
if (plan.length === 0) throw new Error('no legacy report pairs');
fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
process.stdout.write('MIGRATION_COUNT=' + plan.length + '\n');
NODE
cp -a -- "$plan_file" "$backup_root/migration-plan.json"

mark_phase 'COPY'
node - "$plan_file" "$formal_root" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const child = require('node:child_process');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.resolve(process.argv[3]);
const directories = new Set();
for (const item of plan) {
  const reportPath = path.resolve(root, ...item.storedName.split('/'));
  const auditPath = path.resolve(root, ...item.auditName.split('/'));
  if (!reportPath.startsWith(root + path.sep) || !auditPath.startsWith(root + path.sep)) throw new Error('unsafe destination');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o750 });
  fs.copyFileSync(item.sourceReport, reportPath, fs.constants.COPYFILE_EXCL);
  const audit = {
    reportId: item.reportId,
    title: item.title,
    reportType: item.reportType,
    sourceUserId: '_unattributed',
    sourceSessionId: null,
    dataSourceId: null,
    generatedAt: item.generatedAt,
    relativeFilePath: item.storedName,
    relativeAuditPath: item.auditName,
    legacySourceFingerprint: item.legacySourceFingerprint,
    migrationReleaseId: item.migrationReleaseId,
  };
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), { mode: 0o640, flag: 'wx' });
  directories.add(path.dirname(reportPath));
  child.execFileSync('setfacl', ['-m', 'u:gaiop:rw-,u:netinside:rw-,m::rw-', reportPath]);
  child.execFileSync('setfacl', ['-m', 'u:gaiop:rw-,u:netinside:rw-,m::rw-', auditPath]);
}
for (const directory of directories) {
  child.execFileSync('setfacl', ['-m', 'u:gaiop:rwx,u:netinside:rwx,m::rwx', directory]);
  child.execFileSync('setfacl', ['-d', '-m', 'u:gaiop:rwx,u:netinside:rwx,m::rwx', directory]);
}
process.stdout.write('MIGRATION_COPY_VERIFIED=' + plan.length + '\n');
NODE

mark_phase 'ARTIFACT_VERIFY'
node - "$plan_file" "$formal_root" <<'NODE'
const fs = require('node:fs'); const path = require('node:path');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); const root = path.resolve(process.argv[3]);
for (const item of plan) {
  const reportPath = path.resolve(root, ...item.storedName.split('/'));
  const auditPath = path.resolve(root, ...item.auditName.split('/'));
  if (!fs.existsSync(reportPath) || !fs.existsSync(auditPath)) throw new Error('missing copied artifact');
  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  if (audit.relativeFilePath !== item.storedName || audit.relativeAuditPath !== item.auditName || audit.sourceUserId !== '_unattributed') throw new Error('invalid migrated audit');
}
NODE

mark_phase 'BFF_SYNC_PROBE'
expected_migration_count=$(node - "$plan_file" <<'NODE'
const fs = require('node:fs');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(plan.length));
NODE
)
test "$expected_migration_count" -gt 0
sudo -u gaiop env GAIOP_REPORTS_DIR="$formal_root" GAIOP_EXPECTED_MIGRATION_COUNT="$expected_migration_count" node --input-type=module - <<'NODE'
try {
  const expected = Number(process.env.GAIOP_EXPECTED_MIGRATION_COUNT || 0);
  const { __test__ } = await import('/opt/gaiop/admin/server/routes/reports.js');
  let inserts = 0;
  const db = { prepare(sql) {
    if (!String(sql).includes('INSERT INTO report_files')) throw new Error('unexpected sync query');
    return { run() { inserts += 1; } };
  } };
  __test__.syncGeneratedReports(db);
  if (!Number.isInteger(expected) || expected <= 0 || inserts < expected) throw new Error('incomplete BFF archive sync');
} catch (error) {
  const text = String(error && error.message || '').toLowerCase();
  const category = /eacces|eperm|permission|access denied/.test(text) ? 'permission'
    : /relative|audit|stored|archive|path/.test(text) ? 'archive-contract'
      : 'runtime';
  process.stdout.write('BFF_SYNC_FAILURE=' + category + '\n');
  process.exit(1);
}
NODE

mark_phase 'COMPLETE'
committed=1
rm -rf -- "$stage_root"
printf 'MIGRATION_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
`
}

function execute(client, script) {
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

function summarize(result) {
  const output = String(result.output || '')
  const phase = output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1] || output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '') || 'UNKNOWN'
  const syncProbeFailure = output.match(/^BFF_SYNC_FAILURE=([a-z-]+)$/m)?.[1] || null
  return {
    completed: result.ok && /MIGRATION_COMPLETE/.test(output),
    backupCreated: /BACKUP_CREATED/.test(output),
    migratedCount: Number(output.match(/^MIGRATION_COUNT=([0-9]+)$/m)?.[1] || 0),
    copiedCount: Number(output.match(/^MIGRATION_COPY_VERIFIED=([0-9]+)$/m)?.[1] || 0),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    phase,
    syncProbeFailure,
    errorCode: result.ok ? null : (output.includes('BLOCK_RELEASE_PATH_EXISTS') ? 'MIGRATION_RELEASE_PATH_EXISTS' : 'LEGACY_REPORT_MIGRATION_FAILED'),
  }
}

const client = new Client()
let complete = false
const timeout = setTimeout(() => {
  if (!complete) process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'LEGACY_REPORT_MIGRATION_TIMEOUT' })}\n`)
  complete = true
  client.end()
  process.exitCode = 1
}, 180_000)
client.on('ready', async () => {
  try {
    const result = await execute(client, migrationScript())
    complete = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(summarize(result))}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => {
  if (complete) return
  complete = true
  clearTimeout(timeout)
  process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'LEGACY_REPORT_MIGRATION_CONNECTION_FAILED' })}\n`)
  process.exitCode = 1
})
client.connect(connection)
