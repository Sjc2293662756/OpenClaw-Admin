import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('Wizard and Office REST endpoints are all administrator-only', () => {
  const routePattern = /app\.(get|post|put|delete)\('\/api\/wizard\/(?:scenarios|tasks)(?:\/:id)?',\s*(\w+)/g
  const matches = [...source.matchAll(routePattern)]
  assert.equal(matches.length, 10)
  for (const match of matches) {
    assert.equal(match[2], 'adminMiddleware', `${match[1]} ${match[0]} must be admin-only`)
  }
})

test('system metrics uses the dedicated monitor role boundary', () => {
  assert.match(
    source,
    /app\.get\('\/api\/system\/metrics',\s*systemMonitorMiddleware/
  )
})

test('basic workspace REST boundary is registered before every business router', () => {
  const authRouter = source.indexOf("app.use('/api/auth'")
  const basicBoundary = source.indexOf("app.use('/api', createBasicWorkspaceOnlyMiddleware")
  const firstBusinessRouter = source.indexOf("app.use('/api/system-settings/report-storage'")
  assert.ok(authRouter >= 0)
  assert.ok(basicBoundary > authRouter)
  assert.ok(firstBusinessRouter > basicBoundary)
})
