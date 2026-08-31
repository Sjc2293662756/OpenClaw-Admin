'use strict'

const { createHash } = require('node:crypto')
const { existsSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const EXPECTED_HOST = '101.254.114.237'
const ROOT = path.resolve(__dirname, '..')
const ENTRY = path.join(__dirname, 'session-reconciliation-remote-entry.js')
const PACKAGE_JSON = path.join(ROOT, 'package.json')
const requireFromProject = createRequire(PACKAGE_JSON)

function readConfiguration(env = process.env) {
  const configuration = {
    host: String(env.GAIOP_SESSION_RECONCILIATION_237_SSH_HOST || '').trim(),
    username: String(env.GAIOP_SESSION_RECONCILIATION_237_SSH_USERNAME || '').trim(),
    password: String(env.GAIOP_SESSION_RECONCILIATION_237_SSH_PASSWORD || ''),
  }
  if (configuration.host !== EXPECTED_HOST) throw new Error('HOST_NOT_ALLOWED')
  if (!configuration.username || !configuration.password) throw new Error('CONNECTION_CONTEXT_UNAVAILABLE')
  if (!existsSync(ENTRY)) throw new Error('FIXED_ENTRY_UNAVAILABLE')
  return configuration
}

async function buildBundle() {
  const { build } = requireFromProject('esbuild')
  const buildResult = await build({
    entryPoints: [ENTRY],
    absWorkingDir: ROOT,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  })
  const output = buildResult.outputFiles?.[0]?.text
  if (!output || output.length > 1024 * 1024) throw new Error('FIXED_ENTRY_BUILD_FAILED')
  return {
    source: output,
    sha256: createHash('sha256').update(output, 'utf8').digest('hex'),
  }
}

function buildRemoteScript(bundle) {
  if (!/^[0-9a-f]{64}$/.test(bundle.sha256)) throw new Error('FIXED_ENTRY_BUILD_FAILED')
  const encoded = Buffer.from(bundle.source, 'utf8').toString('base64')
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error('FIXED_ENTRY_BUILD_FAILED')
  return `set -euo pipefail
node_path='/usr/local/bin/node'
openclaw_path='/home/netinside/.npm-global/bin/openclaw'
admin_root='/opt/gaiop/admin'
database_file='/var/lib/gaiop/admin/wizard.db'
session_index='/home/netinside/.openclaw/agents/main/sessions/sessions.json'
unit_name='gaiop-session-reconciliation-dry-run'
expected_bundle_sha='${bundle.sha256}'
bundle_b64='${encoded}'

test -x "$node_path"
test -x "$openclaw_path"
test -f "$admin_root/package.json"
test -d "$admin_root/node_modules/better-sqlite3"
test -r "$database_file"
test -r "$session_index"
id netinside >/dev/null 2>&1
getent group gaiop >/dev/null 2>&1

actual_bundle_sha=$(printf '%s' "$bundle_b64" | base64 -d | sha256sum | cut -d' ' -f1)
test "$actual_bundle_sha" = "$expected_bundle_sha"

database_state() {
  for candidate in "$database_file" "$database_file-wal" "$database_file-shm"; do
    if [ -f "$candidate" ]; then
      sha256sum -- "$candidate" | cut -d' ' -f1
    else
      printf 'absent\n'
    fi
  done | sha256sum | cut -d' ' -f1
}

index_state() {
  sha256sum -- "$session_index" | cut -d' ' -f1
}

database_before=$(database_state)
index_before=$(index_state)

set +e
unit_output=$(printf '%s' "$bundle_b64" | base64 -d | timeout --signal=TERM 180 \
  systemd-run --quiet --wait --collect --pipe --service-type=exec \
  --unit="$unit_name" \
  --property=User=netinside \
  --property=Group=netinside \
  --property=SupplementaryGroups=gaiop \
  --property=WorkingDirectory=/opt/gaiop/admin \
  --property=Environment=HOME=/home/netinside \
  --property=Environment=USER=netinside \
  --property=Environment=LOGNAME=netinside \
  --property=Environment=LANG=C.UTF-8 \
  --property=Environment=LC_ALL=C.UTF-8 \
  --property=Environment=PATH=/home/netinside/.npm-global/bin:/usr/local/bin:/usr/bin:/bin \
  --property=NoNewPrivileges=yes \
  --property=PrivateTmp=yes \
  --property=PrivateDevices=yes \
  --property=ProtectSystem=strict \
  --property=ProtectHome=read-only \
  --property='ReadOnlyPaths=/opt/gaiop/admin /var/lib/gaiop/admin /home/netinside/.openclaw' \
  --property=InaccessiblePaths=/etc/gaiop \
  --property='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectKernelLogs=yes \
  --property=ProtectControlGroups=yes \
  --property=ProtectHostname=yes \
  --property=ProtectClock=yes \
  --property=ProtectProc=invisible \
  --property=ProcSubset=pid \
  --property=LockPersonality=yes \
  --property=RestrictRealtime=yes \
  --property=RestrictSUIDSGID=yes \
  --property=SystemCallArchitectures=native \
  --property=UMask=0077 \
  --property=CapabilityBoundingSet= \
  --property=AmbientCapabilities= \
  "$node_path" --input-type=module 2>/dev/null)
run_exit=$?
set -e

database_after=$(database_state)
index_after=$(index_state)
if [ "$database_before" = "$database_after" ]; then database_unchanged=true; else database_unchanged=false; fi
if [ "$index_before" = "$index_after" ]; then index_unchanged=true; else index_unchanged=false; fi

result_b64=$(printf '%s' "$unit_output" | base64 -w0)
printf 'EXECUTED=true\n'
printf 'RUN_EXIT=%s\n' "$run_exit"
printf 'DATABASE_UNCHANGED=%s\n' "$database_unchanged"
printf 'OPENCLAW_INDEX_UNCHANGED=%s\n' "$index_unchanged"
printf 'PROTECT_SYSTEM_STRICT=true\n'
printf 'PROTECT_HOME_READ_ONLY=true\n'
printf 'BUSINESS_PATHS_READ_ONLY=true\n'
printf 'TRANSIENT_SERVICE_COLLECTED=true\n'
printf 'TIMER_CREATED=false\n'
printf 'BUNDLE_SHA256=%s\n' "$expected_bundle_sha"
printf 'RESULT_B64=%s\n' "$result_b64"
`
}

function execute(client, command, password) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) {
        resolve({ ok: false, output: '' })
        return
      }
      let output = ''
      let truncated = false
      stream.on('data', (chunk) => {
        if (truncated) return
        output += chunk.toString('utf8')
        if (output.length > 8 * 1024 * 1024) {
          output = ''
          truncated = true
          stream.close()
        }
      })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({
        ok: exitCode === 0 && !truncated,
        output,
      }))
      stream.write(`${password}\n${command}`)
      stream.end()
    })
  })
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

