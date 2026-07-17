import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeGatewayConfigPayload } from './sensitive-data.js'

test('masks channel credentials in structured Gateway config', () => {
  const result = sanitizeGatewayConfigPayload({
    channels: {
      qqbot: { appId: 'public-id', clientSecret: 'private-value' },
      feishu: { appId: 'public-id', appSecret: 'private-value' },
      dingtalk: { clientId: 'public-id', clientSecret: 'private-value' },
      wecom: {
        corpId: 'public-id',
        agentId: '100001',
        secret: 'private-value',
        accounts: { default: { encodingAesKey: 'private-value', webhookUrl: 'private-value' } },
      },
    },
  })

  assert.equal(result.channels.qqbot.appId, 'public-id')
  assert.equal(result.channels.qqbot.clientSecret, '******')
  assert.equal(result.channels.feishu.appSecret, '******')
  assert.equal(result.channels.dingtalk.clientSecret, '******')
  assert.equal(result.channels.wecom.secret, '******')
  assert.equal(result.channels.wecom.accounts.default.encodingAesKey, '******')
  assert.equal(result.channels.wecom.accounts.default.webhookUrl, '******')
})

test('masks credentials embedded in raw Gateway config snapshots', () => {
  const result = sanitizeGatewayConfigPayload({
    hash: 'snapshot-hash',
    raw: JSON.stringify({ channels: { wecom: { corpId: 'public-id', secret: 'private-value' } } }),
  })
  const raw = JSON.parse(result.raw)

  assert.equal(result.hash, 'snapshot-hash')
  assert.equal(raw.channels.wecom.corpId, 'public-id')
  assert.equal(raw.channels.wecom.secret, '******')
})
