'use strict'

const { Client } = require('ssh2')
const { readFileSync } = require('node:fs')

const installId = String(process.env.GAIOP_TEAM_KEY_INSTALL_ID || '')
const publicKeyPath = String(process.env.GAIOP_TEAM_KEY_PUBLIC_PATH || '')
const connection = {
  host: String(process.env.GAIOP_TEAM_KEY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_TEAM_KEY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_TEAM_KEY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(installId) || !publicKeyPath || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled team-key installation inputs are incomplete.')
}
if (!/^[A-Za-z0-9._-]+$/.test(connection.username)) {
  throw new Error('The controlled SSH username is invalid.')
}

const publicKey = readFileSync(publicKeyPath, 'utf8').trim()
if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]+)?$/.test(publicKey)) {
  throw new Error('The GAIOP team public key has an invalid format.')
}

function execSudoScript(client, script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function installScript() {
  const encodedPublicKey = Buffer.from(publicKey, 'utf8').toString('base64')
  return `set -euo pipefail
account='${connection.username}'
install_id='${installId}'
home_dir=$(getent passwd "$account" | awk -F: '{print $6}')
test -n "$home_dir"
ssh_dir="$home_dir/.ssh"
authorized_keys="$ssh_dir/authorized_keys"
backup="$ssh_dir/authorized_keys.gaiop-backup-$install_id"
test ! -e "$backup"
install -d -m 0700 -o "$account" -g "$account" "$ssh_dir"
if [ -f "$authorized_keys" ]; then
  cp -a -- "$authorized_keys" "$backup"
else
  : > "$authorized_keys"
  chown "$account:$account" "$authorized_keys"
  chmod 0600 "$authorized_keys"
  cp -a -- "$authorized_keys" "$backup"
fi
team_key=$(printf '%s' '${encodedPublicKey}' | base64 -d)
already_present=0
if grep -Fqx -- "$team_key" "$authorized_keys"; then
  already_present=1
else
  printf '%s\\n' "$team_key" >> "$authorized_keys"
fi
chown "$account:$account" "$authorized_keys"
chmod 0600 "$authorized_keys"
grep -Fqx -- "$team_key" "$authorized_keys"
printf '{"completed":true,"status":"team-key-installed","alreadyPresent":%s,"backupPath":"%s"}\\n' "$already_present" "$backup"
`
}

function parseResult(output, completed) {
  const line = String(output || '').split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith('{') && item.endsWith('}'))
  try {
    const result = JSON.parse(line || '')
    result.completed = Boolean(completed && result.completed)
    return result
  } catch {
    return { completed: false, status: completed ? 'team-key-result-missing' : 'team-key-install-failed' }
  }
}

const client = new Client()
client.on('ready', async () => {
  try {
    const operation = await execSudoScript(client, installScript())
    const result = parseResult(operation.output, operation.ok)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.completed) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
