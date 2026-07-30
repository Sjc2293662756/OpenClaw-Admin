'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ACCOUNT_SECURITY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ACCOUNT_SECURITY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ACCOUNT_SECURITY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled account security inspection context is incomplete.')
}

const command = String.raw`set -euo pipefail
cd /opt/gaiop/admin
node <<'NODE'
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const Database = require('better-sqlite3')
const databasePath = '/var/lib/gaiop/admin/wizard.db'
const db = new Database(databasePath, { readonly: true, fileMustExist: true })
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name))
const roleCounts = Object.fromEntries(db.prepare(
  'SELECT role, COUNT(*) AS count FROM users GROUP BY role ORDER BY role'
).all().map((row) => [row.role, row.count]))
const statusCounts = Object.fromEntries(db.prepare(
  'SELECT status, COUNT(*) AS count FROM users GROUP BY status ORDER BY status'
).all().map((row) => [row.status, row.count]))
const result = {
  databaseIntegrity: db.pragma('integrity_check', { simple: true }),
  userCount: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
  roleCounts,
  statusCounts,
  hasInitialAdminColumn: columns.has('is_initial_admin'),
  hasMustChangePasswordColumn: columns.has('must_change_password'),
  initialAdminCount: columns.has('is_initial_admin')
    ? db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_initial_admin = 1').get().count
    : null,
  mustChangePasswordCount: columns.has('must_change_password')
    ? db.prepare('SELECT COUNT(*) AS count FROM users WHERE must_change_password = 1').get().count
    : null,
  serverIndexSha256: createHash('sha256').update(readFileSync('/opt/gaiop/admin/server/index.js')).digest('hex'),
}
db.close()
process.stdout.write(JSON.stringify(result))
NODE
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', chunk => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', exitCode => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${command}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write(`${JSON.stringify({ completed: false, status: 'inspection-timeout' })}\n`)
  finished = true
  client.end()
  process.exitCode = 1
}, 60_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify({ completed: false, status: 'inspection-failed' })}\n`)
      process.exitCode = 1
      return
    }
    const summary = JSON.parse(result.output)
    process.stdout.write(`${JSON.stringify({ completed: true, status: 'inspection-complete', ...summary })}\n`)
  } catch {
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'inspection-failed' })}\n`)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})

client.on('error', () => {
  if (!finished) {
    finished = true
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
    clearTimeout(timeout)
    process.exitCode = 1
  }
})

client.connect(connection)
