import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { load } from 'js-yaml'
import { validateReleaseFreezeRecord } from '../../deploy/iso/scripts/validate-release-freeze-record.mjs'

function makeCompleteRecord() {
  const record = load(readFileSync('deploy/iso/release-freeze-record.example.yaml', 'utf8'))
  record.release.id = 'gaiop-1.0.0-rc1'
  record.release.candidateBuiltAt = '2026-07-18T12:00:00Z'
  record.release.approvalStatus = 'approved'
  record.sourceRevisions.admin.commit = 'a'.repeat(40)
  record.sourceRevisions.gateway.commit = 'b'.repeat(40)
  record.sourceRevisions.admin.worktreeClean = true
  record.sourceRevisions.gateway.worktreeClean = true
  record.artifacts.isoFileName = 'gaiop-1.0.0-rc1.iso'
  record.artifacts.isoSha256 = 'c'.repeat(64)
  for (const value of Object.values(record.buildEvidence)) value.result = 'passed'
  record.acceptance.local.permissionsAndApi = 'passed'
  record.acceptance.local.reportArchive = 'passed'
  record.acceptance.local.alertReceiverContract = 'passed'
  record.acceptance.local.channels = 'passed'
  for (const key of Object.keys(record.acceptance.targetEnvironment)) record.acceptance.targetEnvironment[key] = 'passed'
  record.securityAndDataBoundary.secretInjectionVerified = true
  record.securityAndDataBoundary.secretsExcludedFromSourceAndEvidence = true
  record.securityAndDataBoundary.persistentDataExcludedFromGoldenImage = true
  record.signoff.buildOperator = 'build-operator'
  record.signoff.deploymentReviewer = 'deployment-reviewer'
  record.signoff.approvedAt = '2026-07-18T12:30:00Z'
  return record
}

test('a fully evidenced ISO release record passes validation', () => {
  assert.deepEqual(validateReleaseFreezeRecord(makeCompleteRecord()), [])
})

test('a template or incomplete release record cannot be frozen', () => {
  const errors = validateReleaseFreezeRecord(load(readFileSync('deploy/iso/release-freeze-record.example.yaml', 'utf8')))
  assert.ok(errors.includes('release.id'))
  assert.ok(errors.includes('artifacts.isoSha256'))
  assert.ok(errors.includes('acceptance.targetEnvironment.syslogEndToEnd'))
})
