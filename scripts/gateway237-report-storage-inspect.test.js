import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runner = readFileSync(new URL('./gateway237-report-storage-inspect.cjs', import.meta.url), 'utf8')

test('report sync probe models every prepared statement used by production sync', () => {
  const probeStart = runner.indexOf("const { __test__ } = await import('/opt/gaiop/admin/server/routes/reports.js');")
  const probeEnd = runner.indexOf("printf 'ADMIN_REPORTS_DIR=", probeStart)
  const probe = runner.slice(probeStart, probeEnd)

  assert.ok(probeStart >= 0)
  assert.ok(probeEnd > probeStart)
  assert.match(probe, /INSERT INTO report_files/)
  assert.match(probe, /SELECT stored_name FROM report_files WHERE id = \?/)
  assert.match(probe, /UPDATE report_files SET/)
  assert.match(probe, /SELECT id FROM data_sources WHERE is_active = 1/)
  assert.match(probe, /return \{ get\(\) \{ return null; \} \}/)
  assert.match(probe, /return \{ all\(\) \{ return \[\]; \} \}/)
  assert.match(probe, /throw new Error\('unexpected probe query'\)/)
})
