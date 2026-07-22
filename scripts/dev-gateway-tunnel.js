import net from 'node:net'
import process from 'node:process'
import { Client } from 'ssh2'

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const localPort = readPositiveInteger(process.env.GAIOP_GATEWAY_LOCAL_PORT, 8080)
const remotePort = readPositiveInteger(process.env.GAIOP_GATEWAY_REMOTE_PORT, 18789)
const alertReceiverLocalPort = readPositiveInteger(process.env.GAIOP_ALERT_RECEIVER_LOCAL_PORT, 0)
const alertReceiverRemotePort = readPositiveInteger(process.env.GAIOP_ALERT_RECEIVER_REMOTE_PORT, 19090)
const sshHost = process.env.GAIOP_GATEWAY_SSH_HOST
const sshUsername = process.env.GAIOP_GATEWAY_SSH_USERNAME
const sshPassword = process.env.GAIOP_GATEWAY_SSH_PASSWORD

if (!sshHost || !sshUsername || !sshPassword) {
  console.error('Gateway SSH tunnel configuration is incomplete.')
  process.exit(1)
}

const tunnels = [
  { localPort, remotePort, label: 'Gateway' },
  ...(alertReceiverLocalPort ? [{ localPort: alertReceiverLocalPort, remotePort: alertReceiverRemotePort, label: 'Alert receiver' }] : []),
]
const servers = new Map()
let closing = false
let connection = null
let connectionReady = false
let connectionGeneration = 0
let reconnectTimer = null
let reconnectAttempts = 0

function closeTunnel(exitCode = 0) {
  if (closing) return
  closing = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  for (const server of servers.values()) server.close()
  servers.clear()
  connection?.end()
  process.exit(exitCode)
}

function ensureLocalServers() {
  for (const tunnel of tunnels) {
    if (servers.has(tunnel.localPort)) continue
    const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    const activeConnection = connection
    if (!connectionReady || !activeConnection) {
      socket.destroy(new Error('Gateway SSH connection is temporarily unavailable.'))
      return
    }

    activeConnection.forwardOut(
      socket.remoteAddress || '127.0.0.1',
      socket.remotePort || 0,
      '127.0.0.1',
        tunnel.remotePort,
      (error, stream) => {
        if (error) {
          socket.destroy(error)
          return
        }
        socket.pipe(stream).pipe(socket)
        socket.on('error', () => stream.destroy())
        stream.on('error', () => socket.destroy())
      },
    )
    })

    server.on('error', (error) => {
      console.error(`${tunnel.label} SSH tunnel failed: ${error.message}`)
      closeTunnel(1)
    })

    server.listen(tunnel.localPort, '127.0.0.1')
    servers.set(tunnel.localPort, server)
  }
}

function scheduleReconnect() {
  if (closing || reconnectTimer) return
  const delay = Math.min(2_000 * Math.max(1, reconnectAttempts + 1), 15_000)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectSsh()
  }, delay)
}

function connectSsh() {
  if (closing) return

  const generation = ++connectionGeneration
  const nextConnection = new Client()
  connection = nextConnection
  connectionReady = false

  nextConnection.on('ready', () => {
    if (closing || generation !== connectionGeneration) {
      nextConnection.end()
      return
    }
    nextConnection.setNoDelay(true)
    connectionReady = true
    reconnectAttempts = 0
    ensureLocalServers()
  })

  nextConnection.on('error', (error) => {
    if (generation !== connectionGeneration || closing) return
    connectionReady = false
    console.error(`Gateway SSH connection failed: ${error.message}`)
    scheduleReconnect()
  })

  nextConnection.on('close', () => {
    if (generation !== connectionGeneration || closing) return
    connectionReady = false
    scheduleReconnect()
  })

  nextConnection.connect({
    host: sshHost,
    port: 22,
    username: sshUsername,
    password: sshPassword,
    readyTimeout: 10_000,
    keepaliveInterval: 30_000,
    keepaliveCountMax: 3,
  })
}

process.on('SIGINT', () => closeTunnel())
process.on('SIGTERM', () => closeTunnel())

connectSsh()
