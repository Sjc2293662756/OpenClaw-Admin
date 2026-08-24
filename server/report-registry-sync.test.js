import assert from 'node:assert/strict'
import test from 'node:test'
import { startReportRegistrySync } from './report-registry-sync.js'

test('background report registration runs at startup and on its interval', () => {
  const callbacks = []
  const cleared = []
  let calls = 0
  const timer = { unref() {} }
  const stop = startReportRegistrySync({}, {
    intervalMs: 5_000,
    syncFn: () => { calls += 1; return { registered: 0 } },
    setIntervalFn: (callback, delay) => {
      assert.equal(delay, 5_000)
      callbacks.push(callback)
      return timer
    },
    clearIntervalFn: (value) => cleared.push(value),
    onError: () => assert.fail('sync should not fail'),
  })

  assert.equal(calls, 1)
  callbacks[0]()
  assert.equal(calls, 2)
  stop()
  assert.deepEqual(cleared, [timer])
})

test('background report registration keeps the Admin process alive when one sync fails', () => {
  const callbacks = []
  let errors = 0
  startReportRegistrySync({}, {
    intervalMs: 5_000,
    syncFn: () => { throw new Error('expected test failure') },
    setIntervalFn: (callback) => { callbacks.push(callback); return { unref() {} } },
    clearIntervalFn: () => {},
    onError: () => { errors += 1 },
  })

  callbacks[0]()
  assert.equal(errors, 2)
})
