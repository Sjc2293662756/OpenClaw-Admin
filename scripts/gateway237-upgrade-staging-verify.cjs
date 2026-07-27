'use strict'

const { Client } = require('ssh2')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

const archivePath = String(process.env.GAIOP_UPGRADE_VERIFY_ARCHIVE || '')
const releaseId = String(process.env.GAIOP_UPGRADE_VERIFY_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_UPGRADE_VERIFY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_UPGRADE_VERIFY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_UPGRADE_VERIFY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!archivePath || !/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)
  || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled upgrade staging verification inputs are incomplete.')
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function upload(client, localPath, remotePath) {
  return new Promise((resolve, reject) => client.sftp((error, sftp) => {
    if (error) return reject(error)
    sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (putError) => {
      sftp.end()
      putError ? reject(putError) : resolve()
    })
  }))
}

function execute(client, script) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  }))
}

function remoteScript({ checksum, remoteArchive }) {
  return String.raw`set -euo pipefail
archive='${remoteArchive}'
expected_sha='${checksum}'
stage_root='/tmp/gaiop-upgrade-verify-${releaseId}'
phase='PRECHECK'
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$stage_root/test-output.log" ]; then
    printf 'TEST_OUTPUT_BEGIN\n'
    grep -B 12 -A 30 'not ok' "$stage_root/test-output.log" || tail -n 220 "$stage_root/test-output.log"
    printf 'TEST_OUTPUT_END\n'
  fi
  rm -rf -- "$stage_root"
  rm -f -- "$archive"
  if [ "$status" -ne 0 ]; then printf 'FAILED_PHASE=%s\n' "$phase"; fi
  exit "$status"
}
trap cleanup EXIT

test "$(sha256sum -- "$archive" | awk '{print $1}')" = "$expected_sha"
test ! -e "$stage_root"
install -d -o netinside -g netinside -m 0700 "$stage_root"

phase='EXTRACT'
tar -xzf "$archive" -C "$stage_root" --no-same-owner
test -f "$stage_root/package.json"
test -f "$stage_root/package-lock.json"
test -f "$stage_root/src/index.js"
test -f "$stage_root/test/upgrade-validator.test.js"
grep -Fq 'GAIOP_UPGRADE_INTERNAL_TOKEN is required in production' "$stage_root/src/runtime-safety.js"
grep -Fq '升级包包含不安全路径' "$stage_root/src/services/UpgradeValidator.js"
grep -Fq '前端升级目录必须指向独立 dist 目录' "$stage_root/src/services/FrontendUpgrader.js"

phase='INSTALL'
chown -R netinside:netinside "$stage_root"
runuser -u netinside -- env HOME=/home/netinside npm --prefix "$stage_root" ci --omit=dev --no-audit --no-fund >/dev/null

phase='TEST'
runuser -u netinside -- env HOME=/home/netinside npm --prefix "$stage_root" test > "$stage_root/test-output.log"
test_count=$(sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' "$stage_root/test-output.log" | tail -n 1)
pass_count=$(sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' "$stage_root/test-output.log" | tail -n 1)
fail_count=$(sed -n 's/^# fail \([0-9][0-9]*\)$/\1/p' "$stage_root/test-output.log" | tail -n 1)
test -n "$test_count"
test "$test_count" = "$pass_count"
test "$fail_count" = '0'

phase='COMPLETE'
printf 'UPGRADE_STAGING_VERIFY_COMPLETE\n'
printf 'ARCHIVE_SHA256=%s\n' "$expected_sha"
printf 'TEST_COUNT=%s\n' "$test_count"
printf 'PASS_COUNT=%s\n' "$pass_count"
`
}

function summarize(result) {
  const output = String(result.output || '')
  return {
    completed: result.ok && /UPGRADE_STAGING_VERIFY_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1] || 'COMPLETE',
    archiveSha256: output.match(/^ARCHIVE_SHA256=([a-f0-9]+)$/m)?.[1] || null,
    testCount: Number(output.match(/^TEST_COUNT=([0-9]+)$/m)?.[1] || 0),
    passCount: Number(output.match(/^PASS_COUNT=([0-9]+)$/m)?.[1] || 0),
    details: output.match(/TEST_OUTPUT_BEGIN\n([\s\S]*?)TEST_OUTPUT_END/)?.[1]?.trim() || null,
    errorCode: result.ok ? null : 'UPGRADE_STAGING_VERIFY_FAILED',
  }
}

const client = new Client()
client.on('ready', async () => {
  const remoteArchive = `/tmp/gaiop-upgrade-verify-${releaseId}.tgz`
  try {
    const checksum = await sha256(archivePath)
    await upload(client, archivePath, remoteArchive)
    const result = await execute(client, remoteScript({ checksum, remoteArchive }))
    const summary = summarize(result)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.completed) process.exitCode = 1
  } catch {
    process.stdout.write('{"completed":false,"errorCode":"UPGRADE_STAGING_VERIFY_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"errorCode":"UPGRADE_STAGING_VERIFY_SSH_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