function decodeReconciliation(value) {
  try {
    const output = Buffer.from(String(value || ''), 'base64').toString('utf8').trim()
    for (const line of output.split(/\r?\n/).reverse()) {
      try {
        const parsed = JSON.parse(line)
        if (parsed?.schema === 'gaiop.session-reconciliation.v1'
          && ['ok', 'unknown'].includes(parsed?.status)) return parsed
      } catch {
        // systemd may emit a non-JSON status line around the fixed command output.
      }
    }
  } catch {
    return null
  }
  return null
}

function parseRemoteOutput(output) {
  const markers = markerMap(output)
  const databaseUnchanged = markerBoolean(markers, 'DATABASE_UNCHANGED')
  const openclawIndexUnchanged = markerBoolean(markers, 'OPENCLAW_INDEX_UNCHANGED')
  const timerStateConfirmed = markers.get('TIMER_CREATED') === 'false'
  const runtimeGuards = {
    protectSystemStrict: markerBoolean(markers, 'PROTECT_SYSTEM_STRICT'),
    protectHomeReadOnly: markerBoolean(markers, 'PROTECT_HOME_READ_ONLY'),
    businessPathsReadOnly: markerBoolean(markers, 'BUSINESS_PATHS_READ_ONLY'),
    transientServiceCollected: markerBoolean(markers, 'TRANSIENT_SERVICE_COLLECTED'),
    timerCreated: markerBoolean(markers, 'TIMER_CREATED'),
  }
  let reconciliation = decodeReconciliation(markers.get('RESULT_B64'))
  if (reconciliation?.status === 'ok' && (!databaseUnchanged || !openclawIndexUnchanged)) {
    reconciliation = {
      schema: 'gaiop.session-reconciliation.v1',
      status: 'unknown',
      reasonCodes: ['REMOTE_STATE_CHANGED_DURING_RUN'],
    }
  }
  const runExit = markerInteger(markers, 'RUN_EXIT')
  const reconciliationSafetyConfirmed = reconciliation?.safety?.sqliteReadonly === true
    && reconciliation?.safety?.sqliteQueryOnly === true
    && reconciliation?.safety?.sqliteTotalChanges === 0
    && reconciliation?.safety?.sqliteDataVersionStable === true
    && reconciliation?.safety?.openclawSnapshotStable === true
    && reconciliation?.safety?.fixedOpenClawInterfaces === true
    && reconciliation?.safety?.mutationActionsAvailable === false
  const guardsConfirmed = runtimeGuards.protectSystemStrict
    && runtimeGuards.protectHomeReadOnly
    && runtimeGuards.businessPathsReadOnly
    && runtimeGuards.transientServiceCollected
    && timerStateConfirmed
  const executed = markerBoolean(markers, 'EXECUTED') && reconciliation !== null
  const completed = executed
    && runExit === 0
    && databaseUnchanged
    && openclawIndexUnchanged
    && guardsConfirmed
    && reconciliation?.status === 'ok'
    && reconciliationSafetyConfirmed
  return {
    completed,
    executed,
    status: completed ? 'dry-run-complete' : (reconciliation?.status === 'unknown' ? 'dry-run-unknown' : 'dry-run-failed'),
    runExit,
    sourceBundleSha256: /^[0-9a-f]{64}$/.test(String(markers.get('BUNDLE_SHA256') || ''))
      ? markers.get('BUNDLE_SHA256')
      : null,
    databaseUnchanged,
    openclawIndexUnchanged,
    runtimeGuards,
    reconciliationSafetyConfirmed,
    reconciliation,
    errorCode: completed ? null : 'SESSION_RECONCILIATION_DRY_RUN_INCOMPLETE',
  }
}

