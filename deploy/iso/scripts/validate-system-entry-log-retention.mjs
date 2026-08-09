#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DAY_MS = 24 * 60 * 60 * 1000

export function isStrictlyPastRetention(timestamp, now, retentionDays) {
  const instant = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime()
  const reference = now instanceof Date ? now.getTime() : new Date(now).getTime()
  return Number.isFinite(instant)
    && Number.isFinite(reference)
    && Number.isInteger(retentionDays)
    && retentionDays > 0
    && instant < reference - retentionDays * DAY_MS
}

function requireMatch(errors, content, pattern, code) {
  if (!pattern.test(content)) errors.push(code)
}

function forbidMatch(errors, content, pattern, code) {
  if (pattern.test(content)) errors.push(code)
}

export async function validateRetentionTemplates(repositoryRoot) {
  const paths = {
    caddy: path.join(repositoryRoot, 'deploy/iso/caddy/gaiop-access-log.caddy'),
    syslog: path.join(repositoryRoot, 'deploy/iso/logrotate/gaiop-netinside-syslog'),
    journal: path.join(repositoryRoot, 'deploy/iso/journald/60-gaiop-retention.conf'),
  }
  const [caddy, syslog, journal] = await Promise.all([
    readFile(paths.caddy, 'utf8'),
    readFile(paths.syslog, 'utf8'),
    readFile(paths.journal, 'utf8'),
  ])
  const errors = []

  requireMatch(errors, caddy, /output file \/var\/log\/gaiop\/caddy\/access\.log\s*\{/, 'caddy.root')
  requireMatch(errors, caddy, /\broll_size 100MiB\b/, 'caddy.roll_size')
  requireMatch(errors, caddy, /\broll_at 00:00\b/, 'caddy.daily')
  requireMatch(errors, caddy, /\broll_keep 0\b/, 'caddy.no_count_limit')
  requireMatch(errors, caddy, /\broll_keep_for 8760h\b/, 'caddy.retention')
  forbidMatch(errors, caddy, /\broll_uncompressed\b/, 'caddy.compression_disabled')
  forbidMatch(errors, caddy, /\broll_local_time\b/, 'caddy.non_utc_rotation')
  for (const header of ['Authorization', 'Proxy-Authorization', 'Cookie', 'X-Api-Key', 'X-Auth-Token']) {
    requireMatch(errors, caddy, new RegExp(`request>headers>${header}\\s+delete`), `caddy.header.${header}`)
  }
  requireMatch(errors, caddy, /resp_headers>Set-Cookie\s+delete/, 'caddy.response_cookie')
  requireMatch(errors, caddy, /request>uri\s+regexp\s+"\\\\\?\.\*\$"\s+"\?\[QUERY_REDACTED\]"/, 'caddy.query_redaction')
  for (const field of ['request>body', 'request>body_base64', 'response>body', 'response>body_base64']) {
    requireMatch(errors, caddy, new RegExp(`${field.replace('>', '\\>')}\\s+delete`), `caddy.body.${field}`)
  }

  requireMatch(errors, syslog, /^"\/var\/log\/netinside\/syslog\.log"\s*\{/m, 'syslog.exact_path')
  forbidMatch(errors, syslog, /^\s*[^#\n]*[*?\[][^\n]*\{/m, 'syslog.wildcard')
  requireMatch(errors, syslog, /^\s*daily\s*$/m, 'syslog.daily')
  requireMatch(errors, syslog, /^\s*rotate -1\s*$/m, 'syslog.no_count_limit')
  requireMatch(errors, syslog, /^\s*maxage 365\s*$/m, 'syslog.retention')
  requireMatch(errors, syslog, /^\s*compress\s*$/m, 'syslog.compress')
  requireMatch(errors, syslog, /^\s*delaycompress\s*$/m, 'syslog.delaycompress')
  requireMatch(errors, syslog, /^\s*dateformat -%Y%m%d-%H%M%S\s*$/m, 'syslog.unique_rotated_name')
  requireMatch(errors, syslog, /^\s*create 0640\s*$/m, 'syslog.current_file')
  requireMatch(errors, syslog, /systemctl kill --kill-who=main --signal=HUP rsyslog\.service/, 'syslog.rsyslog_reopen')
  forbidMatch(errors, syslog, /^\s*(?:copytruncate|shred|allowhardlink)\s*$/m, 'syslog.unsafe_rotation')
  forbidMatch(errors, syslog, /alerts\.jsonl|\/var\/lib\/gaiop|\/var\/log\/gaiop/, 'syslog.scope_expansion')

  requireMatch(errors, journal, /^\[Journal\]\s*$/m, 'journal.section')
  requireMatch(errors, journal, /^Storage=persistent\s*$/m, 'journal.persistent')
  requireMatch(errors, journal, /^Compress=yes\s*$/m, 'journal.compress')
  requireMatch(errors, journal, /^MaxFileSec=1day\s*$/m, 'journal.daily_segments')
  requireMatch(errors, journal, /^MaxRetentionSec=180day\s*$/m, 'journal.retention')
  forbidMatch(errors, journal, /^(?:System|Runtime)(?:MaxUse|KeepFree|MaxFileSize|MaxFiles)=/m, 'journal.capacity_limit')

  return { ok: errors.length === 0, errors, paths }
}

async function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
  const repositoryRoot = path.resolve(scriptDirectory, '../../..')
  try {
    const result = await validateRetentionTemplates(repositoryRoot)
    if (!result.ok) {
      process.stderr.write(`GAIOP log-retention template validation failed: ${result.errors.join(',')}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write('GAIOP log-retention templates: valid\n')
  } catch {
    process.stderr.write('GAIOP log-retention template validation failed: unreadable_template\n')
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) await main()
