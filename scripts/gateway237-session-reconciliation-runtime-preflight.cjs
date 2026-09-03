'use strict'

const {
  readConfiguration,
  connect,
  execute,
} = require('./gateway237-session-reconciliation-dry-run.cjs')

function buildRemoteScript() {
  return String.raw`set -euo pipefail
node_path='/usr/local/bin/node'
openclaw_path='/home/netinside/.npm-global/bin/openclaw'
openclaw_home='/home/netinside'

test -x "$node_path"
test -x "$openclaw_path"
netinside_uid=$(id -u netinside)
case "$netinside_uid" in
  ''|*[!0-9]*) exit 41 ;;
esac
runtime_dir="/run/user/$netinside_uid"

if [ -d "$runtime_dir" ]; then runtime_present=true; else runtime_present=false; fi
if [ -S "$runtime_dir/bus" ]; then user_bus_present=true; else user_bus_present=false; fi

run_openclaw() {
  runuser -u netinside -- env \
    HOME="$openclaw_home" \
    USER=netinside \
    LOGNAME=netinside \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/home/netinside/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="$runtime_dir" \
    "$@"
}

gateway_state=$(run_openclaw systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)
case "$gateway_state" in
  active|inactive|failed|activating|deactivating) ;;
  *) gateway_state=unknown ;;
esac

cli_version=$(run_openclaw "$openclaw_path" --version 2>/dev/null \
  | sed -nE 's/.*([0-9]{4}\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1 || true)
case "$cli_version" in
  [0-9][0-9][0-9][0-9].[0-9]*.[0-9]*) ;;
  *) cli_version=unknown ;;
esac

call_help=$(run_openclaw "$openclaw_path" gateway call --help 2>/dev/null || true)
if printf '%s' "$call_help" | grep -q -- '--json'; then supports_json=true; else supports_json=false; fi
if printf '%s' "$call_help" | grep -q -- '--params'; then supports_params=true; else supports_params=false; fi
if printf '%s' "$call_help" | grep -q -- '--timeout'; then supports_timeout=true; else supports_timeout=false; fi

cleanup_help=$(run_openclaw "$openclaw_path" sessions cleanup --help 2>/dev/null || true)
if printf '%s' "$cleanup_help" | grep -q -- '--json'; then supports_cleanup_json=true; else supports_cleanup_json=false; fi
if printf '%s' "$cleanup_help" | grep -q -- '--dry-run'; then supports_cleanup_dry_run=true; else supports_cleanup_dry_run=false; fi

set +e
rpc_output=$(timeout --signal=TERM 75 runuser -u netinside -- env \
  HOME="$openclaw_home" \
  USER=netinside \
  LOGNAME=netinside \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PATH=/home/netinside/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="$runtime_dir" \
  "$openclaw_path" gateway call sessions.list --json --params '{"limit":100000}' --timeout 60000 2>&1)
rpc_exit=$?
set -e

rpc_status=failed
rpc_reason=RPC_NONZERO_EXIT
rpc_summary_b64=''
if [ "$rpc_exit" -eq 124 ]; then
  rpc_reason=RPC_PROCESS_TIMEOUT
elif [ "$rpc_exit" -eq 127 ]; then
  rpc_reason=RPC_COMMAND_UNAVAILABLE
elif [ "$rpc_exit" -ne 0 ]; then
  case "$rpc_output" in
    *[Tt]imed\ out*|*[Tt]imeout*) rpc_reason=RPC_GATEWAY_TIMEOUT ;;
    *[Cc]onnection\ refused*|*ECONNREFUSED*) rpc_reason=RPC_GATEWAY_UNAVAILABLE ;;
    *[Uu]nknown\ option*|*[Uu]nrecognized\ option*) rpc_reason=RPC_ARGUMENT_UNSUPPORTED ;;
    *[Ii]nvalid\ param*|*[Uu]nexpected\ propert*|*[Mm]ust\ match\ a\ schema*) rpc_reason=RPC_PARAMS_REJECTED ;;
    *) rpc_reason=RPC_NONZERO_EXIT ;;
  esac
else
  set +e
  rpc_summary=$(printf '%s' "$rpc_output" | "$node_path" -e '
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  const raw = input.replace(/\u001b\[[0-9;]*m/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const first = raw.indexOf("{")
    const last = raw.lastIndexOf("}")
    if (first < 0 || last <= first) process.exit(2)
    try { parsed = JSON.parse(raw.slice(first, last + 1)) } catch { process.exit(2) }
  }
  let payload = parsed
  for (let depth = 0; depth < 5; depth += 1) {
    if (payload && typeof payload === "object" && Array.isArray(payload.sessions)) break
    const nested = payload?.payload ?? payload?.result ?? payload?.data
    if (!nested || nested === payload) process.exit(3)
    payload = nested
  }
  if (!payload || !Array.isArray(payload.sessions)) process.exit(3)
  const rows = payload.sessions
  const count = (name, predicate) => rows.reduce((total, row) => total + (predicate(row?.[name]) ? 1 : 0), 0)
  const safeInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
  process.stdout.write(JSON.stringify({
    sessionCount: rows.length,
    declaredCount: safeInteger(payload.count),
    declaredTotalCount: safeInteger(payload.totalCount),
    hasMore: typeof payload.hasMore === "boolean" ? payload.hasMore : null,
    fields: {
      keyString: count("key", (value) => typeof value === "string" && value.length > 0),
      sessionKeyString: count("sessionKey", (value) => typeof value === "string" && value.length > 0),
      idString: count("id", (value) => typeof value === "string" && value.length > 0),
      sessionIdString: count("sessionId", (value) => typeof value === "string" && value.length > 0),
      updatedAtNumber: count("updatedAt", (value) => Number.isFinite(Number(value))),
      hasActiveRunBoolean: count("hasActiveRun", (value) => typeof value === "boolean"),
      isRunningBoolean: count("isRunning", (value) => typeof value === "boolean"),
      isStreamingBoolean: count("isStreaming", (value) => typeof value === "boolean"),
      inFlightBoolean: count("inFlight", (value) => typeof value === "boolean"),
      activeRunIdPresent: count("activeRunId", (value) => typeof value === "string" && value.length > 0),
      activeRunsPresent: count("activeRuns", (value) => Array.isArray(value) ? value.length > 0 : Number(value) > 0),
    },
  }))
})
' 2>/dev/null)
  summary_exit=$?
  set -e
  if [ "$summary_exit" -eq 0 ]; then
    rpc_status=ok
    rpc_reason=NONE
    rpc_summary_b64=$(printf '%s' "$rpc_summary" | base64 -w0)
  else
    rpc_reason=RPC_JSON_INVALID
  fi
fi

set +e
cleanup_output=$(timeout --signal=TERM 75 runuser -u netinside -- env \
  HOME="$openclaw_home" \
  USER=netinside \
  LOGNAME=netinside \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PATH=/home/netinside/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="$runtime_dir" \
  "$openclaw_path" sessions cleanup --agent main --dry-run --json 2>&1)
cleanup_exit=$?
set -e

cleanup_status=failed
cleanup_reason=CLEANUP_NONZERO_EXIT
cleanup_summary_b64=''
if [ "$cleanup_exit" -eq 124 ]; then
  cleanup_reason=CLEANUP_PROCESS_TIMEOUT
elif [ "$cleanup_exit" -eq 127 ]; then
  cleanup_reason=CLEANUP_COMMAND_UNAVAILABLE
elif [ "$cleanup_exit" -ne 0 ]; then
  case "$cleanup_output" in
    *[Tt]imed\ out*|*[Tt]imeout*) cleanup_reason=CLEANUP_TIMEOUT ;;
    *[Uu]nknown\ option*|*[Uu]nrecognized\ option*) cleanup_reason=CLEANUP_ARGUMENT_UNSUPPORTED ;;
    *) cleanup_reason=CLEANUP_NONZERO_EXIT ;;
  esac
else
  set +e
  cleanup_summary=$(printf '%s' "$cleanup_output" | "$node_path" -e '
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { input += chunk })
process.stdin.on("end", () => {
  const raw = input.replace(/\u001b\[[0-9;]*m/g, "").trim()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const first = raw.indexOf("{")
    const last = raw.lastIndexOf("}")
    if (first < 0 || last <= first) process.exit(2)
    try { parsed = JSON.parse(raw.slice(first, last + 1)) } catch { process.exit(2) }
  }
  const stores = Array.isArray(parsed?.stores) ? parsed.stores : null
  const named = stores?.filter((store) => store?.agentId === "main") || []
  const store = stores ? (named.length === 1 ? named[0] : (stores.length === 1 ? stores[0] : null)) : parsed
  const missing = Number.isSafeInteger(store?.missing) && store.missing >= 0 ? store.missing : null
  if (!store || missing === null) process.exit(3)
  process.stdout.write(JSON.stringify({
    format: "json_aggregate",
    reportedMissingCount: missing,
    identityResolvedCount: 0,
    identityUnresolvedCount: missing,
    candidateMatchSummary: { exactKey: 0, sessionId: 0, bothSameCanonical: 0, zero: missing, multiple: 0 },
  }))
})
' 2>/dev/null)
  cleanup_summary_exit=$?
  set -e
  if [ "$cleanup_summary_exit" -eq 0 ]; then
    cleanup_status=ok
    cleanup_reason=NONE
    cleanup_summary_b64=$(printf '%s' "$cleanup_summary" | base64 -w0)
  else
    cleanup_reason=CLEANUP_JSON_INVALID
  fi
fi

printf 'PREFLIGHT_COMPLETE=true\n'
printf 'UID_RESOLVED=true\n'
printf 'XDG_RUNTIME_PRESENT=%s\n' "$runtime_present"
printf 'USER_BUS_PRESENT=%s\n' "$user_bus_present"
printf 'DBUS_EXPLICITLY_SET=false\n'
printf 'GATEWAY_SERVICE=%s\n' "$gateway_state"
printf 'CLI_VERSION=%s\n' "$cli_version"
printf 'SUPPORTS_JSON=%s\n' "$supports_json"
printf 'SUPPORTS_PARAMS=%s\n' "$supports_params"
printf 'SUPPORTS_TIMEOUT=%s\n' "$supports_timeout"
printf 'SUPPORTS_CLEANUP_JSON=%s\n' "$supports_cleanup_json"
printf 'SUPPORTS_CLEANUP_DRY_RUN=%s\n' "$supports_cleanup_dry_run"
printf 'RPC_STATUS=%s\n' "$rpc_status"
printf 'RPC_REASON=%s\n' "$rpc_reason"
printf 'RPC_EXIT=%s\n' "$rpc_exit"
printf 'RPC_SUMMARY_B64=%s\n' "$rpc_summary_b64"
printf 'CLEANUP_STATUS=%s\n' "$cleanup_status"
printf 'CLEANUP_REASON=%s\n' "$cleanup_reason"
printf 'CLEANUP_EXIT=%s\n' "$cleanup_exit"
printf 'CLEANUP_SUMMARY_B64=%s\n' "$cleanup_summary_b64"
`
}

