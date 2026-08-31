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
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const requireFromHere = createRequire(import.meta.url)
const controlledEntry = requireFromHere('../../scripts/gateway237-session-reconciliation-dry-run.cjs')

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
  assert.match(core, /'--timeout',\s*'20000'/)
})

test('controlled 237 entry is fixed-purpose and transient with read-only business paths', () => {
  assert.equal(controlledEntry.EXPECTED_HOST, '101.254.114.237')
  assert.doesNotMatch(runner, /process\.argv/)
  assert.match(runner, /ProtectSystem=strict/)
  assert.match(runner, /ProtectHome=read-only/)
  assert.match(runner, /ReadOnlyPaths=\/opt\/gaiop\/admin \/var\/lib\/gaiop\/admin \/home\/netinside\/\.openclaw/)
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

test('controlled runner rejects an ok-shaped result without complete zero-write evidence', () => {
  const unsafe = {
    schema: 'gaiop.session-reconciliation.v1',
    status: 'ok',
    safety: {
      sqliteReadonly: true,
      sqliteQueryOnly: true,
      sqliteTotalChanges: 1,
      sqliteDataVersionStable: true,
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
    'TRANSIENT_SERVICE_COLLECTED=true',
    'TIMER_CREATED=false',
    `RESULT_B64=${Buffer.from(JSON.stringify(unsafe)).toString('base64')}`,
  ].join('\n')
  const parsed = controlledEntry.parseRemoteOutput(output)
  assert.equal(parsed.completed, false)
  assert.equal(parsed.executed, true)
  assert.equal(parsed.reconciliationSafetyConfirmed, false)
})

test('package exposes the dry-run command and runs both reconciliation test contracts', () => {
  assert.equal(packageJson.scripts['reconcile:sessions:dry-run'], 'node server/session-reconciliation.js')
  assert.match(packageJson.scripts['test:node'], /server\/lib\/session-reconciliation\.test\.js/)
  assert.match(packageJson.scripts['test:node'], /server\/lib\/session-reconciliation-contract\.test\.js/)
})
