'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_PREFLIGHT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_PREFLIGHT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_PREFLIGHT_SSH_PASSWORD || ''),
  readyTimeout: 15_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled preflight connection context is incomplete.')
}

const steps = [
  { key: 'kernel', command: 'uname -srm' },
  { key: 'operatingSystem', command: 'cat /etc/os-release' },
  { key: 'node', command: 'node --version' },
  { key: 'npmPath', command: 'command -v npm' },
  { key: 'npmVersion', command: 'npm --version' },
  { key: 'gateway', command: 'openclaw gateway status --deep --require-rpc' },
  { key: 'gatewayVersion', command: 'openclaw --version' },
  { key: 'wecomPlugin', command: 'openclaw plugins inspect wecom-openclaw-plugin --runtime' },
  { key: 'dingtalkPlugin', command: 'openclaw plugins inspect dingtalk-connector --runtime' },
  { key: 'larkPlugin', command: 'openclaw plugins inspect openclaw-lark --runtime' },
  { key: 'channels', command: 'openclaw channels status --probe' },
  { key: 'pm2', command: 'pm2 list --no-color' },
  { key: 'openclawPath', command: 'which openclaw' },
  { key: 'nginx', command: 'systemctl is-active nginx' },
  { key: 'nginxPath', command: 'command -v nginx' },
  { key: 'nginxEnabled', command: 'systemctl is-enabled nginx' },
  { key: 'listeners', command: 'ss -ltnp' },
  { key: 'port443', command: "ss -ltn '( sport = :443 )'" },
  { key: 'nodeProcesses', command: 'ps -C node -o pid=,comm=,etimes=' },
  { key: 'nodeWorkdirs', command: 'for pid in $(pgrep -x node); do readlink -f /proc/$pid/cwd; done' },
  { key: 'sudo', command: 'sudo -n true' },
  { key: 'apt', command: 'command -v apt-get' },
  { key: 'optWritable', command: 'test -w /opt' },
  { key: 'firewall', command: 'ufw status' },
  { key: 'storage', command: 'df -P' },
  { key: 'gaiopDataRoot', command: "stat -c '%a %U %G' /var/lib/gaiop" },
]

function execute(client, step) {
  return new Promise((resolve) => {
    client.exec(step.command, (error, stream) => {
      if (error) {
        resolve({ key: step.key, ok: false, output: '', exitCode: null })
        return
      }
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => {
        resolve({ key: step.key, ok: exitCode === 0, output, exitCode })
      })
    })
  })
}

function validateSudo(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' -v", (error, stream) => {
      if (error) {
        resolve({ key: 'sudoPasswordValidation', ok: false, output: '', exitCode: null })
        return
      }
      stream.on('data', () => {})
      stream.stderr.on('data', () => {})
      stream.write(`${connection.password}\n`)
      stream.end()
      stream.on('close', (exitCode) => {
        resolve({ key: 'sudoPasswordValidation', ok: exitCode === 0, output: '', exitCode })
      })
    })
  })
}

function executeWithSudo(client, key, command) {
  return new Promise((resolve) => {
    client.exec(`sudo -S -p '' ${command}`, (error, stream) => {
      if (error) {
        resolve({ key, ok: false, output: '', exitCode: null })
        return
      }
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.write(`${connection.password}\n`)
      stream.end()
      stream.on('close', (exitCode) => {
        resolve({ key, ok: exitCode === 0, output, exitCode })
      })
    })
  })
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
}

function version(value) {
  const match = String(value || '').match(/v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?/)
  return match ? match[0] : null
}

function status(result) {
  return result.ok ? 'ok' : 'unavailable-or-failed'
}