function markerMap(output) {
  const markers = new Map()
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (match) markers.set(match[1], match[2])
  }
  return markers
}

function markerBoolean(markers, key) {
  return markers.get(key) === 'true'
}

function markerInteger(markers, key) {
  const value = Number(markers.get(key))
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function decodeSummary(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'))
    if (!parsed || !Number.isSafeInteger(parsed.sessionCount) || parsed.sessionCount < 0) return null
    return parsed
  } catch {
    return null
  }
}

function decodeCleanupSummary(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'))
    const count = (field) => Number.isSafeInteger(parsed?.[field]) && parsed[field] >= 0
      ? parsed[field]
      : null
    const reportedMissingCount = count('reportedMissingCount')
    const identityResolvedCount = count('identityResolvedCount')
    const identityUnresolvedCount = count('identityUnresolvedCount')
    const candidates = parsed?.candidateMatchSummary
    if (parsed?.format !== 'json_aggregate' || reportedMissingCount === null
      || identityResolvedCount === null || identityUnresolvedCount === null
      || identityResolvedCount + identityUnresolvedCount !== reportedMissingCount
      || !candidates || ['exactKey', 'sessionId', 'bothSameCanonical', 'zero', 'multiple']
        .some((field) => !Number.isSafeInteger(candidates[field]) || candidates[field] < 0)) return null
    return {
      format: 'json_aggregate',
      reportedMissingCount,
      identityResolvedCount,
      identityUnresolvedCount,
      candidateMatchSummary: {
        exactKey: candidates.exactKey,
        sessionId: candidates.sessionId,
        bothSameCanonical: candidates.bothSameCanonical,
        zero: candidates.zero,
        multiple: candidates.multiple,
      },
    }
  } catch {
    return null
  }
}