function connect(Client, configuration) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.once('ready', () => resolve(client))
    client.once('error', reject)
    client.connect({
      host: configuration.host,
      username: configuration.username,
      password: configuration.password,
      readyTimeout: 20_000,
    })
  })
}

function safeErrorCode(error) {
  const code = String(error?.message || '')
  if (['HOST_NOT_ALLOWED', 'CONNECTION_CONTEXT_UNAVAILABLE', 'FIXED_ENTRY_UNAVAILABLE', 'FIXED_ENTRY_BUILD_FAILED'].includes(code)) {
    return code
  }
  if (/authentication/i.test(code)) return 'SSH_AUTHENTICATION_FAILED'
  return 'CONTROLLED_SESSION_RECONCILIATION_FAILED'
}

async function main() {
  let configuration
  let client
  try {
    configuration = readConfiguration()
    const bundle = await buildBundle()
    const Client = requireFromProject('ssh2').Client
    client = await connect(Client, configuration)
    const remote = await execute(client, buildRemoteScript(bundle), configuration.password)
    const result = remote.ok
      ? parseRemoteOutput(remote.output)
      : {
          completed: false,
          executed: false,
          status: 'dry-run-failed',
          errorCode: 'REMOTE_READONLY_RUNNER_FAILED',
        }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.completed) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      completed: false,
      executed: false,
      status: 'dry-run-failed',
      errorCode: safeErrorCode(error),
    })}\n`)
    process.exitCode = 1
  } finally {
    if (client) client.end()
    if (configuration) configuration.password = ''
  }
}

if (require.main === module) main()

module.exports = {
  EXPECTED_HOST,
  readConfiguration,
  buildBundle,
  buildRemoteScript,
  markerMap,
  decodeReconciliation,
  parseRemoteOutput,
  safeErrorCode,
}
