import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('Wizard and Office use the module boundary while keeping mutations administrator-only', () => {
  assert.match(source, /app\.use\('\/api\/wizard',\s*officeModuleMiddleware\)/)
  const routePattern = /app\.(get|post|put|delete)\('\/api\/wizard\/(?:scenarios|tasks)(?:\/:id)?',\s*(\w+)/g
  const matches = [...source.matchAll(routePattern)]
  assert.equal(matches.length, 10)
  for (const match of matches) {
    const expected = match[1] === 'get' ? 'authMiddleware' : 'adminMiddleware'
    assert.equal(match[2], expected, `${match[1]} ${match[0]} must preserve its action boundary`)
  }
})

test('system monitoring REST uses the effective module boundary', () => {
  assert.match(
    source,
    /app\.get\('\/api\/system\/metrics',\s*systemModuleMiddleware/
  )
  assert.match(
    source,
    /app\.use\('\/api\/system\/storage-watermarks',\s*systemModuleMiddleware,\s*createStorageWatermarkRouter\(\{ db, systemMonitorMiddleware: authMiddleware \}\)\)/
  )
})

test('public branding read is explicit and protected business routers stay behind the basic boundary', () => {
  const authRouter = source.indexOf("app.use('/api/auth'")
  const brandingRouter = source.indexOf("app.use('/api/system-settings/branding'")
  const basicBoundary = source.indexOf("app.use('/api', createBasicWorkspaceOnlyMiddleware")
  const firstBusinessRouter = source.indexOf("app.use('/api/system-settings/report-storage'")
  assert.ok(authRouter >= 0)
  assert.ok(brandingRouter > authRouter)
  assert.ok(basicBoundary > brandingRouter)
  assert.ok(firstBusinessRouter > basicBoundary)
})

test('/api/events remains Bearer-authenticated before opening the browser SSE stream', () => {
  assert.match(source, /app\.get\('\/api\/events',\s*authMiddleware,\s*\(req, res\) =>/u)
  assert.doesNotMatch(source, /app\.get\('\/api\/events',\s*\(req, res\) =>/u)
})