function parseRemoteOutput(output) {
  const markers = markerMap(output)
  const rpcStatus = markers.get('RPC_STATUS') === 'ok' ? 'ok' : 'failed'
  const reasonCode = /^[A-Z][A-Z0-9_]{0,95}$/.test(String(markers.get('RPC_REASON') || ''))
    ? markers.get('RPC_REASON')
    : 'PREFLIGHT_OUTPUT_INVALID'
  const summary = rpcStatus === 'ok' ? decodeSummary(markers.get('RPC_SUMMARY_B64')) : null
  const cleanupStatus = markers.get('CLEANUP_STATUS') === 'ok' ? 'ok' : 'failed'
  const cleanupReasonCode = /^[A-Z][A-Z0-9_]{0,95}$/.test(String(markers.get('CLEANUP_REASON') || ''))
    ? markers.get('CLEANUP_REASON')
    : 'PREFLIGHT_OUTPUT_INVALID'
  const cleanupSummary = cleanupStatus === 'ok' ? decodeCleanupSummary(markers.get('CLEANUP_SUMMARY_B64')) : null
  const completed = markerBoolean(markers, 'PREFLIGHT_COMPLETE')
    && markerBoolean(markers, 'UID_RESOLVED')
    && rpcStatus === 'ok'
    && summary !== null
    && cleanupStatus === 'ok'
    && cleanupSummary !== null
    && markerBoolean(markers, 'SUPPORTS_CLEANUP_JSON')
    && markerBoolean(markers, 'SUPPORTS_CLEANUP_DRY_RUN')
  return {
    completed,
    environment: {
      uidResolved: markerBoolean(markers, 'UID_RESOLVED'),
      xdgRuntimePresent: markerBoolean(markers, 'XDG_RUNTIME_PRESENT'),
      userBusPresent: markerBoolean(markers, 'USER_BUS_PRESENT'),
      dbusExplicitlySet: markerBoolean(markers, 'DBUS_EXPLICITLY_SET'),
      gatewayUserService: ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(markers.get('GATEWAY_SERVICE'))
        ? markers.get('GATEWAY_SERVICE')
        : 'unknown',
    },
    cli: {
      version: /^\d{4}\.\d+\.\d+$/.test(String(markers.get('CLI_VERSION') || ''))
        ? markers.get('CLI_VERSION')
        : 'unknown',
      supportsJson: markerBoolean(markers, 'SUPPORTS_JSON'),
      supportsParams: markerBoolean(markers, 'SUPPORTS_PARAMS'),
      supportsTimeout: markerBoolean(markers, 'SUPPORTS_TIMEOUT'),
      supportsCleanupJson: markerBoolean(markers, 'SUPPORTS_CLEANUP_JSON'),
      supportsCleanupDryRun: markerBoolean(markers, 'SUPPORTS_CLEANUP_DRY_RUN'),
    },
    rpc: {
      status: rpcStatus,
      reasonCode,
      exitCode: markerInteger(markers, 'RPC_EXIT'),
      summary,
    },
    cleanup: {
      status: cleanupStatus,
      reasonCode: cleanupReasonCode,
      exitCode: markerInteger(markers, 'CLEANUP_EXIT'),
      summary: cleanupSummary,
    },
  }
}

async function main() {
  let configuration
  let client
  try {
    configuration = readConfiguration()
    client = await connect(require('ssh2').Client, configuration)
    const remote = await execute(client, buildRemoteScript(), configuration.password)
    const result = remote.ok
      ? parseRemoteOutput(remote.output)
      : { completed: false, errorCode: 'REMOTE_RUNTIME_PREFLIGHT_FAILED' }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.completed) process.exitCode = 1
  } catch {
    process.stdout.write('{"completed":false,"errorCode":"CONTROLLED_RUNTIME_PREFLIGHT_FAILED"}\n')
    process.exitCode = 1
  } finally {
    if (client) client.end()
    if (configuration) configuration.password = ''
  }
}

if (require.main === module) main()

module.exports = {
  buildRemoteScript,
  parseRemoteOutput,
  decodeSummary,
  decodeCleanupSummary,
}
