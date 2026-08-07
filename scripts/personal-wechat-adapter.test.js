import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('personal WeChat adapter refuses to start without its internal token', () => {
  const adapterPath = fileURLToPath(new URL('./personal-wechat-adapter.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [adapterPath], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test' },
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GAIOP_WEIXIN_ADAPTER_TOKEN is required/)
})

test('personal WeChat adapter authenticates requests and serializes concurrent config writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gaiop-weixin-adapter-'))
  const openclawDirectory = join(home, '.openclaw')
  mkdirSync(openclawDirectory, { recursive: true })
  const configPath = join(openclawDirectory, 'openclaw.json')
  writeFileSync(configPath, JSON.stringify({ channels: { 'openclaw-weixin': { accounts: {} } } }))

  const portReservation = createServer()
  portReservation.listen(0, '127.0.0.1')
  await once(portReservation, 'listening')
  const port = portReservation.address().port
  portReservation.close()
  await once(portReservation, 'close')

  const adapterPath = fileURLToPath(new URL('./personal-wechat-adapter.mjs', import.meta.url))
  const child = spawn(process.execPath, [adapterPath], {
    env: {
      NODE_ENV: 'test',
      GAIOP_HOME: home,
      GAIOP_WEIXIN_ADAPTER_PORT: String(port),
      GAIOP_WEIXIN_ADAPTER_TOKEN: 'isolated-adapter-test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    const baseUrl = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/status`, {
          headers: { 'X-GAIOP-Weixin-Token': 'isolated-adapter-test-token' },
        })
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    assert.equal(ready, true)

    const unauthorized = await fetch(`${baseUrl}/status`)
    assert.equal(unauthorized.status, 401)

    const headers = {
      'Content-Type': 'application/json',
      'X-GAIOP-Weixin-Token': 'isolated-adapter-test-token',
    }
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/accounts/account-a/enabled`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: false }),
      }),
      fetch(`${baseUrl}/accounts/account-b/enabled`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ enabled: true }),
      }),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.channels['openclaw-weixin'].accounts['account-a'].enabled, false)
    assert.equal(config.channels['openclaw-weixin'].accounts['account-b'].enabled, true)
  } finally {
    const exitPromise = child.exitCode === null ? once(child, 'exit') : Promise.resolve()
    child.kill('SIGTERM')
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 2_500)
      exitPromise.finally(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
    rmSync(home, { recursive: true, force: true })
  }
})
