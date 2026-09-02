import assert from 'node:assert/strict'
import test from 'node:test'
import { isAlertAccountOnlineAt } from './alert-account-presence.js'

function connection(userId, connectedAt, state = {}) {
  return { user: { id: userId }, connectedAt, res: { writableEnded: false, destroyed: false, ...state } }
}

test('treats an account as online when any authenticated tab or device predates the alert', () => {
  const clients = new Map([
    ['old-tab', connection('account', 100)],
    ['new-device', connection('account', 300)],
    ['other-account', connection('other', 50)],
  ])
  assert.equal(isAlertAccountOnlineAt(clients, 'account', 200), true)
  clients.get('old-tab').res.destroyed = true
  assert.equal(isAlertAccountOnlineAt(clients, 'account', 200), false)
  assert.equal(isAlertAccountOnlineAt(clients, 'account', 300), true)
})

test('treats pre-connection alerts, abnormal disconnects and an empty post-restart registry as offline', () => {
  assert.equal(isAlertAccountOnlineAt(new Map([['tab', connection('account', 200)]]), 'account', 199), false)
  assert.equal(isAlertAccountOnlineAt(new Map([['tab', connection('account', 100, { writableEnded: true })]]), 'account', 200), false)
  assert.equal(isAlertAccountOnlineAt(new Map(), 'account', 200), false)
  assert.equal(isAlertAccountOnlineAt(new Map([['tab', connection('account', 100)]]), 'account', 'invalid'), false)
})
