'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_DELIVERY_DIAG_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DELIVERY_DIAG_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DELIVERY_DIAG_SSH_PASSWORD || ''),
  readyTimeout: 15_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-delivery diagnostic context is incomplete.')
}

const diagnostic = String.raw`set -euo pipefail
gateway_runtime="/run/user/$(id -u netinside)"
outbound_root='/home/netinside/.openclaw/media/outbound'
plugin_file='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
reports_root='/var/lib/gaiop/reports'

gatewayctl() { sudo -u netinside XDG_RUNTIME_DIR="$gateway_runtime" systemctl --user "$@"; }

outbound_state=missing
outbound_access=unavailable
reports_access=unavailable
archive_only_reply=no
public_path_hidden=no
delivery_copy_support=no
path_error_count=0
reports_path_error_count=0
latest_factory_has_session_key=unknown
latest_factory_has_session_id=unknown
latest_transcript_matched=unknown
latest_factory_matched=unknown
active_data_source_readable=no
active_data_source_id_present=no

if [ -d "$outbound_root" ]; then
  outbound_state=present
  if sudo -u netinside test -r "$outbound_root" && sudo -u netinside test -x "$outbound_root"; then
    if sudo -u netinside test -w "$outbound_root"; then outbound_access=read-write; else outbound_access=read-only; fi
  else
    outbound_access=unreadable
  fi
fi
if sudo -u netinside test -r "$reports_root" && sudo -u netinside test -x "$reports_root"; then
  if sudo -u netinside test -w "$reports_root"; then reports_access=read-write; else reports_access=read-only; fi
else
  reports_access=unreadable
fi
active_data_source_file='/var/lib/gaiop/runtime/runtime-active-data-source.json'
if sudo -u netinside test -r "$active_data_source_file"; then
  active_data_source_readable=yes
  if sudo -u netinside node -e "const value=require('$active_data_source_file'); process.exit(String(value?.activeDataSource?.id || '').trim() ? 0 : 1)" 2>/dev/null; then
    active_data_source_id_present=yes
  fi
fi
if grep -Fq '报告将在受控归档流程登记' "$plugin_file" 2>/dev/null || grep -Fq 'buildReportExportReply' "$plugin_file" 2>/dev/null; then archive_only_reply=yes; fi
if grep -Fq 'function toPublicReportExportResult' "$plugin_file" 2>/dev/null && ! sed -n '/function toPublicReportExportResult/,/^}/p' "$plugin_file" | grep -Fq 'filePath'; then public_path_hidden=yes; fi
if grep -Fq 'GAIOP_REPORT_DELIVERY_DIR' "$plugin_file" 2>/dev/null; then delivery_copy_support=yes; fi

gateway_log=$(gatewayctl --no-pager -n 1200 status openclaw-gateway.service 2>/dev/null || true)
journal_log=$(sudo -u netinside XDG_RUNTIME_DIR="$gateway_runtime" journalctl --user -u openclaw-gateway.service -n 1600 --no-pager 2>/dev/null || true)
combined_log="$gateway_log
$journal_log"
path_error_count=$(printf '%s' "$combined_log" | grep -Eci 'LocalMediaAccessError|not under an allowed|outside.*allowed|media.*(denied|reject)|ENOENT.*(docx|pdf)|attachment.*(fail|error)|send.*file.*(fail|error)' || true)
reports_path_error_count=$(printf '%s' "$combined_log" | grep -Eci '/var/lib/gaiop/reports|GAIOP_REPORTS_DIR' || true)
audit_summary=$(sudo -u netinside node - '/home/netinside/.openclaw/logs/audit.log' <<'NODE' 2>/dev/null || true
const fs = require('node:fs')
const file = process.argv[2]
let match = null
try {
  for (const line of fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-5000)) {
    try {
      const value = JSON.parse(line)
      if (value?.event === 'napm_report_provenance_resolution') match = value
    } catch {}
  }
} catch {}
if (match) process.stdout.write([
  String(Boolean(match.factoryHasSessionKey)),
  String(Boolean(match.factoryHasSessionId)),
  String(Boolean(match.transcriptMatched)),
  String(Boolean(match.factoryMatched))
].join('|'))
NODE
)
if [ -n "$audit_summary" ]; then
  IFS='|' read -r latest_factory_has_session_key latest_factory_has_session_id latest_transcript_matched latest_factory_matched <<EOF
$audit_summary
EOF
fi

printf 'GATEWAY_SERVICE=%s\n' "$(gatewayctl is-active openclaw-gateway.service 2>/dev/null || true)"
printf 'OUTBOUND_DIRECTORY=%s\n' "$outbound_state"
printf 'OUTBOUND_ACCESS=%s\n' "$outbound_access"
printf 'REPORTS_ACCESS=%s\n' "$reports_access"
printf 'ARCHIVE_ONLY_REPLY=%s\n' "$archive_only_reply"
printf 'PUBLIC_PATH_HIDDEN=%s\n' "$public_path_hidden"
printf 'DELIVERY_COPY_SUPPORT=%s\n' "$delivery_copy_support"
printf 'PATH_ERROR_COUNT=%s\n' "$path_error_count"
printf 'REPORTS_PATH_ERROR_COUNT=%s\n' "$reports_path_error_count"
printf 'LATEST_FACTORY_HAS_SESSION_KEY=%s\n' "$latest_factory_has_session_key"
printf 'LATEST_FACTORY_HAS_SESSION_ID=%s\n' "$latest_factory_has_session_id"
printf 'LATEST_TRANSCRIPT_MATCHED=%s\n' "$latest_transcript_matched"
printf 'LATEST_FACTORY_MATCHED=%s\n' "$latest_factory_matched"
printf 'ACTIVE_DATA_SOURCE_READABLE=%s\n' "$active_data_source_readable"
printf 'ACTIVE_DATA_SOURCE_ID_PRESENT=%s\n' "$active_data_source_id_present"
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => {
        if (exitCode === 0) resolve(output)
        else reject(new Error(`remote exit ${exitCode}`))
      })
      stream.write(`${connection.password}\n${diagnostic}`)
      stream.end()
    })
  })
}

function parse(output) {
  const values = Object.create(null)
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    if (match) values[match[1]] = match[2]
  }
  return {
    gatewayService: values.GATEWAY_SERVICE || 'unavailable',
    outboundDirectory: values.OUTBOUND_DIRECTORY || 'unavailable',
    outboundAccess: values.OUTBOUND_ACCESS || 'unavailable',
    reportsAccess: values.REPORTS_ACCESS || 'unavailable',
    archiveOnlyReply: values.ARCHIVE_ONLY_REPLY === 'yes',
    publicPathHidden: values.PUBLIC_PATH_HIDDEN === 'yes',
    deliveryCopySupport: values.DELIVERY_COPY_SUPPORT === 'yes',
    pathErrorCount: Number(values.PATH_ERROR_COUNT || 0),
    reportsPathErrorCount: Number(values.REPORTS_PATH_ERROR_COUNT || 0),
    latestFactoryHasSessionKey: values.LATEST_FACTORY_HAS_SESSION_KEY === 'true',
    latestFactoryHasSessionId: values.LATEST_FACTORY_HAS_SESSION_ID === 'true',
    latestTranscriptMatched: values.LATEST_TRANSCRIPT_MATCHED === 'true',
    latestFactoryMatched: values.LATEST_FACTORY_MATCHED === 'true',
    activeDataSourceReadable: values.ACTIVE_DATA_SOURCE_READABLE === 'yes',
    activeDataSourceIdPresent: values.ACTIVE_DATA_SOURCE_ID_PRESENT === 'yes',
  }
}

const client = new Client()
let finished = false
const timer = setTimeout(() => {
  if (!finished) process.stdout.write('{"ok":false,"errorCode":"REPORT_DELIVERY_DIAG_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 45_000)

client.on('ready', async () => {
  try {
    const output = await execute(client)
    finished = true
    clearTimeout(timer)
    process.stdout.write(`${JSON.stringify({ ok: true, diagnostic: parse(output) })}\n`)
  } catch {
    finished = true
    clearTimeout(timer)
    process.stdout.write('{"ok":false,"errorCode":"REPORT_DELIVERY_DIAG_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  process.stdout.write('{"ok":false,"errorCode":"REPORT_DELIVERY_DIAG_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
