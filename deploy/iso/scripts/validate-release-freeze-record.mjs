#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

function getAtPath(value, path) {
  return path.split('.').reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : undefined
  ), value)
}

function isPlaceholder(value) {
  return typeof value !== 'string' || !value.trim() || /REPLACE_WITH|^pending$/i.test(value.trim())
}

/**
 * Returns field paths only. Do not include record values in errors: a release
 * record is delivery evidence and must never become a channel for secrets.
 */
export function validateReleaseFreezeRecord(record) {
  const errors = []
  const requiredText = [
    'release.id',
    'release.candidateBuiltAt',
    'artifacts.isoFileName',
    'artifacts.isoSha256',
    'signoff.buildOperator',
    'signoff.deploymentReviewer',
    'signoff.approvedAt',
  ]
  for (const path of requiredText) {
    if (isPlaceholder(getAtPath(record, path))) errors.push(path)
  }

  for (const path of ['sourceRevisions.admin.commit', 'sourceRevisions.gateway.commit']) {
    const value = getAtPath(record, path)
    if (typeof value !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value)) errors.push(path)
  }
  if (!/^[0-9a-f]{64}$/i.test(String(getAtPath(record, 'artifacts.isoSha256') || ''))) {
    errors.push('artifacts.isoSha256')
  }

  for (const path of ['sourceRevisions.admin.worktreeClean', 'sourceRevisions.gateway.worktreeClean']) {
    if (getAtPath(record, path) !== true) errors.push(path)
  }
  if (getAtPath(record, 'release.approvalStatus') !== 'approved') errors.push('release.approvalStatus')

  const requiredPassed = [
    'buildEvidence.adminProductionBuild.result',
    'buildEvidence.adminNodeTests.result',
    'buildEvidence.manifestValidation.result',
    'buildEvidence.linuxTargetValidation.result',
    'acceptance.local.permissionsAndApi',
    'acceptance.local.reportArchive',
    'acceptance.local.alertReceiverContract',
    'acceptance.local.channels',
    'acceptance.targetEnvironment.firstBootAndRestart',
    'acceptance.targetEnvironment.httpsAndSse',
    'acceptance.targetEnvironment.syslogEndToEnd',
    'acceptance.targetEnvironment.reportEndToEnd',
    'acceptance.targetEnvironment.backupRestore',
    'acceptance.targetEnvironment.fourRoleAcceptance',
  ]
  for (const path of requiredPassed) {
    if (getAtPath(record, path) !== 'passed') errors.push(path)
  }

  for (const path of [
    'securityAndDataBoundary.secretInjectionVerified',
    'securityAndDataBoundary.secretsExcludedFromSourceAndEvidence',
    'securityAndDataBoundary.persistentDataExcludedFromGoldenImage',
  ]) {
    if (getAtPath(record, path) !== true) errors.push(path)
  }
  return [...new Set(errors)]
}

function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node validate-release-freeze-record.mjs <completed-record.yaml>')
    process.exitCode = 2
    return
  }
  let record
  try {
    record = load(readFileSync(filePath, 'utf8'))
  } catch {
    console.error('Release freeze record could not be parsed')
    process.exitCode = 2
    return
  }
  const errors = validateReleaseFreezeRecord(record)
  if (errors.length > 0) {
    console.error(`Release freeze record is incomplete: ${errors.join(', ')}`)
    process.exitCode = 1
    return
  }
  console.log('Release freeze record: OK')
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) main()
