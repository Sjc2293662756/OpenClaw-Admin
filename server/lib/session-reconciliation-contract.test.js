import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const core = readFileSync(join(here, 'session-reconciliation.js'), 'utf8')
const cli = readFileSync(join(root, 'server', 'session-reconciliation.js'), 'utf8')
const remoteEntry = readFileSync(join(root, 'scripts', 'session-reconciliation-remote-entry.js'), 'utf8')
const runner = readFileSync(join(root, 'scripts', 'gateway237-session-reconciliation-dry-run.cjs'), 'utf8')
const wrapper = readFileSync(join(root, 'scripts', 'Invoke-237SessionReconciliationDryRun.ps1'), 'utf8')
const runtimePreflight = readFileSync(join(root, 'scripts', 'gateway237-session-reconciliation-runtime-preflight.cjs'), 'utf8')
const runtimePreflightWrapper = readFileSync(join(root, 'scripts', 'Invoke-237SessionReconciliationRuntimePreflight.ps1'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const requireFromHere = createRequire(import.meta.url)
const controlledEntry = requireFromHere('../../scripts/gateway237-session-reconciliation-dry-run.cjs')
const controlledRuntimePreflight = requireFromHere('../../scripts/gateway237-session-reconciliation-runtime-preflight.cjs')

test('production reconciliation runtime has no database or filesystem mutation capability', () => {
  const productionRuntime = `${core}\n${cli}\n${remoteEntry}`
  assert.doesNotMatch(
    productionRuntime,
    /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+(?:TABLE|INDEX|TRIGGER)|DROP\s+(?:TABLE|INDEX|TRIGGER)|ALTER\s+TABLE|VACUUM\b)/i,
  )
  assert.doesNotMatch(productionRuntime, /\b(?:unlink|rmSync|rm|rename|writeFile|appendFile|copyFile|createWriteStream|mkdir)\b/)
  assert.doesNotMatch(productionRuntime, /sessions\.delete|sessions\.patch|sessions\.reset/)
  assert.doesNotMatch(productionRuntime, /--enforce/)
  assert.doesNotMatch(productionRuntime, /(?:conversation_history|execution_history|session_title|original_name|attachment_ref)/)
  assert.doesNotMatch(productionRuntime, /from ['"].*database\.js['"]/)
  assert.match(core, /new DatabaseClass\(databasePath, \{ readonly: true, fileMustExist: true \}\)/)
  assert.match(core, /query_only = ON/)
  assert.match(core, /SELECT total_changes\(\) AS value/)
  assert.match(core, /'sessions', 'cleanup', '--agent', 'main', '--dry-run', '--fix-missing'/)
  assert.match(core, /'--timeout',\s*'60000'/)
  assert.match(core, /timeout:\s*75_000/)
  assert.match(core, /JSON\.stringify\(\{ limit: MAX_OPENCLAW_ROWS \}\)/)
  assert.match(core, /XDG_RUNTIME_DIR: xdgRuntimeDirectory/)
  assert.doesNotMatch(core, /DBUS_SESSION_BUS_ADDRESS/)
})

test('controlled 237 entry is fixed-purpose and transient with read-only business paths', () => {
  assert.equal(controlledEntry.EXPECTED_HOST, '101.254.114.237')
  assert.doesNotMatch(runner, /process\.argv/)
  assert.match(runner, /ProtectSystem=strict/)
  assert.match(runner, /ProtectHome=read-only/)
  assert.match(runner, /netinside_uid=\$\(id -u netinside\)/)
  assert.match(runner, /runtime_dir="\/run\/user\/\$netinside_uid"/)
  assert.match(runner, /Environment=XDG_RUNTIME_DIR=\$runtime_dir/)
  assert.match(runner, /ReadOnlyPaths=\/opt\/gaiop\/admin \/var\/lib\/gaiop\/admin \/home\/netinside\/\.openclaw \$runtime_dir/)
  assert.match(runner, /InaccessiblePaths=\/etc\/gaiop/)
  assert.match(runner, /NoNewPrivileges=yes/)
  assert.match(runner, /systemd-run --quiet --wait --collect --pipe/)
  assert.match(runner, /TRANSIENT_SERVICE_COLLECTED=true/)
  assert.match(runner, /TIMER_CREATED=false/)
  assert.doesNotMatch(runner, /ReadWritePaths=/)
  assert.doesNotMatch(runner, /systemctl\s+(?:enable|start).*timer/i)
  assert.doesNotMatch(runner, /101\.254\.114\.238/)
  assert.match(wrapper, /param\(\)/)
  assert.doesNotMatch(wrapper, /\[string\]\$Command|\[string\]\$Path|\[string\]\$Mode/)
})

test('controlled runner bundles only the fixed source entry', async () => {
  const bundle = await controlledEntry.buildBundle()
  assert.match(bundle.sha256, /^[0-9a-f]{64}$/)
  assert.match(bundle.source, /gaiop\.session-reconciliation\.v1/)
  assert.doesNotMatch(bundle.source, /sessions\.delete|--enforce/)
  const remote = controlledEntry.buildRemoteScript(bundle)
  assert.match(remote, /\/usr\/local\/bin\/node/)
  assert.match(remote, /\/home\/netinside\/\.npm-global\/bin\/openclaw/)
})

test('runtime preflight uses a dynamic XDG directory and emits only structural session metadata', () => {
  const remote = controlledRuntimePreflight.buildRemoteScript()
  assert.match(remote, /netinside_uid=\$\(id -u netinside\)/)
  assert.match(remote, /runtime_dir="\/run\/user\/\$netinside_uid"/)
  assert.match(remote, /XDG_RUNTIME_DIR="\$runtime_dir"/)
  assert.doesNotMatch(remote, /\/run\/user\/1000/)
  assert.doesNotMatch(remote, /DBUS_SESSION_BUS_ADDRESS=/)
  assert.match(remote, /gateway call sessions\.list --json --params '\{"limit":100000\}' --timeout 60000/)
  assert.match(remote, /timeout --signal=TERM 75 runuser -u netinside -- env/)
  assert.doesNotMatch(remote, /timeout --signal=TERM 75 run_openclaw/)
  assert.match(remote, /rpc_reason=RPC_COMMAND_UNAVAILABLE/)
  assert.doesNotMatch(runtimePreflight, /process\.argv/)
  assert.doesNotMatch(runtimePreflight, /101\.254\.114\.238|--enforce|sessions\.(?:delete|patch|reset)/)
  assert.match(runtimePreflightWrapper, /param\(\)/)
})

test('runtime preflight parser keeps raw session values out of its result', () => {
  const summary = {
    sessionCount: 2,
    declaredCount: 2,
    declaredTotalCount: null,
    hasMore: null,
    fields: { keyString: 2, hasActiveRunBoolean: 0 },
  }
  const output = [
    'PREFLIGHT_COMPLETE=true',
    'UID_RESOLVED=true',
    'XDG_RUNTIME_PRESENT=true',
    'USER_BUS_PRESENT=true',
    'DBUS_EXPLICITLY_SET=false',
    'GATEWAY_SERVICE=active',
    'CLI_VERSION=2026.5.4',
    'SUPPORTS_JSON=true',
    'SUPPORTS_PARAMS=true',
    'SUPPORTS_TIMEOUT=true',
    'RPC_STATUS=ok',
    'RPC_REASON=NONE',
    'RPC_EXIT=0',
    `RPC_SUMMARY_B64=${Buffer.from(JSON.stringify(summary)).toString('base64')}`,
  ].join('\n')
  const parsed = controlledRuntimePreflight.parseRemoteOutput(output)
  assert.equal(parsed.completed, true)
  assert.equal(parsed.rpc.summary.sessionCount, 2)
  assert.equal(JSON.stringify(parsed).includes('agent:main:'), false)
})

test('controlled runner gives two serial snapshots enough fixed outer timeout', () => {
  assert.match(runner, /timeout --signal=TERM 360/)
  assert.match(runner, /systemd-run --quiet --wait --collect --pipe/)
  assert.doesNotMatch(runner, /timeout --signal=TERM 180/)
})

test('controlled runner rejects an ok-shaped result without complete zero-write evidence', () => {
  const unsafe = {
    schema: 'gaiop.session-reconciliation.v1',
    status: 'ok',
    safety: {
      sqliteReadonly: true,
      sqliteQueryOnly: true,
      sqliteTotalChanges: 1,
      sqliteDataVersionStable: true,
      sqliteExternalActivityObserved: false,
      bffMetadataStable: true,
      openclawSnapshotStable: true,
      fixedOpenClawInterfaces: true,
      mutationActionsAvailable: false,
    },
  }
  const output = [
    'EXECUTED=true',
    'RUN_EXIT=0',
    'DATABASE_UNCHANGED=true',
    'OPENCLAW_INDEX_UNCHANGED=true',
    'PROTECT_SYSTEM_STRICT=true',
    'PROTECT_HOME_READ_ONLY=true',
    'BUSINESS_PATHS_READ_ONLY=true',
    'XDG_RUNTIME_DYNAMIC=true',
    'DBUS_EXPLICITLY_SET=false',
    'TRANSIENT_SERVICE_COLLECTED=true',
    'TIMER_CREATED=false',
    `RESULT_B64=${Buffer.from(JSON.stringify(unsafe)).toString('base64')}`,
  ].join('\n')
  const parsed = controlledEntry.parseRemoteOutput(output)
  assert.equal(parsed.completed, false)
  assert.equal(parsed.executed, true)
  assert.equal(parsed.reconciliationSafetyConfirmed, false)
})

test('controlled runner treats unrelated SQLite file activity as an observation when metadata is stable', () => {
  const safe = {
    schema: 'gaiop.session-reconciliation.v1',
    status: 'ok',
    safety: {
      sqliteReadonly: true,
      sqliteQueryOnly: true,
      sqliteTotalChanges: 0,
      sqliteDataVersionStable: false,
      sqliteExternalActivityObserved: true,
      bffMetadataStable: true,
      openclawSnapshotStable: true,
      fixedOpenClawInterfaces: true,
      mutationActionsAvailable: false,
    },
  }
  const output = [
    'EXECUTED=true',
    'RUN_EXIT=0',
    'DATABASE_UNCHANGED=false',
    'OPENCLAW_INDEX_UNCHANGED=true',
    'PROTECT_SYSTEM_STRICT=true',
    'PROTECT_HOME_READ_ONLY=true',
    'BUSINESS_PATHS_READ_ONLY=true',
    'XDG_RUNTIME_DYNAMIC=true',
    'DBUS_EXPLICITLY_SET=false',
    'TRANSIENT_SERVICE_COLLECTED=true',
    'TIMER_CREATED=false',
    `RESULT_B64=${Buffer.from(JSON.stringify(safe)).toString('base64')}`,
  ].join('\n')
  const parsed = controlledEntry.parseRemoteOutput(output)
  assert.equal(parsed.completed, true)
  assert.equal(parsed.databaseFileGroupStable, false)
  assert.equal(parsed.databaseExternalActivityObserved, true)
  assert.equal(parsed.reconciliationSafetyConfirmed, true)
})

test('package exposes the dry-run command and runs both reconciliation test contracts', () => {
  assert.equal(packageJson.scripts['reconcile:sessions:dry-run'], 'node server/session-reconciliation.js')
  assert.match(packageJson.scripts['test:node'], /server\/lib\/session-reconciliation\.test\.js/)
  assert.match(packageJson.scripts['test:node'], /server\/lib\/session-reconciliation-contract\.test\.js/)
})
