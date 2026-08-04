import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { configureTrustedProxy, createCorsMiddleware, isLoopbackAddress, parseAllowedOrigins } from './http-security.js'

async function withServer(options, callback) {
  const app = express()
  configureTrustedProxy(app)
  app.use(createCorsMiddleware(options))
  app.get('/probe', (req, res) => res.json({ ip: req.ip }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

test('production CORS requires exact configured origins and rejects wildcards', () => {
  assert.throws(() => createCorsMiddleware({ isDevelopment: false }), /required in production/)
  assert.throws(() => parseAllowedOrigins('*'), /cannot contain a wildcard/)
  assert.throws(() => parseAllowedOrigins('https://example.test/path'), /exact HTTP origins/)
  assert.deepEqual([...parseAllowedOrigins('https://101.254.114.237,http://127.0.0.1:3002')], [
    'https://101.254.114.237',
    'http://127.0.0.1:3002',
  ])
})

test('production CORS allows the public origin and denies an arbitrary public origin', async () => {
  await withServer({ allowedOrigins: 'https://101.254.114.237', isDevelopment: false }, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/probe`, { headers: { Origin: 'https://101.254.114.237' } })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://101.254.114.237')

    const denied = await fetch(`${baseUrl}/probe`, { headers: { Origin: 'https://attacker.example' } })
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).code, 'CORS_ORIGIN_DENIED')
  })
})

test('development CORS keeps localhost workflows and trusted proxy is loopback only', async () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('10.0.0.5'), false)

  await withServer({ isDevelopment: true }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/probe`, {
      headers: { Origin: 'http://localhost:3001', 'X-Forwarded-For': '198.51.100.40' },
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).ip, '198.51.100.40')
  })
})