function listenerSummary(value) {
  const summary = { loopback: 0, wildcard: 0, other: 0, nodeOwned: 0, nginxOwned: 0, otherOwned: 0 }
  for (const line of String(value || '').split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    const local = fields[3]
    if (/^(127\.0\.0\.1|\[::1\]|::1):/i.test(local)) summary.loopback += 1
    else if (/^(0\.0\.0\.0|\[::\]|\*):/i.test(local)) summary.wildcard += 1
    else summary.other += 1
    if (/\bnode\b/i.test(line)) summary.nodeOwned += 1
    else if (/\bnginx\b/i.test(line)) summary.nginxOwned += 1
    else if (/users:\(\(/i.test(line)) summary.otherOwned += 1
  }
  return summary
}

function highestStorageUse(value) {
  const values = Array.from(String(value || '').matchAll(/\s(\d+)%\s/g), (match) => Number(match[1]))
  return values.length ? Math.max(...values) : null
}

function hasListener(value) {
  return String(value || '').split(/\r?\n/).slice(1).some((line) => line.trim())
}

function portScope(value) {
  const text = String(value || '')
  if (/127\.0\.0\.1:3000/.test(text)) return 'loopback-ipv4'
  if (/\[::1\]:3000/.test(text)) return 'loopback-ipv6'
  if (/0\.0\.0\.0:3000|\[::\]:3000|\*:3000/.test(text)) return 'wildcard'
  return hasListener(text) ? 'other' : 'none'
}

function processKind(value) {
  const text = String(value || '').toLowerCase()
  if (/\bcaddy\b/.test(text)) return 'caddy'
  if (/\bnginx\b/.test(text)) return 'nginx'
  if (/\bapache2?\b|\bhttpd\b/.test(text)) return 'apache'
  if (/\bnode\b/.test(text)) return 'node'
  return text.trim() ? 'other' : 'unidentified'
}

function caddyUnitSummary(value) {
  const text = String(value || '')
  return {
    active: /^ActiveState=active$/m.test(text),
    hasUnitFile: /^FragmentPath=\S+/m.test(text),
    hasExplicitConfigArgument: /--config(?:=|\s+)/.test(text),
  }
}

function positiveCount(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function adminEnvPresence(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim())
    return Object.fromEntries(Object.entries(parsed).map(([key, present]) => [key, present === true]))
  } catch {
    return null
  }
}

function gatewayFailureCategory(value) {
  const output = String(value || '')
  if (output.includes('GATEWAY_DIAG_AUTH')) return 'authentication'
  if (output.includes('GATEWAY_DIAG_DEVICE')) return 'device-identity-or-pairing'
  if (output.includes('GATEWAY_DIAG_REFUSED')) return 'connection-refused'
  if (output.includes('GATEWAY_DIAG_TIMEOUT')) return 'timeout'
  if (output.includes('GATEWAY_DIAG_PROTOCOL')) return 'protocol'
  if (output.includes('GATEWAY_DIAG_NONE')) return 'no-classified-error'
  return 'other'
}

function gatewayServiceFailureCategory(value) {
  const output = String(value || '')
  if (output.includes('GATEWAY_SERVICE_DEVICE')) return 'device-identity-or-pairing'
  if (output.includes('GATEWAY_SERVICE_AUTH')) return 'authentication'
  if (output.includes('GATEWAY_SERVICE_PROTOCOL')) return 'protocol'
  if (output.includes('GATEWAY_SERVICE_REFUSED')) return 'connection-refused'
  if (output.includes('GATEWAY_SERVICE_NONE')) return 'no-classified-error'
  return 'unavailable-or-other'
}

function summarize(results) {
  const byKey = Object.fromEntries(results.map((result) => [result.key, result]))
  const plugin = (key) => ({
    status: status(byKey[key]),
    loadedSignal: byKey[key].ok && /\b(loaded|running)\b/i.test(byKey[key].output),
  })
  const operatingSystem = String(byKey.operatingSystem.output || '').match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/m)
  const dataRoot = byKey.gaiopDataRoot

  return {
    completed: true,
    platform: {
      kernel: firstLine(byKey.kernel.output),
      operatingSystem: operatingSystem ? (operatingSystem[1] || operatingSystem[2]) : null,
      nodeVersion: version(byKey.node.output),
      npmVersion: version(byKey.npmVersion.output),
      npmAvailable: byKey.npmPath.ok,
    },
    gateway: {
      version: version(byKey.gatewayVersion.output),
      deepHealth: status(byKey.gateway),
    },
    plugins: {
      wecom: plugin('wecomPlugin'),
      dingtalk: plugin('dingtalkPlugin'),
      lark: plugin('larkPlugin'),
    },
    channels: { probe: status(byKey.channels) },
    processManagers: {
      pm2: status(byKey.pm2),
      pm2ManagedAppCount: Math.max(0, (String(byKey.pm2.output || '').match(/\bonline\b|\bstopped\b|\berrored\b/gi) || []).length),
      nginx: byKey.nginx.ok && /^active$/im.test(byKey.nginx.output) ? 'active' : 'inactive-or-unavailable',
      nginxInstalled: byKey.nginxPath.ok,
      nginxEnabled: byKey.nginxEnabled.ok && /^enabled$/im.test(byKey.nginxEnabled.output),
      caddy: caddyUnitSummary(byKey.caddyUnit.output),
      defaultCaddyfileReadable: byKey.defaultCaddyfile.ok,
    },
    runtimeDiscovery: {
      openclawCliOnDefaultPath: byKey.openclawPath.ok,
      nodeProcessCount: String(byKey.nodeProcesses.output || '').split(/\r?\n/).filter(Boolean).length,
      workspaceLikeNodeWorkdirCount: String(byKey.nodeWorkdirs.output || '').split(/\r?\n/).filter((line) => /openclaw|gaiop/i.test(line)).length,
    },
    network: {
      listeners: listenerSummary(byKey.listeners.output),
      port443Occupied: hasListener(byKey.port443.output),
      port443OwnerType: processKind(byKey.port443Owner.output),
      firewall: byKey.firewall.ok ? 'reported-active-or-inactive' : 'unavailable-or-not-installed',
    },
    deploymentPrerequisites: {
      nonInteractiveSudo: byKey.sudo.ok,
      sudoWithCurrentConnectionCredential: byKey.sudoPasswordValidation.ok,
      sudoCredentialCleared: byKey.sudoCredentialClear.ok,
      aptAvailable: byKey.apt.ok,
      optWritable: byKey.optWritable.ok,
    },
    storage: {
      highestUsePercent: highestStorageUse(byKey.storage.output),
      gaiopDataRoot: dataRoot.ok ? 'present-with-restricted-metadata-read' : 'not-present-or-unreadable',
    },
    adminBff: {
      serviceState: byKey.adminService.ok && /^active$/im.test(byKey.adminService.output) ? 'active' : 'inactive-or-unavailable',
      enabled: byKey.adminEnabled.ok && /^enabled$/im.test(byKey.adminEnabled.output),
      port3000Listening: hasListener(byKey.adminPort.output),
      port3000Scope: portScope(byKey.adminPort.output),
      healthEndpoint: byKey.adminHealth.ok ? 'http-200' : 'unavailable-or-non-200',
      gatewayTcpFromServiceAccount: byKey.adminGatewayTcp.ok ? 'reachable' : 'unreachable',
      gatewayFailureCategory: gatewayFailureCategory(byKey.adminGatewayLog.output),
      gatewayErrorSummary: firstLine(byKey.adminGatewayError.output),
      gatewayServiceFailureCategory: gatewayServiceFailureCategory(byKey.gatewayServiceLog.output),
      npmProcessCount: positiveCount(byKey.npmProcesses.output),
      stagingDirectoryCount: positiveCount(byKey.adminStageDirectories.output),
      releasePresent: byKey.adminRelease.ok,
      loopbackBindingPatchPresent: byKey.adminBindPatch.ok,
      loopbackBindingGuardPresent: byKey.adminBindGuard.ok,
      persistentStoragePatchPresent: byKey.adminDataPatch.ok,
      serviceWorkingDirectoryExpected: byKey.adminWorkdir.ok,
      loopbackBindingEnvironmentExpected: byKey.adminBindEnvExpected.ok,
      portEnvironmentExpected: byKey.adminPortEnvExpected.ok,
      environmentFieldPresence: adminEnvPresence(byKey.adminEnvPresence.output),
    },
  }
}

