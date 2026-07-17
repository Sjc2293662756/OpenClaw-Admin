import assert from 'node:assert/strict'
import test from 'node:test'
import { createFeishuAppOnboarding } from './feishu-app-onboarding.js'

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('Feishu QR onboarding exposes only short-lived QR state and provisions credentials internally', async () => {
  let provisioned
  const onboarding = createFeishuAppOnboarding({
    register: async (options) => {
      await options.onQRCodeReady({ url: 'https://example.invalid/device/one-time', expireIn: 600 })
      return { client_id: 'app-public-id', client_secret: 'private-app-secret' }
    },
    toDataUrl: async () => 'data:image/png;base64,qr-code',
    provision: async (credentials) => { provisioned = credentials },
  })

  const started = await onboarding.start({
    ownerId: 'admin-1',
    actor: { id: 'admin-1' },
    appName: ' GAIOP   智能助手 ',
    dmPolicy: 'open',
  })
  await nextTurn()

  const result = onboarding.getForOwner(started.id, 'admin-1')
  assert.equal(result.appName, 'GAIOP 智能助手')
  assert.equal(result.status, 'configured')
  assert.equal(result.qrDataUrl, undefined)
  assert.equal(result.verificationUrl, undefined)
  assert.equal(JSON.stringify(result).includes('private-app-secret'), false)
  assert.deepEqual(provisioned, {
    appId: 'app-public-id',
    appSecret: 'private-app-secret',
    dmPolicy: 'open',
  })
})

test('cancelled Feishu onboarding stays cancelled after the device flow aborts', async () => {
  let abortSignal
  const onboarding = createFeishuAppOnboarding({
    register: ({ signal, onQRCodeReady }) => new Promise(async (_resolve, reject) => {
      abortSignal = signal
      await onQRCodeReady({ url: 'https://example.invalid/device/cancel', expireIn: 600 })
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.code = 'abort'
        reject(error)
      }, { once: true })
    }),
    toDataUrl: async () => 'data:image/png;base64,qr-code',
    provision: async () => assert.fail('cancelled onboarding must not provision credentials'),
  })

  const started = await onboarding.start({ ownerId: 'admin-1', actor: { id: 'admin-1' } })
  assert.equal(onboarding.cancel({ id: started.id, ownerId: 'admin-1' }), true)
  await nextTurn()

  const result = onboarding.getForOwner(started.id, 'admin-1')
  assert.equal(abortSignal.aborted, true)
  assert.equal(result.status, 'cancelled')
})
