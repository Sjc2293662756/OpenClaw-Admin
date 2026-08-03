import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'
import { registerRetiredApiBarriers, RETIRED_API_PREFIXES } from './legacy-api.js'

test('retired REST prefixes are 410 before every retained legacy handler', async () => {
  const app = express()
  let reachedLegacySource = false
  registerRetiredApiBarriers(app)
  for (const prefix of RETIRED_API_PREFIXES) {
    app.all(`${prefix}/{*path}`, (_req, res) => {
      reachedLegacySource = true
      res.json({ ok: true })
    })
  }

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    for (const prefix of RETIRED_API_PREFIXES) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await fetch(`${baseUrl}${prefix}/probe`, { method })
        assert.equal(response.status, 410, `${method} ${prefix}`)
        assert.equal((await response.json()).code, 'ENDPOINT_RETIRED')
      }
    }
    assert.equal(reachedLegacySource, false)
  } finally {
    server.close()
    await once(server, 'close')
  }
})