const client = new Client()
let completed = false
const timeout = setTimeout(() => {
  if (!completed) {
    completed = true
    process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'SSH_PREFLIGHT_TIMEOUT' })}\n`)
  }
  client.end()
  process.exitCode = 1
}, 120_000)

client.on('ready', async () => {
  try {
    const results = []
    for (const step of steps) results.push(await execute(client, step))
    results.push(await validateSudo(client))
    results.push(await executeWithSudo(client, 'port443Owner', "ss -ltnp '( sport = :443 )'"))
    results.push(await executeWithSudo(client, 'caddyUnit', 'systemctl show caddy --property=ActiveState --property=FragmentPath --property=ExecStart'))
    results.push(await executeWithSudo(client, 'defaultCaddyfile', 'test -r /etc/caddy/Caddyfile'))
    results.push(await executeWithSudo(client, 'adminService', 'systemctl is-active gaiop-admin.service'))
    results.push(await executeWithSudo(client, 'adminEnabled', 'systemctl is-enabled gaiop-admin.service'))
    results.push(await executeWithSudo(client, 'adminPort', "ss -ltn '( sport = :3000 )'"))
    results.push(await executeWithSudo(client, 'adminHealth', "node -e \"const http=require('http'); const req=http.get('http://127.0.0.1:3000/api/health',{timeout:5000},(res)=>{res.resume();res.on('end',()=>process.exit(res.statusCode===200?0:1));});req.on('error',()=>process.exit(1));req.on('timeout',()=>{req.destroy();process.exit(1);});\""))
    results.push(await executeWithSudo(client, 'adminGatewayTcp', "sudo -u gaiop node -e \"const net=require('net');const socket=net.connect({host:'127.0.0.1',port:18789});const done=(code)=>{socket.destroy();process.exit(code)};socket.setTimeout(5000,()=>done(1));socket.on('connect',()=>done(0));socket.on('error',()=>done(1));\""))
    results.push(await executeWithSudo(client, 'adminGatewayLog', "if journalctl -u gaiop-admin.service -n 200 --no-pager 2>/dev/null | grep -Eqi 'unauthori[sz]ed|forbidden|auth(entication| failed| error)|invalid token|token.*(invalid|expired|mismatch)'; then printf GATEWAY_DIAG_AUTH; elif journalctl -u gaiop-admin.service -n 200 --no-pager 2>/dev/null | grep -Eqi 'device.*(pair|approv|authori[sz]|trust)|pair.*device|identity.*(reject|invalid|deny)'; then printf GATEWAY_DIAG_DEVICE; elif journalctl -u gaiop-admin.service -n 200 --no-pager 2>/dev/null | grep -Eqi 'ECONNREFUSED|connection refused'; then printf GATEWAY_DIAG_REFUSED; elif journalctl -u gaiop-admin.service -n 200 --no-pager 2>/dev/null | grep -Eqi 'ETIMEDOUT|timed out'; then printf GATEWAY_DIAG_TIMEOUT; elif journalctl -u gaiop-admin.service -n 200 --no-pager 2>/dev/null | grep -Eqi 'WebSocket|handshake|protocol'; then printf GATEWAY_DIAG_PROTOCOL; else printf GATEWAY_DIAG_NONE; fi"))
    results.push(await executeWithSudo(client, 'adminGatewayError', "line=$(journalctl -u gaiop-admin.service -n 300 --no-pager 2>/dev/null | grep -E '\\[Gateway\\] (WebSocket error|Connect failed|Connection failed|Error:)' | tail -n 1 || true); printf '%s' \"$line\" | sed -E 's#([?&]auth=)[^&[:space:]]*#\\1[REDACTED]#Ig; s#(token|password|secret)([=:])[[:graph:]]+#\\1\\2[REDACTED]#Ig; s#(Bearer)[[:space:]]+[[:graph:]]+#\\1 [REDACTED]#Ig' | cut -c 1-300"))
    results.push(await executeWithSudo(client, 'gatewayServiceLog', "if journalctl --user-unit=openclaw-gateway.service -n 400 --no-pager 2>/dev/null | grep -Eqi 'device.*(pair|approv|authori[sz]|trust)|pair.*device|identity.*(reject|invalid|deny)'; then printf GATEWAY_SERVICE_DEVICE; elif journalctl --user-unit=openclaw-gateway.service -n 400 --no-pager 2>/dev/null | grep -Eqi 'unauthori[sz]ed|forbidden|auth(entication| failed| error)|invalid token|token.*(invalid|expired|mismatch)'; then printf GATEWAY_SERVICE_AUTH; elif journalctl --user-unit=openclaw-gateway.service -n 400 --no-pager 2>/dev/null | grep -Eqi 'protocol|handshake|unsupported.*version'; then printf GATEWAY_SERVICE_PROTOCOL; elif journalctl --user-unit=openclaw-gateway.service -n 400 --no-pager 2>/dev/null | grep -Eqi 'ECONNREFUSED|connection refused'; then printf GATEWAY_SERVICE_REFUSED; else printf GATEWAY_SERVICE_NONE; fi"))
    results.push(await executeWithSudo(client, 'npmProcesses', 'pgrep -cx npm || true'))
    results.push(await executeWithSudo(client, 'adminStageDirectories', "find /opt/gaiop -maxdepth 1 -type d -name '.admin-stage-*' -printf x 2>/dev/null | wc -c"))
    results.push(await executeWithSudo(client, 'adminRelease', 'test -f /opt/gaiop/admin/server/index.js'))
    results.push(await executeWithSudo(client, 'adminBindPatch', "grep -Fq 'server.listen(envConfig.PORT, envConfig.GAIOP_BIND_HOST' /opt/gaiop/admin/server/index.js"))
    results.push(await executeWithSudo(client, 'adminBindGuard', "grep -Fq 'GAIOP_BIND_HOST must be a loopback address.' /opt/gaiop/admin/server/index.js"))
    results.push(await executeWithSudo(client, 'adminDataPatch', "grep -Fq 'process.env.GAIOP_ADMIN_DATA_DIR' /opt/gaiop/admin/server/database.js"))
    results.push(await executeWithSudo(client, 'adminWorkdir', "test \"$(systemctl show gaiop-admin.service --property=WorkingDirectory --value)\" = '/opt/gaiop/admin'"))
    results.push(await executeWithSudo(client, 'adminBindEnvExpected', "node --env-file=/etc/gaiop/admin.env -e \"process.exit(process.env.GAIOP_BIND_HOST === '127.0.0.1' ? 0 : 1)\""))
    results.push(await executeWithSudo(client, 'adminPortEnvExpected', "node --env-file=/etc/gaiop/admin.env -e \"process.exit(process.env.PORT === '3000' ? 0 : 1)\""))
    results.push(await executeWithSudo(client, 'adminEnvPresence', "node --env-file=/etc/gaiop/admin.env -e \"const keys=['AUTH_PASSWORD','DATA_SOURCE_ENCRYPTION_KEY','SENSITIVE_CONFIG_ENCRYPTION_KEY','OPENCLAW_AUTH_TOKEN','OPENCLAW_AUTH_PASSWORD','GAIOP_REPORT_PROVENANCE_SIGNING_KEY','GAIOP_ALERT_RECEIVER_TOKEN','GAIOP_BIND_HOST','GAIOP_ADMIN_DATA_DIR','GAIOP_ADMIN_BACKUP_DIR']; console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, Boolean(process.env[key])]))))\""))
    results.push(await execute(client, { key: 'sudoCredentialClear', command: 'sudo -k' }))
    completed = true
    process.stdout.write(`${JSON.stringify(summarize(results))}\n`)
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})

client.on('error', (error) => {
  if (!completed) {
    completed = true
    const normalized = String(error?.message || '').toLowerCase()
    const errorCode = normalized.includes('authentication')
      ? 'SSH_AUTHENTICATION_FAILED'
      : 'SSH_CONNECTION_FAILED'
    process.stdout.write(`${JSON.stringify({ completed: false, errorCode })}\n`)
    clearTimeout(timeout)
    process.exitCode = 1
  }
})

client.connect(connection)
