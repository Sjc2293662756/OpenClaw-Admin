import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createPersonalWechatMetadataStore, migratePersonalWechatMetadata } from './personal-wechat-metadata.js'
import { createPersonalWechatOnboarding } from './personal-wechat-onboarding.js'

function deferred() {
  let resolve
  const promise = new Promise((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve))
}

function createMetadataStore() {
  const db = new Database(':memory:')
  migratePersonalWechatMetadata(db)
  return { db, store: createPersonalWechatMetadataStore(db) }
}

test('personal WeChat onboarding keeps QR login ids private and links multiple accounts independently', async () => {
  const { db, store } = createMetadataStore()
  const waits = [deferred(), deferred()]
  let startIndex = 0
  const runtime = {
    async startQr() {
      const index = startIndex++
      return {
        loginId: `private-login-${index + 1}`,
        status: 'waiting',
        qrText: `private-qr-${index + 1}`,
        expiresAt: Date.now() + 60_000,
      }
    },
    async waitQr(loginId) {
      const index = Number(loginId.split('-').at(-1)) - 1
      return waits[index].promise
    },
  }
  const onboarding = createPersonalWechatOnboarding({
    runtime,
    metadataStore: store,
    toDataUrl: async (qrText) => `data:image/png;base64,encoded-${qrText.at(-1)}`,
  })

  try {
    const first = await onboarding.start({
      ownerId: 'admin-one',
      actor: { id: 'admin-one', username: 'admin', role: 'admin' },
      displayName: '杨硕微信',
      note: '第一账号',
    })
    assert.equal(first.status, 'waiting_for_scan')
    assert.equal(first.qrDataUrl, 'data:image/png;base64,encoded-1')
    assert.equal(JSON.stringify(first).includes('private-login'), false)
    assert.equal(JSON.stringify(first).includes('private-qr'), false)
    assert.equal(onboarding.getForOwner(first.id, 'admin-two'), null)

    waits[0].resolve({
      loginId: 'private-login-1',
      status: 'connected',
      accountId: 'wx-account-one',
      wechatId: 'wx-user-one',
    })
    await nextTurn()
    const firstDone = onboarding.getForOwner(first.id, 'admin-one')
    assert.equal(firstDone.status, 'success')
    assert.equal(firstDone.accountId, 'wx-account-one')
    assert.equal(firstDone.qrDataUrl, undefined)

    const second = await onboarding.start({
      ownerId: 'admin-one',
      actor: { id: 'admin-one', username: 'admin', role: 'admin' },
      displayName: '售后微信',
      note: '第二账号',
    })
    waits[1].resolve({
      loginId: 'private-login-2',
      status: 'connected',
      accountId: 'wx-account-two',
      wechatId: 'wx-user-two',
    })
    await nextTurn()
    assert.equal(onboarding.getForOwner(second.id, 'admin-one').status, 'success')

    const accounts = store.list()
    assert.deepEqual(accounts.map((item) => item.accountId), ['wx-account-one', 'wx-account-two'])
    assert.deepEqual(accounts.map((item) => item.displayName), ['杨硕微信', '售后微信'])
  } finally {
    db.close()
  }
})

test('personal WeChat onboarding accepts a verification code only for its owning administrator', async () => {
  const { db, store } = createMetadataStore()
  const calls = []
  const runtime = {
    async startQr() {
      return {
        loginId: 'private-login-verify',
        status: 'need_verify_code',
        qrText: 'private-qr-verify',
        expiresAt: Date.now() + 60_000,
      }
    },
    async verifyQr(loginId, code) {
      calls.push({ loginId, code })
      return {
        loginId,
        status: 'connected',
        accountId: 'wx-account-verified',
        wechatId: 'wx-user-verified',
      }
    },
  }
  const onboarding = createPersonalWechatOnboarding({
    runtime,
    metadataStore: store,
    toDataUrl: async () => 'data:image/png;base64,verify',
  })

  try {
    const started = await onboarding.start({ ownerId: 'admin-one', displayName: '验证微信' })
    assert.equal(started.status, 'verification_required')
    assert.equal(started.requiresVerificationCode, true)
    assert.equal(await onboarding.verify({ id: started.id, ownerId: 'admin-two', code: '123456' }), null)
    assert.equal(calls.length, 0)

    const completed = await onboarding.verify({ id: started.id, ownerId: 'admin-one', code: '123456' })
    assert.equal(completed.status, 'success')
    assert.equal(completed.accountId, 'wx-account-verified')
    assert.deepEqual(calls, [{ loginId: 'private-login-verify', code: '123456' }])
    assert.equal(JSON.stringify(completed).includes('123456'), false)
  } finally {
    db.close()
  }
})
