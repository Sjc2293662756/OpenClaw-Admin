import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import express from 'express'
import { createMediaRouter } from './media.js'

test('media REST requires auth, session ownership, and a contained image path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gaiop-media-'))
  await mkdir(join(root, 'browser'))
  await writeFile(join(root, 'browser', 'ok.png'), Buffer.from([137, 80, 78, 71]))
  await writeFile(join(root, 'browser', 'secret.txt'), 'no')

  const authMiddleware = (req, res, next) => {
    const role = req.get('x-test-role')
    if (!role) return res.status(401).json({ code: 'UNAUTHORIZED' })
    req.user = { id: req.get('x-test-user') || 'owner', role }
    next()
  }
  const app = express()
  app.use('/api/media', createMediaRouter({
    authMiddleware,
    roots: () => [root],
    authorizeSession: (user, key) => ({ ok: key === `session-${user.id}` }),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/media`
  try {
    assert.equal((await fetch(`${baseUrl}?path=browser%2Fok.png`)).status, 401)
    const ownerHeaders = {
      'x-test-role': 'standard',
      'x-test-user': 'owner',
      'x-gaiop-session-key': 'session-owner',
    }
    const image = await fetch(`${baseUrl}?path=browser%2Fok.png`, { headers: ownerHeaders })
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.equal(image.headers.get('cache-control'), 'private, no-store')

    assert.equal((await fetch(`${baseUrl}?path=browser%2Fok.png`, {
      headers: { ...ownerHeaders, 'x-test-user': 'other' },
    })).status, 404)
    assert.equal((await fetch(`${baseUrl}?path=..%2Fbrowser%2Fok.png`, { headers: ownerHeaders })).status, 400)
    assert.equal((await fetch(`${baseUrl}?path=C%3A%5Cbrowser%5Cok.png`, { headers: ownerHeaders })).status, 400)
    assert.equal((await fetch(`${baseUrl}?path=browser%2Fsecret.txt`, { headers: ownerHeaders })).status, 400)
    assert.equal((await fetch(`${baseUrl}?path=browser%2Fok.png`, { headers: { 'x-test-role': 'admin' } })).status, 200)
  } finally {
    server.close()
    await once(server, 'close')
    await rm(root, { recursive: true, force: true })
  }
})
