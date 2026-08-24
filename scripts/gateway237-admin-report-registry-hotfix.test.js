import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const runner = readFileSync(join(root, 'scripts/gateway237-admin-report-registry-hotfix.cjs'), 'utf8')
const powershell = readFileSync(join(root, 'scripts/Invoke-237AdminReportRegistryHotfix.ps1'), 'utf8')

test('controlled Admin report registry hotfix is a three-file, Admin-only release', () => {
  assert.match(powershell, /Import-Clixml/)
  assert.match(powershell, /server\\report-registry-sync\.js/)
  assert.match(runner, /gaiop-admin-report-registry-\$\{releaseId\}-\$\{file\.remote\}/)
  assert.match(runner, /await source\.backup\(destinationPath\)/)
  assert.match(runner, /integrity_check/)
  assert.match(runner, /systemctl stop gaiop-admin\.service/)
  assert.match(runner, /systemctl start gaiop-admin\.service/)
  assert.match(runner, /REPORT_COUNT_BEFORE/)
  assert.match(runner, /REPORT_COUNT_AFTER/)
  assert.doesNotMatch(runner, /openclaw-gateway|gaiop-upgrade|caddy/)
  assert.doesNotMatch(runner, /rm -rf[^\n]*(reports|recovery)/)
  assert.doesNotMatch(runner, /backup_root\/wizard\.db[^\n]*admin_db/)
})
