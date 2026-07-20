import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenClawGateway } from './gateway.js'

test('manual disconnect closes the socket without scheduling a reconnect', () => {
  const gateway = new OpenClawGateway('ws://127.0.0.1:1', 'test-token')
  let listenersRemoved = false
  let socketClosed = false

  gateway.ws = {
    removeAllListeners() {
      listenersRemoved = true
    },
    close() {
      socketClosed = true
    },
  }

  gateway.disconnect()
  gateway.handleDisconnect(1000, 'manual test')

  assert.equal(listenersRemoved, true)
  assert.equal(socketClosed, true)
  assert.equal(gateway.ws, null)
  assert.equal(gateway.shouldReconnect, false)
  assert.equal(gateway.reconnectTimer, null)
})

test('loopback Gateway with shared auth uses the trusted backend handshake path', async () => {
  const gateway = new OpenClawGateway('ws://127.0.0.1:18789', 'test-token')
  const params = await gateway.buildConnectParams()

  assert.equal(params.client.id, 'gateway-client')
  assert.equal(params.client.mode, 'backend')
  assert.equal(params.device, undefined)
})

test('non-loopback Gateway retains the device identity handshake path', () => {
  const gateway = new OpenClawGateway('ws://gateway.example.test:18789', 'test-token')
  assert.equal(gateway.isTrustedLoopbackBackend(), false)
})
