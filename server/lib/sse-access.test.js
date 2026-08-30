import assert from 'node:assert/strict'
import test from 'node:test'
import { canReceiveSseData } from './sse-access.js'

const dependencies = {
  extractSessionKey: (payload) => payload?.sessionKey || '',
  canAccessSession: (user, sessionKey) => user?.ownedSession === sessionKey,
}

test('alert and alert stream state follow the same roles as GET /api/alerts', () => {
  for (const data of [
    { type: 'alert', payload: { name: 'sensitive alert' } },
    { type: 'alertStreamState', state: 'gap', latestSequence: 10 },
  ]) {
    assert.equal(canReceiveSseData({ role: 'basic' }, data, dependencies), true)
    assert.equal(canReceiveSseData({ role: 'standard' }, data, dependencies), true)
    assert.equal(canReceiveSseData({ role: 'auditor' }, data, dependencies), true)
    assert.equal(canReceiveSseData({ role: 'admin' }, data, dependencies), true)
    assert.equal(canReceiveSseData(null, data, dependencies), false)
  }
  assert.equal(canReceiveSseData({ role: 'standard', effectiveModules: { 'alerts.notifications': false } }, { type: 'alert' }, dependencies), false)
  assert.equal(canReceiveSseData({ role: 'basic', effectiveModules: { 'alerts.notifications': true } }, { type: 'alertStreamState' }, dependencies), true)
})

test('permission refresh events are delivered only to the target user', () => {
  const event = { type: 'permissionsChanged', userId: 'target-user', permissionVersion: 3 }
  assert.equal(canReceiveSseData({ id: 'target-user', role: 'basic' }, event, dependencies), true)
  assert.equal(canReceiveSseData({ id: 'other-user', role: 'basic' }, event, dependencies), false)
  assert.equal(canReceiveSseData(null, event, dependencies), false)
})

test('keeps existing Gateway event session isolation and non-event broadcasts', () => {
  const owned = { role: 'standard', ownedSession: 'owned-session' }
  assert.equal(canReceiveSseData(owned, {
    type: 'event',
    payload: { sessionKey: 'owned-session' },
  }, dependencies), true)
  assert.equal(canReceiveSseData(owned, {
    type: 'event',
    payload: { sessionKey: 'other-session' },
  }, dependencies), false)
  assert.equal(canReceiveSseData(owned, {
    type: 'event',
    payload: {},
  }, dependencies), false)
  assert.equal(canReceiveSseData({ role: 'admin' }, {
    type: 'event',
    payload: {},
  }, dependencies), true)

  for (const type of ['gatewayState', 'backupProgress', 'connected']) {
    assert.equal(canReceiveSseData({ role: 'basic' }, { type }, dependencies), true)
  }
})
