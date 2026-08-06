import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  createPersonalWechatMetadataStore,
  migratePersonalWechatMetadata,
  validatePersonalWechatRegistration,
} from './personal-wechat-metadata.js'

function createStore() {
  const db = new Database(':memory:')
  migratePersonalWechatMetadata(db)
  migratePersonalWechatMetadata(db)
  return { db, store: createPersonalWechatMetadataStore(db, { now: () => 1_700_000_000_000 }) }
}

test('personal WeChat metadata migration is idempotent and stores no credential columns', () => {
  const { db } = createStore()
  try {
    const columns = db.prepare('PRAGMA table_info(personal_wechat_accounts)').all().map((item) => item.name)
    assert.deepEqual(columns, [
      'account_id',
      'display_name',
      'note',
      'wechat_user_id',
      'wechat_nickname',
      'enabled',
      'created_by_user_id',
      'created_at',
      'updated_at',
    ])
    assert.equal(columns.some((name) => /token|secret|credential|qr|session/i.test(name)), false)
  } finally {
    db.close()
  }
})

test('personal WeChat metadata validates administrator labels', () => {
  assert.equal(validatePersonalWechatRegistration({ displayName: '   ' }).ok, false)
  assert.deepEqual(validatePersonalWechatRegistration({
    displayName: ' 杨硕   微信 ',
    note: ' 售后值班 ',
  }), {
    ok: true,
    value: { displayName: '杨硕 微信', note: '售后值班' },
  })
})

test('personal WeChat metadata keeps distinct accounts isolated and only replaces the same account', () => {
  const { db, store } = createStore()
  try {
    store.saveLinkedAccount({
      accountId: 'wx-account-one',
      displayName: '售后微信',
      note: '一号',
      wechatId: 'wx-user-one',
      actorId: 'admin-1',
    })
    store.saveLinkedAccount({
      accountId: 'wx-account-two',
      displayName: '测试微信',
      note: '二号',
      wechatId: 'wx-user-two',
      actorId: 'admin-1',
    })
    store.saveLinkedAccount({
      accountId: 'wx-account-one',
      displayName: '售后微信新名称',
      note: '更新备注',
      wechatId: 'wx-user-one',
      actorId: 'admin-1',
    })

    const accounts = store.list()
    assert.equal(accounts.length, 2)
    assert.equal(store.get('wx-account-one').displayName, '售后微信新名称')
    assert.equal(store.get('wx-account-two').displayName, '测试微信')

    assert.equal(store.setEnabled('wx-account-one', false).enabled, false)
    assert.equal(store.get('wx-account-two').enabled, true)
    assert.equal(store.deleteAccount('wx-account-one').accountId, 'wx-account-one')
    assert.equal(store.get('wx-account-one'), null)
    assert.equal(store.get('wx-account-two').accountId, 'wx-account-two')
  } finally {
    db.close()
  }
})
