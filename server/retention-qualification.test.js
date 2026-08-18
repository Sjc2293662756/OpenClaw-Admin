import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualifyAdminUpgradeStaging, qualifyReportProvenance } from './retention-qualification.js'

const NOW = Date.UTC(2026, 7, 18, 12)

function writeEnvelope(root, sessionId, issuedAt, mtime = issuedAt) {
  const digest = createHash('sha256').update(sessionId).digest('hex')
  const target = join(root, `${digest}.json`)
  writeFileSync(target, JSON.stringify({ version: 'gaiop_report_provenance.v3', userId: 'u1', sessionId, issuedAt, signature: 'sig' }))
  utimesSync(target, mtime / 1000, mtime / 1000)
  return target
}

test('report qualification is read-only and enforces strict 48-hour boundary plus association protection', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-qualification-provenance-'))
  const root = join(parent, 'report-provenance')
  mkdirSync(root)
  const old = NOW - 49 * 60 * 60 * 1000
  writeEnvelope(root, 'session-candidate', old)
  writeEnvelope(root, 'session-boundary', NOW - 48 * 60 * 60 * 1000)
  writeEnvelope(root, 'session-active', old)
  writeFileSync(join(root, 'unknown.txt'), 'keep')
  let hasSymlink = false
  try {
    symlinkSync(join(root, 'unknown.txt'), join(root, 'link.json'))
    hasSymlink = true
  } catch {
    // Windows CI may not grant unprivileged symlink creation; the production
    // implementation still checks lstat and the other safety cases remain.
  }
  try {
    const before = readdirSync(root).sort()
    const result = qualifyReportProvenance({
      storeDirectory: root,
      now: NOW,
      associationResolver: (sessionId) => ({ known: true, active: sessionId === 'session-active' }),
    })
    assert.equal(result.safe_candidate.count, 1)
    assert.equal(result.safe_candidate.bytes > 0, true)
    assert.equal(result.protected.reasons.not_expired, 1)
    assert.equal(result.protected.reasons.active_or_pending_reference, 1)
    assert.equal(result.protected.reasons.unknown_filename, 1)
    assert.equal(result.protected.reasons.symbolic_link || 0, hasSymlink ? 1 : 0)
    assert.deepEqual(readdirSync(root).sort(), before)
    assert.equal(result.unknown_or_error.count, 0)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('report qualification fails closed when association proof is unavailable', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-qualification-association-'))
  const root = join(parent, 'report-provenance')
  mkdirSync(root)
  writeEnvelope(root, 'session-unknown', NOW - 49 * 60 * 60 * 1000)
  try {
    const result = qualifyReportProvenance({ storeDirectory: root, now: NOW })
    assert.equal(result.safe_candidate.count, 0)
    assert.equal(result.unknown_or_error.reasons.association_unknown, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('Admin staging qualification requires a known inactive task and never calls deletion', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-qualification-staging-'))
  const root = join(parent, 'upgrade-upload-staging')
  mkdirSync(root)
  const file = join(root, '00000000-0000-4000-8000-000000000001.zip')
  writeFileSync(file, 'zip')
  utimesSync(file, (NOW - 25 * 60 * 60 * 1000) / 1000, (NOW - 25 * 60 * 60 * 1000) / 1000)
  try {
    const result = qualifyAdminUpgradeStaging({
      stagingDirectory: root,
      now: NOW,
      activityResolver: () => ({ known: true, active: false }),
    })
    assert.equal(result.safe_candidate.count, 1)
    assert.equal(readdirSync(root).length, 1)
    const unknown = qualifyAdminUpgradeStaging({ stagingDirectory: root, now: NOW })
    assert.equal(unknown.safe_candidate.count, 0)
    assert.equal(unknown.unknown_or_error.reasons.activity_unknown, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
