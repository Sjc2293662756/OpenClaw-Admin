'use strict'

const { Client } = require('ssh2')

const mode = String(process.env.GAIOP_ORIGIN_MODE || '').trim().toLowerCase()
const releaseId = String(process.env.GAIOP_ORIGIN_RELEASE_ID || '').trim()
const connection = {
  host: String(process.env.GAIOP_ORIGIN_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ORIGIN_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ORIGIN_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!['enable', 'disable'].includes(mode) || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) {
  throw new Error('The temporary origin operation inputs are invalid.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled 237 connection context is incomplete.')
}

function remoteScript() {
  return `set -euo pipefail
mode='${mode}'
release_id='${releaseId}'
origin='http://127.0.0.1:5178'
public_origin='https://101.254.114.237'
env_file='/etc/gaiop/admin.env'
backup_root="/var/backups/gaiop/admin-origin-$release_id"
backup_file="$backup_root/admin.env"
changed=0
completed=0

rollback() {
  status=$?
  if [ "$completed" -eq 0 ] && [ "$changed" -eq 1 ] && [ -f "$backup_file" ]; then
    cp -a -- "$backup_file" "$env_file"
    systemctl restart gaiop-admin.service >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap rollback ERR

test -f "$env_file"
systemctl is-active --quiet gaiop-admin.service
test "$(grep -c '^GAIOP_ALLOWED_ORIGINS=' "$env_file")" -eq 1
current="$(sed -n 's/^GAIOP_ALLOWED_ORIGINS=//p' "$env_file")"
case ",$current," in
  *,"$public_origin",*) ;;
  *) printf 'BLOCK_PUBLIC_ORIGIN_MISSING\n'; exit 41 ;;
esac

next=''
IFS=',' read -r -a origins <<< "$current"
for item in "\${origins[@]}"; do
  [ -n "$item" ] || continue
  if [ "$mode" = 'disable' ] && [ "$item" = "$origin" ]; then continue; fi
  if [ -z "$next" ]; then next="$item"; else next="$next,$item"; fi
done
if [ "$mode" = 'enable' ]; then
  case ",$next," in
    *,"$origin",*) ;;
    *) next="$next,$origin" ;;
  esac
fi

if [ "$next" != "$current" ]; then
  install -d -o root -g root -m 0700 "$backup_root"
  cp -a -- "$env_file" "$backup_file"
  tmp_file="$(mktemp /etc/gaiop/.admin.env.origin.XXXXXX)"
  awk -v replacement="GAIOP_ALLOWED_ORIGINS=$next" '
    /^GAIOP_ALLOWED_ORIGINS=/ { print replacement; next }
    { print }
  ' "$env_file" > "$tmp_file"
  chown --reference="$env_file" "$tmp_file"
  chmod --reference="$env_file" "$tmp_file"
  mv -- "$tmp_file" "$env_file"
  changed=1
  systemctl restart gaiop-admin.service
fi

for attempt in $(seq 1 30); do
  if systemctl is-active --quiet gaiop-admin.service && curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then break; fi
  sleep 1
done
systemctl is-active --quiet gaiop-admin.service
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Origin: $public_origin" http://127.0.0.1:3000/api/health)" = '200'
test "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H 'Origin: https://attacker.invalid' http://127.0.0.1:3000/api/health)" = '403'
local_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Origin: $origin" http://127.0.0.1:3000/api/health)"
if [ "$mode" = 'enable' ]; then test "$local_status" = '200'; else test "$local_status" = '403'; fi
test "$(ss -ltnH '( sport = :3000 )' | awk '{print $4}' | sort -u)" = '127.0.0.1:3000'

completed=1
printf 'RESULT_MODE=%s\n' "$mode"
printf 'RESULT_CHANGED=%s\n' "$changed"
printf 'RESULT_SERVICE=active\n'
printf 'RESULT_LOCAL_ORIGIN_HTTP=%s\n' "$local_status"
printf 'RESULT_PUBLIC_ORIGIN_HTTP=200\n'
printf 'RESULT_BAD_ORIGIN_HTTP=403\n'
if [ "$changed" -eq 1 ]; then printf 'RESULT_BACKUP=%s\n' "$backup_root"; else printf 'RESULT_BACKUP=existing-state\n'; fi
`
}

function execute(client, script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function resultValue(output, key) {
  return output.match(new RegExp(`^${key}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || 'unknown'
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client, remoteScript())
    const payload = {
      completed: result.ok,
      mode: resultValue(result.output, 'RESULT_MODE'),
      changed: resultValue(result.output, 'RESULT_CHANGED') === '1',
      service: resultValue(result.output, 'RESULT_SERVICE'),
      localOriginHttp: resultValue(result.output, 'RESULT_LOCAL_ORIGIN_HTTP'),
      publicOriginHttp: resultValue(result.output, 'RESULT_PUBLIC_ORIGIN_HTTP'),
      badOriginHttp: resultValue(result.output, 'RESULT_BAD_ORIGIN_HTTP'),
      backup: resultValue(result.output, 'RESULT_BACKUP'),
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (!result.ok) process.exitCode = 1
  } finally {
    connection.password = ''
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
