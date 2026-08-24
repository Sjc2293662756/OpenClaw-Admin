import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const runner = readFileSync(join(root, 'scripts/gateway237-report-registry-reconcile.cjs'), 'utf8')
const powershell = readFileSync(join(root, 'scripts/Invoke-237ReportRegistryReconcile.ps1'), 'utf8')

test('report registry reconcile previews on a snapshot and only inserts safe candidates', () => {
  assert.match(powershell, /Import-Clixml/)
  assert.match(runner, /await source\.backup\(destinationPath\)/)
  assert.match(runner, /syncGeneratedReports\(database\)/)
  assert.match(runner, /report_or_audit_not_regular/)
  assert.match(runner, /report_size_mismatch/)
  assert.match(runner, /live\.transaction/)
  assert.match(runner, /candidate_live_conflict/)
  assert.match(runner, /candidate_count=\$\(/)
  assert.match(runner, /\.candidateCount/)
  assert.match(runner, /DATABASE_BACKUP_CREATED/)
  assert.doesNotMatch(runner, /unlinkSync|rmSync\([^\n]*(reports|recovery)/)
  assert.doesNotMatch(runner, /openclaw-gateway|gaiop-upgrade|caddy/)
})
